import { useEffect, useMemo } from "react";
import { todayLocalYm } from "../adminUtils";
import AccountingStatsSection from "../components/AccountingStatsSection";
import { useDashboard } from "../DashboardContext";

function monthPrefix() {
  return todayLocalYm();
}

export default function ReportMonthlyPage() {
  const { setSummaryFilter, completedDeliveries, payments, exportCompletedDeliveriesCsv, exportPaymentsCsv } = useDashboard();

  useEffect(() => {
    setSummaryFilter((prev) => ({ ...prev, range: "month" }));
  }, [setSummaryFilter]);

  const ym = useMemo(() => monthPrefix(), []);

  const deliveriesMonth = useMemo(
    () => completedDeliveries.filter((row) => row.completedAt && String(row.completedAt).slice(0, 7) === ym),
    [completedDeliveries, ym],
  );

  const paymentsMonth = useMemo(
    () => payments.filter((p) => p.paidAt && String(p.paidAt).slice(0, 7) === ym),
    [payments, ym],
  );

  return (
    <>
      <AccountingStatsSection mode="monthly" />

      <section className="card">
        <h2 className="card__title">
          本月已完成配送 <span className="card__title-count">{deliveriesMonth.length} 筆</span>
        </h2>
        <p className="card__hint">依完成時間年月篩選（客戶端）；匯出仍為全部資料。</p>
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
              {deliveriesMonth.map((row) => (
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
          本月收款 <span className="card__title-count">{paymentsMonth.length} 筆</span>
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
              {paymentsMonth.map((p) => (
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
    </>
  );
}
