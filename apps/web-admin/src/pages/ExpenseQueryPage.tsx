import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import type { ExpenseVoucher } from "../expenseUtils";
import { paymentMethodLabel, statusLabel } from "../expenseUtils";

export default function ExpenseQueryPage() {
  const { affiliatedCompanies } = useDashboard();
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [dateTo, setDateTo] = useState(todayLocalYmd());
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ExpenseVoucher[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (companyId) params.set("companyId", companyId);
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    try {
      const res = await fetch(`/api/expense-vouchers?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "查詢失敗");
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "查詢失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, companyId, status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">查詢支出</h2>
        <p className="page__desc text-muted">依日期區間、公司、核銷狀態篩選；點單號可編輯待核銷憑證。</p>
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
            <span>公司</span>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">全部</option>
              {affiliatedCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>核銷狀態</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部</option>
              <option value="pending">待核銷</option>
              <option value="verified">已核銷</option>
            </select>
          </label>
          <label className="field field--span2">
            <span>關鍵字</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、廠商、項目、客戶…" />
          </label>
          <div className="field field--actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? "查詢中…" : "查詢"}
            </button>
          </div>
        </div>

        {msg ? <div className="alert alert--error">{msg}</div> : null}

        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>支出日期</th>
                <th>單號</th>
                <th>公司</th>
                <th>廠商</th>
                <th className="num">含稅總額</th>
                <th>付款</th>
                <th>核銷</th>
                <th>登錄人</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="cell-nowrap">{String(v.expenseDate).slice(0, 10)}</td>
                  <td>{v.voucherNo}</td>
                  <td>{v.affiliatedCompany?.name ?? "—"}</td>
                  <td>{v.vendorName}</td>
                  <td className="num">{v.totalAmount}</td>
                  <td>{paymentMethodLabel(v.paymentMethod)}</td>
                  <td>
                    <span className={`badge ${v.status === "verified" ? "badge--completed" : "badge--default"}`}>
                      {statusLabel(v.status)}
                    </span>
                  </td>
                  <td>{v.createdBy?.name ?? "—"}</td>
                  <td>
                    <Link className="btn btn--secondary btn--sm" to={`/expenses/edit/${v.id}`}>
                      {v.status === "verified" ? "檢視" : "編輯"}
                    </Link>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={9}>查無資料</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
