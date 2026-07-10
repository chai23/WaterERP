import { useCallback, useMemo, useState } from "react";
import { fmtLocalYmd, moneyText, orderStatusBadgeClass } from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { useDashboard } from "../DashboardContext";
import { openOrderPrintWindow, slipFromDashboardOrderWithAnnouncement } from "../orderPrint";
import { breakdownCashTaxInvoicePreview } from "../taxDisplay";

function canCancelOrderStatus(status: unknown): boolean {
  const s = String(status ?? "");
  return s !== "completed" && s !== "cancelled" && s !== "assigned" && s !== "delivering";
}

function getActualDeliveryYmd(order: OrderRecord): string | null {
  const assignments = Array.isArray(order.assignments) ? order.assignments : [];
  if (assignments.length === 0) return null;
  const picked = assignments
    .map((a) => a?.driverReportedAt ?? a?.assignmentDate ?? a?.completedAt ?? a?.officeSettledAt ?? null)
    .find((v) => v != null && String(v).trim() !== "");
  if (!picked) return null;
  return fmtLocalYmd(picked);
}

function deliveryDateLabel(order: OrderRecord): string {
  const status = String(order.status ?? "");
  if (status === "completed" || status === "not_delivered") {
    return getActualDeliveryYmd(order) ?? fmtLocalYmd(order.scheduledDeliveryDate);
  }
  return fmtLocalYmd(order.scheduledDeliveryDate);
}

/** 本單應收（現金含稅＋月結份額）；與報表、訂單詳情一致 */
function orderTaxInclusiveAmount(order: OrderRecord): string {
  if (order.orderBillableAmount != null && String(order.orderBillableAmount).trim() !== "") {
    return moneyText(order.orderBillableAmount);
  }
  const lines = Array.isArray(order.lines) ? order.lines : [];
  let cashUntaxed = 0;
  let monthly = 0;
  for (const line of lines) {
    const amt = Number(line.lineAmount ?? 0);
    if (!Number.isFinite(amt)) continue;
    const bt = line.billingTypeAtLine ?? "";
    if (bt === "cash") cashUntaxed += amt;
    else if (bt === "monthly") monthly += amt;
  }
  const cashInvoiceMode = order.cashInvoiceMode != null ? String(order.cashInvoiceMode) : "none";
  const taxPreview = breakdownCashTaxInvoicePreview(cashUntaxed, cashInvoiceMode);
  const billableCash = taxPreview?.totalWithTax ?? cashUntaxed;
  return moneyText(billableCash + monthly);
}

export { OrderDetailModal, type OrderRecord };

export default function OrderQueryPage() {
  const { orders, onCancelOrder } = useDashboard();
  const [q, setQ] = useState("");
  const [detailOrder, setDetailOrder] = useState<OrderRecord | null>(null);
  const closeDetail = useCallback(() => setDetailOrder(null), []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return orders;
    return orders.filter((o) => {
      const no = String(o.orderNo ?? "").toLowerCase();
      const cust = String(o.customer?.name ?? "").toLowerCase();
      return no.includes(s) || cust.includes(s);
    });
  }, [orders, q]);

  return (
    <section className="card">
      <h2 className="card__title">查詢訂單</h2>
      <p className="card__hint">
        以單號或客戶名稱篩選；未結案訂單可取消。<strong>滑鼠移到列上</strong>會高亮該筆訂單；<strong>點一下訂單列</strong>或點<strong>明細欄「詳情」</strong>可開啟詳情並檢視多筆商品明細。
        配送日欄位：<strong>已結案顯示實際配送日</strong>，未結案顯示預計配送日。
        套印單上一維條碼內容為<strong>訂單編號字串</strong>，可用掃描槍掃描後貼入上方關鍵字以快速查單。
      </p>
      <div className="field" style={{ maxWidth: "24rem", marginBottom: "1rem" }}>
        <span>關鍵字</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號或客戶名稱" />
      </div>
      <h3 className="card__title" style={{ fontSize: "1rem", marginTop: 0 }}>
        結果 <span className="card__title-count">{filtered.length} 筆</span>
      </h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>單號</th>
              <th>客戶</th>
              <th>狀態</th>
              <th>配送日</th>
              <th className="num">金額（含稅）</th>
              <th>明細</th>
              <th>套印</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => {
              const lineCount = Array.isArray(o.lines) ? o.lines.length : 0;
              return (
                <tr
                  key={String(o.id)}
                  className="order-row--clickable"
                  title="點一下此列開啟訂單詳情"
                  onClick={() => setDetailOrder(o as OrderRecord)}
                >
                  <td>
                    <code style={{ fontSize: "0.8em" }}>{o.orderNo}</code>
                  </td>
                  <td>{o.customer?.name ?? "—"}</td>
                  <td>
                    <span className={orderStatusBadgeClass(o.status)}>{o.status}</span>
                  </td>
                  <td>{deliveryDateLabel(o as OrderRecord)}</td>
                  <td className="num">{orderTaxInclusiveAmount(o as OrderRecord)}</td>
                  <td>
                    <div className="order-detail-cell">
                      <span className="order-detail-cell__count" title="商品明細筆數">
                        {lineCount} 項
                      </span>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        aria-label={`查看訂單 ${String(o.orderNo ?? "")} 詳情`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailOrder(o as OrderRecord);
                        }}
                      >
                        詳情
                      </button>
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void (async () => {
                          const slip = await slipFromDashboardOrderWithAnnouncement(o as unknown as Record<string, unknown>);
                          const ok = openOrderPrintWindow(slip);
                          if (!ok) window.alert("無法開啟列印視窗，請允許此網站的彈出視窗後再試。");
                        })();
                      }}
                    >
                      套印
                    </button>
                  </td>
                  <td>
                    {canCancelOrderStatus(o.status) ? (
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onCancelOrder(String(o.id));
                        }}
                      >
                        取消訂單
                      </button>
                    ) : (
                      <span className="feedback" style={{ color: "var(--text-muted)" }}>
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailOrder ? <OrderDetailModal order={detailOrder} onClose={closeDetail} /> : null}
    </section>
  );
}
