import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  billingTypeLabel,
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  fmtLocalYmd,
  lineBillingTypeLabel,
  lineExcludedFromOrderTotal,
  linePurposeLabel,
  moneyText,
  orderStatusBadgeClass,
  orderStatusLabel,
  settlementOutcomeLabel,
  splitLocalDateTime,
} from "../adminUtils";
import TaxInvoiceRegisterModal from "./TaxInvoiceRegisterModal";
import { breakdownCashTaxInvoicePreview, cashInvoiceModeLabel } from "../taxDisplay";
import type { TaxInvoiceRecord } from "../taxInvoiceUtils";
import { taxInvoiceStatusLabel } from "../taxInvoiceUtils";
import { openOrderPrintWindow, slipFromDashboardOrderWithAnnouncement } from "../orderPrint";

function fmtDateTimeShort(value: unknown): string {
  const parts = splitLocalDateTime(value);
  if (!parts) return "—";
  return `${parts.date} ${parts.time}`;
}

export type OrderRecord = Record<string, unknown> & {
  id?: unknown;
  orderNo?: unknown;
  status?: unknown;
  scheduledDeliveryDate?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  remark?: unknown;
  subtotal?: unknown;
  totalAmount?: unknown;
  cashSubtotal?: unknown;
  monthlySubtotal?: unknown;
  billingTypeAtOrder?: unknown;
  cashInvoiceMode?: unknown;
  pendingPrepaidTopupBarrels?: unknown;
  officeSettledAt?: unknown;
  customer?: { name?: string; customerCode?: string | null; billingType?: string; taxId?: string | null };
  deliveryAddress?: {
    label?: string | null;
    addressLine?: string;
    contactName?: string | null;
    contactPhone?: string | null;
    contactMobile?: string | null;
  };
  lines?: Array<{
    id?: unknown;
    productId?: unknown;
    qtyOrdered?: unknown;
    qtyDelivered?: unknown;
    unitPrice?: unknown;
    lineAmount?: unknown;
    billingTypeAtLine?: string | null;
    linePurpose?: string | null;
    isPromotionGift?: boolean;
    promotionRuleKey?: string | null;
    promotionNote?: string | null;
    isReplenishment?: boolean;
    product?: { name?: string; sku?: string | null; unit?: string | null };
  }>;
  assignments?: Array<{
    id?: unknown;
    status?: string | null;
    assignmentDate?: unknown;
    driverReportedAt?: unknown;
    completedAt?: unknown;
    officeSettledAt?: unknown;
    settlementOutcome?: string | null;
    failureReason?: string | null;
    settlementNote?: string | null;
    expectedAmount?: unknown;
    cashReceived?: unknown;
    cashVariance?: unknown;
    emptyBarrelsReturned?: number | null;
    driver?: { user?: { employeeCode?: string; name?: string } };
    vehicle?: { plateNo?: string | null };
  }>;
  taxInvoices?: Array<{
    id?: unknown;
    invoiceNo?: unknown;
    externalInvoiceNo?: unknown;
    status?: unknown;
    invoiceMode?: unknown;
    basisType?: unknown;
    untaxedAmount?: unknown;
    taxAmount?: unknown;
    totalAmount?: unknown;
    taxRate?: unknown;
    buyerName?: unknown;
    buyerTaxId?: unknown;
    note?: unknown;
    issuedAt?: unknown;
    createdAt?: unknown;
    salesOrderId?: unknown;
    salesOrderNo?: unknown;
  }>;
};

function getActualDeliveryYmd(order: OrderRecord): string | null {
  const assignments = Array.isArray(order.assignments) ? order.assignments : [];
  if (assignments.length === 0) return null;
  const picked = assignments
    .map((a) => a?.driverReportedAt ?? a?.assignmentDate ?? a?.completedAt ?? a?.officeSettledAt ?? null)
    .find((v) => v != null && String(v).trim() !== "");
  if (!picked) return null;
  return fmtLocalYmd(picked);
}

