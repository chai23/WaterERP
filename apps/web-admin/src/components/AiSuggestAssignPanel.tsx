import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { driverIsActive, fmtLocalYmd, geocodeStatusMeta, type Driver } from "../adminUtils";
import AddressGeocodePanel from "./AddressGeocodePanel";

type ShiftCode = "am" | "pm";

type PlanPayload = {
  plan: {
    id: string;
    planDate: string;
    shift?: string;
    version: number;
    status: string;
    mode: string;
    unassignedCount: number;
  };
  routes: Array<{
    id: string;
    driverId: string;
    vehicleId: string | null;
    totalBarrelQty: number;
    totalDriveMinutes?: number | null;
    stops: Array<{
      id: string;
      salesOrderId: string;
      stopSequence: number;
      aiExplanation: string | null;
      hasHardViolation: boolean;
      orderNo: string;
      orderKind?: string;
      dispatchPriority?: string | null;
      dispatchLocked?: boolean;
      addressLine: string;
      geocodeStatus: string;
      barrelQty: number;
      customerName: string;
      zoneName: string | null;
    }>;
  }>;
  unassigned: Array<{
    salesOrderId: string;
    reasonCode: string;
    reasonText: string | null;
    orderNo: string;
    orderKind?: string;
    dispatchPriority?: string | null;
    dispatchLocked?: boolean;
    addressLine: string;
    geocodeStatus: string;
    deliveryAddressId: string;
  }>;
};

type BoardOrder = {
  id: string;
  orderNo: string;
  status: string;
  orderKind: string;
  dispatchPriority?: string | null;
  dispatchLocked?: boolean;
  scheduledDeliveryDate: string | null;
  latestDate: string | null;
  latestShift: string | null;
  barrelQty: number;
  customerName: string;
  customerCode?: string | null;
  addressLine: string;
  deliveryAddressId: string;
  geocodeStatus: string;
  latitude?: number | null;
  longitude?: number | null;
  zoneId: string | null;
  zoneName: string | null;
  assignStatus: "unassigned" | "assigned";
  eligible: boolean;
  must?: boolean;
  geocodeOk?: boolean;
  tier: string | null;
  explanationHint: string | null;
  assignment: {
    id: string;
    status: string;
    assignmentDate: string | null;
    assignmentShift: string | null;
    sameShift: boolean;
    driverId: string;
    driverName: string | null;
  } | null;
};

type PlanningSla = {
  generalShifts: number;
  patrolEarlyShifts: number;
  patrolLateShifts: number;
  afterScheduledShifts: number | null;
};

type PlanningCutoff = {
  am: string;
  pm: string;
};

type ShiftSummary = {
  cutoff: { label: string; ymd: string; hm: string; passed: boolean } | null;
  mustUnassigned: number;
  mustMissingGeo: number;
  mustMissingGeoOrderNos: string[];
  eligibleUnassigned: number;
  assignedThisShift: number;
  missingGeoUnassigned: number;
  overloadDrivers: number;
  sla?: PlanningSla;
  zones: Array<{
    zoneId: string | null;
    zoneName: string;
    unassigned: number;
    assigned: number;
    must: number;
    missingGeo: number;
  }>;
  drivers: Array<{
    driverId: string;
    name: string;
    plateNo: string | null;
    maxOrderCount: number;
    maxBarrelQty: number;
    onDuty: boolean;
    leave: boolean;
    orderCount: number;
    barrelQty: number;
    overload: boolean;
    zones?: Array<{ zoneId: string | null; zoneName: string; orderCount: number; barrelQty: number }>;
    plannedZones?: Array<{ zoneId: string | null; zoneName: string; orderCount: number; barrelQty: number }>;
    familiarZones?: Array<{ zoneId: string; zoneName: string }>;
  }>;
};

type RosterRow = {
  driverId: string;
  name: string;
  plateNo: string | null;
  maxOrderCount: number;
  maxBarrelQty: number;
  status: "unset" | "on" | "off";
  note: string | null;
  runZoneIds?: string[] | null;
};

type AssignFilter = "all" | "unassigned" | "assigned";
type KindFilter = "all" | "general" | "patrol" | "replenishment" | "emergency";
type EligibleFilter = "all" | "eligible" | "other";
type GeoFilter = "all" | "ok" | "missing";

function nextBusinessYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!, 12, 0, 0);
  dt.setDate(dt.getDate() + 1);
  while (dt.getDay() === 0) dt.setDate(dt.getDate() + 1);
  return fmtLocalYmd(dt);
}

function defaultTarget(): { date: string; shift: ShiftCode } {
  const now = new Date();
  const today = fmtLocalYmd(now);
  if (now.getHours() < 12) return { date: today, shift: "pm" };
  return { date: nextBusinessYmd(today), shift: "am" };
}

function shiftLabel(shift: string): string {
  if (shift === "am") return "上午";
  if (shift === "pm") return "下午";
  return shift;
}

function kindLabel(kind?: string): string {
  if (kind === "patrol") return "巡單";
  if (kind === "replenishment") return "補送";
  if (kind === "emergency") return "緊急";
  return "一般";
}

function reasonLabel(code: string): string {
  if (code === "DEFER_NEXT_SHIFT") return "延後下一班";
  if (code === "NO_GEOCODE") return "缺座標";
  if (code === "NO_CAPACITY") return "容量不足";
  if (code === "NO_DRIVER") return "無司機";
  return code;
}

function isMustOrder(o: { orderKind?: string; dispatchPriority?: string | null; dispatchLocked?: boolean }): boolean {
  if (o.dispatchLocked) return true;
  const pri = (o.dispatchPriority ?? "").toLowerCase();
  if (pri === "must" || pri === "urgent") return true;
  return o.orderKind === "replenishment" || o.orderKind === "emergency";
}

function summaryBucket(o: { orderKind?: string; dispatchPriority?: string | null; dispatchLocked?: boolean }): "must" | "patrol" | "general" {
  if (o.orderKind === "patrol") return "patrol";
  if (isMustOrder(o)) return "must";
  return "general";
}

