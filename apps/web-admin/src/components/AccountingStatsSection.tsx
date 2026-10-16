import { moneyText } from "../adminUtils";
import { useDashboard } from "../DashboardContext";

type Mode = "overview" | "daily" | "monthly";

export default function AccountingStatsSection({ mode }: { mode: Mode }) {
  const { summary, summaryFilter, setSummaryFilter, loadSummary, summaryStatus } = useDashboard();

  const showToolbar = mode === "overview";
  const pendingMonthly = Number(summary.periodPendingMonthly ?? 0);
  const pendingMonthlyCount = Number(summary.periodPendingMonthlyCount ?? 0);
  const arOutstanding = Number(summary.periodOrderOutstanding ?? 0);
  const receivableTotal = Number(summary.periodReceivableTotal ?? arOutstanding + pendingMonthly);

  return (
    <section className={`card${showToolbar ? " overview-metrics" : ""}`} aria-busy={summaryStatus === "loading"}>
      <h2 className="card__title card__title--stacked">
        {mode === "overview" && "營運指標"}
        {mode === "daily" && "日報表 · 營運指標"}
        {mode === "monthly" && "月報表 · 營運指標"}
        <span className="card__title-count">
          {summary.startDate} ~ {summary.endDate}
        </span>
      </h2>

      {mode === "daily" ? (
        <p className="card__hint">統計所選日期／自訂區間資料（可於上方切換與篩選）。</p>
      ) : null}
      {mode === "monthly" ? (
        <p className="card__hint">統計所選月份／自訂區間資料（可於上方切換與篩選）。</p>
      ) : null}

      {showToolbar ? (
        <div className="stats-toolbar">
          <span className="stats-toolbar__label">統計區間</span>
          <div className="stats-period-options" role="group" aria-label="統計區間">
          <label>
            <input
              type="radio"
              name="range"
              checked={summaryFilter.range === "today"}
              onChange={() => setSummaryFilter((prev) => ({ ...prev, range: "today" }))}
            />
            本日
          </label>
          <label>
            <input
              type="radio"
              name="range"
              checked={summaryFilter.range === "month"}
              onChange={() => setSummaryFilter((prev) => ({ ...prev, range: "month" }))}
            />
            本月
          </label>
          <label>
            <input
              type="radio"
              name="range"
              checked={summaryFilter.range === "custom"}
              onChange={() => setSummaryFilter((prev) => ({ ...prev, range: "custom" }))}
            />
            自訂
          </label>
          </div>
          <div className="stats-custom-dates" hidden={summaryFilter.range !== "custom"}>
          <input
            type="date"
            aria-label="統計開始日期"
            value={summaryFilter.startDate}
            onChange={(e) => setSummaryFilter((prev) => ({ ...prev, startDate: e.target.value }))}
            disabled={summaryFilter.range !== "custom"}
          />
          <span>~</span>
          <input
            type="date"
            aria-label="統計結束日期"
            value={summaryFilter.endDate}
            onChange={(e) => setSummaryFilter((prev) => ({ ...prev, endDate: e.target.value }))}
            disabled={summaryFilter.range !== "custom"}
          />
          </div>
          <span className="stats-range-hint">
            待收＝本區間完成訂單之 AR 未清＋尚未開立月結批次 · 變更後會自動重新載入
          </span>
        </div>
      ) : (
        <div className="form-actions stats-refresh-actions">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void loadSummary()}
          >
            重新整理數據
          </button>
        </div>
      )}

      {showToolbar && summaryStatus !== "ready" ? (
        <div className="overview-data-state" role="status">
          <strong>{summaryStatus === "loading" ? "正在整理營運數據…" : "營運數據暫時無法載入"}</strong>
          <p>{summaryStatus === "loading" ? "稍候即可查看所選區間的營運狀況。" : "請確認連線後重試，避免將未取得的數據誤認為零。"}</p>
          {summaryStatus === "error" && <button type="button" className="btn btn--secondary" onClick={() => void loadSummary()}>重新載入</button>}
        </div>
      ) : <>
      <div className="stats-grid stats-grid--metrics">
        <article className="stat-card stat-card--revenue">
          <div className="stat-card__label">區間營收</div>
          <div className="stat-card__value">{summary.periodRevenue.toLocaleString()}</div>
          <p className="stat-card__hint">
            現金 {moneyText(summary.revenueCash)} · 月結 {moneyText(summary.revenueMonthly)}
            {summary.revenuePrepaidTopup > 0 ? ` · 預付儲值 ${moneyText(summary.revenuePrepaidTopup)}` : ""}
          </p>
        </article>
        <article className="stat-card stat-card--cash">
          <div className="stat-card__label">區間收款</div>
          <div className="stat-card__value">{summary.periodCollected.toLocaleString()}</div>
          <p className="stat-card__hint">
            現金 {summary.periodCollectedCash.toLocaleString()}
            {summary.periodCollectedTransfer > 0 ? (
              <>
                <br />
                匯款 {summary.periodCollectedTransfer.toLocaleString()}
              </>
            ) : null}
            {summary.periodCollectedOther > 0 ? (
              <>
                <br />
                其他 {summary.periodCollectedOther.toLocaleString()}
              </>
            ) : null}
          </p>
        </article>
        <article className="stat-card stat-card--count">
          <div className="stat-card__label">已完成單數</div>
          <div className="stat-card__value">{summary.todayCompletedCount}</div>
          <p className="stat-card__hint">本區間配送／服務完成筆數</p>
        </article>
        <article className="stat-card stat-card--unpaid">
          <div className="stat-card__label">區間總待收</div>
          <div className="stat-card__value">{receivableTotal.toLocaleString()}</div>
          <p className="stat-card__hint">
            AR 未清 {arOutstanding.toLocaleString()}
            <br />
            待開月結 {pendingMonthly.toLocaleString()}
            {pendingMonthlyCount > 0 ? `（${pendingMonthlyCount} 筆）` : ""}
          </p>
        </article>
      </div>

      {(mode === "overview" || mode === "daily" || mode === "monthly") && (
        <div className="stats-grid stats-grid--metrics" style={{ marginTop: "1rem" }}>
          <article className="stat-card">
            <div className="stat-card__label">前期欠款</div>
            <div className="stat-card__value">{moneyText(summary.arOpening)}</div>
          </article>
          <article className="stat-card">
            <div className="stat-card__label">本期新增 AR</div>
            <div className="stat-card__value">{moneyText(summary.arPeriodAccrual)}</div>
          </article>
          <article className="stat-card">
            <div className="stat-card__label">本期沖帳</div>
            <div className="stat-card__value">{moneyText(summary.arPeriodCollected)}</div>
          </article>
          <article className="stat-card">
            <div className="stat-card__label">期末 AR</div>
            <div className="stat-card__value">{moneyText(summary.arClosing)}</div>
          </article>
        </div>
      )}
      {(summaryFilter.driverId || summaryFilter.billingType) && (
        <p className="card__hint" style={{ marginTop: "0.75rem" }}>
          AR 滾動僅套用客戶篩選；司機／結帳方式不影響上列 AR 數字（避免與營收口徑混淆）。
        </p>
      )}
      </>}
    </section>
  );
}
