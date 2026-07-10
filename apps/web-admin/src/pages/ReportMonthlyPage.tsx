import { useEffect } from "react";
import ReportPeriodView from "../components/ReportPeriodView";
import { todayLocalYm } from "../adminUtils";
import { useDashboard } from "../DashboardContext";

export default function ReportMonthlyPage() {
  const { setSummaryFilter } = useDashboard();
  const ym = todayLocalYm();

  useEffect(() => {
    setSummaryFilter((prev) => ({ ...prev, range: "month" }));
  }, [setSummaryFilter]);

  return (
    <ReportPeriodView
      range="month"
      statsMode="monthly"
      periodLabel="本月"
      pageTitle="月報表"
      expenseTitle="本月支出"
      expenseSummaryUrl={`/api/expense-vouchers/reports/monthly?ym=${ym}`}
      expenseLinkTo="/expenses/reports"
      expenseLinkLabel="查看支出報表"
    />
  );
}
