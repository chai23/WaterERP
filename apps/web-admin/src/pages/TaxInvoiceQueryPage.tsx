import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import TaxInvoiceRegisterModal from "../components/TaxInvoiceRegisterModal";
import type { TaxInvoiceRecord } from "../taxInvoiceUtils";
import {
  taxInvoiceBasisLabel,
  taxInvoiceModeLabel,
  taxInvoiceStatusLabel,
} from "../taxInvoiceUtils";

export default function TaxInvoiceQueryPage() {
  const { customers } = useDashboard();
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [dateTo, setDateTo] = useState(todayLocalYmd());
  const [customerId, setCustomerId] = useState("");
  const [status, setStatus] = useState("planned");
  const [basisType, setBasisType] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TaxInvoiceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [registerTarget, setRegisterTarget] = useState<TaxInvoiceRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (customerId) params.set("customerId", customerId);
    if (status) params.set("status", status);
    if (basisType) params.set("basisType", basisType);
    if (q.trim()) params.set("q", q.trim());
    try {
      const res = await fetch(`/api/tax-invoices?${params}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.message ?? "查詢失敗");
      setRows(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "查詢失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, customerId, status, basisType, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = (updated: TaxInvoiceRecord) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    setMsg(updated.status === "voided" ? "發票已作廢" : "發票號碼已儲存");
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">發票查詢與補登</h2>
        <p className="page__desc text-muted">
          系統於打單、月結開立、預收儲值時自動建立「待開票」紀錄；財務開完發票後在此補登實際發票號碼。
        </p>
      </header>

      <section className="card">
        <div className="form-grid form-grid--wide">
          <label className="field">
            <span>起日</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>迄日</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label className="field">
            <span>客戶</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">全部</option>
              {customers.map((c) => (
                <option key={String(c.id)} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>狀態</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部</option>
              <option value="planned">待開票</option>
              <option value="issued">已開票</option>
              <option value="voided">已作廢</option>
            </select>
          </label>
          <label className="field">
            <span>來源</span>
            <select value={basisType} onChange={(e) => setBasisType(e.target.value)}>
              <option value="">全部</option>
              <option value="sales_order">訂單（現金／儲值）</option>
              <option value="billing_statement">月結批次</option>
              <option value="prepayment_topup">預收儲值</option>
            </select>
          </label>
          <label className="field field--span2">
            <span>關鍵字</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="發票號碼、客戶、訂單、月結批次…"
            />
          </label>
          <div className="field field--actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? "查詢中…" : "查詢"}
            </button>
          </div>
        </div>

        {msg ? (
          <div className={msg.includes("已") ? "alert alert--ok" : "alert alert--error"} style={{ marginTop: "0.75rem" }}>
            {msg}
          </div>
        ) : null}

        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>建立日</th>
                <th>狀態</th>
                <th>實際發票號</th>
                <th>客戶</th>
                <th>來源</th>
                <th>關聯單據</th>
                <th>模式</th>
                <th className="num">含稅總額</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-muted">
                    {loading ? "讀取中…" : "無資料"}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="cell-nowrap">{String(r.createdAt).slice(0, 10)}</td>
                    <td>{taxInvoiceStatusLabel(r.status)}</td>
                    <td className="mono-text">{r.externalInvoiceNo?.trim() || "—"}</td>
                    <td>{r.customerName ?? "—"}</td>
                    <td>{taxInvoiceBasisLabel(r.basisType)}</td>
                    <td>
                      {r.salesOrderNo ? (
                        <Link to="/orders/query">{r.salesOrderNo}</Link>
                      ) : r.billingStatementNo ? (
                        r.billingStatementNo
                      ) : r.receiptVoucherNo ? (
                        r.receiptVoucherNo
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{taxInvoiceModeLabel(r.invoiceMode)}</td>
                    <td className="num">
                      <strong>{r.totalAmount}</strong>
                    </td>
                    <td>
                      {r.status === "planned" ? (
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => setRegisterTarget(r)}>
                          補登
                        </button>
                      ) : (
                        <button type="button" className="btn btn--sm" onClick={() => setRegisterTarget(r)}>
                          檢視
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card__hint" style={{ marginTop: "0.5rem" }}>
          內部編號（TI…）僅供系統追蹤；「實際發票號」為財務系統開出之發票號碼。預設篩選「待開票」。
        </p>
      </section>

      {registerTarget ? (
        <TaxInvoiceRegisterModal
          invoice={registerTarget}
          onClose={() => setRegisterTarget(null)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}
