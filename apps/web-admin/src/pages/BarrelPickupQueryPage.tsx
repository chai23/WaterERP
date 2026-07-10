import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Customer } from "../adminUtils";
import {
  barrelCollectionSourceBadgeClass,
  barrelCollectionSourceLabel,
  barrelPickupStatusBadgeClass,
  barrelPickupStatusLabel,
  formatBarrelSiteChangeSummary,
  sumCustomerBarrelsOnSite,
  todayLocalYmd,
} from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { useDashboard } from "../DashboardContext";

type CollectionRow = {
  id: string;
  sourceType: "pickup" | "delivery";
  refNo?: string;
  refId?: string;
  status: string;
  collectionDate?: string;
  movementDate?: string;
  barrelsExpected?: number | null;
  barrelsReturned?: number | null;
  barrelsDelivered?: number | null;
  barrelNet?: number | null;
  barrelsOnSiteBefore?: number | null;
  barrelsOnSiteAfter?: number | null;
  barrelSiteChangeSummary?: string | null;
  barrelSitePreview?: boolean;
  ledgerId?: string | null;
  driverReportedAt?: string | null;
  officeSettledAt?: string | null;
  occurredAt?: string | null;
  note?: string | null;
  customer?: { id?: string; name?: string; customerCode?: string | null };
  deliveryAddress?: { id?: string; label?: string | null; addressLine?: string; barrelsOnSite?: number };
  driver?: { user?: { employeeCode?: string; name?: string } };
  vehicle?: { plateNo?: string };
};

const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部類型" },
  { value: "pickup", label: "純收空桶" },
  { value: "delivery", label: "配送順收" },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部狀態" },
  { value: "assigned", label: "已分派" },
  { value: "pending_settlement", label: "待辦公室核銷" },
  { value: "completed", label: "已核銷結案" },
  { value: "cancelled", label: "已取消" },
];

const VIEW_MODES = [
  { value: "operational", label: "作業紀錄（含待核銷）" },
  { value: "ledger", label: "稽核流水（僅已核銷）" },
] as const;

type ViewMode = (typeof VIEW_MODES)[number]["value"];

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
  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, "0");
    if (code === q || code === padded) return 1_000_000;
    if (code.startsWith(q)) return 900_000;
  }
  const name = (c.name ?? "").toLowerCase();
  if (name.includes(q)) return 480_000;
  const qDigits = digitsOnly(qRaw);
  if (qDigits.length >= 6) {
    const phone = digitsOnly(c.phone ?? "");
    if (phone.includes(qDigits)) return 760_000;
  }
  if (q.length >= 2 && charsInOrder(q, name)) return 220_000;
  return 0;
}

function fmtDt(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 19).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateOnly(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatBarrelNet(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v > 0) return `+${v}`;
  return String(v);
}

function addressGroupKey(row: CollectionRow): string {
  return row.deliveryAddress?.id ? String(row.deliveryAddress.id) : "unknown";
}

