import { toCoord } from "./geoNear.js";
import { DEFAULT_SLA_CONFIG, type SlaConfig } from "./settings.js";
import type { ShiftKey } from "./shiftSla.js";
import {
  classifyPatrolForShift,
  compareShift,
  generalEffectiveLatest,
  parseShiftCode,
  suggestedNextShift,
  ymdFromDbDate,
} from "./shiftSla.js";

export type CandidateTier =
  | "must"
  | "patrol_due"
  | "patrol_late"
  | "general"
  | "patrol_early";

export type ClassifiedOrder = {
  id: bigint;
  orderNo: string;
  orderKind: string;
  tier: CandidateTier;
  barrelQty: number;
  zoneId: string | null;
  zoneName: string | null;
  floor: number | null;
  geocodeOk: boolean;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
  latest: ShiftKey | null;
  explanationHint: string;
  deferTo: ShiftKey | null;
  customerName: string;
  addressLine: string;
  geocodeStatus: string;
  deliveryAddressId: bigint;
  requiredDriverId: bigint | null;
  preferredDriverId: bigint | null;
};

type OrderRow = {
  id: bigint;
  orderNo: string;
  remark: string | null;
  createdAt: Date;
  scheduledDeliveryDate: Date | null;
  orderKind: string | null;
  dispatchPriority: string | null;
  earliestDate: Date | null;
  earliestShift: string | null;
  latestDate: Date | null;
  latestShift: string | null;
  preferredShift: string | null;
  dispatchLocked: boolean;
  preferredDriverId: bigint | null;
  requiredDriverId: bigint | null;
  isReplenishmentLines?: boolean;
  lines: Array<{ qtyOrdered: number; linePurpose: string | null; isReplenishment?: boolean }>;
  deliveryAddress: {
    id: bigint;
    addressLine: string;
    geocodeStatus: string;
    deliveryFloor: number | null;
    latitude?: unknown;
    longitude?: unknown;
  };
  customer: {
    name: string;
    addressZoneId: bigint | null;
    addressZone: { name: string } | null;
  };
  assignments: Array<{ id: bigint }>;
};

