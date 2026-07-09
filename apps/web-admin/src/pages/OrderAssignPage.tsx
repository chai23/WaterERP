import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../DashboardContext";
import type { Customer } from "../adminUtils";
import {
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  fmtLocalYmd,
  orderStatusBadgeClass,
} from "../adminUtils";

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function charsInOrder(query: string, haystack: string): boolean {
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < query.length; i++) {
    if (haystack[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

function scoreCustomerMatch(c: Customer, qRaw: string): number {
  const q = qRaw.trim().toLowerCase();
  if (!q) return 0;

  const code = (c.customerCode ?? "").trim().toLowerCase();
  const idStr = String(c.id);

  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, "0");
    if (code === q || code === padded) return 1_000_000;
    if (code.startsWith(q)) return 900_000 + q.length * 500;
    if (code.includes(q)) return 750_000;
  }

  if (idStr === q || idStr.includes(q)) return 930_000;

  const qDigits = digitsOnly(qRaw);
  const phoneBuckets = new Set<string>();
  const pushDigits = (s: string | null | undefined) => {
    const d = digitsOnly(s ?? "");
    if (d.length > 0) phoneBuckets.add(d);
  };
  pushDigits(c.phone ?? "");
  for (const a of c.addresses ?? []) {
    pushDigits(a.contactPhone ?? "");
  }
  if (qDigits.length >= 6) {
    for (const p of phoneBuckets) {
      if (p === qDigits) return 920_000;
      if (p.endsWith(qDigits)) return 880_000;
      if (p.includes(qDigits)) return 760_000;
    }
  } else if (qDigits.length >= 4 && qDigits === qRaw.trim()) {
    for (const p of phoneBuckets) {
      if (p === qDigits) return 915_000;
      if (p.endsWith(qDigits)) return 870_000;
      if (p.includes(qDigits)) return 720_000;
    }
  }

  const name = (c.name ?? "").toLowerCase();
  if (name === q) return 860_000;
  if (name.startsWith(q)) return 650_000;
  if (name.includes(q)) return 480_000 + Math.min(q.length * 800, 24_000);

  const addrBlob = (c.addresses ?? [])
    .map((a) => `${a.label ?? ""} ${a.addressLine ?? ""} ${a.contactPhone ?? ""}`.toLowerCase())
    .join(" ");
  if (addrBlob.includes(q)) return 460_000;

  if (q.length >= 2 && charsInOrder(q, name)) return 220_000;

  return 0;
}

const MATCH_DEBOUNCE_MS = 320;
const MIN_AUTO_SCORE = 240_000;
const AMBIGUOUS_GAP = 38_000;

function orderAssignMatchHintClass(msg: string): string {
  const base = "order-new__match-hint";
  if (!msg) return base;
  if (msg.includes("找不到") || msg.includes("不明確")) return `${base} order-new__match-hint--err`;
  if (msg.includes("相近")) return `${base} order-new__match-hint--warn`;
  return `${base} order-new__match-hint--ok`;
}

function orderStatusLabel(status: string | undefined): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "confirmed":
      return "已確認";
    case "assigned":
      return "已分派";
    case "delivering":
      return "配送中";
    case "completed":
      return "已完成";
    case "not_delivered":
      return "未送達";
    case "cancelled":
      return "已取消";
    default:
      return status ?? "—";
  }
}

type IncompleteOrder = {
  id: string;
  orderNo: string;
  status: string;
  scheduledDeliveryDate?: string | null;
  lines?: Array<{
    qtyOrdered: number;
    linePurpose?: string | null;
    product?: { name?: string | null; unit?: string | null } | null;
  }>;
  assignments?: Array<{
    id: string;
    status?: string;
    assignmentDate?: string | null;
    driver?: { user?: { name?: string; employeeCode?: string | null } | null } | null;
    vehicle?: { plateNo?: string | null } | null;
  }>;
};

