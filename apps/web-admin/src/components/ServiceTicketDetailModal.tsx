import type { ReactNode } from "react";
import { moneyText } from "../adminUtils";

export type ServiceTicketDetail = {
  id: string;
  ticketNo: string;
  serviceType: string;
  serviceTypeLabel?: string;
  status: string;
  statusLabel?: string;
  preferredDate?: string | null;
  preferredSlot?: string | null;
  problemNote?: string | null;
  customerNote?: string | null;
  needLoaner?: boolean;
  loanerNote?: string | null;
  loanerRequestedAt?: string | null;
  quoteAmount?: string | null;
  quoteDetail?: string | null;
  quoteStatus?: string | null;
  workshopStatus?: string | null;
  workshopStatusLabel?: string | null;
  workshopNote?: string | null;
  assessDate?: string | null;
  assessSlot?: string | null;
  assessOutcome?: string | null;
  assessFeeAmount?: string | null;
  assessDriverNote?: string | null;
  assessCustomerAgreed?: boolean | null;
  assessReportedAt?: string | null;
  assessAssignedAt?: string | null;
  acceptedAt?: string | null;
  chargeAmount?: string | null;
  billingType?: string | null;
  closedAt?: string | null;
  cancelledReason?: string | null;
  source?: string | null;
  createdAt?: string;
  returnDate?: string | null;
  returnedAt?: string | null;
  customer?: {
    id: string;
    customerCode?: string | null;
    name: string;
    mobile?: string | null;
    phone?: string | null;
    billingType?: string | null;
  } | null;
  deliveryAddress?: { id?: string; addressLine: string; label?: string | null } | null;
  assessDriver?: { id: string; name?: string | null; employeeCode?: string | null } | null;
  assessVehicle?: { id: string; plateNo?: string | null } | null;
  returnDriver?: { id: string; name?: string | null; employeeCode?: string | null } | null;
  returnVehicle?: { id: string; plateNo?: string | null } | null;
  salesOrderId?: string | null;
  salesOrder?: {
    id: string;
    orderNo: string;
    status: string;
    totalAmount: string;
    cashSubtotal?: string;
    monthlySubtotal?: string;
    billingTypeAtOrder?: string | null;
    officeSettledAt?: string | null;
    createdAt?: string;
  } | null;
  collectorDriverId?: string | null;
  collectorDriver?: { id: string; name?: string | null; employeeCode?: string | null } | null;
  collectionDate?: string | null;
  driverCashReceived?: string | null;
  driverCheckReceived?: string | null;
  events?: Array<{
    id: string;
    eventType: string;
    payloadJson?: unknown;
    createdAt: string;
  }>;
};

function fmtDateTime(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("zh-TW", { hour12: false });
}

function personLabel(p?: { name?: string | null; employeeCode?: string | null } | null): string {
  if (!p) return "—";
  const name = p.name?.trim() || "—";
  return p.employeeCode ? `${name}（${p.employeeCode}）` : name;
}

function billingLabel(v?: string | null): string {
  if (v === "cash") return "現金";
  if (v === "monthly") return "月結";
  return v?.trim() || "—";
}

function eventTypeLabel(t: string): string {
  const map: Record<string, string> = {
    reported: "客戶回報",
    accepted: "受理",
    assess_assigned: "派評估",
    onsite_completed_admin: "後台補登現場完成",
    assess_reported: "評估回報",
    loaner_marked: "標記需備用機",
    in_workshop: "入廠",
    workshop_progress: "廠內進度",
    quote_sent: "送出報價",
    quote_accepted: "報價同意",
    quote_rejected: "報價拒絕",
    return_assigned: "安排送回",
    returned: "已送回",
    closed: "結案",
    billing_posted: "補立帳務",
    cancelled: "取消",
  };
  return map[t] ?? t;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="order-detail__row">
      <span className="order-detail__row-label">{label}</span>
      <span className="order-detail__row-value">{children}</span>
    </div>
  );
}

type Props = {
  ticket: ServiceTicketDetail;
  onClose: () => void;
  onEnsureBilling?: () => void;
  ensuringBilling?: boolean;
};