export function barrelQtyFromLines(
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

function inferKind(o: OrderRow): string {
  if (o.orderKind) return o.orderKind;
  if ((o.remark ?? "").startsWith("【週期巡查】")) return "patrol";
  if (o.lines.some((l) => l.isReplenishment)) return "replenishment";
  return "general";
}

function resolveLatest(o: OrderRow, kind: string, sla: SlaConfig): ShiftKey | null {
  const ld = ymdFromDbDate(o.latestDate);
  const ls = parseShiftCode(o.latestShift);
  const stored = ld && ls ? { date: ld, shift: ls } : null;
  if (kind === "patrol") {
    const due = ymdFromDbDate(o.scheduledDeliveryDate);
    if (!due) return null;
    return { date: due, shift: "pm" }; // 到期日當天最晚班；真正 overdue 用 classifyPatrol
  }
  return generalEffectiveLatest(
    o.createdAt,
    ymdFromDbDate(o.scheduledDeliveryDate),
    stored,
    sla.generalShifts,
    sla.afterScheduledShifts,
  );
}

export function classifyOrder(
  o: OrderRow,
  target: ShiftKey,
  sla: SlaConfig = DEFAULT_SLA_CONFIG,
): ClassifiedOrder | null {
  if (o.assignments.length > 0) return null;

  const kind = inferKind(o);
  const geo = o.deliveryAddress.geocodeStatus;
  const geocodeOk = geo === "ok" || geo === "manual_confirmed";
  const zoneId = o.customer.addressZoneId?.toString() ?? null;
  const latest = resolveLatest(o, kind, sla);
  const preferred = o.preferredShift === "any" ? null : parseShiftCode(o.preferredShift);
  const locked = Boolean(o.dispatchLocked);
  const pri = (o.dispatchPriority ?? "").toLowerCase();
  const isMustPri = pri === "must" || pri === "urgent" || kind === "emergency" || kind === "replenishment";

  let tier: CandidateTier | null = null;
  let explanationHint = "";
  let deferTo: ShiftKey | null = suggestedNextShift(target);

  if (kind === "patrol") {
    const due = ymdFromDbDate(o.scheduledDeliveryDate);
    if (!due) return null;
    const cls = classifyPatrolForShift(due, target, sla.patrolEarlyShifts, sla.patrolLateShifts);
    if (cls === "out") return null;
    if (cls === "overdue" || locked || isMustPri) {
      tier = "must";
      explanationHint = cls === "overdue" ? "逾期巡單，本班必送" : "巡單必送";
    } else if (cls === "on_due") {
      tier = "patrol_due";
      explanationHint = "今日到期巡單";
    } else if (cls === "late") {
      tier = "patrol_late";
      explanationHint = `巡單延後 ${sla.patrolLateShifts} 班內`;
    } else if (cls === "early") {
      tier = "patrol_early";
      explanationHint = `可提前 ${sla.patrolEarlyShifts} 班之巡單`;
    }
  } else {
    if (preferred && preferred !== target.shift && !locked && !isMustPri) {
      // 指定另一班
      return null;
    }
    if (locked || isMustPri || (preferred && preferred === target.shift)) {
      tier = "must";
      explanationHint = locked ? "人工鎖定必送" : isMustPri ? "緊急／補送" : "指定本班";
    } else if (latest && compareShift(target, latest) > 0) {
      tier = "must";
      explanationHint = "已逾最晚應送班次";
    } else if (latest && compareShift(target, latest) === 0) {
      tier = "general";
      explanationHint = "本班為最晚應送";
    } else if (!latest || compareShift(target, latest) <= 0) {
      const earliestDate = ymdFromDbDate(o.earliestDate);
      const earliestShift = parseShiftCode(o.earliestShift);
      if (earliestDate && earliestShift && compareShift(target, { date: earliestDate, shift: earliestShift }) < 0) {
        return null;
      }
      const sched = ymdFromDbDate(o.scheduledDeliveryDate);
      if (sched && sched > target.date && !o.latestDate) {
        // 只填了未來預定日、尚未算 SLA：不當本班候選
        if (sched !== target.date) return null;
      }
      tier = "general";
      explanationHint = "一般訂單（成立時間／SLA）";
    }
  }

  if (!tier) return null;

  return {
    id: o.id,
    orderNo: o.orderNo,
    orderKind: kind,
    tier,
    barrelQty: barrelQtyFromLines(o.lines),
    zoneId,
    zoneName: o.customer.addressZone?.name ?? null,
    floor: o.deliveryAddress.deliveryFloor,
    geocodeOk,
    latitude: toCoord(o.deliveryAddress.latitude),
    longitude: toCoord(o.deliveryAddress.longitude),
    createdAt: o.createdAt,
    latest,
    explanationHint,
    deferTo,
    customerName: o.customer.name,
    addressLine: o.deliveryAddress.addressLine,
    geocodeStatus: geo,
    deliveryAddressId: o.deliveryAddress.id,
    requiredDriverId: o.requiredDriverId,
    preferredDriverId: o.preferredDriverId,
  };
}

export function sortForInsert(a: ClassifiedOrder, b: ClassifiedOrder): number {
  const tierRank: Record<CandidateTier, number> = {
    must: 0,
    patrol_due: 1,
    patrol_late: 2,
    general: 3,
    patrol_early: 4,
  };
  const tr = tierRank[a.tier] - tierRank[b.tier];
  if (tr !== 0) return tr;
  if (a.latest && b.latest) {
    const c = compareShift(a.latest, b.latest);
    if (c !== 0) return c;
  } else if (a.latest && !b.latest) return -1;
  else if (!a.latest && b.latest) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
