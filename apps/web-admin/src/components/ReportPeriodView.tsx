import { useEffect, useMemo, useState } from "react";
import AccountingStatsSection from "./AccountingStatsSection";
import { DateTimeCell } from "./DateTimeCell";
import ExpenseSummarySection, { ExpenseNetHint } from "./ExpenseSummarySection";
import type { ExpenseSummary } from "../expenseUtils";
import { moneyText } from "../adminUtils";
import {
  downloadReportCsv,
  driverDisplayName,
  orderBillableDisplay,
  paymentMethodLabel,
  settlementOutcomeLabel,
  type ReportPeriodDetail,
  type ReportPeriodRange,
} from "../reportUtils";

type Props = {
  range: ReportPeriodRange;
  statsMode: "daily" | "monthly";
  periodLabel: string;
  pageTitle: string;
  expenseTitle: string;
  expenseSummaryUrl: string;
  expenseLinkTo: string;
  expenseLinkLabel: string;
};

export default function ReportPeriodView({
  range,
  statsMode,
  periodLabel,
  pageTitle,
  expenseTitle,
  expenseSummaryUrl,
  expenseLinkTo,
  expenseLinkLabel,
}: Props) {
  const [detail, setDetail] = useState<ReportPeriodDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expenseTotal, setExpenseTotal] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError("");
    fetch(`/api/reports/period-detail?range=${range}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${r.status}`);
        return body.data as ReportPeriodDetail;
      })
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => setLoading(false));
  }, [range]);

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
        settlementOutcomeLabel(row.settlementOutcome),
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

  return (
    <>
      <header className="report-page-head">
        <h1 className="report-page-head__title">{pageTitle}</h1>
        <p className="report-page-head__desc">
          {periodLabel}
          {detail ? `（${detail.startDate}${detail.startDate !== detail.endDate ? ` ~ ${detail.endDate}` : ""}）` : ""}
          — 先看總覽數字，再往下查配送與收款明細。
        </p>
      </header>

      <AccountingStatsSection mode={statsMode} />

      {loading ? <section className="card"><p className="card__hint">載入報表明細…</p></section> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}

      {summary ? (
        <section className="card report-flow-card">
          <h2 className="card__title card__title--stacked">資金概要</h2>
          <p className="card__hint">用白話說明：{periodLabel}送達的訂單賺了多少、實際收到多少、還有多少沒收清。</p>

          <div className="report-flow">
            <div className="report-flow__step report-flow__step--revenue">
              <span className="report-flow__label">① 營收（應收合計）</span>
              <span className="report-flow__value">{moneyText(summary.periodRevenue)}</span>
              <span className="report-flow__hint">
                {summary.todayCompletedCount} 筆 · 配送 {moneyText(summary.deliveryRevenue ?? summary.periodRevenue)}
                {(summary.serviceRevenue ?? 0) > 0 ? ` ＋ 服務 ${moneyText(summary.serviceRevenue)}` : ""}
              </span>
            </div>
            <span className="report-flow__arrow" aria-hidden>→</span>
            <div className="report-flow__step report-flow__step--collected">
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
              </span>
            </div>
            <span className="report-flow__arrow" aria-hidden>→</span>
            <div className="report-flow__step report-flow__step--outstanding">
              <span className="report-flow__label">③ 待收（AR 未清）</span>
              <span className="report-flow__value">{moneyText(summary.periodOrderOutstanding)}</span>
              <span className="report-flow__hint">僅計{periodLabel}完成訂單</span>
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
                <th>關聯訂單</th>
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
                  <td>{p.salesOrder?.orderNo ?? <span className="text-muted">（沖帳／儲值）</span>}</td>
                  <td>
                    <span className={`badge badge--${p.paymentMethod === "transfer" ? "info" : "default"}`}>
                      {paymentMethodLabel(p.paymentMethod ?? "")}
                    </span>
                  </td>
                  <td className="num">{moneyText(p.amount)}</td>
                  <td className="cell-truncate">{p.note?.trim() || "—"}</td>
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
                    <span className="badge badge--default">{settlementOutcomeLabel(row.settlementOutcome)}</span>
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
        </p>
        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>結案時間</th>
                <th>服務單</th>
                <th>帳務訂單</th>
                <th>客戶</th>
                <th>帳務</th>
                <th className="num">應收</th>
              </tr>
            </thead>
            <tbody>
              {serviceTickets.map((row) => (
                <tr key={row.id}>
                  <td><DateTimeCell value={row.closedAt} /></td>
                  <td>{row.ticketNo}</td>
                  <td>{row.salesOrder?.orderNo ?? "—"}</td>
                  <td>{row.customer?.name ?? "—"}</td>
                  <td>{row.billingType === "monthly" ? "月結" : row.billingType === "cash" ? "現金" : "—"}</td>
                  <td className="num">{moneyText(row.salesOrder?.orderBillableAmount ?? row.chargeAmount)}</td>
                </tr>
              ))}
              {serviceTickets.length === 0 ? (
                <tr>
                  <td colSpan={6}>此區間無服務單結案入帳</td>
                </tr>
              ) : null}
            </tbody>
            {serviceTickets.length > 0 ? (
              <tfoot>
                <tr className="data-table__foot">
                  <td colSpan={5}>合計</td>
                  <td className="num">{moneyText(summary?.serviceRevenue)}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      <ExpenseSummarySection
        title={expenseTitle}
        dateLabel={detail?.startDate ?? ""}
        summaryUrl={expenseSummaryUrl}
        linkTo={expenseLinkTo}
        linkLabel={expenseLinkLabel}
      />
    </>
  );
}
