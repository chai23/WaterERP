import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import { todayLocalYm, todayLocalYmd } from "../adminUtils";
import ExpenseSummarySection from "../components/ExpenseSummarySection";
import type { ExpenseSummary } from "../expenseUtils";
import { exportExpenseLinesCsv } from "../expenseUtils";

type TabId = "daily" | "monthly";

function parseTab(raw: string | null): TabId {
  if (raw === "monthly" || raw === "reports") return "monthly";
  return "daily";
}

export default function ExpenseAnalyticsPage() {
  const { affiliatedCompanies } = useDashboard();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  const [date, setDate] = useState(todayLocalYmd());
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");

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
  const [catLoading, setCatLoading] = useState(false);

  const setTab = (next: TabId) => {
    setSearchParams(next === "daily" ? {} : { tab: "monthly" }, { replace: true });
  };

  const dailySummaryUrl = useMemo(() => {
    const params = new URLSearchParams({ date });
    if (companyId) params.set("companyId", companyId);
    if (status) params.set("status", status);
    if (vendor.trim()) params.set("vendor", vendor.trim());
    return `/api/expense-vouchers/today-summary?${params}`;
  }, [date, companyId, status, vendor]);

  const monthlyUrl = useMemo(() => `/api/expense-vouchers/reports/monthly?ym=${ym}`, [ym]);

  useEffect(() => {
    if (tab !== "monthly") return;
    setCatLoading(true);
    setCatMsg("");
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    fetch(`/api/expense-vouchers/reports/by-category?${params}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body.ok === false) throw new Error(body.message);
        setByCategory(Array.isArray(body.data) ? body.data : []);
      })
      .catch((e) => {
        setByCategory([]);
        setCatMsg(e instanceof Error ? e.message : "讀取失敗");
      })
      .finally(() => setCatLoading(false));
  }, [tab, dateFrom, dateTo]);

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
        <p className="page__desc text-muted">請先在下方選擇「日報表」或「月報表」，再依日期／月份查看支出彙總與明細。</p>
      </header>

      <section className="expense-report-switch" aria-label="報表類型選擇">
        <p className="expense-report-switch__lead">選擇報表類型</p>
        <div className="expense-report-switch__grid" role="tablist" aria-label="日報表與月報表">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "daily"}
            className={`expense-report-switch__btn${tab === "daily" ? " expense-report-switch__btn--active" : ""}`}
            onClick={() => setTab("daily")}
          >
            <span className="expense-report-switch__name">日報表</span>
            <span className="expense-report-switch__desc">依單日查看支出彙總與明細</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "monthly"}
            className={`expense-report-switch__btn${tab === "monthly" ? " expense-report-switch__btn--active" : ""}`}
            onClick={() => setTab("monthly")}
          >
            <span className="expense-report-switch__name">月報表</span>
            <span className="expense-report-switch__desc">月總表、CSV 匯出與類別分析</span>
          </button>
        </div>
      </section>

      {tab === "daily" ? (
        <div role="tabpanel" aria-label="日報表">
          <section className="card">
            <h3 className="card__title">日報表篩選</h3>
            <div className="form-grid form-grid--wide">
              <label className="field">
                <span>支出日期</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
              <label className="field">
                <span>廠商</span>
                <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="模糊搜尋" />
              </label>
            </div>
          </section>

          <ExpenseSummarySection
            title={`${date} 日報表`}
            dateLabel={date}
            summaryUrl={dailySummaryUrl}
          />
        </div>
      ) : (
        <div role="tabpanel" aria-label="月報表">
          <section className="card">
            <h3 className="card__title">月支出總表</h3>
            <div className="form-grid form-grid--wide" style={{ marginBottom: "0.25rem" }}>
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

          <ExpenseSummarySection title={`${ym} 月報表`} dateLabel={ym} summaryUrl={monthlyUrl} />

          <section className="card">
            <h3 className="card__title">類別分析</h3>
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
            <div className="table-wrap table-wrap--card-mobile">
              <table className="data-table data-table--card">
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
                      <td data-label="類別">{c.name}</td>
                      <td className="num" data-label="筆數">{c.count}</td>
                      <td className="num" data-label="含稅金額">{Number(c.totalAmount).toLocaleString()}</td>
                    </tr>
                  ))}
                  {!catLoading && byCategory.length === 0 ? (
                    <tr>
                      <td colSpan={3}>此區間無資料</td>
                    </tr>
                  ) : null}
                  {catLoading ? (
                    <tr>
                      <td colSpan={3}>載入中…</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
