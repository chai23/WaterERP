import { useMemo, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import ExpenseSummarySection from "../components/ExpenseSummarySection";

export default function ExpenseTodayPage() {
  const { affiliatedCompanies } = useDashboard();
  const [date, setDate] = useState(todayLocalYmd());
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");

  const summaryUrl = useMemo(() => {
    const params = new URLSearchParams({ date });
    if (companyId) params.set("companyId", companyId);
    if (status) params.set("status", status);
    if (vendor.trim()) params.set("vendor", vendor.trim());
    return `/api/expense-vouchers/today-summary?${params}`;
  }, [date, companyId, status, vendor]);

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">支出統計</h2>
        <p className="page__desc text-muted">依支出日期查看彙總與明細；預設為今日。</p>
      </header>

      <section className="card">
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
        title={`${date} 支出統計`}
        dateLabel={date}
        summaryUrl={summaryUrl}
      />
    </div>
  );
}
