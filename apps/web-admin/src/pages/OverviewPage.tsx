import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AccountingStatsSection from "../components/AccountingStatsSection";
import { useDashboard } from "../DashboardContext";
import { formatHealthStatus, healthLedClass } from "../adminUtils";

export default function OverviewPage() {
  const { health } = useDashboard();
  const [exceptionTotal, setExceptionTotal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/reports/exception-center?summaryOnly=1");
        const payload = await res.json();
        if (!res.ok || !payload?.ok) return;
        const n = Number(payload?.data?.totalCount);
        if (!cancelled && Number.isFinite(n)) setExceptionTotal(n);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <section className="card card--compact">
        <h2 className="card__title">連線狀態</h2>
        <div className="health-card">
          <span className={healthLedClass(health)} title="健康檢查" />
          <span className="health-card__status">{formatHealthStatus(health)}</span>
        </div>
      </section>

      <section className="card card--compact">
        <h2 className="card__title">今日待辦</h2>
        {exceptionTotal == null ? (
          <p className="text-muted">載入異常摘要…</p>
        ) : exceptionTotal > 0 ? (
          <p>
            <Link to="/reports/exceptions">今日待辦：異常 {exceptionTotal} 筆</Link>
          </p>
        ) : (
          <p className="text-muted">
            今日待辦：異常 0 筆（
            <Link to="/reports/exceptions">異常中心</Link>）
          </p>
        )}
      </section>

      <AccountingStatsSection mode="overview" />
    </>
  );
}