export default function BarrelPickupQueryPage() {
  const { customers } = useDashboard();
  const [searchParams] = useSearchParams();

  const [keyword, setKeyword] = useState(() => searchParams.get("q") ?? "");
  const [customerId, setCustomerId] = useState("");

  const [viewMode, setViewMode] = useState<ViewMode>("operational");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [detailOrder, setDetailOrder] = useState<OrderRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const candidates = useMemo(() => {
    const q = keyword.trim();
    if (!q) return [];
    return customers
      .map((c) => ({ c, score: scoreCustomerMatch(c, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.c);
  }, [customers, keyword]);

  // 完全命中（例如輸入完整 6 碼編號）時自動選定
  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setCustomerId("");
      return;
    }
    if (customerId && candidates.some((c) => String(c.id) === customerId)) return;
    const exact = candidates.find(
      (c) => (c.customerCode ?? "").trim() === q || (c.customerCode ?? "").trim() === q.padStart(6, "0"),
    );
    if (exact) {
      setCustomerId(String(exact.id));
    } else if (candidates.length === 1) {
      setCustomerId(String(candidates[0].id));
    } else {
      setCustomerId("");
    }
  }, [keyword, candidates, customerId]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => String(c.id) === customerId) ?? null,
    [customers, customerId],
  );

  const load = useCallback(async () => {
    if (!customerId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams({ customerId });
      params.set("source", source || "all");
      if (viewMode === "operational" && status) params.set("status", status);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const endpoint = viewMode === "ledger" ? "/api/barrel-movements" : "/api/barrel-collections";
      const r = await fetch(`${endpoint}?${params.toString()}`);
      const data = await r.json();
      if (!r.ok) {
        setErr(typeof data?.message === "string" ? data.message : "讀取失敗");
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setErr("讀取失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [customerId, source, status, dateFrom, dateTo, viewMode]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDeliveryOrder = async (row: CollectionRow) => {
    if (row.sourceType !== "delivery" || !row.refId) return;
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/sales-orders/${encodeURIComponent(row.refId)}`);
      const data = await res.json();
      if (!res.ok) {
        window.alert(typeof data?.message === "string" ? data.message : "讀取訂單失敗");
        return;
      }
      setDetailOrder(data as OrderRecord);
    } catch {
      window.alert("讀取訂單失敗");
    } finally {
      setDetailLoading(false);
    }
  };

  /** 依送貨點分組（重複的送貨點資訊每組只顯示一次） */
  const groups = useMemo(() => {
    const map = new Map<string, { address: CollectionRow["deliveryAddress"]; rows: CollectionRow[] }>();
    for (const row of rows) {
      const key = addressGroupKey(row);
      if (!map.has(key)) map.set(key, { address: row.deliveryAddress, rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.values()];
  }, [rows]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.returned += Math.max(0, Number(row.barrelsReturned ?? 0));
        if (row.sourceType === "pickup") acc.pickup += 1;
        if (row.sourceType === "delivery") acc.delivery += 1;
        if (row.status === "pending_settlement") acc.pending += 1;
        return acc;
      },
      { returned: 0, pickup: 0, delivery: 0, pending: 0 },
    );
  }, [rows]);

  const quickThisMonth = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    setDateFrom(`${yyyy}-${mm}-01`);
    setDateTo(todayLocalYmd());
  };

  const exportCsv = () => {
    if (!selectedCustomer) return;
    const header = [
      "客戶編號",
      "客戶",
      "送貨點",
      "收桶日",
      "類型",
      "狀態",
      "單號",
      "出貨押桶",
      "實收",
      "淨增減",
      "客戶押桶變化",
      "司機",
      "車輛",
      "核銷時間",
      "備註",
    ];
    const lines = rows.map((row) => [
      selectedCustomer.customerCode ?? "",
      selectedCustomer.name,
      `${row.deliveryAddress?.label ? `${row.deliveryAddress.label} · ` : ""}${row.deliveryAddress?.addressLine ?? ""}`,
      fmtDateOnly(row.collectionDate ?? row.movementDate),
      barrelCollectionSourceLabel(row.sourceType),
      barrelPickupStatusLabel(row.status),
      row.refNo ?? "",
      row.barrelsDelivered ?? "",
      row.barrelsReturned ?? "",
      row.barrelNet ?? "",
      formatBarrelSiteChangeSummary(row),
      `${row.driver?.user?.employeeCode ? `${row.driver.user.employeeCode} / ` : ""}${row.driver?.user?.name ?? ""}`,
      row.vehicle?.plateNo ?? "",
      fmtDt(row.officeSettledAt ?? row.occurredAt),
      row.note || "",
    ]);
    const csv = [header, ...lines].map((line) => line.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `barrel-collections-${selectedCustomer.customerCode ?? selectedCustomer.name}-${todayLocalYmd()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">查詢空桶回收</h2>
        <p className="page__desc text-muted">先查詢並選定客戶，再檢視該客戶的空桶回收紀錄（純收空桶與配送順收）。</p>
      </header>

      <section className="card">
        <div className="card__body">
          <div className="field" style={{ maxWidth: "24rem" }}>
            <span>客戶關鍵字</span>
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="6 碼編號、姓名或電話"
              autoComplete="off"
            />
          </div>

          {keyword.trim() && candidates.length === 0 ? (
            <p className="text-muted" style={{ marginTop: "0.5rem" }}>
              找不到相符客戶。
            </p>
          ) : null}

          {!customerId && candidates.length > 1 ? (
            <div style={{ marginTop: "0.5rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {candidates.map((c) => (
                <button
                  key={String(c.id)}
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setCustomerId(String(c.id))}
                >
                  {c.customerCode ?? "------"} · {c.name}
                </button>
              ))}
            </div>
          ) : null}

          {selectedCustomer ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p className="order-new__identity order-new__identity--compact">
                <strong>{selectedCustomer.customerCode ?? "------"}</strong> · <strong>{selectedCustomer.name}</strong>
                {selectedCustomer.phone ? <span style={{ marginLeft: "0.75rem" }}>電話 {selectedCustomer.phone}</span> : null}
                <span style={{ marginLeft: "0.75rem" }}>
                  未收回空桶合計 <strong>{sumCustomerBarrelsOnSite(selectedCustomer)}</strong> 桶
                </span>
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {selectedCustomer ? (
        <section className="card">
          <div className="card__body">
            <div className="field-row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "flex-end" }}>
              <div className="field">
                <span>檢視</span>
                <select value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)}>
                  {VIEW_MODES.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span>類型</span>
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  {SOURCE_FILTERS.map((f) => (
                    <option key={f.value || "all"} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              {viewMode === "operational" ? (
                <div className="field">
                  <span>狀態</span>
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUS_FILTERS.map((f) => (
                      <option key={f.value || "all"} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="field">
                <span>收桶日（起）</span>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
              <div className="field">
                <span>收桶日（迄）</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
              <button type="button" className="btn btn--secondary btn--sm" onClick={quickThisMonth}>
                本月
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
                {loading ? "查詢中…" : "重新整理"}
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={rows.length === 0}>
                匯出 CSV
              </button>
            </div>

            <div className="card__hint" style={{ marginTop: "0.75rem" }}>
              共 {rows.length} 筆（純收空桶 {totals.pickup} 筆、配送順收 {totals.delivery} 筆
              {viewMode === "operational" ? `、待核銷 ${totals.pending} 筆` : ""}）；實收桶數合計 {totals.returned} 桶。
              {detailLoading ? <span style={{ marginLeft: "0.75rem" }}>訂單明細載入中…</span> : null}
            </div>
            {err ? (
              <div className="alert alert--error" style={{ marginTop: "0.75rem" }}>
                {err}
              </div>
            ) : null}

            {!loading && rows.length === 0 && !err ? (
              <p className="card__hint" style={{ marginTop: "0.75rem" }}>
                此客戶在目前條件下沒有空桶回收紀錄。
              </p>
            ) : null}

            {groups.map((group) => (
              <div key={group.address?.id ?? "unknown"} style={{ marginTop: "1rem" }}>
                <h3 className="card__title" style={{ fontSize: "0.9375rem", marginBottom: "0.5rem" }}>
                  {group.address?.label ? `${group.address.label} · ` : ""}
                  {group.address?.addressLine ?? "送貨點不明"}
                  {group.address?.barrelsOnSite != null ? (
                    <span className="badge badge--default" style={{ marginLeft: "0.5rem" }}>
                      目前在場 {group.address.barrelsOnSite} 桶
                    </span>
                  ) : null}
                </h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>收桶日</th>
                        <th>類型</th>
                        {viewMode === "operational" ? <th>狀態</th> : null}
                        <th>單號</th>
                        <th className="num">出貨（押桶）</th>
                        <th className="num">實收</th>
                        <th className="num">淨增減</th>
                        <th>客戶押桶變化</th>
                        <th>司機</th>
                        <th>{viewMode === "ledger" ? "核銷時間" : "辦公室核銷"}</th>
                        <th>備註</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={`${row.sourceType}-${row.id}`}>
                          <td className="cell-nowrap">{fmtDateOnly(row.collectionDate ?? row.movementDate)}</td>
                          <td>
                            <span className={barrelCollectionSourceBadgeClass(row.sourceType)}>
                              {barrelCollectionSourceLabel(row.sourceType)}
                            </span>
                          </td>
                          {viewMode === "operational" ? (
                            <td>
                              <span className={barrelPickupStatusBadgeClass(row.status)}>
                                {barrelPickupStatusLabel(row.status)}
                              </span>
                            </td>
                          ) : null}
                          <td>
                            {row.sourceType === "delivery" && row.refId ? (
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                style={{ padding: "0 0.25rem", fontSize: "0.8em" }}
                                onClick={() => void openDeliveryOrder(row)}
                                disabled={detailLoading}
                                title="開啟訂單明細"
                              >
                                <code>{row.refNo ?? "—"}</code>
                              </button>
                            ) : (
                              <code style={{ fontSize: "0.8em" }}>{row.refNo ?? "—"}</code>
                            )}
                          </td>
                          <td className="num">{row.sourceType === "delivery" ? (row.barrelsDelivered ?? "—") : "—"}</td>
                          <td className="num">{row.barrelsReturned ?? "—"}</td>
                          <td className="num">
                            {row.sourceType === "delivery" || viewMode === "ledger" ? formatBarrelNet(row.barrelNet) : "—"}
                          </td>
                          <td style={{ minWidth: "13rem", fontSize: "0.875rem" }}>{formatBarrelSiteChangeSummary(row)}</td>
                          <td className="cell-nowrap">
                            {row.driver?.user?.name ?? "—"}
                            {row.vehicle?.plateNo ? (
                              <span className="text-muted" style={{ marginLeft: "0.35rem", fontSize: "0.8em" }}>
                                {row.vehicle.plateNo}
                              </span>
                            ) : null}
                          </td>
                          <td className="cell-nowrap">{fmtDt(row.officeSettledAt ?? row.occurredAt)}</td>
                          <td>{row.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {detailOrder ? <OrderDetailModal order={detailOrder} onClose={() => setDetailOrder(null)} /> : null}
    </div>
  );
}
