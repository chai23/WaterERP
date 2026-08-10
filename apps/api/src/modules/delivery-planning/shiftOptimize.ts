import type { PrismaClient } from "@prisma/client";
import { GEOCODE_OK_STATUSES } from "./flag.js";
import { writePlanningAudit } from "./audit.js";
import { loadPlan, serializePlanPayload } from "./suggestOptimize.js";
import {
  classifyOrder,
  sortForInsert,
  type ClassifiedOrder,
  type CandidateTier,
} from "./selectCandidates.js";
import { formatNearKm, haversineKm, unzonedProximityScore } from "./geoNear.js";
import { discardOpenDrafts, nextPlanVersion } from "./planDraft.js";
import { assertShiftNotPastCutoff, loadPlanningSettings, slaConfigFromSettings } from "./settings.js";
import {
  parseYmd,
  shiftMinutes,
  suggestedNextShift,
  type ShiftCode,
  type ShiftKey,
} from "./shiftSla.js";

function parseLocalYmd(ymd: string): Date | null {
  return parseYmd(ymd);
}

function addDaysDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function serviceMinutes(order: ClassifiedOrder): number {
  const floor = order.floor != null && order.floor > 1 ? order.floor - 1 : 0;
  return 10 + order.barrelQty * 2 + Math.round(floor * 1.5);
}

type RouteDraft = {
  driverId: bigint;
  vehicleId: bigint | null;
  maxOrderCount: number;
  maxBarrelQty: number;
  familiarZones: Set<string>;
  runZones: Set<string>;
  otherShiftLoad: number;
  stops: ClassifiedOrder[];
  barrelQty: number;
  minutes: number;
};

function hasCoords(o: { latitude: number | null; longitude: number | null }): boolean {
  return o.latitude != null && o.longitude != null;
}

function nearestStopKm(route: RouteDraft, order: ClassifiedOrder, excludeId?: bigint): number | null {
  if (!hasCoords(order)) return null;
  let min = Infinity;
  for (const st of route.stops) {
    if (excludeId != null && st.id === excludeId) continue;
    if (!hasCoords(st)) continue;
    min = Math.min(min, haversineKm(order.latitude!, order.longitude!, st.latitude!, st.longitude!));
  }
  return Number.isFinite(min) ? min : null;
}

