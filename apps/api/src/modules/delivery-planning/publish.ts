import type { PrismaClient } from "@prisma/client";
import { createDeliveryAssignment } from "../../createDeliveryAssignment.js";
import { GEOCODE_OK_STATUSES } from "./flag.js";
import { writePlanningAudit } from "./audit.js";
import { classifyOrder } from "./selectCandidates.js";
import { assertShiftNotPastCutoff, loadPlanningSettings, slaConfigFromSettings } from "./settings.js";
import { parseShiftCode, parseYmd, type ShiftKey } from "./shiftSla.js";
import { loadPlan, serializePlanPayload } from "./suggestOptimize.js";

function parseLocalYmd(ymd: string): Date | null {
  return parseYmd(ymd);
}

function barrelQtyFromLines(
  lines: Array<{ qtyOrdered: number; linePurpose: string | null }>,
): number {
  let n = 0;
  for (const ln of lines) {
    const p = (ln.linePurpose ?? "delivery").trim();
    if (p !== "delivery") continue;
    n += Number(ln.qtyOrdered) || 0;
  }
  return n;
}

/**
 * 發布草稿方案 → 正式 DeliveryAssignment。
 * 硬限制（僅此路徑）：出勤、容量、座標、既有 createDeliveryAssignment 規則。
 */
