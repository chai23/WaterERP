import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AccountingStatsSection from "../components/AccountingStatsSection";
import { InterfaceIcon, WaterRipple } from "../components/WaterIdentity";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { formatHealthStatus, healthLedClass } from "../adminUtils";
import { canAccessPath } from "../rolePermissions";

export default function OverviewPage() {
  const { user } = useAuth();
  const { health } = useDashboard();
  const [exceptionTotal, setExceptionTotal] = useState<number | null>(null);
  const [exceptionError, setExceptionError] = useState(false);
  const [retry, setRetry] = useState(0);
  const showExceptions = canAccessPath(user?.role, "/reports/exceptions");
  const retryExceptions = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    if (!showExceptions) return;
    const controller = new AbortController();
    setExceptionError(false);
    setExceptionTotal(null);
    void (async () => {
      try {
        const res = await fetch("/api/reports/exception-center?summaryOnly=1", { signal: controller.signal });
        const payload = await res.json();
        const count = Number(payload?.data?.totalCount);
        if (!res.ok || !payload?.ok || !Number.isFinite(count)) throw new Error("摘要載入失敗");
        if (!controller.signal.aborted) setExceptionTotal(count);
      } catch {
        if (!controller.signal.aborted) setExceptionError(true);
      }
    })();
    return () => controller.abort();
  }, [showExceptions, retry]);

  const actions = [
    { to: "/orders/new", label: "建立訂單", description: "接下每一份託付", icon: "plus" },
    { to: "/orders/assign", label: "配送安排", description: "讓服務準時抵達", icon: "orders" },
    { to: "/data/customers", label: "客戶資料", description: "熟悉每一位客戶", icon: "data" },
    { to: "/reports/billing-ar", label: "應收帳款", description: "每一筆往來都清楚", icon: "reports" },
  ].filter((item) => canAccessPath(user?.role, item.to));

  return (
    <div className="overview-studio">
      <section className="overview-welcome">
        <div className="overview-welcome__copy">
          <span className="design-eyebrow">YOUR DAILY FLOW / 每日營運</span>
          <h2>{user?.name && <span className="overview-greeting">{user.name}，</span>}今天也從容有序。</h2>
          <p>掌握營運的每個環節，讓每一份服務順利送達。</p>
          <div className="overview-health" role="status"><span className={healthLedClass(health)} /><span>{formatHealthStatus(health)}</span></div>
        </div>
        <div className="overview-welcome__art"><WaterRipple /><span>用心，流動在每一天。</span></div>
      </section>

      {actions.length > 0 && <section className="overview-actions" aria-label="常用作業">
        {actions.map((item, index) => <Link key={item.to} to={item.to} className="overview-action">
          <span className="overview-action__icon"><InterfaceIcon name={item.icon} /></span>
          <span className="overview-action__text"><strong>{item.label}</strong><small>{item.description}</small></span>
          <span className="overview-action__number">0{index + 1}</span><InterfaceIcon name="arrow" />
        </Link>)}
      </section>}

      {showExceptions && <section className={`overview-attention${exceptionTotal && exceptionTotal > 0 ? " overview-attention--warn" : ""}`} aria-label="今日待辦" aria-live="polite">
        <div><span className="overview-attention__label">今日待辦</span><strong>{exceptionError ? "暫時無法取得待辦摘要" : exceptionTotal == null ? "正在整理今日待辦…" : exceptionTotal > 0 ? `${exceptionTotal.toLocaleString("zh-TW")} 筆異常需要留意` : "目前沒有待處理的異常"}</strong></div>
        {exceptionError ? <button type="button" className="btn btn--ghost btn--sm" onClick={retryExceptions}>重新載入 <InterfaceIcon name="arrow" /></button> : <Link to="/reports/exceptions">前往異常中心 <InterfaceIcon name="arrow" /></Link>}
      </section>}

      <AccountingStatsSection mode="overview" />
      <footer className="overview-footer"><span>超好企業 · 每一份託付，用心送達。</span><span>WATER ERP</span></footer>
    </div>
  );
}