function nearestStopIndex(route: RouteDraft, order: ClassifiedOrder): number | null {
  if (!hasCoords(order)) return null;
  let bestIdx: number | null = null;
  let bestKm = Infinity;
  for (let i = 0; i < route.stops.length; i++) {
    const st = route.stops[i];
    if (!hasCoords(st)) continue;
    const km = haversineKm(order.latitude!, order.longitude!, st.latitude!, st.longitude!);
    if (km < bestKm) {
      bestKm = km;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function stopExplanation(route: RouteDraft, st: ClassifiedOrder): string {
  const parts = [st.explanationHint];
  if (st.zoneName) {
    parts.push(st.zoneName);
  } else if (hasCoords(st)) {
    const km = nearestStopKm(route, st, st.id);
    parts.push(km != null ? `未分區就近約 ${formatNearKm(km)}` : "未分區");
  } else {
    parts.push("未分區");
  }
  parts.push(`約 ${st.barrelQty} 桶`);
  return parts.join("；");
}

function routeScore(route: RouteDraft, order: ClassifiedOrder): number {
  let s = 0;
  if (order.zoneId) {
    if (route.runZones.size > 0) {
      s += route.runZones.has(order.zoneId) ? 90 : -40;
    }
    if (route.familiarZones.has(order.zoneId)) s += 40;
    const majority = majorityZone(route);
    if (majority && order.zoneId === majority) s += 30;
  } else if (hasCoords(order)) {
    s += unzonedProximityScore(nearestStopKm(route, order), route.stops.length === 0);
  }
  if (route.stops.length === 0) s += 5;
  s += Math.max(0, 20 - route.stops.length);
  s -= route.otherShiftLoad * 2;
  return s;
}

function majorityZone(route: RouteDraft): string | null {
  const counts = new Map<string, number>();
  for (const st of route.stops) {
    if (!st.zoneId) continue;
    counts.set(st.zoneId, (counts.get(st.zoneId) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [z, c] of counts) {
    if (c > n) {
      best = z;
      n = c;
    }
  }
  return best;
}

function canFit(route: RouteDraft, order: ClassifiedOrder, capMinutes: number): boolean {
  if (route.stops.length + 1 > route.maxOrderCount) return false;
  if (route.barrelQty + order.barrelQty > route.maxBarrelQty) return false;
  if (route.minutes + 12 + serviceMinutes(order) > capMinutes) return false;
  if (order.requiredDriverId && order.requiredDriverId !== route.driverId) return false;
  return true;
}

function commitAdd(route: RouteDraft, order: ClassifiedOrder): void {
  const nearIdx = !order.zoneId && hasCoords(order) ? nearestStopIndex(route, order) : null;
  if (nearIdx == null) route.stops.push(order);
  else route.stops.splice(nearIdx + 1, 0, order);
  route.barrelQty += order.barrelQty;
  route.minutes += 12 + serviceMinutes(order);
}

function bestRoute(routes: RouteDraft[], order: ClassifiedOrder, capMinutes: number): RouteDraft | null {
  let best: { route: RouteDraft; score: number } | null = null;
  for (const r of routes) {
    if (!canFit(r, order, capMinutes)) continue;
    const score = routeScore(r, order);
    if (!best || score > best.score) best = { route: r, score };
  }
  return best?.route ?? null;
}

function canAutoDefer(tier: CandidateTier): boolean {
  return tier === "patrol_early" || tier === "general";
}

/**
 * 班次一鍵排程：必送 → 到期／延後巡單 → 一般 SLA → 可提前巡單。
 * 分區作骨架；未分區且有座標則直線就近併入已排站點。司機不綁死。
 */
export async function optimizeShiftOneClick(
  prisma: PrismaClient,
  args: {
    planDate: string;
    shift: ShiftCode;
    driverIds?: bigint[];
    salesOrderIds?: bigint[];
    zoneId?: bigint | null;
    driverZones?: Record<string, string[]>;
    actorUserId?: bigint | null;
  },
) {
  const planDate = parseLocalYmd(args.planDate);
  if (!planDate) throw new Error("planDate 須為 YYYY-MM-DD");
  const settings = await loadPlanningSettings(prisma);
  const sla = slaConfigFromSettings(settings);
  assertShiftNotPastCutoff(args.planDate, args.shift, settings);
  const target: ShiftKey = { date: args.planDate, shift: args.shift };
  const capMinutes = shiftMinutes(args.shift);
  const computeStartedAt = new Date();

  const dayStart = planDate;
  const dayEnd = addDaysDate(planDate, 1);
  const windowStart = addDaysDate(planDate, -21);
  const windowEnd = addDaysDate(planDate, 14);

  let driverIds = args.driverIds ?? [];
  if (driverIds.length === 0) {
    const attendance = await prisma.driverAttendance.findMany({
      where: {
        workDate: planDate,
        isOnDuty: true,
        shift: { in: [args.shift, "all"] },
      },
      select: { driverId: true },
    });
    driverIds = [...new Set(attendance.map((a) => a.driverId))];
  }
  if (driverIds.length === 0) {
    throw new Error("無該班出勤司機：請先標記上午／下午出勤，或傳入 driverIds");
  }

  const drivers = await prisma.driver.findMany({
    where: { id: { in: driverIds }, isActive: true },
    include: { user: true, vehicle: true },
  });
  if (drivers.length === 0) throw new Error("找不到可用司機");

  const otherShiftAssignments = await prisma.deliveryAssignment.findMany({
    where: {
      driverId: { in: drivers.map((d) => d.id) },
      assignmentDate: { gte: dayStart, lt: dayEnd },
      status: { in: ["assigned", "delivering", "pending_settlement"] },
    },
    select: { driverId: true },
  });
  const otherLoad = new Map<bigint, number>();
  for (const a of otherShiftAssignments) {
    otherLoad.set(a.driverId, (otherLoad.get(a.driverId) ?? 0) + 1);
  }

  const zoneFilter =
    args.zoneId === undefined
      ? {}
      : args.zoneId === null
        ? { customer: { addressZoneId: null } }
        : { customer: { addressZoneId: args.zoneId } };
  const idFilter =
    args.salesOrderIds && args.salesOrderIds.length > 0 ? { id: { in: args.salesOrderIds } } : {};

  const orders = await prisma.salesOrder.findMany({
    where: {
      status: { notIn: ["completed", "cancelled", "pending_review", "draft"] },
      assignments: { none: { status: { in: ["assigned", "delivering", "pending_settlement"] } } },
      ...zoneFilter,
      ...idFilter,
      OR: [
        { scheduledDeliveryDate: { gte: windowStart, lt: windowEnd } },
        { scheduledDeliveryDate: null, createdAt: { gte: windowStart } },
        { latestDate: { gte: windowStart, lte: windowEnd } },
        { dispatchLocked: true },
      ],
    },
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

  const classified: ClassifiedOrder[] = [];
  for (const o of orders) {
    const c = classifyOrder(
      {
        ...o,
        orderKind: o.orderKind ?? null,
        dispatchPriority: o.dispatchPriority ?? null,
        earliestDate: o.earliestDate ?? null,
        earliestShift: o.earliestShift ?? null,
        latestDate: o.latestDate ?? null,
        latestShift: o.latestShift ?? null,
        preferredShift: o.preferredShift ?? null,
        dispatchLocked: o.dispatchLocked ?? false,
        preferredDriverId: o.preferredDriverId ?? null,
        requiredDriverId: o.requiredDriverId ?? null,
      },
      target,
      sla,
    );
    if (c) classified.push(c);
  }

  classified.sort(sortForInsert);

  const routes: RouteDraft[] = drivers.map((d) => {
    let familiar = new Set<string>();
    const raw = d.familiarZoneIdsJson;
    if (Array.isArray(raw)) familiar = new Set(raw.map((x) => String(x)));
    const run = new Set((args.driverZones?.[d.id.toString()] ?? []).map(String).filter((x) => /^\d+$/.test(x)));
    return {
      driverId: d.id,
      vehicleId: d.vehicleId,
      maxOrderCount: d.maxOrderCount,
      maxBarrelQty: d.maxBarrelQty,
      familiarZones: familiar,
      runZones: run,
      otherShiftLoad: otherLoad.get(d.id) ?? 0,
      stops: [],
      barrelQty: 0,
      minutes: 0,
    };
  });

  const unassigned: Array<{
    salesOrderId: bigint;
    reasonCode: string;
    reasonText: string;
    order: ClassifiedOrder;
  }> = [];

  for (const order of classified) {
    if (!order.geocodeOk || !GEOCODE_OK_STATUSES.has(order.geocodeStatus)) {
      unassigned.push({
        salesOrderId: order.id,
        reasonCode: "NO_GEOCODE",
        reasonText: `地址座標狀態為 ${order.geocodeStatus}，不可自動正式派單`,
        order,
      });
      continue;
    }

    const dest = order.requiredDriverId
      ? routes.find((r) => r.driverId === order.requiredDriverId) ?? null
      : bestRoute(routes, order, capMinutes);

    if (dest && canFit(dest, order, capMinutes)) {
      commitAdd(dest, order);
      continue;
    }

    if (!canAutoDefer(order.tier)) {
      unassigned.push({
        salesOrderId: order.id,
        reasonCode: "NO_CAPACITY",
        reasonText: `必送／到期單無法排入本班（${order.explanationHint}）。請加開司機或人工處理。`,
        order,
      });
      continue;
    }

    const next = suggestedNextShift(target);
    unassigned.push({
      salesOrderId: order.id,
      reasonCode: "DEFER_NEXT_SHIFT",
      reasonText: `${order.explanationHint}；本班容量不足，建議改排 ${next.date} ${next.shift === "am" ? "上午" : "下午"}`,
      order,
    });
  }

  const plan = await prisma.$transaction(async (tx) => {
    await discardOpenDrafts(tx, { planDate, shift: args.shift });
    const version = await nextPlanVersion(tx, { planDate, shift: args.shift });
    const created = await tx.deliveryPlan.create({
      data: {
        planDate,
        shift: args.shift,
        version,
        status: "draft",
        mode: "shift_one_click",
        algorithmVersion: "shift-one-click-v1.1",
        weightProfileKey: "weights.v1",
        unassignedCount: unassigned.length,
        createdByUserId: args.actorUserId ?? null,
        computeStartedAt,
        computeFinishedAt: new Date(),
      },
    });

    let seqNo = 1;
    for (const r of routes) {
      if (r.stops.length === 0) continue;
      const route = await tx.deliveryRoute.create({
        data: {
          planId: created.id,
          driverId: r.driverId,
          vehicleId: r.vehicleId,
          sequenceNo: seqNo++,
          totalBarrelQty: r.barrelQty,
          totalDriveMinutes: r.minutes,
        },
      });
      let stopSeq = 1;
      for (const st of r.stops) {
        await tx.deliveryRouteStop.create({
          data: {
            routeId: route.id,
            salesOrderId: st.id,
            stopSequence: stopSeq++,
            aiExplanation: stopExplanation(r, st),
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
    promptVersion: "shift-one-click-v1.1",
    actorUserId: args.actorUserId ?? null,
    inputSummary: {
      planDate: args.planDate,
      shift: args.shift,
      driverCount: drivers.length,
      candidateCount: classified.length,
      salesOrderIds: args.salesOrderIds?.map((x) => x.toString()) ?? null,
      zoneId: args.zoneId === undefined ? null : args.zoneId === null ? "none" : args.zoneId.toString(),
      mode: "shift_one_click",
    },
    outputSummary: {
      planId: plan.id.toString(),
      version: plan.version,
      unassignedCount: unassigned.length,
      routed: routes.filter((r) => r.stops.length > 0).length,
    },
  });

  const full = await loadPlan(prisma, plan.id);
  return serializePlanPayload(plan.id, full);
}