export async function publishPlan(
  prisma: PrismaClient,
  args: {
    planId: bigint;
    assignmentDate?: string;
    onlyStopIds?: bigint[] | null;
    actorUserId: bigint;
  },
) {
  const plan = await loadPlan(prisma, args.planId);
  if (!plan) throw new Error("找不到方案");
  if (!["draft", "pending_review"].includes(plan.status)) {
    throw new Error(`方案狀態為 ${plan.status}，不可發布`);
  }

  const assignmentDateLabel =
    args.assignmentDate?.trim().slice(0, 10) ||
    plan.planDate.toISOString().slice(0, 10);
  const assignmentDate = parseLocalYmd(assignmentDateLabel);
  if (!assignmentDate) throw new Error("assignmentDate 無效");

  const planShift = parseShiftCode(plan.shift);
  if (planShift) {
    const settings = await loadPlanningSettings(prisma);
    const sla = slaConfigFromSettings(settings);
    assertShiftNotPastCutoff(assignmentDateLabel, planShift, settings);
    const target: ShiftKey = { date: assignmentDateLabel, shift: planShift };
    const relatedIds = [
      ...plan.routes.flatMap((r) => r.stops.map((s) => s.salesOrderId)),
      ...plan.unassigned.map((u) => u.salesOrderId),
    ];
    if (relatedIds.length > 0) {
      const sos = await prisma.salesOrder.findMany({
        where: { id: { in: relatedIds } },
        include: {
          lines: true,
          deliveryAddress: true,
          customer: { include: { addressZone: true } },
        },
      });
      const blockers: string[] = [];
      for (const so of sos) {
        const geo = so.deliveryAddress.geocodeStatus;
        if (GEOCODE_OK_STATUSES.has(geo)) continue;
        const classified = classifyOrder(
          {
            ...so,
            assignments: [],
            orderKind: so.orderKind ?? null,
            dispatchPriority: so.dispatchPriority ?? null,
            earliestDate: so.earliestDate ?? null,
            earliestShift: so.earliestShift ?? null,
            latestDate: so.latestDate ?? null,
            latestShift: so.latestShift ?? null,
            preferredShift: so.preferredShift ?? null,
            dispatchLocked: so.dispatchLocked ?? false,
            preferredDriverId: so.preferredDriverId ?? null,
            requiredDriverId: so.requiredDriverId ?? null,
          },
          target,
          sla,
        );
        if (classified?.tier === "must") blockers.push(so.orderNo);
      }
      if (blockers.length > 0) {
        throw new Error(`必送單缺座標，不可發布：${[...new Set(blockers)].join("、")}`);
      }
    }
  }

  const dayStart = assignmentDate;
  const dayEnd = new Date(assignmentDate);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const only = args.onlyStopIds ? new Set(args.onlyStopIds.map(String)) : null;

  const succeeded: Array<{ salesOrderId: string; assignmentId: string; driverId: string }> = [];
  const skipped: Array<{ salesOrderId: string; reason: string }> = [];

  // 追蹤 publish 過程中累計容量（含當日已存在）
  const loadCache = new Map<bigint, { orderCount: number; barrelQty: number; maxO: number; maxB: number }>();

  async function ensureLoad(driverId: bigint) {
    let cur = loadCache.get(driverId);
    if (cur) return cur;
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new Error("司機不存在");
    const existing = await prisma.deliveryAssignment.findMany({
      where: {
        driverId,
        assignmentDate: { gte: dayStart, lt: dayEnd },
        status: { in: ["assigned", "delivering", "pending_settlement"] },
      },
      include: { salesOrder: { include: { lines: true } } },
    });
    let barrelQty = 0;
    for (const a of existing) barrelQty += barrelQtyFromLines(a.salesOrder.lines);
    cur = {
      orderCount: existing.length,
      barrelQty,
      maxO: driver.maxOrderCount,
      maxB: driver.maxBarrelQty,
    };
    loadCache.set(driverId, cur);
    return cur;
  }

  for (const route of plan.routes) {
    const attendanceRows = await prisma.driverAttendance.findMany({
      where: {
        driverId: route.driverId,
        workDate: assignmentDate,
        ...(planShift ? { shift: { in: [planShift, "all"] } } : {}),
      },
    });
    const attendance =
      (planShift ? attendanceRows.find((a) => a.shift === planShift) : null) ??
      attendanceRows.find((a) => a.shift === "all") ??
      attendanceRows[0] ??
      null;
    // 若完全沒有出勤列：仍允許（調度員已在 optimize 選司機）；若有列且未出勤則擋
    if (attendance && !attendance.isOnDuty) {
      for (const stop of route.stops) {
        if (only && !only.has(stop.id.toString())) continue;
        skipped.push({
          salesOrderId: stop.salesOrderId.toString(),
          reason: "司機當日未出勤",
        });
      }
      continue;
    }

    for (const stop of route.stops) {
      if (only && !only.has(stop.id.toString())) continue;
      const salesOrderId = stop.salesOrderId.toString();

      const geo = stop.salesOrder.deliveryAddress.geocodeStatus;
      if (!GEOCODE_OK_STATUSES.has(geo)) {
        skipped.push({ salesOrderId, reason: `地址座標不可用（${geo}）` });
        continue;
      }

      const need = barrelQtyFromLines(stop.salesOrder.lines);
      const load = await ensureLoad(route.driverId);
      if (load.orderCount + 1 > load.maxO) {
        skipped.push({ salesOrderId, reason: "超過司機最大訂單數" });
        continue;
      }
      if (load.barrelQty + need > load.maxB) {
        skipped.push({ salesOrderId, reason: "超過司機最大桶數" });
        continue;
      }

      const result = await createDeliveryAssignment(prisma, {
        salesOrderId: stop.salesOrderId,
        driverId: route.driverId,
        vehicleId: route.vehicleId,
        assignmentDate,
        assignmentDateLabel,
        assignedByUserId: args.actorUserId,
        routeStopId: stop.id,
        routeSequence: stop.stopSequence,
        assignmentShift: plan.shift === "am" || plan.shift === "pm" ? plan.shift : null,
        checkStock: true,
      });

      if (!result.ok) {
        skipped.push({ salesOrderId, reason: result.reason });
        continue;
      }

      load.orderCount += 1;
      load.barrelQty += need;
      succeeded.push({
        salesOrderId,
        assignmentId: result.assignmentId.toString(),
        driverId: route.driverId.toString(),
      });
    }
  }

  await prisma.deliveryPlan.update({
    where: { id: plan.id },
    data: {
      status: "published",
      publishedAt: new Date(),
      approvedByUserId: args.actorUserId,
    },
  });

  await writePlanningAudit(prisma, {
    planId: plan.id,
    action: "publish",
    actorUserId: args.actorUserId,
    inputSummary: { planId: plan.id.toString(), assignmentDate: assignmentDateLabel },
    outputSummary: {
      succeededCount: succeeded.length,
      skippedCount: skipped.length,
      succeeded,
      skipped,
    },
  });

  return {
    planId: plan.id.toString(),
    status: "published" as const,
    succeeded,
    skipped,
    plan: serializePlanPayload(plan.id, await loadPlan(prisma, plan.id)),
  };
}

