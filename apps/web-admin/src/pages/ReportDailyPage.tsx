import { useEffect, useMemo, useState } from "react";
import AccountingStatsSection from "../components/AccountingStatsSection";
import ExpenseSummarySection, { ExpenseNetHint } from "../components/ExpenseSummarySection";
import { todayLocalYmd } from "../adminUtils";
import { useDashboard } from "../DashboardContext";
import type { ExpenseSummary } from "../expenseUtils";

function datePrefix() {
  return todayLocalYmd();
}

export default function ReportDailyPage() {
  const { setSummaryFilter, completedDeliveries, payments, exportCompletedDeliveriesCsv, exportPaymentsCsv } = useDashboard();

  useEffect(() => {
    setSummaryFilter((prev) => ({ ...prev, range: "today" }));
  }, [setSummaryFilter]);

  const todayStr = useMemo(() => datePrefix(), []);

  const deliveriesToday = useMemo(
    () =>
      completedDeliveries.filter((row) => row.completedAt && String(row.completedAt).slice(0, 10) === todayStr),
    [completedDeliveries, todayStr],
  );

  const paymentsToday = useMemo(
    () => payments.filter((p) => p.paidAt && String(p.paidAt).slice(0, 10) === todayStr),
    [payments, todayStr],
  );

  const cashToday = useMemo(
    () => paymentsToday.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
    [paymentsToday],
  );

  const [expenseTotal, setExpenseTotal] = useState(0);
  useEffect(() => {
    fetch(`/api/expense-vouchers/daily-summary?date=${todayStr}`)
      .then((r) => r.json())
      .then((body) => {
        if (body?.data) setExpenseTotal(Number((body.data as ExpenseSummary).totalAmount ?? 0));
      })
      .catch(() => setExpenseTotal(0));
  }, [todayStr]);

  return (
    <>
      <AccountingStatsSection mode="daily" />

      <section className="card">
        <h2 className="card__title">
          本日已完成配送 <span className="card__title-count">{deliveriesToday.length} 筆</span>
        </h2>
        <p className="card__hint">依完成時間日期篩選（客戶端）；匯出仍為全部資料。</p>
        <div className="toolbar">
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportCompletedDeliveriesCsv}>
            匯出銷單 CSV（全部）
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>完成時間</th>
                <th>單號</th>
                <th>客戶</th>
                <th className="num">現收</th>
              </tr>
            </thead>
            <tbody>
              {deliveriesToday.map((row) => (
                <tr key={String(row.id)}>
                  <td className="cell-nowrap">{row.completedAt ? String(row.completedAt).slice(0, 19).replace("T", " ") : "—"}</td>
                  <td>{row.salesOrder?.orderNo ?? "—"}</td>
                  <td>{row.salesOrder?.customer?.name ?? "—"}</td>
                  <td className="num">{row.cashReceived}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">
          本日收款 <span className="card__title-count">{paymentsToday.length} 筆</span>
        </h2>
        <div className="toolbar">
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportPaymentsCsv}>
            匯出收款 CSV（全部）
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>收款時間</th>
                <th>客戶</th>
                <th>訂單</th>
                <th>方式</th>
                <th className="num">金額</th>
              </tr>
            </thead>
            <tbody>
              {paymentsToday.map((p) => (
                <tr key={String(p.id)}>
                  <td className="cell-nowrap">{p.paidAt ? String(p.paidAt).slice(0, 19).replace("T", " ") : "—"}</td>
                  <td>{p.customer?.name ?? "—"}</td>
                  <td>{p.salesOrder?.orderNo ?? "—"}</td>
                  <td>{p.paymentMethod}</td>
                  <td className="num">{p.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ExpenseSummarySection
        title="本日支出"
        dateLabel={todayStr}
        summaryUrl={`/api/expense-vouchers/daily-summary?date=${todayStr}`}
        linkTo="/expenses/today"
        linkLabel="查看完整支出"
      />

      <section className="card">
        <h2 className="card__title">本日淨額參考</h2>
        <p className="card__hint">現金收款合計（本日 payments）減本日支出含稅總額；支出數字請以「本日支出」區塊為準。</p>
        <ExpenseNetHint cashReceived={cashToday} expenseTotal={expenseTotal} />
        <p className="card__hint">本日支出含稅總額：{expenseTotal.toLocaleString()}</p>
      </section>
    </>
  );
}
