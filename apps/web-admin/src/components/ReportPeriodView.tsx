import { useEffect, useMemo, useState } from "react";
import AccountingStatsSection from "./AccountingStatsSection";
import { DateTimeCell } from "./DateTimeCell";
import ExpenseSummarySection, { ExpenseNetHint } from "./ExpenseSummarySection";
import ReportBreakdownModal, { type ReportBreakdownKind } from "./ReportBreakdownModal";
import type { ExpenseSummary } from "../expenseUtils";
import { moneyText, todayLocalYmd, todayLocalYm } from "../adminUtils";
import { useDashboard } from "../DashboardContext";
import {
  appendReportFilterParams,
  deliverySettlementLabel,
  downloadReportCsv,
  driverDisplayName,
  orderBillableDisplay,
  paymentMethodLabel,
  type ReportFilters,
  type ReportPeriodDetail,
} from "../reportUtils";

type Props = {
  statsMode: "daily" | "monthly";
  pageTitle: string;
};

const emptyFilters = (): ReportFilters => ({
  customerId: "",
  driverId: "",
  billingType: "",
});

export default function ReportPeriodView({ statsMode, pageTitle }: Props) {
  const { customers, drivers, setSummaryFilter } = useDashboard();
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [reportDate, setReportDate] = useState(todayLocalYmd());
  const [reportYm, setReportYm] = useState(todayLocalYm());
  const [customStart, setCustomStart] = useState(todayLocalYmd());
  const [customEnd, setCustomEnd] = useState(todayLocalYmd());
  const [filters, setFilters] = useState<ReportFilters>(emptyFilters);
  const [detail, setDetail] = useState<ReportPeriodDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [breakdownKind, setBreakdownKind] = useState<ReportBreakdownKind | null>(null);

  const periodQuery = useMemo((): {
    range: "today" | "month" | "custom";
    startDate: string;
    endDate: string;
    ym?: string;
  } => {
    if (useCustomRange) {
      return {
        range: "custom",
        startDate: customStart,
        endDate: customEnd,
      };
    }
    if (statsMode === "daily") {
      return {
        range: "today",
        startDate: reportDate,
        endDate: reportDate,
      };
    }
    return {
      range: "month",
      startDate: `${reportYm}-01`,
      endDate: `${reportYm}-01`,
      ym: reportYm,
    };
  }, [useCustomRange, customStart, customEnd, statsMode, reportDate, reportYm]);

  const periodLabel = useMemo(() => {
    if (useCustomRange) {
      return customStart === customEnd ? customStart : `${customStart} ~ ${customEnd}`;
    }
    if (statsMode === "daily") {
      return reportDate === todayLocalYmd() ? "本日" : reportDate;
    }
    return reportYm === todayLocalYm() ? "本月" : reportYm;
  }, [useCustomRange, customStart, customEnd, statsMode, reportDate, reportYm]);

  const detailQuery = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set("range", periodQuery.range);
    if (periodQuery.range === "today") {
      qs.set("date", periodQuery.startDate);
      qs.set("startDate", periodQuery.startDate);
    } else if (periodQuery.range === "month") {
      qs.set("ym", periodQuery.ym ?? periodQuery.startDate.slice(0, 7));
      qs.set("startDate", periodQuery.startDate);
    } else {
      qs.set("startDate", periodQuery.startDate);
      qs.set("endDate", periodQuery.endDate);
    }
    appendReportFilterParams(qs, filters);
    return qs.toString();
  }, [periodQuery, filters]);

  const expenseSummaryUrl = useMemo(() => {
    const { startDate, endDate } = periodQuery;
    if (startDate === endDate) {
      return `/api/expense-vouchers/daily-summary?date=${startDate}`;
    }
    const ym = startDate.slice(0, 7);
    if (endDate.slice(0, 7) === ym) {
      return `/api/expense-vouchers/reports/monthly?ym=${ym}`;
    }
    // 跨月自訂區間：暫以起始月月報近似（完整區間請至支出分析）
    return `/api/expense-vouchers/reports/monthly?ym=${ym}`;
  }, [periodQuery]);

  const expenseTitle = useCustomRange
    ? "區間支出"
    : statsMode === "daily"
      ? "當日支出"
      : "當月支出";

  const expenseLinkTo =
    statsMode === "monthly" || (useCustomRange && periodQuery.startDate !== periodQuery.endDate)
      ? "/expenses/analytics?tab=monthly"
      : "/expenses/analytics";

  useEffect(() => {
    setSummaryFilter((prev) => {
      if (
        prev.range === periodQuery.range &&
        prev.startDate === periodQuery.startDate &&
        prev.endDate === periodQuery.endDate &&
        prev.customerId === filters.customerId &&
        prev.driverId === filters.driverId &&
        prev.billingType === filters.billingType
      ) {
        return prev;
      }
      return {
        ...prev,
        range: periodQuery.range,
        startDate: periodQuery.startDate,
        endDate: periodQuery.endDate,
        customerId: filters.customerId,
        driverId: filters.driverId,
        billingType: filters.billingType,
      };
    });
  }, [periodQuery, filters, setSummaryFilter]);

  useEffect(() => {
    setLoading(true);
    setError("");
    fetch(`/api/reports/period-detail?${detailQuery}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${r.status}`);
        return body.data as ReportPeriodDetail;
      })
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => setLoading(false));
  }, [detailQuery]);

  useEffect(() => {
    fetch(expenseSummaryUrl)
      .then((r) => r.json())
      .then((body) => {
        if (body?.data) setExpenseTotal(Number((body.data as ExpenseSummary).totalAmount ?? 0));
      })
      .catch(() => setExpenseTotal(0));
  }, [expenseSummaryUrl]);

  const summary = detail?.summary;
  const deliveries = detail?.deliveries ?? [];
  const serviceTickets = detail?.serviceTickets ?? [];
  const payments = detail?.payments ?? [];
  const pendingMonthly = Number(summary?.periodPendingMonthly ?? 0);
  const pendingMonthlyCount = Number(summary?.periodPendingMonthlyCount ?? 0);
  const arOutstanding = Number(summary?.periodOrderOutstanding ?? 0);
  const receivableTotal = Number(summary?.periodReceivableTotal ?? arOutstanding + pendingMonthly);

  const paymentGroups = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    for (const p of payments) {
      const key = p.paymentMethod ?? "other";
      const prev = map.get(key) ?? { count: 0, total: 0 };
      map.set(key, { count: prev.count + 1, total: prev.total + Number(p.amount ?? 0) });
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [payments]);

  const exportDeliveries = () => {
    if (!detail) return;
    downloadReportCsv(
      `deliveries-${detail.startDate}-to-${detail.endDate}.csv`,
      ["完成時間", "單號", "客戶", "司機", "車牌", "本單應收（含稅）", "司機代收現金", "結帳結果"],
      deliveries.map((row) => [
        row.completedAt ? String(row.completedAt).slice(0, 19).replace("T", " ") : "",
        row.salesOrder?.orderNo ?? "",
        row.salesOrder?.customer?.name ?? "",
        driverDisplayName(row.driver),
        row.vehicle?.plateNo ?? "",
        row.salesOrder?.orderBillableAmount ?? row.salesOrder?.totalAmount ?? 0,
        row.cashReceived ?? 0,
        deliverySettlementLabel(row),
      ]),
    );
  };

  const exportPayments = () => {
    if (!detail) return;
    downloadReportCsv(
      `payments-${detail.startDate}-to-${detail.endDate}.csv`,
      ["收款時間", "客戶", "訂單", "方式", "金額", "備註"],
      payments.map((p) => [
        p.paidAt ? String(p.paidAt).slice(0, 19).replace("T", " ") : "",
        p.customer?.name ?? "",
        p.salesOrder?.orderNo ?? "",
        paymentMethodLabel(p.paymentMethod ?? ""),
        p.amount ?? 0,
        p.note ?? "",
      ]),
    );
  };

  const sortedCustomers = useMemo(
    () => [...customers].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "zh-Hant")),
    [customers],
  );

  return (
    <>
      <header className="report-page-head">
        <h1 className="report-page-head__title">{pageTitle}</h1>
        <p className="report-page-head__desc">
          {periodLabel}
          {detail ? `（${detail.startDate}${detail.startDate !== detail.endDate ? ` ~ ${detail.endDate}` : ""}）` : ""}
          — 先看總覽數字，再往下查配送與收款明細。
        </p>
        <div
          className="report-page-head__filters"
          style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.75rem" }}
        >
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">區間模式</span>
            <select
              value={useCustomRange ? "custom" : "preset"}
              onChange={(e) => setUseCustomRange(e.target.value === "custom")}
            >
              <option value="preset">{statsMode === "daily" ? "單日" : "單月"}</option>
              <option value="custom">自訂起訖</option>
            </select>
          </label>
          {!useCustomRange && statsMode === "daily" ? (
            <label className="form-field" style={{ margin: 0 }}>
              <span className="form-field__label">報表日期</span>
              <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
            </label>
          ) : null}
          {!useCustomRange && statsMode === "monthly" ? (
            <label className="form-field" style={{ margin: 0 }}>
              <span className="form-field__label">報表月份</span>
              <input type="month" value={reportYm} onChange={(e) => setReportYm(e.target.value)} />
            </label>
          ) : null}
          {useCustomRange ? (
            <>
              <label className="form-field" style={{ margin: 0 }}>
                <span className="form-field__label">起日</span>
                <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </label>
              <label className="form-field" style={{ margin: 0 }}>
                <span className="form-field__label">迄日</span>
                <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </label>
            </>
          ) : null}
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">客戶</span>
            <select
              value={filters.customerId}
              onChange={(e) => setFilters((prev) => ({ ...prev, customerId: e.target.value }))}
            >
              <option value="">全部客戶</option>
              {sortedCustomers.map((c) => (
                <option key={String(c.id)} value={String(c.id)}>
                  {c.customerCode ? `${c.customerCode} ` : ""}
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">司機</span>
            <select
              value={filters.driverId}
              onChange={(e) => setFilters((prev) => ({ ...prev, driverId: e.target.value }))}
            >
              <option value="">全部司機</option>
              {drivers.map((d) => (
                <option key={String(d.id)} value={String(d.id)}>
                  {d.user?.employeeCode ? `${d.user.employeeCode} ` : ""}
                  {d.user?.name ?? d.employeeCode ?? String(d.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field" style={{ margin: 0 }}>
            <span className="form-field__label">結帳方式</span>
            <select
              value={filters.billingType}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  billingType: e.target.value as ReportFilters["billingType"],
                }))
              }
            >
              <option value="">全部</option>
              <option value="cash">現金</option>
              <option value="monthly">月結</option>
              <option value="prepaid">預付</option>
            </select>
          </label>
          {(filters.customerId || filters.driverId || filters.billingType) ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setFilters(emptyFilters())}
            >
              清除篩選
            </button>
          ) : null}
        </div>
        {filters.driverId ? (
          <p className="card__hint" style={{ marginTop: "0.5rem" }}>
            已選司機：僅計該司機配送完成單（不含服務單結案）。
          </p>
        ) : null}
      </header>

      <AccountingStatsSection mode={statsMode} />

      {loading ? <section className="card"><p className="card__hint">載入報表明細…</p></section> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}

      {summary ? (
        <section className="card report-flow-card">
          <h2 className="card__title card__title--stacked">資金概要</h2>
          <p className="card__hint">
            關係：營收 ≈ 實際入帳 ＋ AR 未清 ＋ 待開月結（{periodLabel}完成訂單口徑）。
          </p>

          <div className="report-flow">
            <button
              type="button"
              className="report-flow__step report-flow__step--revenue"
              onClick={() => setBreakdownKind("revenue")}
              title="點擊查看營收明細"
            >
              <span className="report-flow__label">① 營收（應收合計）</span>
              <span className="report-flow__value">{moneyText(summary.periodRevenue)}</span>
              <span className="report-flow__hint">
                {summary.todayCompletedCount} 筆 · 配送 {moneyText(summary.deliveryRevenue ?? summary.periodRevenue)}
                {(summary.serviceRevenue ?? 0) > 0 ? ` ＋ 服務 ${moneyText(summary.serviceRevenue)}` : ""}
                <br />
                點擊鑽取
              </span>
            </button>
            <span className="report-flow__arrow" aria-hidden>→</span>
            <button
              type="button"
              className="report-flow__step report-flow__step--collected"
              onClick={() => setBreakdownKind("payments")}
              title="點擊查看收款明細"
            >
              <span className="report-flow__label">② 實際入帳</span>
              <span className="report-flow__value">{moneyText(summary.periodCollected)}</span>
              <span className="report-flow__hint">
                現金 {moneyText(summary.periodCollectedCash)}
                {summary.periodCollectedTransfer > 0 ? (
                  <>
                    <br />
                    匯款 {moneyText(summary.periodCollectedTransfer)}
                  </>
                ) : null}
                {summary.periodCollectedOther > 0 ? (
                  <>
                    <br />
                    其他 {moneyText(summary.periodCollectedOther)}
                  </>
                ) : null}
                <br />
                點擊鑽取
              </span>
            </button>
            <span className="report-flow__arrow" aria-hidden>→</span>
            <div className="report-flow__step report-flow__step--outstanding">
              <span className="report-flow__label">③ 總待收</span>
              <span className="report-flow__value">{moneyText(receivableTotal)}</span>
              <span className="report-flow__hint">
                <button
                  type="button"
                  className="linkish"
                  style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => setBreakdownKind("ar")}
                >
                  AR 未清 {moneyText(arOutstanding)}
                </button>
                <br />
                <button
                  type="button"
                  className="linkish"
                  style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => setBreakdownKind("pendingMonthly")}
                >
                  待開月結 {moneyText(pendingMonthly)}
                  {pendingMonthlyCount > 0 ? `（${pendingMonthlyCount} 筆）` : ""}
                </button>
              </span>
            </div>
          </div>

          <div className="report-flow-notes">
            <div className="report-flow-note">
              <span className="report-flow-note__label">司機代收現金</span>
              <span className="report-flow-note__value">{moneyText(summary.driverCashCollected)}</span>
              <span className="report-flow-note__hint">配送當場收取，之後會入帳沖帳</span>
            </div>
            <div className="report-flow-note">
              <span className="report-flow-note__label">支出（含稅）</span>
              <span className="report-flow-note__value">{moneyText(expenseTotal)}</span>
              <span className="report-flow-note__hint">見下方支出區塊</span>
            </div>
            <div className="report-flow-note report-flow-note--net">
              <span className="report-flow-note__label">淨流入（入帳 − 支出）</span>
              <ExpenseNetHint collected={summary.periodCollected} expenseTotal={expenseTotal} inline />
            </div>
          </div>
        </section>
      ) : null}

      {summary ? (
        <section className="card">
          <h2 className="card__title card__title--stacked">營收拆分</h2>
          <p className="card__hint">
            現金＋月結＋預付儲值應約等於區間營收；預付扣桶以桶數為主（金額多為 0，不列入營收加總）。
          </p>
          <div className="stats-grid stats-grid--metrics">
            <article className="stat-card">
              <div className="stat-card__label">現金應收</div>
              <div className="stat-card__value">{moneyText(summary.revenueCash ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">月結份額</div>
              <div className="stat-card__value">{moneyText(summary.revenueMonthly ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">預付儲值</div>
              <div className="stat-card__value">{moneyText(summary.revenuePrepaidTopup ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">預付扣桶</div>
              <div className="stat-card__value">{moneyText(summary.revenuePrepaidConsume ?? 0)}</div>
              <p className="stat-card__hint">
                桶數 {(summary.prepaidConsumeBarrels ?? 0).toLocaleString()}
              </p>
            </article>
          </div>
        </section>
      ) : null}

      {summary ? (
        <section className="card">
          <h2 className="card__title card__title--stacked">應收滾動</h2>
          <p className="card__hint">
            期末 ≈ 前期欠款 ＋ 本期新增 − 本期收款（允許小數差）。
            {(filters.driverId || filters.billingType) ? (
              <>
                {" "}
                <strong>注意：已套用司機或結帳方式篩選時，AR 滾動仍僅套用客戶條件（不受司機／結帳影響）。</strong>
              </>
            ) : (
              " 篩選客戶時一併套用。"
            )}
          </p>
          <div className="stats-grid stats-grid--metrics">
            <article className="stat-card">
              <div className="stat-card__label">前期欠款</div>
              <div className="stat-card__value">{moneyText(summary.arOpening ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">本期新增</div>
              <div className="stat-card__value">{moneyText(summary.arPeriodAccrual ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">本期收款</div>
              <div className="stat-card__value">{moneyText(summary.arPeriodCollected ?? 0)}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">期末餘額</div>
              <div className="stat-card__value">{moneyText(summary.arClosing ?? 0)}</div>
            </article>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2 className="card__title card__title--stacked">
          {periodLabel}收款明細
          <span className="card__title-count">{payments.length} 筆 · 合計 {moneyText(summary?.periodCollected ?? 0)}</span>
        </h2>
        <p className="card__hint">含現金、匯款等實際入帳；預付桶扣款不列入。</p>

        {paymentGroups.length > 0 ? (
          <div className="report-method-chips">
            {paymentGroups.map(([method, g]) => (
              <span key={method} className="report-method-chip">
                {paymentMethodLabel(method)} <strong>{moneyText(g.total)}</strong>
                <span className="report-method-chip__count">{g.count} 筆</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="card__hint">此區間尚無收款記錄。</p>
        )}

        <div className="toolbar">
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportPayments} disabled={payments.length === 0}>
            匯出收款 CSV
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>收款時間</th>
                <th>客戶</th>
                <th>訂單</th>
                <th>方式</th>
                <th className="num">金額</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={String(p.id)}>
                  <td><DateTimeCell value={p.paidAt} /></td>
                  <td>{p.customer?.name ?? "—"}</td>
                  <td>{p.salesOrder?.orderNo ?? "—"}</td>
                  <td>{paymentMethodLabel(p.paymentMethod ?? "")}</td>
                  <td className="num">{moneyText(p.amount)}</td>
                  <td>{p.note ?? "—"}</td>
                </tr>
              ))}
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6}>此區間無收款</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title card__title--stacked">
          {periodLabel}配送完成
          <span className="card__title-count">
            {deliveries.length} 筆 · 應收 {moneyText(summary?.deliveryRevenue ?? 0)}
          </span>
        </h2>
        <p className="card__hint">
          依核銷完成時間列出。「本單應收」為向客戶收取金額（現金列含稅＋月結份額），非未稅明細合計。
          「司機代收」為配送當場收取的現金，與上方入帳時間可能不同天。
        </p>

        <div className="toolbar">
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportDeliveries} disabled={deliveries.length === 0}>
            匯出配送 CSV
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>完成時間</th>
                <th>單號</th>
                <th>客戶</th>
                <th>司機</th>
                <th className="num">本單應收</th>
                <th className="num">司機代收</th>
                <th>結帳</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={String(row.id)}>
                  <td><DateTimeCell value={row.completedAt} /></td>
                  <td>{row.salesOrder?.orderNo ?? "—"}</td>
                  <td>{row.salesOrder?.customer?.name ?? "—"}</td>
                  <td className="cell-nowrap">{driverDisplayName(row.driver)}</td>
                  <td className="num">{orderBillableDisplay(row.salesOrder)}</td>
                  <td className="num">{moneyText(row.cashReceived)}</td>
                  <td>
                    <span className="badge badge--default">{deliverySettlementLabel(row)}</span>
                  </td>
                </tr>
              ))}
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={7}>此區間無完成配送</td>
                </tr>
              ) : null}
            </tbody>
            {deliveries.length > 0 ? (
              <tfoot>
                <tr className="data-table__foot">
                  <td colSpan={4}>合計</td>
                  <td className="num">{moneyText(summary?.deliveryRevenue)}</td>
                  <td className="num">{moneyText(summary?.driverCashCollected)}</td>
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title card__title--stacked">
          {periodLabel}飲水機服務結案
          <span className="card__title-count">
            {serviceTickets.length} 筆 · 應收 {moneyText(summary?.serviceRevenue ?? 0)}
          </span>
        </h2>
        <p className="card__hint">
          依服務單結案時間列入營收。現金結案會同步產生收款入帳；月結則進入月結批次，不在此重複立 AR。
          {filters.driverId ? "（目前有司機篩選，服務單不納入）" : ""}
        </p>
        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>結案時間</th>
                <th>服務單</th>
                <th>客戶</th>
                <th>結帳</th>
                <th className="num">應收</th>
                <th>關聯訂單</th>
              </tr>
            </thead>
            <tbody>
              {serviceTickets.map((t) => (
                <tr key={t.id}>
                  <td><DateTimeCell value={t.closedAt} /></td>
                  <td>{t.ticketNo}</td>
                  <td>{t.customer?.name ?? "—"}</td>
                  <td>{t.billingType ?? "—"}</td>
                  <td className="num">{moneyText(t.salesOrder?.orderBillableAmount ?? t.chargeAmount)}</td>
                  <td>{t.salesOrder?.orderNo ?? "—"}</td>
                </tr>
              ))}
              {serviceTickets.length === 0 ? (
                <tr>
                  <td colSpan={6}>此區間無服務結案</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <ExpenseSummarySection
        title={expenseTitle}
        dateLabel={detail?.startDate ?? periodLabel}
        summaryUrl={expenseSummaryUrl}
        linkTo={expenseLinkTo}
        linkLabel={
          statsMode === "monthly" || useCustomRange ? "查看支出月報表" : "查看支出日報表"
        }
      />

      <ReportBreakdownModal
        open={breakdownKind != null}
        kind={breakdownKind}
        queryString={detailQuery}
        onClose={() => setBreakdownKind(null)}
      />
    </>
  );
}
