import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { moneyText } from "../adminUtils";
import { downloadReportCsv } from "../reportUtils";

type ExceptionType =
  | "ar_past_due"
  | "cash_short"
  | "cash_over"
  | "delivered_unpaid"
  | "pending_settlement_stale"
  | "assigned_unreported"
  | "monthly_delivered_unbilled"
  | "prepaid_low"
  | "inventory_negative"
  | "deposit_barrels_stale"
  | "credit_over_limit";

type ExceptionItem = {
  type: ExceptionType;
  severity: "info" | "warn" | "critical";
  title: string;
  customerId?: string;
  customerName?: string;
  salesOrderId?: string;
  orderNo?: string;
  assignmentId?: string;
  productId?: string;
  productName?: string;
  driverId?: string;
  driverName?: string;
  amount?: string;
  expectedAmount?: string;
  collectedAmount?: string;
  variance?: string;
  qty?: number;
  qtyOnHand?: number;
  threshold?: number;
  dueDate?: string | null;
  overdueDays?: number;
  reportedAt?: string | null;
  assignmentDate?: string | null;
  deepLink?: string;
};

type ExceptionCenterData = {
  generatedAt: string;
  prepaidLowThreshold: number;
  depositStaleDays: number;
  totalCount: number;
  summary: Record<ExceptionType, number>;
  items: ExceptionItem[];
};

const TYPE_LABELS: Record<ExceptionType, string> = {
  ar_past_due: "AR 逾期",
  cash_short: "短收",
  cash_over: "溢收",
  delivered_unpaid: "已送達未收款",
  pending_settlement_stale: "待核銷逾時",
  assigned_unreported: "已分派未回報",
  monthly_delivered_unbilled: "月結未開帳",
  prepaid_low: "預付桶低水位",
  inventory_negative: "負庫存",
  deposit_barrels_stale: "押桶長期未收",
  credit_over_limit: "信用超限",
};

function severityBadge(severity: ExceptionItem["severity"]): string {
  if (severity === "critical") return "badge badge--danger";
  if (severity === "warn") return "badge badge--warn";
  return "badge badge--info";
}

export default function ReportExceptionCenterPage() {
  const [data, setData] = useState<ExceptionCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | ExceptionType>("");
  const [severityFilter, setSeverityFilter] = useState<"" | ExceptionItem["severity"]>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/reports/exception-center");
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setData(body.data as ExceptionCenterData);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const rows = data?.items ?? [];
    return rows.filter((r) => {
      if (typeFilter && r.type !== typeFilter) return false;
      if (severityFilter && r.severity !== severityFilter) return false;
      return true;
    });
  }, [data, typeFilter, severityFilter]);

  const exportCsv = () => {
    if (!data) return;
    downloadReportCsv(
      `exception-center-${data.generatedAt.slice(0, 10)}.csv`,
      ["類型", "嚴重度", "標題", "客戶", "單號", "司機", "金額", "數量", "日期", "連結"],
      filtered.map((r) => [
        TYPE_LABELS[r.type],
        r.severity,
        r.title,
        r.customerName ?? "",
        r.orderNo ?? "",
        r.driverName ?? "",
        r.amount ?? r.variance ?? "",
        r.qty ?? r.qtyOnHand ?? "",
        r.dueDate ?? r.assignmentDate ?? "",
        r.deepLink ?? "",
      ]),
    );
  };

  return (
    <>
      <header className="report-page-head">
        <h1 className="report-page-head__title">異常中心</h1>
        <p className="report-page-head__desc">
          聚合 AR 逾期、短溢收、待核銷逾時、已分派未回報、月結未開帳、預付低水位、負庫存、押桶長期未收與信用超限。
        </p>
      </header>

      <section className="card">
        <div className="toolbar" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">類型</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "" | ExceptionType)}>
              <option value="">全部類型</option>
              {(Object.keys(TYPE_LABELS) as ExceptionType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                  {data ? `（${data.summary[t] ?? 0}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">嚴重度</span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as "" | ExceptionItem["severity"])}
            >
              <option value="">全部</option>
              <option value="critical">critical</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
            </select>
          </label>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
            重新整理
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={!filtered.length}>
            匯出 CSV
          </button>
        </div>
        {data ? (
          <p className="card__hint" style={{ marginTop: "0.75rem" }}>
            共 {data.totalCount} 筆 · 產生於 {new Date(data.generatedAt).toLocaleString("zh-TW")} · 預付低水位 ≤{" "}
            {data.prepaidLowThreshold} · 押桶未收門檻 {data.depositStaleDays} 天
          </p>
        ) : null}
      </section>

      {data ? (
        <section className="card">
          <h2 className="card__title">異常摘要</h2>
          <div className="stats-grid stats-grid--metrics">
            {(Object.keys(TYPE_LABELS) as ExceptionType[])
              .filter((t) => (data.summary[t] ?? 0) > 0)
              .map((t) => (
                <article key={t} className="stat-card" style={{ cursor: "pointer" }} onClick={() => setTypeFilter(t)}>
                  <div className="stat-card__label">{TYPE_LABELS[t]}</div>
                  <div className="stat-card__value">{data.summary[t]}</div>
                </article>
              ))}
            {(Object.keys(TYPE_LABELS) as ExceptionType[]).every((t) => (data.summary[t] ?? 0) === 0) ? (
              <p className="card__hint">目前無異常。</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {loading ? <section className="card"><p className="card__hint">載入中…</p></section> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}

      <section className="card">
        <h2 className="card__title card__title--stacked">
          異常清單
          <span className="card__title-count">{filtered.length} 筆</span>
        </h2>
        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>嚴重度</th>
                <th>類型</th>
                <th>標題</th>
                <th>客戶／商品</th>
                <th>單號／司機</th>
                <th className="num">金額／數量</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => (
                <tr key={`${r.type}-${r.assignmentId ?? r.salesOrderId ?? r.productId ?? r.customerId ?? idx}`}>
                  <td>
                    <span className={severityBadge(r.severity)}>{r.severity}</span>
                  </td>
                  <td>{TYPE_LABELS[r.type]}</td>
                  <td>{r.title}</td>
                  <td>
                    {r.customerName ?? r.productName ?? "—"}
                    {r.productName && r.customerName ? ` · ${r.productName}` : ""}
                  </td>
                  <td>
                    {r.orderNo ?? "—"}
                    {r.driverName ? ` · ${r.driverName}` : ""}
                  </td>
                  <td className="num">
                    {r.amount != null ? moneyText(r.amount) : null}
                    {r.variance != null && r.amount == null ? `差 ${moneyText(r.variance)}` : null}
                    {r.qty != null ? `${r.qty} 桶` : null}
                    {r.qtyOnHand != null ? `庫存 ${r.qtyOnHand}` : null}
                    {r.overdueDays != null ? ` · ${r.overdueDays} 天` : null}
                    {r.amount == null && r.variance == null && r.qty == null && r.qtyOnHand == null ? "—" : null}
                  </td>
                  <td>
                    {r.deepLink ? (
                      <Link to={r.deepLink} className="btn btn--secondary btn--sm">
                        前往
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7}>無符合條件的異常</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