function lineSummary(line: NonNullable<IncompleteOrder["lines"]>[number]): string {
  const name = line.product?.name?.trim() || "（商品）";
  const unit = line.product?.unit?.trim();
  const qty = line.qtyOrdered;
  const suffix = line.linePurpose === "prepaid_barrel_topup" ? " · 預付桶儲值" : "";
  const u = unit ? `${unit}` : "";
  return `${name}${u ? `（${u}）` : ""} × ${qty}${suffix}`;
}

function goodsSummaryFromLines(lines: IncompleteOrder["lines"] | undefined, maxLen = 96): string {
  const parts = (lines ?? []).map((ln) => {
    let t = lineSummary(ln);
    if (t.includes("預付桶儲值")) t = t.replace(" · 預付桶儲值", "（儲值）");
    return t;
  });
  const s = parts.join("；");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function goodsSummary(o: IncompleteOrder, maxLen = 96): string {
  return goodsSummaryFromLines(o.lines, maxLen);
}

function describeLatestAssignment(order: IncompleteOrder): string {
  const raw = [...(order.assignments ?? [])]
    .filter((a) => a.status !== "cancelled")
    .sort((a, b) => Number(b.id) - Number(a.id));
  const a = raw[0];
  if (!a) return "尚未建立配送任務";
  const emp = a.driver?.user?.employeeCode ?? "";
  const name = a.driver?.user?.name ?? "";
  const st = deliveryAssignmentStatusLabel(a.status);
  const d = fmtLocalYmd(a.assignmentDate);
  const plate = a.vehicle?.plateNo ? ` · ${a.vehicle.plateNo}` : "";
  return `${st} · ${emp}/${name} · ${d}${plate}`;
}

type RouteAssignmentRow = {
  id: string;
  status?: string;
  assignmentDate?: string | null;
  vehicle?: { plateNo?: string | null } | null;
  salesOrder?: {
    orderNo?: string;
    status?: string;
    customer?: { customerCode?: string | null; name?: string };
    deliveryAddress?: { label?: string | null; addressLine?: string };
    lines?: IncompleteOrder["lines"];
  } | null;
};

type ProductTotalRow = { productId: string; label: string; unit: string; qtyTotal: number };

export default function OrderAssignPage() {
  const {
    customers,
    drivers,
    vehicles,
    assigning,
    assignMessage,
    assignForm,
    setAssignForm,
    onSubmitAssign,
    driverEmployeeCode,
  } = useDashboard();

  const [customerKeyword, setCustomerKeyword] = useState("");
  const [assignCustomerId, setAssignCustomerId] = useState("");
  const [matchHint, setMatchHint] = useState("");
  const [incompleteOrders, setIncompleteOrders] = useState<IncompleteOrder[]>([]);
  const [incompleteLoading, setIncompleteLoading] = useState(false);
  const [routeAssignments, setRouteAssignments] = useState<RouteAssignmentRow[]>([]);
  const [routeTotals, setRouteTotals] = useState<ProductTotalRow[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");

  const alternateCandidates = useMemo(() => {
    const q = customerKeyword.trim();
    if (!q) return [];
    return customers
      .map((c) => ({ c, score: scoreCustomerMatch(c, customerKeyword) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 18);
  }, [customers, customerKeyword]);

  const pickerOptions = useMemo(() => {
    const base = alternateCandidates;
    if (!assignCustomerId) return base;
    if (base.some(({ c }) => String(c.id) === assignCustomerId)) return base;
    const sel = customers.find((c) => String(c.id) === assignCustomerId);
    if (!sel) return base;
    return [{ c: sel, score: 0 }, ...base];
  }, [alternateCandidates, assignCustomerId, customers]);

  const selectedCustomer = customers.find((c) => String(c.id) === assignCustomerId);

  useEffect(() => {
    const q = customerKeyword.trim();
    const timer = window.setTimeout(() => {
      if (!q) {
        setMatchHint("");
        setAssignCustomerId("");
        return;
      }

      const ranked = customers
        .map((c) => ({ c, score: scoreCustomerMatch(c, customerKeyword) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length === 0) {
        setMatchHint("找不到相符客戶，請換個關鍵字試試。");
        setAssignCustomerId("");
        return;
      }

      const top = ranked[0];
      const second = ranked[1];
      const ambiguous =
        second != null &&
        top.score >= MIN_AUTO_SCORE &&
        second.score >= MIN_AUTO_SCORE &&
        top.score - second.score < AMBIGUOUS_GAP;

      if (top.score < MIN_AUTO_SCORE) {
        setMatchHint("結果不明確，請輸入更完整的客戶編號、電話或地址。");
        setAssignCustomerId("");
        return;
      }

      setAssignCustomerId(String(top.c.id));

      if (ambiguous) {
        setMatchHint(
          `已自動帶入最相近客戶（${top.c.customerCode ?? "------"}／${top.c.name}）。另有相近結果，若不正確請從下方「改選」或繼續輸入更完整資料。`,
        );
      } else {
        setMatchHint(`已自動選取：${top.c.customerCode ?? "------"}／${top.c.name}`);
      }
    }, MATCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [customerKeyword, customers]);

  const prevAssignCustomerIdRef = useRef<string>("__init__");
  useEffect(() => {
    if (prevAssignCustomerIdRef.current !== "__init__" && prevAssignCustomerIdRef.current !== assignCustomerId) {
      setAssignForm((f) => ({ ...f, salesOrderId: "" }));
    }
    prevAssignCustomerIdRef.current = assignCustomerId;
  }, [assignCustomerId, setAssignForm]);

  const loadIncomplete = useCallback(async () => {
    if (!assignCustomerId) {
      setIncompleteOrders([]);
      return;
    }
    setIncompleteLoading(true);
    try {
      const res = await fetch(`/api/sales-orders/incomplete-by-customer?customerId=${encodeURIComponent(assignCustomerId)}`);
      const j = await res.json();
      if (!res.ok || !j?.ok || !Array.isArray(j.data)) {
        setIncompleteOrders([]);
        return;
      }
      setIncompleteOrders(j.data as IncompleteOrder[]);
    } catch {
      setIncompleteOrders([]);
    } finally {
      setIncompleteLoading(false);
    }
  }, [assignCustomerId]);

  useEffect(() => {
    void loadIncomplete();
  }, [loadIncomplete]);

  useEffect(() => {
    if (!assignForm.salesOrderId) return;
    if (!incompleteOrders.some((o) => String(o.id) === assignForm.salesOrderId)) {
      setAssignForm((f) => ({ ...f, salesOrderId: "" }));
    }
  }, [incompleteOrders, assignForm.salesOrderId, setAssignForm]);

  const loadRoute = useCallback(async () => {
    const driverId = assignForm.driverId;
    const assignmentDate = assignForm.assignmentDate;
    if (!driverId || !assignmentDate) {
      setRouteAssignments([]);
      setRouteTotals([]);
      setRouteError("");
      return;
    }
    setRouteLoading(true);
    setRouteError("");
    try {
      const qs = new URLSearchParams({ driverId, assignmentDate });
      const res = await fetch(`/api/delivery-assignments/by-driver-date?${qs.toString()}`);
      const j = await res.json();
      if (!res.ok || !j?.ok || !j.data) {
        setRouteAssignments([]);
        setRouteTotals([]);
        setRouteError(j?.message ?? "無法載入司機路線資料");
        return;
      }
      setRouteAssignments(Array.isArray(j.data.assignments) ? j.data.assignments : []);
      setRouteTotals(Array.isArray(j.data.productTotals) ? j.data.productTotals : []);
    } catch {
      setRouteAssignments([]);
      setRouteTotals([]);
      setRouteError("載入司機路線時發生錯誤");
    } finally {
      setRouteLoading(false);
    }
  }, [assignForm.driverId, assignForm.assignmentDate]);

  useEffect(() => {
    void loadRoute();
  }, [loadRoute]);

  const handleSubmit = async (e: React.FormEvent) => {
    const ok = await onSubmitAssign(e);
    if (ok) {
      void loadIncomplete();
      void loadRoute();
    }
  };

  const selectedOrderSummary = incompleteOrders.find((o) => String(o.id) === assignForm.salesOrderId);

  return (
    <section className="card order-new-page order-new-page--pro">
      <header className="order-new__hero">
        <div className="order-new__hero-top">
          <div className="order-new__hero-titles">
            <span className="order-new__badge">訂單作業</span>
            <h2 className="order-new__page-title">分配訂單</h2>
          </div>
        </div>
        <p className="order-new__hero-lead">
          區塊 <strong>①②</strong>
          輸入客戶編號後列出未完成訂單（含已分派與未分派）；區塊 <strong>③</strong>{" "}
          於選定司機與配送日後顯示該司機當日任務與商品合計。區塊 <strong>④</strong> 確認分派。
        </p>
      </header>

      <form onSubmit={handleSubmit} className="order-new__form order-new__form--layout">
        <div className="order-new__workspace" aria-label="分配訂單分區">
          <section className="order-new__zone order-new__zone--tools" aria-labelledby="order-assign-zone-tools-title">
            <header className="order-new__zone-head">
              <span className="order-new__zone-index" aria-hidden="true">
                1
              </span>
              <div className="order-new__zone-head-text">
                <p className="order-new__zone-eyebrow">輸入 · 篩選</p>
                <h3 id="order-assign-zone-tools-title" className="order-new__zone-title">
                  客戶編號／關鍵字
                </h3>
              </div>
            </header>
            <div className="order-new__zone-body">
              <div className="order-new__tool-section">
                <p className="order-new__tool-section-label">客戶搜尋</p>
                <div className="field order-new__field--code">
                  <label htmlFor="order-assign-customer-search">關鍵字（6 碼編號優先）</label>
                  <input
                    id="order-assign-customer-search"
                    type="search"
                    className="order-new__input-code"
                    placeholder="6 碼編號或關鍵字"
                    value={customerKeyword}
                    onChange={(e) => setCustomerKeyword(e.target.value)}
                    autoComplete="off"
                  />
                  {matchHint ? <p className={orderAssignMatchHintClass(matchHint)}>{matchHint}</p> : null}

                  {customerKeyword.trim() && pickerOptions.length > 1 ? (
                    <div className="field order-new__field--nested">
                      <label htmlFor="order-assign-customer-picker">改選相符客戶</label>
                      <select
                        id="order-assign-customer-picker"
                        className="order-new__select-block"
                        value={assignCustomerId}
                        onChange={(e) => setAssignCustomerId(e.target.value)}
                        aria-label="改選其他相符客戶"
                      >
                        {pickerOptions.map(({ c }) => (
                          <option key={String(c.id)} value={String(c.id)}>
                            {`${c.customerCode ?? "------"} · ${c.name}${c.phone ? ` · ${c.phone}` : ""}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <p className="order-new__meta-line">相符約 {alternateCandidates.length} 筆（改選最多 18 筆）</p>
                </div>
              </div>
              <hr className="order-new__surface-rule" />
              <p className="text-muted order-new__placeholder-sm">
                車輛為選填；配送日須與司機端查詢任務時選擇的日期一致。
              </p>
            </div>
          </section>

          <section className="order-new__zone order-new__zone--main" aria-labelledby="order-assign-zone-main-title">
            <header className="order-new__zone-head">
              <span className="order-new__zone-index order-new__zone-index--slate" aria-hidden="true">
                2
              </span>
              <div className="order-new__zone-head-text">
                <p className="order-new__zone-eyebrow">未完成 · 訂單</p>
                <h3 id="order-assign-zone-main-title" className="order-new__zone-title">
                  此客戶未完成訂單
                </h3>
              </div>
            </header>
            <div className="order-new__zone-body">
              {!assignCustomerId ? (
                <div className="order-new__empty-state">
                  <p className="order-new__empty-state-title">尚未選定客戶</p>
                  <p className="text-muted order-new__empty-state-desc">請於區塊 ① 輸入客戶編號或關鍵字。</p>
                </div>
              ) : selectedCustomer ? (
                <>
                  <p className="order-new__identity order-new__identity--compact">
                    <span className="mono-text">
                      <strong>{selectedCustomer.customerCode ?? "------"}</strong>
                    </span>
                    {" · "}
                    <strong>{selectedCustomer.name}</strong>
                    {selectedCustomer.phone ? (
                      <>
                        {" · "}
                        <span className="mono-text">{selectedCustomer.phone}</span>
                      </>
                    ) : null}
                  </p>
                  <p className="order-new__meta-line order-new__meta-line--tight">
                    請點選一筆訂單以帶入區塊 ④；「配送任務」欄位摘要最近一次有效任務。
                  </p>
                  {incompleteLoading ? (
                    <p className="text-muted order-new__placeholder-sm">載入未完成訂單…</p>
                  ) : incompleteOrders.length === 0 ? (
                    <p className="text-muted order-new__placeholder-sm">此客戶目前沒有未完成訂單。</p>
                  ) : (
                    <div className="order-new__history-table order-assign__pick-scroll" role="list">
                      {incompleteOrders.map((o) => {
                        const sel = String(o.id) === assignForm.salesOrderId;
                        const detailTitle = `${o.orderNo}\n${describeLatestAssignment(o)}\n${goodsSummary(o)}`;
                        return (
                          <button
                            key={String(o.id)}
                            type="button"
                            role="listitem"
                            title={detailTitle}
                            className={`order-assign__pick-row${sel ? " order-assign__pick-row--selected" : ""}`}
                            onClick={() => setAssignForm((f) => ({ ...f, salesOrderId: String(o.id) }))}
                          >
                            <span className="order-new__history-row__top">
                              <span className="order-new__history-row__ymd mono-text">{fmtLocalYmd(o.scheduledDeliveryDate)}</span>
                              <span className="order-new__history-row__no mono-text">{o.orderNo}</span>
                              <span className={orderStatusBadgeClass(String(o.status))}>{orderStatusLabel(o.status)}</span>
                            </span>
                            <span className="order-assign__assign-task text-muted">{describeLatestAssignment(o)}</span>
                            <span className="order-new__history-row__goods">{goodsSummary(o) || "無明細"}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-muted order-new__placeholder-sm">無法載入客戶主檔。</p>
              )}
            </div>
          </section>

          <aside className="order-new__zone order-new__zone--history" aria-label="司機路線預覽">
            <header className="order-new__zone-head">
              <span className="order-new__zone-index order-new__zone-index--amber" aria-hidden="true">
                3
              </span>
              <div className="order-new__zone-head-text">
                <p className="order-new__zone-eyebrow">預覽</p>
                <h3 className="order-new__zone-title">司機當日任務</h3>
              </div>
            </header>
            <div className="order-new__zone-body order-new__zone-body--history">
              {!assignForm.driverId || !assignForm.assignmentDate ? (
                <p className="text-muted order-new__placeholder-sm">請於區塊 ④ 選擇司機與配送日。</p>
              ) : routeLoading ? (
                <p className="text-muted order-new__placeholder-sm">載入路線…</p>
              ) : routeError ? (
                <p className="feedback feedback--err order-new__placeholder-sm">{routeError}</p>
              ) : (
                <>
                  <p className="order-new__subsection-label order-new__subsection-label--inline">當日配送訂單</p>
                  {routeAssignments.length === 0 ? (
                    <p className="text-muted order-new__placeholder-sm">此配送日尚無任務。</p>
                  ) : (
                    <div className="order-new__history-table order-assign__pick-scroll" role="list">
                      {routeAssignments.map((row) => {
                        const so = row.salesOrder;
                        const cust = so?.customer;
                        const code = cust?.customerCode ?? "------";
                        const goods = goodsSummaryFromLines(so?.lines as IncompleteOrder["lines"] | undefined);
                        return (
                          <div key={String(row.id)} className="order-new__history-row" role="listitem">
                            <span className="order-new__history-row__top">
                              <span className="mono-text">{so?.orderNo ?? "—"}</span>
                              {row.status ? (
                                <span className={deliveryAssignmentStatusBadgeClass(row.status)}>
                                  {deliveryAssignmentStatusLabel(row.status)}
                                </span>
                              ) : null}
                            </span>
                            <span className="text-muted">
                              {code} · {cust?.name ?? "—"}
                              {row.vehicle?.plateNo ? ` · ${row.vehicle.plateNo}` : ""}
                            </span>
                            {goods ? <span className="order-new__history-row__goods">{goods}</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <hr className="order-new__surface-rule" />

                  <p className="order-new__subsection-label order-new__subsection-label--inline">商品數量彙總</p>
                  {routeTotals.length === 0 ? (
                    <p className="text-muted order-new__placeholder-sm">無明細可彙總。</p>
                  ) : (
                    <ul className="order-assign__tot-list">
                      {routeTotals.map((t) => (
                        <li key={`${t.productId}-${t.label}`} className="order-assign__tot-item">
                          <span className="order-assign__tot-name">{t.label}</span>
                          <span className="order-assign__tot-qty mono-text">
                            <strong>{t.qtyTotal}</strong>
                            {t.unit ? ` ${t.unit}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>

        <section className="order-new__zone order-new__zone--lines" aria-labelledby="order-assign-zone-submit-title">
          <header className="order-new__zone-head order-new__zone-head--flush">
            <span className="order-new__zone-index order-new__zone-index--brand" aria-hidden="true">
              4
            </span>
            <div className="order-new__zone-head-text">
              <p className="order-new__zone-eyebrow">分派 · 送出</p>
              <h3 id="order-assign-zone-submit-title" className="order-new__zone-title">
                司機、車輛與配送日
              </h3>
            </div>
          </header>
          <div className="order-new__zone-body order-new__zone-body--lines">
            <div className="form-row-2">
              <div className="field">
                <label htmlFor="order-assign-driver">司機</label>
                <select
                  id="order-assign-driver"
                  className="order-new__select-block"
                  value={assignForm.driverId}
                  onChange={(e) => setAssignForm({ ...assignForm, driverId: e.target.value })}
                >
                  <option value="">請選擇</option>
                  {drivers.map((d) => (
                    <option key={String(d.id)} value={String(d.id)}>
                      {driverEmployeeCode(d) || "-"} / {d.user?.name ?? "-"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="order-assign-vehicle">車輛（選填）</label>
                <select
                  id="order-assign-vehicle"
                  className="order-new__select-block"
                  value={assignForm.vehicleId}
                  onChange={(e) => setAssignForm({ ...assignForm, vehicleId: e.target.value })}
                >
                  <option value="">不指定車輛</option>
                  {vehicles.map((v) => (
                    <option key={String(v.id)} value={String(v.id)}>
                      {v.plateNo}
                      {v.description ? ` — ${v.description}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field order-new__field--date">
              <label htmlFor="order-assign-date">配送日</label>
              <input
                id="order-assign-date"
                type="date"
                className="order-new__input-date"
                value={assignForm.assignmentDate}
                onChange={(e) => setAssignForm({ ...assignForm, assignmentDate: e.target.value })}
              />
            </div>

            <div className="order-assign__selected-order">
              <p className="order-new__subsection-label order-new__subsection-label--inline">目前選擇的訂單</p>
              {selectedOrderSummary ? (
                <div className="order-assign__selected-inner">
                  <p className="mono-text">
                    <strong>{selectedOrderSummary.orderNo}</strong> ·{" "}
                    <span className={orderStatusBadgeClass(String(selectedOrderSummary.status))}>
                      {orderStatusLabel(selectedOrderSummary.status)}
                    </span>
                  </p>
                  <p className="text-muted">{describeLatestAssignment(selectedOrderSummary)}</p>
                  <p className="order-new__history-row__goods">{goodsSummary(selectedOrderSummary) || "無明細"}</p>
                </div>
              ) : (
                <p className="text-muted order-new__placeholder-sm">請於區塊 ② 點選一筆未完成訂單。</p>
              )}
            </div>

            <div className="order-new__submit-area order-new__submit-area--inline">
              <div className="form-actions">
                <button type="submit" className="btn btn--primary" disabled={assigning}>
                  {assigning ? "分派中..." : "確認分派"}
                </button>
                {assignMessage ? (
                  <span className={assignMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>
                    {assignMessage}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </form>
    </section>
  );
}
