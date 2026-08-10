import type { PrismaClient } from "@prisma/client";
import { formatNearKm, haversineKm, toCoord, unzonedProximityScore } from "./geoNear.js";
import { GEOCODE_OK_STATUSES } from "./flag.js";
import { writePlanningAudit } from "./audit.js";
import { discardOpenDrafts, nextPlanVersion } from "./planDraft.js";
import { parseYmd } from "./shiftSla.js";

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

function serializePlanPayload(planId: bigint, prismaPlan: Awaited<ReturnType<typeof loadPlan>>) {
  if (!prismaPlan) return null;
  return {
    plan: {
      id: planId.toString(),
      planDate: prismaPlan.planDate.toISOString().slice(0, 10),
      shift: prismaPlan.shift,
      version: prismaPlan.version,
      status: prismaPlan.status,
      mode: prismaPlan.mode,
      algorithmVersion: prismaPlan.algorithmVersion,
      totalDistanceMeters: prismaPlan.totalDistanceMeters,
      totalDriveMinutes: prismaPlan.totalDriveMinutes,
      unassignedCount: prismaPlan.unassignedCount,
    },
    routes: prismaPlan.routes.map((r) => ({
      id: r.id.toString(),
      driverId: r.driverId.toString(),
      vehicleId: r.vehicleId?.toString() ?? null,
      totalBarrelQty: r.totalBarrelQty,
      totalDriveMinutes: r.totalDriveMinutes,
      stops: r.stops.map((s) => ({
        id: s.id.toString(),
        salesOrderId: s.salesOrderId.toString(),
        stopSequence: s.stopSequence,
        etaAt: s.etaAt?.toISOString() ?? null,
        aiExplanation: s.aiExplanation,
        hasHardViolation: s.hasHardViolation,
        orderNo: s.salesOrder.orderNo,
        orderKind: s.salesOrder.orderKind ?? (((s.salesOrder.remark ?? "").startsWith("【週期巡查】")) ? "patrol" : "general"),
        dispatchPriority: s.salesOrder.dispatchPriority ?? null,
        dispatchLocked: Boolean(s.salesOrder.dispatchLocked),
        addressLine: s.salesOrder.deliveryAddress.addressLine,
        geocodeStatus: s.salesOrder.deliveryAddress.geocodeStatus,
        barrelQty: barrelQtyFromLines(s.salesOrder.lines),
        customerName: s.salesOrder.customer.name,
        zoneId: s.salesOrder.customer.addressZoneId?.toString() ?? null,
        zoneName: s.salesOrder.customer.addressZone?.name ?? null,
      })),
    })),
    unassigned: prismaPlan.unassigned.map((u) => ({
      salesOrderId: u.salesOrderId.toString(),
      reasonCode: u.reasonCode,
      reasonText: u.reasonText,
      orderNo: u.salesOrder.orderNo,
      orderKind: u.salesOrder.orderKind ?? (((u.salesOrder.remark ?? "").startsWith("【週期巡查】")) ? "patrol" : "general"),
      dispatchPriority: u.salesOrder.dispatchPriority ?? null,
      dispatchLocked: Boolean(u.salesOrder.dispatchLocked),
      addressLine: u.salesOrder.deliveryAddress.addressLine,
      geocodeStatus: u.salesOrder.deliveryAddress.geocodeStatus,
      deliveryAddressId: u.salesOrder.deliveryAddressId.toString(),
    })),
  };
}

async function loadPlan(prisma: PrismaClient, planId: bigint) {
  return prisma.deliveryPlan.findUnique({
    where: { id: planId },
    include: {
      routes: {
        orderBy: { sequenceNo: "asc" },
        include: {
          stops: {
            orderBy: { stopSequence: "asc" },
            include: {
              salesOrder: {
                include: {
                  lines: true,
                  deliveryAddress: true,
                  customer: { include: { addressZone: true } },
                },
              },
            },
          },
        },
      },
      unassigned: {
        include: {
          salesOrder: { include: { deliveryAddress: true } },
        },
      },
    },
  });
}

export { loadPlan, serializePlanPayload };

/**
 * MVP-A：suggest_driver 啟發式
 * - 出勤司機
 * - 容量（訂單數／桶數）
 * - 區域熟悉度（AddressZone）
 * - 無可靠座標 → 未排入
 * - 不做完整路線／ETA
 */