function pickLatestAssignment(order: OrderRecord) {
  const list = Array.isArray(order.assignments) ? [...order.assignments] : [];
  if (list.length === 0) return null;
  list.sort((a, b) => {
    const ta = new Date(String(a.driverReportedAt ?? a.officeSettledAt ?? a.completedAt ?? a.assignmentDate ?? 0)).getTime();
    const tb = new Date(String(b.driverReportedAt ?? b.officeSettledAt ?? b.completedAt ?? b.assignmentDate ?? 0)).getTime();
    return tb - ta;
  });
  return list[0] ?? null;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="order-detail__row">
      <span className="order-detail__label">{label}</span>
      <span className="order-detail__value">{children}</span>
    </div>
  );
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="order-detail__stat">
      <span className="order-detail__stat-label">{label}</span>
      <strong className="order-detail__stat-value">{value}</strong>
      {hint ? <span className="order-detail__stat-hint">{hint}</span> : null}
    </div>
  );
}

export function OrderDetailModal({ order, onClose }: { order: OrderRecord; onClose: () => void }) {
  const lines = useMemo(() => {
    const raw = Array.isArray(order.lines) ? [...order.lines] : [];
    raw.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
    return raw;
  }, [order.lines]);

  const assignment = useMemo(() => pickLatestAssignment(order), [order.assignments]);

  const amountSummary = useMemo(() => {
    let cashUntaxed = 0;
    let monthly = 0;
    let prepaidInTotal = 0;
    let prepaidExcluded = 0;
    for (const line of lines) {
      const amt = Number(line.lineAmount ?? 0);
      if (!Number.isFinite(amt)) continue;
      const bt = line.billingTypeAtLine ?? "";
      if (bt === "cash") cashUntaxed += amt;
      else if (bt === "monthly") monthly += amt;
      else if (bt === "prepaid") {
        if (lineExcludedFromOrderTotal(line, lines)) prepaidExcluded += amt;
        else prepaidInTotal += amt;
      }
    }
    const cashInvoiceMode = order.cashInvoiceMode != null ? String(order.cashInvoiceMode) : "none";
    const taxPreview = breakdownCashTaxInvoicePreview(cashUntaxed, cashInvoiceMode);
    const billableCash = taxPreview?.totalWithTax ?? cashUntaxed;
    const billableTotal = billableCash + monthly;
    return { cashUntaxed, monthly, prepaidInTotal, prepaidExcluded, billableTotal, taxPreview };
  }, [lines, order.cashInvoiceMode]);

  const [taxInvoices, setTaxInvoices] = useState(() =>
    Array.isArray(order.taxInvoices) ? [...order.taxInvoices] : [],
  );
  const [registerTarget, setRegisterTarget] = useState<TaxInvoiceRecord | null>(null);
  const [showInvoiceHistory, setShowInvoiceHistory] = useState(false);
  const activeTaxInvoices = useMemo(
    () => taxInvoices.filter((ti) => String(ti.status ?? "planned") !== "voided"),
    [taxInvoices],
  );
  const voidedTaxInvoices = useMemo(
    () => taxInvoices.filter((ti) => String(ti.status ?? "planned") === "voided"),
    [taxInvoices],
  );

  useEffect(() => {
    setTaxInvoices(Array.isArray(order.taxInvoices) ? [...order.taxInvoices] : []);
    setShowInvoiceHistory(false);
  }, [order]);

  const toTaxInvoiceRecord = (ti: NonNullable<OrderRecord["taxInvoices"]>[number]): TaxInvoiceRecord => ({
    id: String(ti.id ?? ""),
    invoiceNo: String(ti.invoiceNo ?? ""),
    externalInvoiceNo: ti.externalInvoiceNo != null ? String(ti.externalInvoiceNo) : null,
    customerId: String((order as { customerId?: unknown }).customerId ?? ""),
    customerName: order.customer?.name ?? null,
    basisType: String(ti.basisType ?? "sales_order"),
    salesOrderId: ti.salesOrderId != null ? String(ti.salesOrderId) : String(order.id ?? ""),
    salesOrderNo: ti.salesOrderNo != null ? String(ti.salesOrderNo) : String(order.orderNo ?? ""),
    billingStatementId: null,
    billingStatementNo: null,
    receiptVoucherId: null,
    receiptVoucherNo: null,
    invoiceMode: String(ti.invoiceMode ?? ""),
    untaxedAmount: String(ti.untaxedAmount ?? "0"),
    taxAmount: String(ti.taxAmount ?? "0"),
    totalAmount: String(ti.totalAmount ?? "0"),
    taxRate: String(ti.taxRate ?? "0.05"),
    status: String(ti.status ?? "planned"),
    buyerTaxId: ti.buyerTaxId != null ? String(ti.buyerTaxId) : null,
    buyerName: ti.buyerName != null ? String(ti.buyerName) : null,
    note: ti.note != null ? String(ti.note) : null,
    issuedAt: String(ti.issuedAt ?? ""),
    createdAt: String(ti.createdAt ?? ""),
  });

  const addr = order.deliveryAddress;
  const addressText = addr
    ? [addr.label ? `${addr.label}` : null, addr.addressLine].filter(Boolean).join(" — ") || "—"
    : "—";
  const contactText = [addr?.contactName, addr?.contactPhone ?? addr?.contactMobile].filter(Boolean).join(" / ") || "—";

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusRaw = String(order.status ?? "");
  const billingAtOrder = order.billingTypeAtOrder != null ? String(order.billingTypeAtOrder) : null;

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-dialog--order-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <div className="order-detail__header-main">
            <h2 id="order-detail-title" className="modal-dialog__title">
              訂單詳情
            </h2>
            <code className="modal-dialog__order-no">{String(order.orderNo ?? "")}</code>
            <div className="order-detail__header-badges">
              <span className={orderStatusBadgeClass(statusRaw)}>{orderStatusLabel(statusRaw)}</span>
              {billingAtOrder ? <span className="badge badge--default">{billingTypeLabel(billingAtOrder)}</span> : null}
            </div>
          </div>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉視窗">
            ×
          </button>
        </header>

        <div className="modal-dialog__body">
          <div className="order-detail__summary">
            <SummaryStat
              label="本單應收"
              value={moneyText(amountSummary.billableTotal)}
              hint={
                amountSummary.taxPreview
                  ? `現金含稅 ${moneyText(amountSummary.taxPreview.totalWithTax)}`
                  : undefined
              }
            />
            <SummaryStat label="現金列（未稅）" value={moneyText(amountSummary.cashUntaxed)} />
            <SummaryStat label="月結列" value={moneyText(amountSummary.monthly)} />
            <SummaryStat
              label="預付扣桶"
              value={moneyText(amountSummary.prepaidInTotal + amountSummary.prepaidExcluded)}
              hint={amountSummary.prepaidExcluded > 0 ? `其中 ${moneyText(amountSummary.prepaidExcluded)} 含於儲值` : undefined}
            />
          </div>

          <div className="order-detail__panels">
            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">客戶與配送</h3>
              <DetailRow label="客戶">{order.customer?.name ?? "—"}</DetailRow>
              {order.customer?.customerCode ? (
                <DetailRow label="客戶代號">{order.customer.customerCode}</DetailRow>
              ) : null}
              {order.customer?.taxId ? <DetailRow label="統編">{order.customer.taxId}</DetailRow> : null}
              <DetailRow label="送貨地址">{addressText}</DetailRow>
              <DetailRow label="聯絡人">{contactText}</DetailRow>
              <DetailRow label="預計配送">{fmtLocalYmd(order.scheduledDeliveryDate)}</DetailRow>
              <DetailRow label="實際配送">{getActualDeliveryYmd(order) ?? "—"}</DetailRow>
              <DetailRow label="建立時間">{fmtDateTimeShort(order.createdAt)}</DetailRow>
              <DetailRow label="辦公室核銷">{fmtDateTimeShort(order.officeSettledAt ?? assignment?.officeSettledAt)}</DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">配送與收款</h3>
              {assignment ? (
                <>
                  <DetailRow label="配送狀態">
                    <span className={deliveryAssignmentStatusBadgeClass(assignment.status)}>
                      {deliveryAssignmentStatusLabel(assignment.status)}
                    </span>
                  </DetailRow>
                  <DetailRow label="司機">{assignment.driver?.user?.name ?? "—"}</DetailRow>
                  <DetailRow label="車牌">{assignment.vehicle?.plateNo ?? "—"}</DetailRow>
                  <DetailRow label="司機回報">{fmtDateTimeShort(assignment.driverReportedAt)}</DetailRow>
                  <DetailRow label="回報結果">
                    {settlementOutcomeLabel(assignment.settlementOutcome, {
                      billingTypeAtOrder:
                        typeof order?.billingTypeAtOrder === "string" ? order.billingTypeAtOrder : null,
                      expectedAmount: assignment.expectedAmount != null ? Number(assignment.expectedAmount) : null,
                      cashReceived: assignment.cashReceived != null ? Number(assignment.cashReceived) : 0,
                      checkReceived: 0,
                    })}
                  </DetailRow>
                  <DetailRow label="應收現金">{moneyText(assignment.expectedAmount)}</DetailRow>
                  <DetailRow label="實收現金">{moneyText(assignment.cashReceived)}</DetailRow>
                  <DetailRow label="差額">{moneyText(assignment.cashVariance)}</DetailRow>
                  <DetailRow label="空桶回收">{assignment.emptyBarrelsReturned ?? "—"}</DetailRow>
                  {assignment.failureReason ? (
                    <DetailRow label="未送達原因">{String(assignment.failureReason)}</DetailRow>
                  ) : null}
                  {assignment.settlementNote ? (
                    <DetailRow label="核銷備註">{String(assignment.settlementNote)}</DetailRow>
                  ) : null}
                </>
              ) : (
                <p className="order-detail__empty-panel">尚未分派配送任務。</p>
              )}
            </section>
          </div>

          {(order.remark || order.cashInvoiceMode || Number(order.pendingPrepaidTopupBarrels ?? 0) > 0) && (
            <div className="order-detail__meta-strip">
              {order.remark ? (
                <div className="order-detail__meta-item">
                  <span className="order-detail__meta-label">備註</span>
                  <span>{String(order.remark)}</span>
                </div>
              ) : null}
              <div className="order-detail__meta-item">
                <span className="order-detail__meta-label">現金／儲值發票</span>
                <span>{cashInvoiceModeLabel(order.cashInvoiceMode != null ? String(order.cashInvoiceMode) : null)}</span>
              </div>
              {Number(order.pendingPrepaidTopupBarrels ?? 0) > 0 ? (
                <div className="order-detail__meta-item">
                  <span className="order-detail__meta-label">待入帳儲值</span>
                  <span>{String(order.pendingPrepaidTopupBarrels)} 桶（現金 AR 沖清後入帳）</span>
                </div>
              ) : null}
            </div>
          )}

          <h3 className="modal-dialog__section-title">商品明細</h3>
          {lines.length === 0 ? (
            <p className="modal-dialog__empty">此訂單無明細資料。</p>
          ) : (
            <div className="table-wrap modal-dialog__table-wrap">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>品名</th>
                    <th>用途</th>
                    <th>結帳</th>
                    <th className="num">實際送桶</th>
                    <th className="num">空桶回收</th>
                    <th className="num">單價</th>
                    <th className="num">小計</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const excluded = lineExcludedFromOrderTotal(line, lines);
                    return (
                      <tr key={String(line.id ?? i)}>
                        <td className="num">{i + 1}</td>
                        <td>
                          <strong>{line.product?.name ?? "—"}</strong>
                          <div className="order-detail__line-sku">
                            {line.product?.sku ?? "—"} · {line.product?.unit ?? "—"}
                          </div>
                        </td>
                        <td>
                          {linePurposeLabel(
                            line.linePurpose,
                            Boolean(line.isPromotionGift),
                            Boolean(line.isReplenishment),
                          )}
                          {line.promotionNote ? (
                            <div className="order-detail__line-note">{String(line.promotionNote)}</div>
                          ) : null}
                        </td>
                        <td>{lineBillingTypeLabel(line.billingTypeAtLine)}</td>
                        <td className="num">{line.qtyDelivered != null ? String(line.qtyDelivered) : "—"}</td>
                        {i === 0 ? (
                          <td
                            className="num"
                            rowSpan={lines.length}
                            title="本趟配送空桶回收（非單品明細）"
                          >
                            {assignment?.emptyBarrelsReturned != null
                              ? String(assignment.emptyBarrelsReturned)
                              : "—"}
                          </td>
                        ) : null}
                        <td className="num">{moneyText(line.unitPrice)}</td>
                        <td className="num">
                          {moneyText(line.lineAmount)}
                          {line.isPromotionGift ? <div className="order-detail__line-note">贈品</div> : null}
                          {line.isReplenishment ? <div className="order-detail__line-note">補送</div> : null}
                          {excluded ? <div className="order-detail__line-note">含於儲值</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {amountSummary.prepaidExcluded > 0 ? (
            <p className="order-detail__footnote">
              同商品「預付桶儲值」與「預付出貨」同單時，出貨金額不另計入本單應收（已含於儲值）。
            </p>
          ) : null}

          {activeTaxInvoices.length > 0 ? (
            <>
              <h3 className="modal-dialog__section-title">有效發票</h3>
              <div className="table-wrap modal-dialog__table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>狀態</th>
                      <th>實際發票號</th>
                      <th>模式</th>
                      <th className="num">未稅</th>
                      <th className="num">稅額</th>
                      <th className="num">含稅</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {activeTaxInvoices.map((ti, idx) => {
                      const status = ti.status != null ? String(ti.status) : "planned";
                      const ext = ti.externalInvoiceNo != null ? String(ti.externalInvoiceNo) : "";
                      return (
                        <tr key={`${String(ti.invoiceNo ?? "")}-${idx}`}>
                          <td>{taxInvoiceStatusLabel(status)}</td>
                          <td className="mono-text">{ext.trim() || "—"}</td>
                          <td>{cashInvoiceModeLabel(ti.invoiceMode != null ? String(ti.invoiceMode) : null)}</td>
                          <td className="num">{moneyText(ti.untaxedAmount)}</td>
                          <td className="num">{moneyText(ti.taxAmount)}</td>
                          <td className="num">
                            <strong>{moneyText(ti.totalAmount)}</strong>
                          </td>
                          <td>
                            {status === "planned" && ti.id != null ? (
                              <button
                                type="button"
                                className="btn btn--sm btn--primary"
                                onClick={() => setRegisterTarget(toTaxInvoiceRecord(ti))}
                              >
                                補登
                              </button>
                            ) : ti.id != null ? (
                              <button
                                type="button"
                                className="btn btn--sm"
                                onClick={() => setRegisterTarget(toTaxInvoiceRecord(ti))}
                              >
                                檢視
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-muted order-detail__footnote">
                更多紀錄見
                <Link to="/reports/tax-invoices" style={{ marginLeft: "0.25rem" }}>
                  發票查詢
                </Link>
                。
              </p>
            </>
          ) : order.cashInvoiceMode != null &&
            String(order.cashInvoiceMode).trim() !== "" &&
            String(order.cashInvoiceMode) !== "none" ? (
            <p className="text-muted modal-dialog__empty">已設定開票模式但尚無發票紀錄。</p>
          ) : null}

          {voidedTaxInvoices.length > 0 ? (
            <details
              className="order-detail__invoice-history"
              open={showInvoiceHistory}
              onToggle={(e) => setShowInvoiceHistory(e.currentTarget.open)}
            >
              <summary>作廢發票歷史（{voidedTaxInvoices.length} 筆）</summary>
              <div className="table-wrap modal-dialog__table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>狀態</th>
                      <th>內部編號</th>
                      <th>模式</th>
                      <th className="num">未稅</th>
                      <th className="num">稅額</th>
                      <th className="num">含稅</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {voidedTaxInvoices.map((ti, idx) => (
                      <tr key={`${String(ti.invoiceNo ?? "")}-voided-${idx}`}>
                        <td>{taxInvoiceStatusLabel(String(ti.status ?? "voided"))}</td>
                        <td className="mono-text">{ti.invoiceNo != null ? String(ti.invoiceNo) : "—"}</td>
                        <td>{cashInvoiceModeLabel(ti.invoiceMode != null ? String(ti.invoiceMode) : null)}</td>
                        <td className="num">{moneyText(ti.untaxedAmount)}</td>
                        <td className="num">{moneyText(ti.taxAmount)}</td>
                        <td className="num">
                          <strong>{moneyText(ti.totalAmount)}</strong>
                        </td>
                        <td>
                          {ti.id != null ? (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => setRegisterTarget(toTaxInvoiceRecord(ti))}
                            >
                              檢視
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>

        <footer className="modal-dialog__footer">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              void (async () => {
                const slip = await slipFromDashboardOrderWithAnnouncement(order as unknown as Record<string, unknown>);
                const ok = openOrderPrintWindow(slip);
                if (!ok) window.alert("無法開啟列印視窗，請允許此網站的彈出視窗後再試。");
              })();
            }}
          >
            套印列印
          </button>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            關閉
          </button>
        </footer>
      </div>
      {registerTarget ? (
        <TaxInvoiceRegisterModal
          invoice={registerTarget}
          onClose={() => setRegisterTarget(null)}
          onSaved={(updated) => {
            setTaxInvoices((prev) =>
              prev.map((ti) =>
                String(ti.id) === updated.id
                  ? {
                      ...ti,
                      externalInvoiceNo: updated.externalInvoiceNo,
                      status: updated.status,
                      buyerName: updated.buyerName,
                      buyerTaxId: updated.buyerTaxId,
                      note: updated.note,
                    }
                  : ti,
              ),
            );
          }}
        />
      ) : null}
    </div>
  );
}
