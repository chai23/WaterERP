import type { Prisma, PrismaClient } from "@prisma/client";
import { barrelQtyFromLines, classifyOrder } from "./selectCandidates.js";
import { loadPlanningSettings, shiftCutoffAt, slaConfigFromSettings } from "./settings.js";
import { parseYmd, type ShiftCode, type ShiftKey, ymdFromDbDate } from "./shiftSla.js";

const ACTIVE_ASSIGNMENT = ["assigned", "delivering", "pending_settlement"] as const;

function addDaysDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function inferKind(orderKind: string | null, remark: string | null, hasReplenishment: boolean): string {
  if (orderKind) return orderKind;
  if ((remark ?? "").startsWith("【週期巡查】")) return "patrol";
  if (hasReplenishment) return "replenishment";
  return "general";
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type ZoneLoad = { zoneId: string | null; zoneName: string; orderCount: number; barrelQty: number };

function addZoneLoad(
  map: Map<string, ZoneLoad>,
  zoneId: string | null,
  zoneName: string | null | undefined,
  barrelQty: number,
) {
  const key = zoneId ?? "none";
  const cur = map.get(key) ?? {
    zoneId,
    zoneName: (zoneName ?? "").trim() || "未分區",
    orderCount: 0,
    barrelQty: 0,
  };
  cur.orderCount += 1;
  cur.barrelQty += barrelQty;
  map.set(key, cur);
}

function zoneLoadsFromMap(map: Map<string, ZoneLoad>): ZoneLoad[] {
  return [...map.values()].sort((a, b) => b.orderCount - a.orderCount || a.zoneName.localeCompare(b.zoneName, "zh-Hant"));
}

function parseFamiliarIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x)).filter((x) => /^\d+$/.test(x)))];
}

export type ShiftBoardZoneFilter = "all" | "none" | bigint;

export function parseZoneFilter(raw: unknown): ShiftBoardZoneFilter {
  if (raw == null || raw === "" || raw === "all") return "all";
  if (raw === "none" || raw === "unspecified") return "none";
  const s = String(raw).trim();
  if (s === "all") return "all";
  if (s === "none") return "none";
  if (!/^\d+$/.test(s)) return "all";
  return BigInt(s);
}

