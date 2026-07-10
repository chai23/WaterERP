import { useEffect, useMemo, useState } from "react";
import { todayLocalYm, todayLocalYmd } from "../adminUtils";
import type { ExpenseSummary } from "../expenseUtils";
import { exportExpenseLinesCsv } from "../expenseUtils";
import ExpenseSummarySection from "../components/ExpenseSummarySection";

export default function ExpenseReportsPage() {
  const [ym, setYm] = useState(todayLocalYm());
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  });
  const [dateTo, setDateTo] = useState(todayLocalYmd());
  const [byCategory, setByCategory] = useState<ExpenseSummary["byCategory"]>([]);
  const [catMsg, setCatMsg] = useState("");

  const monthlyUrl = useMemo(() => `/api/expense-vouchers/reports/monthly?ym=${ym}`, [ym]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    fetch(`/api/expense-vouchers/reports/by-category?${params}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body.ok === false) throw new Error(body.message);
        setByCategory(Array.isArray(body.data) ? body.data : []);
      })
      .catch((e) => setCatMsg(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => {});
  }, [dateFrom, dateTo]);

  const exportMonthly = async () => {
    const res = await fetch(monthlyUrl);
    const body = await res.json();
    if (!res.ok || !body.data) return;
    const summary = body.data as ExpenseSummary;
    exportExpenseLinesCsv(`expenses-monthly-${ym}.csv`, summary.lines);
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">支出報表</h2>
        <p className="page__desc text-muted">月支出總表與類別分析。</p>
      </header>

      <section className="card">
        <h3 className="card__subtitle">月支出總表</h3>
        <div className="form-grid" style={{ marginBottom: "1rem" }}>
          <label className="field">
            <span>月份</span>
            <input type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          </label>
          <div className="field field--actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void exportMonthly()}>
              匯出本月 CSV
            </button>
          </div>
        </div>
      </section>

      <ExpenseSummarySection title={`${ym} 月支出`} dateLabel={ym} summaryUrl={monthlyUrl} />

      <section className="card">
        <h3 className="card__subtitle">類別分析</h3>
        <div className="form-grid form-grid--wide" style={{ marginBottom: "1rem" }}>
          <label className="field">
            <span>起日</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>迄日</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
        </div>
        {catMsg ? <div className="alert alert--error">{catMsg}</div> : null}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>類別</th>
                <th className="num">筆數</th>
                <th className="num">含稅金額</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{Number(c.totalAmount).toLocaleString()}</td>
                </tr>
              ))}
              {byCategory.length === 0 ? (
                <tr>
                  <td colSpan={3}>此區間無資料</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
