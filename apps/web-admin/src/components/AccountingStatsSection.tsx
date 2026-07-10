import { useDashboard } from "../DashboardContext";

type Mode = "overview" | "daily" | "monthly";

export default function AccountingStatsSection({ mode }: { mode: Mode }) {
  const { summary, summaryFilter, setSummaryFilter, loadDashboard } = useDashboard();

  const showToolbar = mode === "overview";

  return (
    <section className="card">
      <h2 className="card__title card__title--stacked">
        {mode === "overview" && "營運指標"}
        {mode === "daily" && "日報表 · 營運指標"}
        {mode === "monthly" && "月報表 · 營運指標"}
        <span className="card__title-count">
          {summary.startDate} ~ {summary.endDate}
        </span>
      </h2>

      {mode === "daily" ? (
        <p className="card__hint">固定統計<strong>本日</strong>資料（與總覽「本日」相同邏輯）。</p>
      ) : null}
      {mode === "monthly" ? (
        <p className="card__hint">固定統計<strong>本月</strong>資料（與總覽「本月」相同邏輯）。</p>
      ) : null}

      {showToolbar ? (
        <div className="stats-toolbar">
          <span className="stats-toolbar__label">統計區間</span>
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
          <input
            type="date"
            value={summaryFilter.startDate}
            onChange={(e) => setSummaryFilter((prev) => ({ ...prev, startDate: e.target.value }))}
            disabled={summaryFilter.range !== "custom"}
          />
          <span>~</span>
          <input
            type="date"
            value={summaryFilter.endDate}
            onChange={(e) => setSummaryFilter((prev) => ({ ...prev, endDate: e.target.value }))}
            disabled={summaryFilter.range !== "custom"}
          />
          <span className="stats-range-hint">前三張依區間統計；待收為本區間完成訂單之應收未清 · 變更後會自動重新載入</span>
        </div>
      ) : (
        <div className="form-actions stats-refresh-actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => loadDashboard()}>
            重新整理數據
          </button>
        </div>
      )}

      <div className="stats-grid stats-grid--metrics">
        <article className="stat-card stat-card--revenue">
          <div className="stat-card__label">區間營收</div>
          <div className="stat-card__value">{summary.periodRevenue.toLocaleString()}</div>
          <p className="stat-card__hint">本區間完成訂單應收合計（含稅現金＋月結）</p>
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
          <p className="stat-card__hint">本區間配送完成筆數</p>
        </article>
        <article className="stat-card stat-card--unpaid">
          <div className="stat-card__label">區間待收</div>
          <div className="stat-card__value">{summary.periodOrderOutstanding.toLocaleString()}</div>
          <p className="stat-card__hint">本區間完成訂單之應收未清（AR）</p>
        </article>
      </div>
    </section>
  );
}