export async function optimizeSuggestDriver(
  prisma: PrismaClient,
  args: {
    planDate: string;
    salesOrderIds?: bigint[];
    driverIds?: bigint[];
    weightProfileKey?: string;
    actorUserId?: bigint | null;
  },
) {
  const planDate = parseLocalYmd(args.planDate);
  if (!planDate) throw new Error("planDate 須為 YYYY-MM-DD");

  const dayStart = planDate;
  const dayEnd = new Date(planDate);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const computeStartedAt = new Date();

  let driverIds = args.driverIds ?? [];
  if (driverIds.length === 0) {
    const attendance = await prisma.driverAttendance.findMany({
      where: { workDate: planDate, isOnDuty: true },
      select: { driverId: true },
    });
    driverIds = attendance.map((a) => a.driverId);
  }
  if (driverIds.length === 0) {
    throw new Error("無出勤司機：請先設定當日 driver attendance，或傳入 driverIds");
  }

  const drivers = await prisma.driver.findMany({
    where: { id: { in: driverIds }, isActive: true },
    include: { user: true, vehicle: true },
  });
  if (drivers.length === 0) throw new Error("找不到可用司機");

  const orderWhere =
    args.salesOrderIds && args.salesOrderIds.length > 0
      ? { id: { in: args.salesOrderIds } }
      : {
          status: { notIn: ["completed", "cancelled", "pending_review", "draft"] },
          scheduledDeliveryDate: { gte: dayStart, lt: dayEnd },
          assignments: {
            none: { status: { in: ["assigned", "delivering", "pending_settlement"] } },
          },
        };

  const orders = await prisma.salesOrder.findMany({
    where: orderWhere,
    include: {
      lines: true,
      deliveryAddress: true,
      customer: { include: { addressZone: true } },
      assignments: {
        where: { status: { in: ["assigned", "delivering", "pending_settlement"] } },
        take: 1,
      },
    },
  });

  type Load = {
    driverId: bigint;
    orderCount: number;
    barrelQty: number;
    maxOrderCount: number;
    maxBarrelQty: number;
    familiarZones: Set<string>;
    vehicleId: bigint | null;
    stops: Array<{
      salesOrderId: bigint;
      barrelQty: number;
      explanation: string;
      zoneId: string | null;
      latitude: number | null;
      longitude: number | null;
    }>;
  };

  const loads = new Map<bigint, Load>();
  for (const d of drivers) {
    const existing = await prisma.deliveryAssignment.count({
      where: {
        driverId: d.id,
        assignmentDate: { gte: dayStart, lt: dayEnd },
        status: { in: ["assigned", "delivering", "pending_settlement"] },
      },
    });
    const existingBarrels = await prisma.deliveryAssignment.findMany({
      where: {
        driverId: d.id,
        assignmentDate: { gte: dayStart, lt: dayEnd },
        status: { in: ["assigned", "delivering", "pending_settlement"] },
      },
      include: { salesOrder: { include: { lines: true } } },
    });
    let barrelQty = 0;
    for (const a of existingBarrels) {
      barrelQty += barrelQtyFromLines(a.salesOrder.lines);
    }
    let familiar = new Set<string>();
    const raw = d.familiarZoneIdsJson;
    if (Array.isArray(raw)) {
      familiar = new Set(raw.map((x) => String(x)));
    }
    loads.set(d.id, {
      driverId: d.id,
      orderCount: existing,
      barrelQty,
      maxOrderCount: d.maxOrderCount,
      maxBarrelQty: d.maxBarrelQty,
      familiarZones: familiar,
      vehicleId: d.vehicleId,
      stops: [],
    });
  }

  const unassigned: Array<{ salesOrderId: bigint; reasonCode: string; reasonText: string }> = [];

  const sortedOrders = [...orders].sort((a, b) => {
    const ba = barrelQtyFromLines(a.lines);
    const bb = barrelQtyFromLines(b.lines);
    return bb - ba;
  });

  for (const order of sortedOrders) {
    if (order.assignments.length > 0) {
      unassigned.push({
        salesOrderId: order.id,
        reasonCode: "LOCKED_ASSIGNMENT",
        reasonText: "已有進行中分派",
      });
      continue;
    }
    const geo = order.deliveryAddress.geocodeStatus;
    if (!GEOCODE_OK_STATUSES.has(geo)) {
      unassigned.push({
        salesOrderId: order.id,
        reasonCode: "NO_GEOCODE",
        reasonText: `地址座標狀態為 ${geo}，不可自動正式派單`,
      });
      continue;
    }

    const needBarrels = barrelQtyFromLines(order.lines);
    const zoneId = order.customer.addressZoneId?.toString() ?? null;
    const lat = toCoord(order.deliveryAddress.latitude);
    const lng = toCoord(order.deliveryAddress.longitude);

    let best: { driverId: bigint; score: number; explanation: string } | null = null;
    for (const load of loads.values()) {
      if (load.orderCount + 1 > load.maxOrderCount) continue;
      if (load.barrelQty + needBarrels > load.maxBarrelQty) continue;

      let score = 0;
      const parts: string[] = [];
      if (zoneId && load.familiarZones.has(zoneId)) {
        score += 50;
        parts.push("熟悉該區域");
      } else if (!zoneId && lat != null && lng != null) {
        let minKm: number | null = null;
        for (const st of load.stops) {
          if (st.latitude == null || st.longitude == null) continue;
          const km = haversineKm(lat, lng, st.latitude, st.longitude);
          if (minKm == null || km < minKm) minKm = km;
        }
        score += unzonedProximityScore(minKm, load.stops.length === 0);
        parts.push(minKm != null ? `未分區就近約 ${formatNearKm(minKm)}` : "未分區");
      }
      // 工作量平衡：剩餘容量越大越好
      const remainOrders = load.maxOrderCount - load.orderCount;
      const remainBarrels = load.maxBarrelQty - load.barrelQty;
      score += remainOrders * 2 + Math.min(30, remainBarrels / 5);
      parts.push(`加入後約 ${load.orderCount + 1} 單／${load.barrelQty + needBarrels} 桶`);

      if (order.timeWindowPriority === "required") {
        parts.push("具強制時段（完整路線階段再算 ETA）");
        score += 5;
      }

      if (!best || score > best.score) {
        best = {
          driverId: load.driverId,
          score,
          explanation: parts.join("；"),
        };
      }
    }

    if (!best) {
      unassigned.push({
        salesOrderId: order.id,
        reasonCode: "NO_CAPACITY",
        reasonText: "所有出勤司機皆超過訂單數或桶數上限",
      });
      continue;
    }

    const load = loads.get(best.driverId)!;
    load.orderCount += 1;
    load.barrelQty += needBarrels;
    load.stops.push({
      salesOrderId: order.id,
      barrelQty: needBarrels,
      explanation: `建議派給此司機：${best.explanation}`,
      zoneId,
      latitude: lat,
      longitude: lng,
    });
  }

  const plan = await prisma.$transaction(async (tx) => {
    await discardOpenDrafts(tx, { planDate, shift: "all" });
    const version = await nextPlanVersion(tx, { planDate, shift: "all" });
    const created = await tx.deliveryPlan.create({
      data: {
        planDate,
        shift: "all",
        version,
        status: "draft",
        mode: "suggest_driver",
        algorithmVersion: "rules-suggest-v1",
        weightProfileKey: args.weightProfileKey ?? "weights.v1",
        unassignedCount: unassigned.length,
        createdByUserId: args.actorUserId ?? null,
        computeStartedAt,
        computeFinishedAt: new Date(),
      },
    });

    let seqNo = 1;
    for (const load of loads.values()) {
      if (load.stops.length === 0) continue;
      const route = await tx.deliveryRoute.create({
        data: {
          planId: created.id,
          driverId: load.driverId,
          vehicleId: load.vehicleId,
          sequenceNo: seqNo++,
          totalBarrelQty: load.stops.reduce((s, x) => s + x.barrelQty, 0),
        },
      });
      let stopSeq = 1;
      for (const st of load.stops) {
        await tx.deliveryRouteStop.create({
          data: {
            routeId: route.id,
            salesOrderId: st.salesOrderId,
            stopSequence: stopSeq++,
            aiExplanation: st.explanation,
            hasHardViolation: false,
          },
        });
      }
    }

    for (const u of unassigned) {
      await tx.deliveryPlanUnassigned.create({
        data: {
          planId: created.id,
          salesOrderId: u.salesOrderId,
          reasonCode: u.reasonCode,
          reasonText: u.reasonText,
        },
      });
    }

    return created;
  });

  await writePlanningAudit(prisma, {
    planId: plan.id,
    action: "optimize",
    modelVersion: null,
    promptVersion: "rules-suggest-v1",
    actorUserId: args.actorUserId ?? null,
    inputSummary: {
      planDate: args.planDate,
      orderCount: orders.length,
      driverCount: drivers.length,
      mode: "suggest_driver",
    },
    outputSummary: {
      planId: plan.id.toString(),
      version: plan.version,
      unassignedCount: unassigned.length,
      routedDrivers: [...loads.values()].filter((l) => l.stops.length > 0).length,
    },
  });

  const full = await loadPlan(prisma, plan.id);
  return serializePlanPayload(plan.id, full);
}
