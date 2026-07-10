import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import type { ExpenseVoucher } from "../expenseUtils";
import { paymentMethodLabel } from "../expenseUtils";

export default function ExpenseVerifyPage() {
  const { user } = useAuth();
  const { affiliatedCompanies } = useDashboard();
  const canVerify = user?.role === "admin" || user?.role === "accounting";
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [dateTo, setDateTo] = useState(todayLocalYmd());
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<ExpenseVoucher[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    const params = new URLSearchParams({ status: "pending" });
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (companyId) params.set("companyId", companyId);
    try {
      const res = await fetch(`/api/expense-vouchers?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "讀取失敗");
      setRows(Array.isArray(data) ? data : []);
      setSelected(new Set());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "讀取失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canVerify) {
    return <Navigate to="/expenses/query" replace />;
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => String(r.id))));
  };

  const verify = async () => {
    if (selected.size === 0) {
      setMsg("請至少選取一張待核銷憑證");
      return;
    }
    if (!window.confirm(`確定核銷 ${selected.size} 張支出憑證？核銷後不可修改。`)) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/expense-vouchers/batch-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setMsg(data.message ?? "核銷失敗");
        return;
      }
      setMsg(`已核銷 ${data.data?.count ?? 0} 張憑證`);
      await load();
    } catch {
      setMsg("核銷時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">會計核銷支出</h2>
        <p className="page__desc text-muted">僅會計與管理員可核銷。核銷後憑證鎖定不可修改。</p>
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
          <div className="field field--actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
              重新整理
            </button>
          </div>
        </div>

        {msg ? (
          <div className={`alert ${msg.includes("失敗") || msg.includes("請") ? "alert--error" : "alert--success"}`} style={{ marginTop: "1rem" }}>
            {msg}
          </div>
        ) : null}

        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <label>
            <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} />
            {" "}全選（{selected.size}/{rows.length}）
          </label>
          <button type="button" className="btn btn--primary btn--sm" disabled={saving || selected.size === 0} onClick={() => void verify()}>
            {saving ? "核銷中…" : "確認核銷選取項目"}
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th />
                <th>支出日期</th>
                <th>單號</th>
                <th>公司</th>
                <th>廠商</th>
                <th className="num">含稅總額</th>
                <th>付款</th>
                <th>明細數</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>
                    <input type="checkbox" checked={selected.has(String(v.id))} onChange={() => toggle(String(v.id))} />
                  </td>
                  <td className="cell-nowrap">{String(v.expenseDate).slice(0, 10)}</td>
                  <td>{v.voucherNo}</td>
                  <td>{v.affiliatedCompany?.name ?? "—"}</td>
                  <td>{v.vendorName}</td>
                  <td className="num">{v.totalAmount}</td>
                  <td>{paymentMethodLabel(v.paymentMethod)}</td>
                  <td>{v.lines?.length ?? 0}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>目前無待核銷憑證</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