function zoneSummary(stops: Array<{ zoneName?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const s of stops) {
    const z = s.zoneName?.trim() || "未分區";
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([z, n]) => `${z}×${n}`)
    .join("、");
}

function geoOk(status?: string): boolean {
  return status === "ok" || status === "manual_confirmed";
}

function formatZoneLoads(
  rows?: Array<{ zoneName: string; orderCount?: number }>,
): string {
  if (!rows?.length) return "";
  return rows
    .map((z) => (z.orderCount != null && z.orderCount > 0 ? `${z.zoneName}×${z.orderCount}` : z.zoneName))
    .join("、");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; data?: unknown };
  if (!r.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${r.status}`);
  }
  return data as T;
}

export default function AiSuggestAssignPanel() {
  const { drivers, addressZones } = useDashboard();
  const initial = useMemo(() => defaultTarget(), []);
  const [planDate, setPlanDate] = useState(initial.date);
  const [shift, setShift] = useState<ShiftCode | "">(initial.shift);
  const [zoneId, setZoneId] = useState("driver");
  const [board, setBoard] = useState<BoardOrder[]>([]);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [boardMeta, setBoardMeta] = useState<{ unassignedCount: number; assignedCount: number; eligibleCount: number } | null>(
    null,
  );
  const [boardLoading, setBoardLoading] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [assignFilter, setAssignFilter] = useState<AssignFilter>("unassigned");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [eligibleFilter, setEligibleFilter] = useState<EligibleFilter>("eligible");
  const [geoFilter, setGeoFilter] = useState<GeoFilter>("all");
  const [mustOnly, setMustOnly] = useState(false);
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState<PlanPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [geoOpenId, setGeoOpenId] = useState<string | null>(null);
  const [driverRunZones, setDriverRunZones] = useState<Record<string, string[]>>({});
  const rosterReqId = useRef(0);
  const boardReqId = useRef(0);
  const resultRef = useRef<HTMLElement | null>(null);
  const [sla, setSla] = useState<PlanningSla | null>(null);
  const [cutoff, setCutoff] = useState<PlanningCutoff | null>(null);
  const [slaDraft, setSlaDraft] = useState({
    generalShifts: "4",
    patrolEarlyShifts: "1",
    patrolLateShifts: "1",
    afterScheduledShifts: "",
    amCutoff: "15:00",
    pmCutoff: "10:00",
  });
  const [slaSaving, setSlaSaving] = useState(false);

  const driverList = useMemo(() => (drivers as Driver[]).filter(driverIsActive), [drivers]);
  const zones = useMemo(
    () => addressZones.filter((z) => z.isActive !== false),
    [addressZones],
  );

  const driverName = useCallback(
    (id: string) => driverList.find((d) => String(d.id) === id)?.user?.name ?? `司機#${id}`,
    [driverList],
  );

  const shiftReady = shift === "am" || shift === "pm";

  const rosterRows = useMemo((): RosterRow[] => {
    const rows =
      roster.length > 0
        ? roster
        : driverList.map((d) => ({
            driverId: String(d.id),
            name: d.user?.name ?? String(d.id),
            plateNo: d.vehicle?.plateNo ?? null,
            maxOrderCount: d.maxOrderCount ?? 0,
            maxBarrelQty: d.maxBarrelQty ?? 0,
            status: "on" as const,
            note: null,
            runZoneIds: null,
          }));
    return rows.map((r) => ({ ...r, status: r.status === "off" ? "off" : "on" }));
  }, [roster, driverList]);

  const selectedDriverIds = useMemo(
    () => rosterRows.filter((r) => r.status === "on").map((r) => r.driverId),
    [rosterRows],
  );
  const driversReady = selectedDriverIds.length > 0;

  useEffect(() => {
    setPlan(null);
    setBoard([]);
    setSummary(null);
    setBoardMeta(null);
    setSelectedOrderIds(new Set());
    setRoster([]);
    setDriverRunZones({});
  }, [planDate, shift]);

  const loadRoster = useCallback(async () => {
    if (!shiftReady) return;
    const reqId = ++rosterReqId.current;
    try {
      const qs = new URLSearchParams({ workDate: planDate, shift });
      const res = await fetchJson<{ ok: boolean; data: { roster: RosterRow[] } }>(
        `/api/drivers/attendance?${qs.toString()}`,
      );
      if (reqId !== rosterReqId.current) return;
      const rows = res.data?.roster ?? [];
      setRoster(rows);
      setDriverRunZones((prev) => {
        const next: Record<string, string[]> = { ...prev };
        for (const r of rows) {
          if (Array.isArray(r.runZoneIds)) next[r.driverId] = r.runZoneIds;
        }
        return next;
      });
    } catch (e) {
      if (reqId !== rosterReqId.current) return;
      setRoster([]);
      setMessage(String(e));
    }
  }, [planDate, shift, shiftReady]);

  const loadBoard = useCallback(async () => {
    if (!shiftReady) return;
    const reqId = ++boardReqId.current;
    setBoardLoading(true);
    setMessage("");
    try {
      const qs = new URLSearchParams({ planDate, shift, zoneId: "all" });
      const res = await fetchJson<{
        ok: boolean;
        data: {
          orders: BoardOrder[];
          unassignedCount: number;
          assignedCount: number;
          eligibleCount: number;
          summary?: ShiftSummary;
        };
      }>(`/api/delivery-plans/shift-board?${qs.toString()}`);
      if (reqId !== boardReqId.current) return;
      const orders = res.data?.orders ?? [];
      setBoard(orders);
      setSummary(res.data?.summary ?? null);
      setBoardMeta({
        unassignedCount: res.data?.unassignedCount ?? 0,
        assignedCount: res.data?.assignedCount ?? 0,
        eligibleCount: res.data?.eligibleCount ?? 0,
      });
    } catch (e) {
      if (reqId !== boardReqId.current) return;
      setBoard([]);
      setSummary(null);
      setBoardMeta(null);
      setMessage(String(e));
    } finally {
      if (reqId === boardReqId.current) setBoardLoading(false);
    }
  }, [planDate, shift, shiftReady]);

  const applyRules = useCallback((s: PlanningSla, c?: PlanningCutoff | null) => {
    setSla(s);
    if (c) setCutoff(c);
    setSlaDraft({
      generalShifts: String(s.generalShifts),
      patrolEarlyShifts: String(s.patrolEarlyShifts),
      patrolLateShifts: String(s.patrolLateShifts),
      afterScheduledShifts: s.afterScheduledShifts == null ? "" : String(s.afterScheduledShifts),
      amCutoff: c?.am ?? "15:00",
      pmCutoff: c?.pm ?? "10:00",
    });
  }, []);

  const loadSla = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: { sla: PlanningSla; cutoff?: PlanningCutoff } }>(
        "/api/delivery-planning/settings",
      );
      if (res.data?.sla) applyRules(res.data.sla, res.data.cutoff ?? null);
    } catch (e) {
      setMessage(String(e));
    }
  }, [applyRules]);

  const saveSla = async () => {
    setSlaSaving(true);
    setMessage("");
    try {
      const res = await fetchJson<{ ok: boolean; data: { sla: PlanningSla; cutoff?: PlanningCutoff } }>(
        "/api/delivery-planning/settings",
        {
          method: "PUT",
          body: JSON.stringify({
            settings: {
              "sla.general_shifts": slaDraft.generalShifts,
              "patrol.early_shifts": slaDraft.patrolEarlyShifts,
              "patrol.late_shifts": slaDraft.patrolLateShifts,
              "sla.after_scheduled_shifts": slaDraft.afterScheduledShifts.trim(),
              "shift.am.cutoff": slaDraft.amCutoff,
              "shift.pm.cutoff": slaDraft.pmCutoff,
            },
          }),
        },
      );
      if (res.data?.sla) applyRules(res.data.sla, res.data.cutoff ?? null);
      if (shiftReady) await loadBoard();
      setMessage("已更新排程規則（截單與必送會立即生效）");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSlaSaving(false);
    }
  };

  useEffect(() => {
    void loadSla();
  }, [loadSla]);

  useEffect(() => {
    if (shiftReady) {
      void loadRoster();
      void loadBoard();
    }
  }, [loadRoster, loadBoard, shiftReady]);

  useEffect(() => {
    if (!summary?.drivers?.length) return;
    setDriverRunZones((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const d of summary.drivers) {
        if (next[d.driverId] != null) continue;
        if (!d.familiarZones?.length) continue;
        next[d.driverId] = d.familiarZones.map((z) => z.zoneId);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [summary]);

  const persistRunZones = async (driverId: string, runZoneIds: string[]) => {
    if (!shiftReady) return;
    try {
      await fetchJson(`/api/drivers/${driverId}/attendance`, {
        method: "PUT",
        body: JSON.stringify({
          workDate: planDate,
          shift,
          isOnDuty: true,
          runZoneIds,
        }),
      });
    } catch (e) {
      setMessage(String(e));
    }
  };

  const toggleDriverRunZone = (driverId: string, zoneId: string) => {
    setDriverRunZones((prev) => {
      const cur = prev[driverId] ?? [];
      const nextIds = cur.includes(zoneId) ? cur.filter((x) => x !== zoneId) : [...cur, zoneId];
      void persistRunZones(driverId, nextIds);
      return { ...prev, [driverId]: nextIds };
    });
  };

  const zoneNameById = useCallback(
    (id: string) => zones.find((z) => String(z.id) === id)?.name ?? `區域#${id}`,
    [zones],
  );

  const applyShortcut = (kind: "today_pm" | "tomorrow_am") => {
    const today = fmtLocalYmd(new Date());
    if (kind === "today_pm") {
      setPlanDate(today);
      setShift("pm");
    } else {
      setPlanDate(nextBusinessYmd(today));
      setShift("am");
    }
    setZoneId("driver");
    setPlan(null);
  };

  const selectedRunZoneIds = useMemo(() => {
    const ids = new Set<string>();
    let anyUnrestricted = selectedDriverIds.length === 0;
    for (const id of selectedDriverIds) {
      const zs = driverRunZones[id];
      if (!zs?.length) {
        anyUnrestricted = true;
        break;
      }
      for (const z of zs) ids.add(z);
    }
    return { ids, anyUnrestricted };
  }, [selectedDriverIds, driverRunZones]);

  const zoneBoard = useMemo(() => {
    if (zoneId === "all") return board;
    if (zoneId === "none") return board.filter((o) => !o.zoneId);
    if (zoneId && zoneId !== "driver") return board.filter((o) => o.zoneId === zoneId);
    if (selectedRunZoneIds.anyUnrestricted) return board;
    return board.filter((o) => {
      if (o.assignStatus === "unassigned" && o.must) return true;
      return Boolean(o.zoneId && selectedRunZoneIds.ids.has(o.zoneId));
    });
  }, [board, zoneId, selectedRunZoneIds]);

  const filteredOrders = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    return zoneBoard.filter((o) => {
      if (assignFilter !== "all" && o.assignStatus !== assignFilter) return false;
      if (kindFilter !== "all" && o.orderKind !== kindFilter) return false;
      if (eligibleFilter === "eligible" && !o.eligible) return false;
      if (eligibleFilter === "other" && o.eligible) return false;
      if (geoFilter === "ok" && !geoOk(o.geocodeStatus)) return false;
      if (geoFilter === "missing" && geoOk(o.geocodeStatus)) return false;
      if (mustOnly && !o.must) return false;
      if (keyword) {
        const blob = `${o.orderNo} ${o.customerName} ${o.customerCode ?? ""} ${o.addressLine}`.toLowerCase();
        if (!blob.includes(keyword)) return false;
      }
      return true;
    });
  }, [zoneBoard, assignFilter, kindFilter, eligibleFilter, geoFilter, mustOnly, q]);

  const visibleUnassigned = useMemo(
    () => filteredOrders.filter((o) => o.assignStatus === "unassigned"),
    [filteredOrders],
  );

  useEffect(() => {
    if (!driversReady) return;
    setSelectedOrderIds(
      new Set(zoneBoard.filter((o) => o.assignStatus === "unassigned" && o.eligible).map((o) => o.id)),
    );
  }, [driversReady, zoneId, board, zoneBoard]);

  const toggleOrder = (id: string) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisibleUnassigned = () => {
    const ids = visibleUnassigned.map((o) => o.id);
    const allOn = ids.length > 0 && ids.every((id) => selectedOrderIds.has(id));
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const runOptimize = async () => {
    if (!shiftReady) return;
    const salesOrderIds = [...selectedOrderIds].filter((id) =>
      board.some((o) => o.id === id && o.assignStatus === "unassigned"),
    );
    if (salesOrderIds.length === 0) {
      setMessage("請先勾選要排入本班的未分配訂單");
      return;
    }
    if (selectedDriverIds.length === 0) {
      setMessage("目前沒有上班司機，請先取消請假或確認出勤班表");
      return;
    }
    if (summary?.cutoff?.passed) {
      setMessage(`已過本班截單時間（${summary.cutoff.label}），不可再排程`);
      return;
    }
    const offSelected = selectedDriverIds.filter((id) => roster.find((r) => r.driverId === id)?.status === "off");
    if (offSelected.length > 0) {
      setMessage("已勾選請假司機，請取消勾選或改為上班後再排");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const driverZones: Record<string, string[]> = {};
      for (const id of selectedDriverIds) {
        const zs = driverRunZones[id];
        if (zs?.length) driverZones[id] = zs;
      }
      const res = await fetchJson<{ ok: boolean; data: PlanPayload }>("/api/delivery-plans/optimize", {
        method: "POST",
        body: JSON.stringify({
          planDate,
          shift,
          mode: "shift_one_click",
          driverIds: selectedDriverIds,
          salesOrderIds,
          zoneId: "all",
          driverZones: Object.keys(driverZones).length ? driverZones : undefined,
        }),
      });
      setPlan(res.data);
      setMessage(
        `已更新 ${planDate} ${shiftLabel(shift)}草稿：排入 ${res.data.routes.reduce((n, r) => n + r.stops.length, 0)} 單，未排入／延後 ${res.data.plan.unassignedCount} 單`,
      );
      await loadBoard();
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reassignStop = async (salesOrderId: string, toDriverId: string) => {
    if (!plan) return;
    setBusy(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: PlanPayload }>(
        `/api/delivery-plans/${plan.plan.id}/stops`,
        {
          method: "PATCH",
          body: JSON.stringify({
            moves: [{ salesOrderId, toDriverId, toSequence: 99, manualAdjustReason: "調度員改派" }],
          }),
        },
      );
      setPlan(res.data);
      setMessage("已改派（草稿）");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const cutoffPassed = Boolean(summary?.cutoff?.passed);
  const zoneMustMissingGeo = useMemo(() => {
    return zoneBoard.filter((o) => o.assignStatus === "unassigned" && o.must && !geoOk(o.geocodeStatus));
  }, [zoneBoard]);

  const setAttendance = async (driverId: string, isOnDuty: boolean) => {
    if (!shiftReady) {
      setMessage("請先選擇班別");
      return;
    }
    const nextStatus = isOnDuty ? "on" : "off";
    setRoster((prev) => {
      const rows =
        prev.length > 0
          ? prev
          : driverList.map((d) => ({
              driverId: String(d.id),
              name: d.user?.name ?? String(d.id),
              plateNo: d.vehicle?.plateNo ?? null,
              maxOrderCount: d.maxOrderCount ?? 0,
              maxBarrelQty: d.maxBarrelQty ?? 0,
              status: "on" as const,
              note: null,
              runZoneIds: null,
            }));
      return rows.map((r) => (r.driverId === driverId ? { ...r, status: nextStatus, note: isOnDuty ? null : "請假" } : r));
    });
    setBusy(true);
    setMessage("");
    try {
      await fetchJson(`/api/drivers/${driverId}/attendance`, {
        method: "PUT",
        body: JSON.stringify({
          workDate: planDate,
          shift,
          isOnDuty,
          note: isOnDuty ? "" : "請假",
        }),
      });
      await loadRoster();
      await loadBoard();
      setMessage(isOnDuty ? "已標記上班" : "已標記請假");
    } catch (e) {
      setMessage(String(e));
      await loadRoster();
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!plan || !shiftReady) return;
    if (cutoffPassed) {
      setMessage(`已過本班截單時間（${summary?.cutoff?.label ?? ""}），不可發布`);
      return;
    }
    if (zoneMustMissingGeo.length > 0) {
      setMessage(`必送單缺座標，不可發布：${zoneMustMissingGeo.map((o) => o.orderNo).join("、")}`);
      return;
    }
    if (
      !window.confirm(
        `確認發布 ${planDate} ${shiftLabel(plan.plan.shift || shift)}本班草稿？將建立正式配送任務。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const res = await fetchJson<{
        ok: boolean;
        data: { succeeded: unknown[]; skipped: Array<{ salesOrderId: string; reason: string }> };
      }>(`/api/delivery-plans/${plan.plan.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ assignmentDate: planDate }),
      });
      setMessage(
        `發布完成：成功 ${res.data.succeeded.length}、略過 ${res.data.skipped.length}` +
          (res.data.skipped[0] ? `（例：${res.data.skipped[0].reason}）` : ""),
      );
      setPlan(null);
      await loadBoard();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const routedCount = useMemo(
    () => plan?.routes.reduce((n, r) => n + r.stops.length, 0) ?? 0,
    [plan],
  );

  const kindSummary = useMemo(() => {
    const routed = { must: 0, patrol: 0, general: 0 };
    const leftover = { must: 0, patrol: 0, general: 0 };
    if (!plan) return { routed, leftover };
    for (const r of plan.routes) {
      for (const s of r.stops) routed[summaryBucket(s)] += 1;
    }
    for (const u of plan.unassigned) leftover[summaryBucket(u)] += 1;
    return { routed, leftover };
  }, [plan]);

  const checkedUnassignedCount = useMemo(
    () => [...selectedOrderIds].filter((id) => board.some((o) => o.id === id && o.assignStatus === "unassigned")).length,
    [selectedOrderIds, board],
  );
  const onDutyCount = rosterRows.filter((r) => r.status === "on").length;
  const leaveCount = rosterRows.filter((r) => r.status === "off").length;
  const slaSummaryText = [
    cutoff ? `截單 上午前日 ${cutoff.am}／下午當日 ${cutoff.pm}` : "截單 上午前日 15:00／下午當日 10:00",
    sla
      ? `一般 ${sla.generalShifts} 班 · 預定日${sla.afterScheduledShifts == null ? "不另限" : `+${sla.afterScheduledShifts}`} · 巡單 −${sla.patrolEarlyShifts}／+${sla.patrolLateShifts}`
      : "一般 4 班 · 巡單 ±1",
  ].join(" · ");

  const applyMustFilter = () => {
    setAssignFilter("unassigned");
    setEligibleFilter("all");
    setMustOnly(true);
    setGeoFilter("all");
  };
  const applyMissingGeoFilter = () => {
    setAssignFilter("unassigned");
    setEligibleFilter("all");
    setMustOnly(true);
    setGeoFilter("missing");
  };
  const applyEligibleFilter = () => {
    setAssignFilter("unassigned");
    setEligibleFilter("eligible");
    setMustOnly(false);
    setGeoFilter("all");
  };

  return (
    <div className="ai-suggest-panel">
      <div className="ai-suggest-panel__top">
        <div className="ai-suggest-panel__top-row">
          <div className="ai-suggest-panel__title-block">
            <h2>班次排程</h2>
            <p className="muted small">
              {shiftReady
                ? `${planDate} ${shiftLabel(shift)} · 上班 ${onDutyCount} 人`
                : "先選班別，或按快捷"}
            </p>
          </div>
          <div className="ai-suggest-panel__target">
            <div className="ai-suggest-panel__shortcuts">
              <button
                type="button"
                className={`btn btn--sm${planDate === fmtLocalYmd(new Date()) && shift === "pm" ? " btn--primary" : ""}`}
                disabled={busy}
                onClick={() => applyShortcut("today_pm")}
              >
                今天下午
              </button>
              <button
                type="button"
                className={`btn btn--sm${shift === "am" && planDate === nextBusinessYmd(fmtLocalYmd(new Date())) ? " btn--primary" : ""}`}
                disabled={busy}
                onClick={() => applyShortcut("tomorrow_am")}
              >
                明天上午
              </button>
            </div>
            <label className="ai-suggest-panel__field">
              <span>配送日</span>
              <input type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)} />
            </label>
            <div className="order-assign-seg" role="group" aria-label="班別">
              <button
                type="button"
                className={`order-assign-seg__btn${shift === "am" ? " order-assign-seg__btn--active" : ""}`}
                onClick={() => setShift("am")}
              >
                上午
              </button>
              <button
                type="button"
                className={`order-assign-seg__btn${shift === "pm" ? " order-assign-seg__btn--active" : ""}`}
                onClick={() => setShift("pm")}
              >
                下午
              </button>
            </div>
          </div>
        </div>

        {shiftReady && summary ? (
          <div className="ai-suggest-panel__top-meta">
            <div className="ai-suggest-panel__overview">
              {summary.cutoff ? (
                <div className={`ai-suggest-panel__stat${summary.cutoff.passed ? " is-danger" : ""}`}>
                  <span className="ai-suggest-panel__stat-label">截單</span>
                  <strong>{summary.cutoff.hm}</strong>
                  <span className="muted small">{summary.cutoff.passed ? "已截止" : summary.cutoff.ymd}</span>
                </div>
              ) : null}
              <button
                type="button"
                className={`ai-suggest-panel__stat${summary.mustUnassigned > 0 ? " is-warn" : ""}`}
                onClick={applyMustFilter}
              >
                <span className="ai-suggest-panel__stat-label">必送未排</span>
                <strong>{summary.mustUnassigned}</strong>
              </button>
              <button
                type="button"
                className={`ai-suggest-panel__stat${summary.mustMissingGeo > 0 ? " is-danger" : ""}`}
                onClick={applyMissingGeoFilter}
              >
                <span className="ai-suggest-panel__stat-label">必送缺座標</span>
                <strong>{summary.mustMissingGeo}</strong>
              </button>
              <button type="button" className="ai-suggest-panel__stat" onClick={applyEligibleFilter}>
                <span className="ai-suggest-panel__stat-label">可排／已派</span>
                <strong>
                  {summary.eligibleUnassigned}／{summary.assignedThisShift}
                </strong>
              </button>
              <div className={`ai-suggest-panel__stat${summary.overloadDrivers > 0 ? " is-warn" : ""}`}>
                <span className="ai-suggest-panel__stat-label">司機超載</span>
                <strong>{summary.overloadDrivers}</strong>
              </div>
            </div>
            <div className="ai-suggest-panel__primary-actions">
              <button type="button" className="btn" disabled={busy || boardLoading} onClick={() => void loadBoard()}>
                重新整理
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !driversReady || checkedUnassignedCount === 0 || cutoffPassed}
                onClick={() => void runOptimize()}
              >
                一鍵排該班（{checkedUnassignedCount}）
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !plan || routedCount === 0 || cutoffPassed || zoneMustMissingGeo.length > 0}
                onClick={() => void publish()}
              >
                確認發布
              </button>
            </div>
          </div>
        ) : null}

        {message ? (
          <p className={`ai-suggest-panel__toast${/不可|失敗|錯誤|請先/.test(message) ? " is-danger" : ""}`}>{message}</p>
        ) : null}
        {shiftReady && cutoffPassed ? (
          <p className="ai-suggest-panel__banner is-danger">已過本班截單時間（{summary?.cutoff?.label}），不可再排程或發布。</p>
        ) : shiftReady && zoneMustMissingGeo.length > 0 ? (
          <p className="ai-suggest-panel__banner is-danger">
            必送單缺座標，請先確認座標：{zoneMustMissingGeo.map((o) => o.orderNo).join("、")}
          </p>
        ) : null}
      </div>

      {shiftReady && plan ? (
            <section className="ai-suggest-panel__result" ref={resultRef}>
              <header className="ai-suggest-panel__result-head">
                <div>
                  <h3>本班草稿</h3>
                  <p className="muted small">
                    {plan.plan.planDate} {shiftLabel(plan.plan.shift || shift)} · 排入 {routedCount} 單
                    {plan.unassigned.length > 0 ? ` · 未排 ${plan.unassigned.length}` : ""}
                    <span className="ai-suggest-panel__result-hint"> · 再按一鍵排會覆寫這份草稿</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || routedCount === 0 || cutoffPassed || zoneMustMissingGeo.length > 0}
                  onClick={() => void publish()}
                >
                  確認發布（{routedCount}）
                </button>
              </header>
              <div className="ai-suggest-panel__result-kpis">
                <span>
                  必送 <strong>{kindSummary.routed.must}</strong>
                  {kindSummary.leftover.must ? <em>未排 {kindSummary.leftover.must}</em> : null}
                </span>
                <span>
                  巡單 <strong>{kindSummary.routed.patrol}</strong>
                  {kindSummary.leftover.patrol ? <em>未排 {kindSummary.leftover.patrol}</em> : null}
                </span>
                <span>
                  一般 <strong>{kindSummary.routed.general}</strong>
                  {kindSummary.leftover.general ? <em>未排 {kindSummary.leftover.general}</em> : null}
                </span>
              </div>
              {plan.routes.length === 0 ? <p className="muted">尚無建議路線</p> : null}
              <div className="ai-suggest-panel__route-grid">
                {plan.routes.map((r) => (
                  <article key={r.id} className="ai-suggest-panel__route">
                    <header className="ai-suggest-panel__route-head">
                      <div>
                        <strong>{driverName(r.driverId)}</strong>
                        {r.stops.length > 0 ? (
                          <div className="muted small">{zoneSummary(r.stops)}</div>
                        ) : null}
                      </div>
                      <div className="ai-suggest-panel__route-meta">
                        <span>{r.stops.length} 站</span>
                        <span>{r.totalBarrelQty} 桶</span>
                        {r.totalDriveMinutes != null ? <span>約 {r.totalDriveMinutes} 分</span> : null}
                      </div>
                    </header>
                    <ol className="ai-suggest-panel__stops">
                      {r.stops.map((s, idx) => (
                        <li key={s.id}>
                          <div className="ai-suggest-panel__stop-main">
                            <span className="ai-suggest-panel__stop-seq">{idx + 1}</span>
                            <div className="ai-suggest-panel__stop-body">
                              <div className="ai-suggest-panel__stop-title">
                                <span className={`ai-suggest-panel__kind ai-suggest-panel__kind--${s.orderKind || "general"}`}>
                                  {kindLabel(s.orderKind)}
                                </span>
                                <strong>{s.customerName}</strong>
                                <span className="muted small">{s.barrelQty} 桶</span>
                              </div>
                              <div className="muted small">{s.addressLine}</div>
                              {s.zoneName ? (
                                <div className="muted small">{s.zoneName}</div>
                              ) : s.aiExplanation?.includes("未分區就近") ? (
                                <div className="muted small">未分區 · 就近併入</div>
                              ) : (
                                <div className="muted small">未分區</div>
                              )}
                            </div>
                            <label className="ai-suggest-panel__stop-reassign">
                              <span>改派</span>
                              <select
                                value={r.driverId}
                                onChange={(e) => {
                                  const to = e.target.value;
                                  if (to !== r.driverId) void reassignStop(s.salesOrderId, to);
                                }}
                              >
                                {selectedDriverIds.map((id) => (
                                  <option key={id} value={id}>
                                    {driverName(id)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </article>
                ))}
              </div>
              {plan.unassigned.length > 0 ? (
                <div className="ai-suggest-panel__leftover">
                  <h4>未排入／延後（{plan.unassigned.length}）</h4>
                  <ul className="ai-suggest-panel__unassigned">
                    {plan.unassigned.map((u) => (
                      <li key={u.salesOrderId}>
                        <div>
                          <span className={`ai-suggest-panel__kind ai-suggest-panel__kind--${u.orderKind || "general"}`}>
                            {kindLabel(u.orderKind)}
                          </span>{" "}
                          <strong>{u.orderNo}</strong>{" "}
                          <span className={u.reasonCode === "DEFER_NEXT_SHIFT" ? "ai-suggest-panel__defer" : ""}>
                            {reasonLabel(u.reasonCode)}
                          </span>
                        </div>
                        <div className="muted small">{u.reasonText}</div>
                        <div className="muted small">{u.addressLine}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="muted small ai-suggest-panel__all-in">全部已排入本班</p>
              )}
            </section>
      ) : null}

      {!shiftReady ? (
        <p className="ai-suggest-panel__empty">請按「今天下午／明天上午」，或自行選配送日與班別。</p>
      ) : (
        <details className="ai-suggest-panel__block" open>
          <summary>
            出勤班表
            <span className="muted">
              上班 {onDutyCount}／請假 {leaveCount}
              {!driversReady ? " · 請至少留一位上班" : ""}
            </span>
          </summary>
          <div className="table-wrap">
            <table className="data-table data-table--compact ai-suggest-panel__roster-table">
              <thead>
                <tr>
                  <th>司機</th>
                  <th>出勤</th>
                  <th>本班跑區</th>
                  <th>已派／上限</th>
                </tr>
              </thead>
              <tbody>
                {rosterRows.map((r) => {
                  const onDuty = r.status === "on";
                  const load = summary?.drivers.find((d) => d.driverId === r.driverId);
                  const runIds = driverRunZones[r.driverId] ?? [];
                  const assignedZones = formatZoneLoads(load?.zones);
                  const plannedZones = formatZoneLoads(load?.plannedZones);
                  return (
                    <tr key={r.driverId} className={`${onDuty ? "" : "is-leave"}${load?.overload ? " is-overload" : ""}`}>
                      <td>
                        <strong>{r.name}</strong>
                        {r.plateNo ? <div className="muted small">{r.plateNo}</div> : null}
                        {load?.familiarZones?.length ? (
                          <div className="muted small">熟悉 {load.familiarZones.map((z) => z.zoneName).join("、")}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="order-assign-seg" role="group" aria-label={`${r.name} 出勤`}>
                          <button
                            type="button"
                            className={`order-assign-seg__btn${onDuty ? " order-assign-seg__btn--active" : ""}`}
                            disabled={busy || onDuty}
                            onClick={() => void setAttendance(r.driverId, true)}
                          >
                            上班
                          </button>
                          <button
                            type="button"
                            className={`order-assign-seg__btn${!onDuty ? " order-assign-seg__btn--active is-leave" : ""}`}
                            disabled={busy || !onDuty}
                            onClick={() => void setAttendance(r.driverId, false)}
                          >
                            請假
                          </button>
                        </div>
                      </td>
                      <td>
                        {onDuty ? (
                          <div className="ai-suggest-panel__run-zones">
                            {runIds.map((zid) => (
                              <button
                                key={zid}
                                type="button"
                                className="btn btn--sm btn--primary"
                                onClick={() => toggleDriverRunZone(r.driverId, zid)}
                              >
                                {zoneNameById(zid)} ×
                              </button>
                            ))}
                            <select
                              value=""
                              aria-label={`${r.name} 本班區域`}
                              onChange={(e) => {
                                const id = e.target.value;
                                if (id) toggleDriverRunZone(r.driverId, id);
                              }}
                            >
                              <option value="">＋區域</option>
                              {zones
                                .filter((z) => !runIds.includes(String(z.id)))
                                .map((z) => (
                                  <option key={String(z.id)} value={String(z.id)}>
                                    {z.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                        ) : (
                          <span className="muted small">請假不排</span>
                        )}
                      </td>
                      <td>
                        <div>
                          {load ? `${load.orderCount} 單／${load.barrelQty} 桶` : "0 單"}
                          <span className="muted">
                            {" "}
                            · 上限 {r.maxOrderCount || "—"}／{r.maxBarrelQty || "—"}
                          </span>
                        </div>
                        {assignedZones ? <div className="muted small">已派 {assignedZones}</div> : null}
                        {plannedZones ? <div className="muted small">草稿 {plannedZones}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {shiftReady && driversReady ? (
          <div className="ai-suggest-panel__work">
          <section className="ai-suggest-panel__board">
            <div className="ai-suggest-panel__board-head">
              <h3>
                訂單
                {boardMeta
                  ? ` · 未分配 ${boardMeta.unassignedCount} · 已分配 ${boardMeta.assignedCount} · 可排 ${boardMeta.eligibleCount}`
                  : ""}
              </h3>
            </div>

            <div className="ai-suggest-panel__chips">
              <button
                type="button"
                className={`ai-suggest-panel__chip${assignFilter === "unassigned" ? " is-on" : ""}`}
                onClick={() => setAssignFilter((v) => (v === "unassigned" ? "all" : "unassigned"))}
              >
                未分配
              </button>
              <button
                type="button"
                className={`ai-suggest-panel__chip${assignFilter === "assigned" ? " is-on" : ""}`}
                onClick={() => setAssignFilter((v) => (v === "assigned" ? "all" : "assigned"))}
              >
                已分配
              </button>
              <button
                type="button"
                className={`ai-suggest-panel__chip${eligibleFilter === "eligible" ? " is-on" : ""}`}
                onClick={() => setEligibleFilter((v) => (v === "eligible" ? "all" : "eligible"))}
              >
                本班可排
              </button>
              <button
                type="button"
                className={`ai-suggest-panel__chip${mustOnly ? " is-on is-warn" : ""}`}
                onClick={() => setMustOnly((v) => !v)}
              >
                必送
              </button>
              <button
                type="button"
                className={`ai-suggest-panel__chip${geoFilter === "missing" ? " is-on is-danger" : ""}`}
                onClick={() => setGeoFilter((v) => (v === "missing" ? "all" : "missing"))}
              >
                缺座標
              </button>
              <label className="ai-suggest-panel__field">
                <span>種類</span>
                <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
                  <option value="all">全部</option>
                  <option value="general">一般</option>
                  <option value="patrol">巡單</option>
                  <option value="replenishment">補送</option>
                  <option value="emergency">緊急</option>
                </select>
              </label>
              <label className="ai-suggest-panel__field ai-suggest-panel__search">
                <span>搜尋</span>
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號／客戶／地址" />
              </label>
            </div>

            {(summary?.zones?.length ?? 0) > 0 ? (
              <div className="ai-suggest-panel__zone-chips">
                <span className="muted small">分區</span>
                <button
                  type="button"
                  className={`btn btn--sm${zoneId === "all" ? " btn--primary" : " btn--secondary"}`}
                  onClick={() => setZoneId("all")}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={`btn btn--sm${zoneId === "driver" ? " btn--primary" : " btn--secondary"}`}
                  onClick={() => setZoneId("driver")}
                >
                  依司機區域
                </button>
                {(summary?.zones ?? []).map((z) => (
                  <button
                    key={z.zoneId ?? "none"}
                    type="button"
                    className={`btn btn--sm${zoneId === (z.zoneId ?? "none") ? " btn--primary" : " btn--secondary"}`}
                    onClick={() => setZoneId(z.zoneId ?? "none")}
                  >
                    {z.zoneName} {z.unassigned}
                    {z.must ? ` · 必送 ${z.must}` : ""}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="table-wrap">
              <table className="data-table data-table--compact ai-suggest-panel__table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={visibleUnassigned.length > 0 && visibleUnassigned.every((o) => selectedOrderIds.has(o.id))}
                        onChange={toggleVisibleUnassigned}
                        aria-label="全選目前未分配"
                      />
                    </th>
                    <th>訂單</th>
                    <th>客戶／地址</th>
                    <th>分派</th>
                    <th>桶數</th>
                    <th>配送／最晚</th>
                    <th>座標</th>
                  </tr>
                </thead>
                <tbody>
                  {boardLoading ? (
                    <tr>
                      <td colSpan={7} className="text-muted">
                        載入中…
                      </td>
                    </tr>
                  ) : filteredOrders.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted">
                        這個篩選下沒有訂單，試試取消「本班可排」或改分區。
                      </td>
                    </tr>
                  ) : (
                    filteredOrders.map((o) => {
                      const geo = geocodeStatusMeta(o.geocodeStatus);
                      const unassigned = o.assignStatus === "unassigned";
                      return (
                        <tr key={o.id} className={o.must ? "is-must-row" : ""}>
                          <td>
                            {unassigned ? (
                              <input
                                type="checkbox"
                                checked={selectedOrderIds.has(o.id)}
                                onChange={() => toggleOrder(o.id)}
                                aria-label={`選取 ${o.orderNo}`}
                              />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            <code>{o.orderNo}</code>
                            <div>
                              <span className={`ai-suggest-panel__kind ai-suggest-panel__kind--${o.orderKind}`}>
                                {kindLabel(o.orderKind)}
                              </span>
                              {o.must ? <span className="badge badge--warn">必送</span> : null}
                              {o.eligible ? <span className="badge badge--confirmed">本班可排</span> : null}
                              {o.dispatchLocked ? <span className="badge badge--warn">鎖定</span> : null}
                            </div>
                          </td>
                          <td>
                            <strong>{o.customerName}</strong>
                            {o.customerCode ? <span className="muted mono-text"> {o.customerCode}</span> : null}
                            <div className="muted small">{o.addressLine}</div>
                            <div className="muted small">{o.zoneName ?? "未分區"}</div>
                            {o.explanationHint ? <div className="small">{o.explanationHint}</div> : null}
                          </td>
                          <td>
                            {unassigned ? (
                              <span className="badge badge--default">未分配</span>
                            ) : (
                              <>
                                <span className="badge badge--assigned">已分配</span>
                                <div className="small">
                                  {o.assignment?.driverName ?? "—"}
                                  {o.assignment?.assignmentShift ? ` · ${shiftLabel(o.assignment.assignmentShift)}` : ""}
                                </div>
                              </>
                            )}
                          </td>
                          <td>{o.barrelQty}</td>
                          <td>
                            <div>{o.scheduledDeliveryDate ?? "—"}</div>
                            {o.latestDate ? (
                              <div className="muted small">
                                最晚 {o.latestDate} {o.latestShift ? shiftLabel(o.latestShift) : ""}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <span className={geo.className}>{geo.text}</span>
                            {!geoOk(o.geocodeStatus) ? (
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setGeoOpenId(geoOpenId === o.id ? null : o.id)}
                              >
                                {geoOpenId === o.id ? "收起" : "確認座標"}
                              </button>
                            ) : null}
                            {geoOpenId === o.id ? (
                              <AddressGeocodePanel
                                address={{
                                  id: o.deliveryAddressId,
                                  addressLine: o.addressLine,
                                  latitude: o.latitude,
                                  longitude: o.longitude,
                                  geocodeStatus: o.geocodeStatus,
                                }}
                                defaultOpen
                                onUpdated={(patch) => {
                                  setBoard((prev) =>
                                    prev.map((row) =>
                                      row.id === o.id
                                        ? {
                                            ...row,
                                            geocodeStatus: String(patch.geocodeStatus ?? row.geocodeStatus),
                                            latitude: patch.latitude != null ? Number(patch.latitude) : row.latitude,
                                            longitude: patch.longitude != null ? Number(patch.longitude) : row.longitude,
                                          }
                                        : row,
                                    ),
                                  );
                                }}
                              />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
          </div>
      ) : shiftReady ? (
        <p className="ai-suggest-panel__empty">目前沒有上班司機，請在出勤班表改回「上班」。</p>
      ) : null}

      <details className="ai-suggest-panel__details">
        <summary>排程規則 · {slaSummaryText}</summary>
        <div className="ai-suggest-panel__rules-grid">
          <label>
            上午班截單（配送日前一營業日）
            <input
              type="time"
              step={60}
              value={slaDraft.amCutoff}
              onChange={(e) => setSlaDraft((d) => ({ ...d, amCutoff: e.target.value }))}
            />
          </label>
          <label>
            下午班截單（配送日當天）
            <input
              type="time"
              step={60}
              value={slaDraft.pmCutoff}
              onChange={(e) => setSlaDraft((d) => ({ ...d, pmCutoff: e.target.value }))}
            />
          </label>
          <label>
            一般單：成立後幾班內要送完
            <input
              type="number"
              min={1}
              max={20}
              value={slaDraft.generalShifts}
              onChange={(e) => setSlaDraft((d) => ({ ...d, generalShifts: e.target.value }))}
            />
          </label>
          <label>
            超過預定日後再幾班內必送
            <input
              type="number"
              min={0}
              max={20}
              placeholder="空白＝不另用預定日"
              value={slaDraft.afterScheduledShifts}
              onChange={(e) => setSlaDraft((d) => ({ ...d, afterScheduledShifts: e.target.value }))}
            />
          </label>
          <label>
            巡單可提前幾班
            <input
              type="number"
              min={0}
              max={10}
              value={slaDraft.patrolEarlyShifts}
              onChange={(e) => setSlaDraft((d) => ({ ...d, patrolEarlyShifts: e.target.value }))}
            />
          </label>
          <label>
            巡單可延後幾班
            <input
              type="number"
              min={0}
              max={10}
              value={slaDraft.patrolLateShifts}
              onChange={(e) => setSlaDraft((d) => ({ ...d, patrolLateShifts: e.target.value }))}
            />
          </label>
        </div>
        <p className="muted small">
          截單後不可再一鍵排程或發布。早上未送達要改排下午，請把「下午班截單」調到核銷來得及的時間（例如 12:30）。
          「超過預定日」留空＝只看成立後班次；填 <strong>0</strong>＝過了預定日當天下午班就必送。
        </p>
        <button type="button" className="btn btn--sm" disabled={slaSaving || busy} onClick={() => void saveSla()}>
          {slaSaving ? "儲存中…" : "儲存規則"}
        </button>
      </details>
    </div>
  );
}