export async function listShiftBoard(
  prisma: PrismaClient,
  args: {
    planDate: string;
    shift: ShiftCode;
    zone: ShiftBoardZoneFilter;
  },
) {
  const planDate = parseYmd(args.planDate);
  if (!planDate) throw new Error("planDate 須為 YYYY-MM-DD");
  const target: ShiftKey = { date: args.planDate, shift: args.shift };
  const dayStart = planDate;
  const dayEnd = addDaysDate(planDate, 1);
  const windowStart = addDaysDate(planDate, -21);
  const windowEnd = addDaysDate(planDate, 14);

  const zoneWhere: Prisma.SalesOrderWhereInput =
    args.zone === "all"
      ? {}
      : args.zone === "none"
        ? { customer: { addressZoneId: null } }
        : { customer: { addressZoneId: args.zone } };

  const settings = await loadPlanningSettings(prisma);
  const sla = slaConfigFromSettings(settings);

  const include = {
    lines: true,
    deliveryAddress: true,
    customer: { include: { addressZone: true } },
    assignments: {
      where: { status: { in: [...ACTIVE_ASSIGNMENT] } },
      include: { driver: { include: { user: true } } },
      take: 3,
      orderBy: { id: "desc" as const },
    },
  } satisfies Prisma.SalesOrderInclude;

  const [openRows, assignedRows] = await Promise.all([
    prisma.salesOrder.findMany({
      where: {
        status: { notIn: ["completed", "cancelled", "pending_review", "draft"] },
        assignments: { none: { status: { in: [...ACTIVE_ASSIGNMENT] } } },
        ...zoneWhere,
        OR: [
          { scheduledDeliveryDate: { gte: windowStart, lt: windowEnd } },
          { scheduledDeliveryDate: null, createdAt: { gte: windowStart } },
          { latestDate: { gte: windowStart, lte: windowEnd } },
          { dispatchLocked: true },
        ],
      },
      include,
      orderBy: [{ scheduledDeliveryDate: "asc" }, { id: "asc" }],
      take: 400,
    }),
    prisma.salesOrder.findMany({
      where: {
        status: { notIn: ["completed", "cancelled", "pending_review", "draft"] },
        ...zoneWhere,
        assignments: {
          some: {
            status: { in: [...ACTIVE_ASSIGNMENT] },
            assignmentDate: { gte: dayStart, lt: dayEnd },
          },
        },
      },
      include,
      orderBy: [{ id: "desc" }],
      take: 400,
    }),
  ]);

  const seen = new Set<string>();
  const orders: Array<Record<string, unknown>> = [];

  const pushRow = (
    o: (typeof openRows)[number],
    assignStatus: "unassigned" | "assigned",
  ) => {
    const idStr = o.id.toString();
    if (seen.has(idStr)) return;
    seen.add(idStr);
    const hasRepl = o.lines.some((l) => l.isReplenishment);
    const kind = inferKind(o.orderKind, o.remark, hasRepl);
    const classified =
      assignStatus === "unassigned"
        ? classifyOrder(
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
          )
        : null;
    const active = o.assignments[0] ?? null;
    const sameShift =
      !active ||
      !active.assignmentShift ||
      active.assignmentShift === args.shift;
    orders.push({
      id: idStr,
      orderNo: o.orderNo,
      status: o.status,
      orderKind: kind,
      dispatchPriority: o.dispatchPriority,
      dispatchLocked: o.dispatchLocked,
      remark: o.remark,
      scheduledDeliveryDate: ymdFromDbDate(o.scheduledDeliveryDate),
      latestDate: ymdFromDbDate(o.latestDate),
      latestShift: o.latestShift,
      barrelQty: barrelQtyFromLines(o.lines),
      customerName: o.customer.name,
      customerCode: o.customer.customerCode ?? null,
      addressLine: o.deliveryAddress.addressLine,
      deliveryAddressId: o.deliveryAddress.id.toString(),
      geocodeStatus: o.deliveryAddress.geocodeStatus,
      latitude: toNum(o.deliveryAddress.latitude),
      longitude: toNum(o.deliveryAddress.longitude),
      zoneId: o.customer.addressZoneId?.toString() ?? null,
      zoneName: o.customer.addressZone?.name ?? null,
      assignStatus,
      eligible: Boolean(classified),
      must: classified?.tier === "must",
      geocodeOk: Boolean(classified?.geocodeOk ?? (o.deliveryAddress.geocodeStatus === "ok" || o.deliveryAddress.geocodeStatus === "manual_confirmed")),
      tier: classified?.tier ?? null,
      explanationHint: classified?.explanationHint ?? null,
      assignment: active
        ? {
            id: active.id.toString(),
            status: active.status,
            assignmentDate: ymdFromDbDate(active.assignmentDate),
            assignmentShift: active.assignmentShift,
            sameShift,
            driverId: active.driverId.toString(),
            driverName: active.driver?.user?.name ?? null,
          }
        : null,
    });
  };

  for (const o of openRows) pushRow(o, "unassigned");
  for (const o of assignedRows) pushRow(o, "assigned");

  const unassigned = orders.filter((x) => x.assignStatus === "unassigned");
  const assigned = orders.filter((x) => x.assignStatus === "assigned");
  const eligible = unassigned.filter((x) => x.eligible);
  const mustRows = eligible.filter((x) => x.must);
  const mustMissingGeo = mustRows.filter((x) => !x.geocodeOk);
  const missingGeo = unassigned.filter((x) => !x.geocodeOk);

  const zoneMap = new Map<
    string,
    { zoneId: string | null; zoneName: string; unassigned: number; assigned: number; must: number; missingGeo: number }
  >();
  for (const o of orders) {
    const key = String(o.zoneId ?? "none");
    let z = zoneMap.get(key);
    if (!z) {
      z = {
        zoneId: typeof o.zoneId === "string" ? o.zoneId : null,
        zoneName: typeof o.zoneName === "string" && o.zoneName ? o.zoneName : "未分區",
        unassigned: 0,
        assigned: 0,
        must: 0,
        missingGeo: 0,
      };
      zoneMap.set(key, z);
    }
    if (o.assignStatus === "assigned") z.assigned += 1;
    else {
      z.unassigned += 1;
      if (o.must) z.must += 1;
      if (!o.geocodeOk) z.missingGeo += 1;
    }
  }

  const cutoff = shiftCutoffAt(args.planDate, args.shift, settings);

  const driverRows = await prisma.driver.findMany({
    where: { isActive: true },
    include: { user: true, vehicle: true },
    orderBy: { id: "asc" },
  });
  const attendanceRows = await prisma.driverAttendance.findMany({
    where: { workDate: planDate, shift: { in: [args.shift, "all"] } },
  });
  const attByDriver = new Map<string, (typeof attendanceRows)[number]>();
  for (const a of attendanceRows) {
    const key = a.driverId.toString();
    const prev = attByDriver.get(key);
    if (!prev || a.shift === args.shift) attByDriver.set(key, a);
  }
  const assignmentRows = await prisma.deliveryAssignment.findMany({
    where: {
      assignmentDate: { gte: dayStart, lt: dayEnd },
      status: { in: [...ACTIVE_ASSIGNMENT] },
      OR: [{ assignmentShift: args.shift }, { assignmentShift: null }],
    },
    select: { driverId: true, salesOrderId: true },
  });
  const assignedOrderIds = [...new Set(assignmentRows.map((a) => a.salesOrderId))];
  const assignedOrders =
    assignedOrderIds.length > 0
      ? await prisma.salesOrder.findMany({
          where: { id: { in: assignedOrderIds } },
          include: { lines: true, customer: { include: { addressZone: true } } },
        })
      : [];
  const assignedOrderById = new Map(assignedOrders.map((o) => [o.id.toString(), o]));
  const loadByDriver = new Map<string, { orderCount: number; barrelQty: number; zones: Map<string, ZoneLoad> }>();
  for (const a of assignmentRows) {
    const so = assignedOrderById.get(a.salesOrderId.toString());
    if (!so) continue;
    const key = a.driverId.toString();
    const cur = loadByDriver.get(key) ?? { orderCount: 0, barrelQty: 0, zones: new Map() };
    const qty = barrelQtyFromLines(so.lines);
    cur.orderCount += 1;
    cur.barrelQty += qty;
    addZoneLoad(
      cur.zones,
      so.customer.addressZoneId?.toString() ?? null,
      so.customer.addressZone?.name,
      qty,
    );
    loadByDriver.set(key, cur);
  }

  const draft = await prisma.deliveryPlan.findFirst({
    where: { planDate, shift: args.shift, status: { in: ["draft", "pending_review"] } },
    orderBy: { version: "desc" },
    include: {
      routes: {
        include: {
          stops: { select: { salesOrderId: true } },
        },
      },
    },
  });
  const draftOrderIds = [
    ...new Set((draft?.routes ?? []).flatMap((r) => r.stops.map((s) => s.salesOrderId))),
  ];
  const draftOrders =
    draftOrderIds.length > 0
      ? await prisma.salesOrder.findMany({
          where: { id: { in: draftOrderIds } },
          include: { lines: true, customer: { include: { addressZone: true } } },
        })
      : [];
  const draftOrderById = new Map(draftOrders.map((o) => [o.id.toString(), o]));
  const plannedByDriver = new Map<string, Map<string, ZoneLoad>>();
  for (const route of draft?.routes ?? []) {
    const key = route.driverId.toString();
    const zones = plannedByDriver.get(key) ?? new Map();
    for (const stop of route.stops) {
      const so = draftOrderById.get(stop.salesOrderId.toString());
      if (!so) continue;
      addZoneLoad(
        zones,
        so.customer.addressZoneId?.toString() ?? null,
        so.customer.addressZone?.name,
        barrelQtyFromLines(so.lines),
      );
    }
    plannedByDriver.set(key, zones);
  }

  const zoneNameById = new Map(
    (await prisma.addressZone.findMany({ select: { id: true, name: true } })).map((z) => [
      z.id.toString(),
      z.name,
    ]),
  );

  const drivers = driverRows.map((d) => {
    const id = d.id.toString();
    const att = attByDriver.get(id);
    const load = loadByDriver.get(id) ?? { orderCount: 0, barrelQty: 0, zones: new Map<string, ZoneLoad>() };
    const onDuty = att?.isOnDuty === true;
    const overload =
      onDuty && (load.orderCount >= d.maxOrderCount || load.barrelQty >= d.maxBarrelQty);
    const familiarZones = parseFamiliarIds(d.familiarZoneIdsJson).map((zoneId) => ({
      zoneId,
      zoneName: zoneNameById.get(zoneId) ?? `區域#${zoneId}`,
    }));
    return {
      driverId: id,
      name: d.user?.name ?? `司機#${id}`,
      plateNo: d.vehicle?.plateNo ?? null,
      maxOrderCount: d.maxOrderCount,
      maxBarrelQty: d.maxBarrelQty,
      onDuty,
      leave: att?.isOnDuty === false,
      orderCount: load.orderCount,
      barrelQty: load.barrelQty,
      overload,
      zones: zoneLoadsFromMap(load.zones),
      plannedZones: zoneLoadsFromMap(plannedByDriver.get(id) ?? new Map()),
      familiarZones,
    };
  });

  return {
    planDate: args.planDate,
    shift: args.shift,
    zone: args.zone === "all" || args.zone === "none" ? args.zone : args.zone.toString(),
    total: orders.length,
    unassignedCount: unassigned.length,
    assignedCount: assigned.length,
    eligibleCount: eligible.length,
    summary: {
      cutoff: cutoff
        ? { label: cutoff.label, ymd: cutoff.ymd, hm: cutoff.hm, passed: cutoff.passed }
        : null,
      mustUnassigned: mustRows.length,
      mustMissingGeo: mustMissingGeo.length,
      mustMissingGeoOrderNos: mustMissingGeo.map((x) => String(x.orderNo)),
      eligibleUnassigned: eligible.length,
      assignedThisShift: assigned.length,
      missingGeoUnassigned: missingGeo.length,
      overloadDrivers: drivers.filter((d) => d.overload).length,
      sla,
      zones: [...zoneMap.values()].sort((a, b) => b.must - a.must || b.unassigned - a.unassigned),
      drivers,
    },
    orders,
  };
}