export async function cancelPlan(
  prisma: PrismaClient,
  args: { planId: bigint; reason?: string; actorUserId?: bigint | null },
) {
  const plan = await prisma.deliveryPlan.findUnique({ where: { id: args.planId } });
  if (!plan) throw new Error("找不到方案");
  if (plan.status === "published") {
    throw new Error("已發布方案不可取消（正式派單仍保留）；如需調整請用人工派單流程");
  }
  await prisma.deliveryPlan.update({
    where: { id: args.planId },
    data: { status: "cancelled" },
  });
  await writePlanningAudit(prisma, {
    planId: args.planId,
    action: "cancel",
    actorUserId: args.actorUserId ?? null,
    inputSummary: { reason: args.reason ?? null },
  });
  return { planId: args.planId.toString(), status: "cancelled" };
}

export async function patchPlanStops(
  prisma: PrismaClient,
  args: {
    planId: bigint;
    moves: Array<{
      salesOrderId: bigint;
      toDriverId: bigint;
      toSequence: number;
      manualAdjustReason?: string | null;
    }>;
    actorUserId?: bigint | null;
  },
) {
  const plan = await loadPlan(prisma, args.planId);
  if (!plan) throw new Error("找不到方案");
  if (!["draft", "pending_review"].includes(plan.status)) {
    throw new Error("僅草稿／待確認方案可調整站點");
  }

  for (const move of args.moves) {
    const stop = plan.routes.flatMap((r) => r.stops).find((s) => s.salesOrderId === move.salesOrderId);
    if (!stop) throw new Error(`找不到訂單站點 ${move.salesOrderId}`);

    const existingRoute = plan.routes.find((r) => r.driverId === move.toDriverId);
    let targetRouteId = existingRoute?.id;
    if (!targetRouteId) {
      const driver = await prisma.driver.findUnique({ where: { id: move.toDriverId } });
      if (!driver || !driver.isActive) throw new Error("目標司機不可用");
      const createdRoute = await prisma.deliveryRoute.create({
        data: {
          planId: plan.id,
          driverId: move.toDriverId,
          vehicleId: driver.vehicleId,
          sequenceNo: plan.routes.length + 1,
          totalBarrelQty: 0,
        },
      });
      targetRouteId = createdRoute.id;
    }

    await prisma.deliveryRouteStop.update({
      where: { id: stop.id },
      data: {
        routeId: targetRouteId,
        stopSequence: Math.max(1, move.toSequence),
        manualAdjustReason: move.manualAdjustReason ?? stop.manualAdjustReason,
      },
    });
  }

  // 重算各路線桶數（簡化：依目前 stops）
  const refreshed = await loadPlan(prisma, args.planId);
  if (refreshed) {
    for (const r of refreshed.routes) {
      const total = r.stops.reduce((s, st) => s + barrelQtyFromLines(st.salesOrder.lines), 0);
      await prisma.deliveryRoute.update({
        where: { id: r.id },
        data: { totalBarrelQty: total },
      });
    }
  }

  await writePlanningAudit(prisma, {
    planId: args.planId,
    action: "patch_stops",
    actorUserId: args.actorUserId ?? null,
    inputSummary: { moves: args.moves.map((m) => ({ ...m, salesOrderId: m.salesOrderId.toString(), toDriverId: m.toDriverId.toString() })) },
  });

  return serializePlanPayload(args.planId, await loadPlan(prisma, args.planId));
}
