import { useEffect } from "react";
import ReportPeriodView from "../components/ReportPeriodView";
import { todayLocalYmd } from "../adminUtils";
import { useDashboard } from "../DashboardContext";

export default function ReportDailyPage() {
  const { setSummaryFilter } = useDashboard();
  const todayStr = todayLocalYmd();

  useEffect(() => {
    setSummaryFilter((prev) => ({ ...prev, range: "today" }));
  }, [setSummaryFilter]);

  return (
    <ReportPeriodView
      range="today"
      statsMode="daily"
      periodLabel="本日"
      pageTitle="日報表"
      expenseTitle="本日支出"
      expenseSummaryUrl={`/api/expense-vouchers/daily-summary?date=${todayStr}`}
      expenseLinkTo="/expenses/today"
      expenseLinkLabel="查看完整支出"
    />
  );
}
