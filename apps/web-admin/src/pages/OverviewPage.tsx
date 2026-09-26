import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AccountingStatsSection from "../components/AccountingStatsSection";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { formatHealthStatus, healthLedClass, moneyText } from "../adminUtils";
import { canAccessPath } from "../rolePermissions";
import { useMediaQuery } from "../useMediaQuery";

export default function OverviewPage() {
  const { loadSummary } = useDashboard();
  const [exceptionTotal, setExceptionTotal] = useState<number | null>(null);
  const isMobile = useMediaQuery("(max-width: 768px)");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadSummary();
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
  }, [loadSummary]);

  if (isMobile) {
    return <MobileOverview exceptionTotal={exceptionTotal} />;
  }

  return (
    <>
      <section className="card card--compact">
        <h2 className="card__title">連線狀態</h2>
        <HealthRow />
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

function HealthRow() {
  const { health } = useDashboard();
  return (
    <div className="health-card">
      <span className={healthLedClass(health)} title="健康檢查" />
      <span className="health-card__status">{formatHealthStatus(health)}</span>
    </div>
  );
}

function MobileOverview({ exceptionTotal }: { exceptionTotal: number | null }) {
  const { user } = useAuth();
  const { health, summary, summaryFilter, setSummaryFilter } = useDashboard();
  const pendingMonthly = Number(summary.periodPendingMonthly ?? 0);
  const pendingMonthlyCount = Number(summary.periodPendingMonthlyCount ?? 0);
  const arOutstanding = Number(summary.periodOrderOutstanding ?? 0);
  const receivableTotal = Number(summary.periodReceivableTotal ?? arOutstanding + pendingMonthly);
  const healthOk = healthLedClass(health).includes("status-led--ok");
  const todayLabel = new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date());

  const setRange = (range: "today" | "month" | "custom") => {
    setSummaryFilter((prev) => ({ ...prev, range }));
  };

  const actions = [
    { to: "/orders/query", label: "查詢訂單" },
    { to: "/data/customers", label: "客戶資料" },
    { to: "/orders/new", label: "建立訂單" },
    { to: "/reports/exceptions", label: "異常中心" },
  ].filter((item) => canAccessPath(user?.role, item.to));

  return (
    <div className="ov-mobile">
      <div className="ov-mobile__status">
        <span className={`ov-mobile__pulse${healthOk ? " ov-mobile__pulse--ok" : " ov-mobile__pulse--bad"}`} />
        <span>{healthOk ? "系統正常" : formatHealthStatus(health)}</span>
        <time>{todayLabel}</time>
      </div>

      {exceptionTotal == null ? (
        <p className="ov-mobile__todo ov-mobile__todo--loading">載入今日待辦…</p>
      ) : (
        <Link
          to="/reports/exceptions"
          className={`ov-mobile__todo${exceptionTotal > 0 ? " ov-mobile__todo--alert" : " ov-mobile__todo--ok"}`}
        >
          <strong>{exceptionTotal > 0 ? "今日待辦" : "今日無待辦"}</strong>
          <span>{exceptionTotal > 0 ? `異常 ${exceptionTotal.toLocaleString("zh-TW")} 筆，點此查看` : "點此進入異常中心"}</span>
        </Link>
      )}

      <section className="ov-mobile__panel">
        <div className="ov-mobile__period" role="group" aria-label="統計區間">
          {(
            [
              ["today", "本日"],
              ["month", "本月"],
              ["custom", "自訂"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={summaryFilter.range === value ? "is-active" : ""}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {summaryFilter.range === "custom" ? (
          <div className="ov-mobile__dates">
            <input
              type="date"
              value={summaryFilter.startDate}
              onChange={(e) => setSummaryFilter((prev) => ({ ...prev, startDate: e.target.value }))}
            />
            <span>至</span>
            <input
              type="date"
              value={summaryFilter.endDate}
              onChange={(e) => setSummaryFilter((prev) => ({ ...prev, endDate: e.target.value }))}
            />
          </div>
        ) : (
          <p className="ov-mobile__range">
            {summary.startDate === summary.endDate ? summary.startDate : `${summary.startDate} ～ ${summary.endDate}`}
          </p>
        )}

        <div className="ov-mobile__kpis">
          <article className="ov-mobile__kpi ov-mobile__kpi--revenue">
            <span>營收</span>
            <strong>{moneyText(summary.periodRevenue)}</strong>
            <small>
              現金 {moneyText(summary.revenueCash)} · 月結 {moneyText(summary.revenueMonthly)}
            </small>
          </article>
          <article className="ov-mobile__kpi ov-mobile__kpi--cash">
            <span>已收款</span>
            <strong>{moneyText(summary.periodCollected)}</strong>
            <small>現金 {moneyText(summary.periodCollectedCash)}</small>
          </article>
          <article className="ov-mobile__kpi ov-mobile__kpi--count">
            <span>完成單</span>
            <strong>{summary.todayCompletedCount.toLocaleString("zh-TW")}</strong>
            <small>配送／服務完成</small>
          </article>
          <article className={`ov-mobile__kpi ov-mobile__kpi--due${receivableTotal > 0 ? " is-warn" : ""}`}>
            <span>待收款</span>
            <strong>{moneyText(receivableTotal)}</strong>
            <small>
              AR {moneyText(arOutstanding)}
              {pendingMonthlyCount > 0 ? ` · 月結 ${pendingMonthlyCount} 筆` : ""}
            </small>
          </article>
        </div>
      </section>

      <section className="ov-mobile__panel">
        <h3>應收帳款</h3>
        <dl className="ov-mobile__ar">
          <div>
            <dt>前期欠款</dt>
            <dd>{moneyText(summary.arOpening)}</dd>
          </div>
          <div>
            <dt>本期新增</dt>
            <dd>{moneyText(summary.arPeriodAccrual)}</dd>
          </div>
          <div>
            <dt>本期沖帳</dt>
            <dd>{moneyText(summary.arPeriodCollected)}</dd>
          </div>
          <div>
            <dt>期末 AR</dt>
            <dd>{moneyText(summary.arClosing)}</dd>
          </div>
        </dl>
      </section>

      {actions.length > 0 ? (
        <section className="ov-mobile__panel">
          <h3>常用</h3>
          <div className="ov-mobile__actions">
            {actions.map((item) => (
              <Link key={item.to} to={item.to}>
                {item.label}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