export default function ServiceTicketDetailModal({ ticket, onClose, onEnsureBilling, ensuringBilling }: Props) {
  const needsBilling =
    ticket.status === "closed" &&
    !ticket.salesOrderId &&
    Number(ticket.chargeAmount ?? ticket.quoteAmount ?? ticket.assessFeeAmount ?? 0) > 0;

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-dialog--order-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="svc-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <div className="order-detail__header-main">
            <h2 id="svc-detail-title" className="modal-dialog__title">
              服務單詳情
            </h2>
            <code className="modal-dialog__order-no">{ticket.ticketNo}</code>
            <div className="order-detail__header-badges">
              <span className="badge badge--default">{ticket.statusLabel ?? ticket.status}</span>
              <span className="badge badge--info">{ticket.serviceTypeLabel ?? ticket.serviceType}</span>
            </div>
          </div>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉視窗">
            ×
          </button>
        </header>

        <div className="modal-dialog__body">
          <div className="order-detail__summary">
            <div className="order-detail__stat">
              <span className="order-detail__stat-label">結案收費</span>
              <span className="order-detail__stat-value">{moneyText(ticket.chargeAmount ?? ticket.quoteAmount)}</span>
            </div>
            <div className="order-detail__stat">
              <span className="order-detail__stat-label">結帳方式</span>
              <span className="order-detail__stat-value">{billingLabel(ticket.billingType)}</span>
            </div>
            <div className="order-detail__stat">
              <span className="order-detail__stat-label">帳務訂單</span>
              <span className="order-detail__stat-value">{ticket.salesOrder?.orderNo ?? "尚未立帳"}</span>
            </div>
            <div className="order-detail__stat">
              <span className="order-detail__stat-label">結案時間</span>
              <span className="order-detail__stat-value" style={{ fontSize: "0.95rem" }}>
                {fmtDateTime(ticket.closedAt)}
              </span>
            </div>
          </div>

          {needsBilling && onEnsureBilling ? (
            <div className="svc-alert svc-alert--warn" style={{ marginBottom: "0.85rem" }}>
              <strong>尚未入帳</strong>
              <span>此單已結案但尚未建立帳務訂單／AR。</span>
              <button type="button" className="btn btn--primary btn--sm" disabled={ensuringBilling} onClick={onEnsureBilling}>
                {ensuringBilling ? "立帳中…" : "補建立帳務"}
              </button>
            </div>
          ) : null}

          <div className="order-detail__panels">
            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">客戶與地址</h3>
              <DetailRow label="客戶">{ticket.customer?.name ?? "—"}</DetailRow>
              <DetailRow label="客戶代號">{ticket.customer?.customerCode ?? "—"}</DetailRow>
              <DetailRow label="電話">{ticket.customer?.mobile || ticket.customer?.phone || "—"}</DetailRow>
              <DetailRow label="客戶預設帳務">{billingLabel(ticket.customer?.billingType)}</DetailRow>
              <DetailRow label="地址">
                {ticket.deliveryAddress?.label ? `${ticket.deliveryAddress.label}｜` : ""}
                {ticket.deliveryAddress?.addressLine ?? "—"}
              </DetailRow>
              <DetailRow label="來源">{ticket.source === "admin" ? "後台" : "LINE"}</DetailRow>
              <DetailRow label="建立時間">{fmtDateTime(ticket.createdAt)}</DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">問題與希望時間</h3>
              <DetailRow label="問題說明">{ticket.problemNote?.trim() || "—"}</DetailRow>
              <DetailRow label="客戶備註">{ticket.customerNote?.trim() || "—"}</DetailRow>
              <DetailRow label="希望日">
                {ticket.preferredDate ?? "—"}
                {ticket.preferredSlot ? ` ${ticket.preferredSlot}` : ""}
              </DetailRow>
              <DetailRow label="需備用機">{ticket.needLoaner ? "是" : "否"}</DetailRow>
              {ticket.needLoaner ? <DetailRow label="備用機說明">{ticket.loanerNote ?? "—"}</DetailRow> : null}
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">評估與現場</h3>
              <DetailRow label="評估司機">{personLabel(ticket.assessDriver)}</DetailRow>
              <DetailRow label="評估車輛">{ticket.assessVehicle?.plateNo ?? "—"}</DetailRow>
              <DetailRow label="評估安排">
                {ticket.assessDate ?? "—"}
                {ticket.assessSlot ? ` ${ticket.assessSlot}` : ""}
              </DetailRow>
              <DetailRow label="評估結果">{ticket.assessOutcome ?? "—"}</DetailRow>
              <DetailRow label="現場費用">{moneyText(ticket.assessFeeAmount)}</DetailRow>
              <DetailRow label="司機備註">{ticket.assessDriverNote?.trim() || "—"}</DetailRow>
              <DetailRow label="回報時間">{fmtDateTime(ticket.assessReportedAt)}</DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">廠內／報價／送回</h3>
              <DetailRow label="廠內進度">{ticket.workshopStatusLabel ?? ticket.workshopStatus ?? "—"}</DetailRow>
              <DetailRow label="廠內備註">{ticket.workshopNote?.trim() || "—"}</DetailRow>
              <DetailRow label="報價金額">{moneyText(ticket.quoteAmount)}</DetailRow>
              <DetailRow label="報價說明">{ticket.quoteDetail?.trim() || "—"}</DetailRow>
              <DetailRow label="報價狀態">{ticket.quoteStatus ?? "—"}</DetailRow>
              <DetailRow label="送回司機">{personLabel(ticket.returnDriver)}</DetailRow>
              <DetailRow label="送回車輛">{ticket.returnVehicle?.plateNo ?? "—"}</DetailRow>
              <DetailRow label="送回日">{ticket.returnDate ?? "—"}</DetailRow>
              <DetailRow label="實際送回">{fmtDateTime(ticket.returnedAt)}</DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">帳務關聯</h3>
              <DetailRow label="結案收費">{moneyText(ticket.chargeAmount)}</DetailRow>
              <DetailRow label="結帳方式">{billingLabel(ticket.billingType)}</DetailRow>
              <DetailRow label="訂單編號">{ticket.salesOrder?.orderNo ?? "—"}</DetailRow>
              <DetailRow label="訂單狀態">{ticket.salesOrder?.status ?? "—"}</DetailRow>
              <DetailRow label="訂單金額">{moneyText(ticket.salesOrder?.totalAmount)}</DetailRow>
              <DetailRow label="現金小計">{moneyText(ticket.salesOrder?.cashSubtotal)}</DetailRow>
              <DetailRow label="月結小計">{moneyText(ticket.salesOrder?.monthlySubtotal)}</DetailRow>
              <DetailRow label="收款司機">{personLabel(ticket.collectorDriver)}</DetailRow>
              <DetailRow label="收款歸屬日">{ticket.collectionDate ?? "—"}</DetailRow>
              <DetailRow label="司機帶回現金">{moneyText(ticket.driverCashReceived)}</DetailRow>
              <DetailRow label="司機帶回支票">{moneyText(ticket.driverCheckReceived)}</DetailRow>
              <DetailRow label="辦公室核銷">{fmtDateTime(ticket.salesOrder?.officeSettledAt)}</DetailRow>
              {ticket.cancelledReason ? <DetailRow label="取消原因">{ticket.cancelledReason}</DetailRow> : null}
            </section>
          </div>

          <section style={{ marginTop: "1rem" }}>
            <h3 className="modal-dialog__section-title">事件歷程</h3>
            {(ticket.events?.length ?? 0) === 0 ? (
              <p className="modal-dialog__empty">尚無事件紀錄</p>
            ) : (
              <div className="modal-dialog__table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>時間</th>
                      <th>事件</th>
                      <th>內容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(ticket.events ?? []).map((e) => (
                      <tr key={e.id}>
                        <td className="cell-nowrap">{fmtDateTime(e.createdAt)}</td>
                        <td>{eventTypeLabel(e.eventType)}</td>
                        <td className="cell-truncate">
                          {e.payloadJson == null
                            ? "—"
                            : typeof e.payloadJson === "string"
                              ? e.payloadJson
                              : JSON.stringify(e.payloadJson)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <footer className="modal-dialog__footer">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            關閉
          </button>
        </footer>
      </div>
    </div>
  );
}
