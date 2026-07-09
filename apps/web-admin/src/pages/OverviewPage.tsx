import AccountingStatsSection from "../components/AccountingStatsSection";
import { useDashboard } from "../DashboardContext";
import { formatHealthStatus, healthLedClass } from "../adminUtils";

export default function OverviewPage() {
  const { health } = useDashboard();

  return (
    <>
      <section className="card card--compact">
        <h2 className="card__title">連線狀態</h2>
        <div className="health-card">
          <span className={healthLedClass(health)} title="健康檢查" />
          <span className="health-card__status">{formatHealthStatus(health)}</span>
        </div>
      </section>

      <AccountingStatsSection mode="overview" />
    </>
  );
}
