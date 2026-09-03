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

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const raw = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    return `${y}/${Number(m)}/${Number(d)}`;
  }
  return fmtDateTime(raw);
}

function personLabel(p?: { name?: string | null; employeeCode?: string | null } | null): string {
  if (!p) return "尚未指定";
  const name = p.name?.trim() || "—";
  return p.employeeCode ? `${name}（員編 ${p.employeeCode}）` : name;
}

function billingLabel(v?: string | null): string {
  if (v === "cash") return "現金";
  if (v === "monthly") return "月結";
  if (v === "prepaid") return "預付（桶）";
  if (v === "mixed") return "混用";
  return v?.trim() || "—";
}

function sourceLabel(v?: string | null): string {
  if (v === "admin") return "後台手動建立（來電）";
  if (v === "liff") return "LINE 客戶自行回報";
  return v?.trim() || "—";
}

function assessOutcomeLabel(v?: string | null): string {
  if (!v) return "尚未回報";
  switch (v) {
    case "onsite_fixed":
      return "現場維修完成（可收費）";
    case "unable":
    case "bring_back":
      return "無法現場處理，載回廠內";
    case "cancelled":
      return "評估後取消";
    case "loaner_swapped":
      return "已換臨時機";
    default:
      return v;
  }
}

function quoteStatusLabel(v?: string | null): string {
  if (!v) return "尚未報價";
  switch (v) {
    case "pending":
      return "待客戶確認";
    case "accepted":
      return "已同意";
    case "rejected":
      return "已拒絕";
    default:
      return v;
  }
}

function orderStatusLabel(v?: string | null): string {
  if (!v) return "—";
  switch (v) {
    case "draft":
      return "草稿";
    case "confirmed":
      return "已確認";
    case "assigned":
      return "已派單";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "pending_settlement":
      return "待核銷";
    default:
      return v;
  }
}

function yesNo(v?: boolean | null, empty = "—"): string {
  if (v === true) return "是";
  if (v === false) return "否";
  return empty;
}

function ticketStatusLabel(v?: string | null): string {
  if (!v) return "—";
  switch (v) {
    case "reported":
      return "已回報，待受理";
    case "accepted":
      return "已受理";
    case "assess_assigned":
      return "已派評估";
    case "onsite_completed":
      return "現場已完工";
    case "pending_pickup":
      return "待載回";
    case "pending_loaner":
      return "待換臨時機";
    case "in_workshop":
      return "廠內處理中";
    case "quote_pending":
      return "待確認報價";
    case "quote_accepted":
      return "報價已同意";
    case "quote_rejected":
      return "報價已拒絕";
    case "pending_return":
      return "待送回";
    case "returned":
      return "已送回";
    case "closed":
      return "已結案";
    case "cancelled":
      return "已取消";
    case "unable":
      return "無法現場處理";
    default:
      return v;
  }
}

function workshopProgressLabel(v?: string | null): string {
  if (!v) return "—";
  switch (v) {
    case "received":
      return "已入廠";
    case "diagnosing":
      return "診斷中";
    case "in_progress":
      return "清洗／維修中";
    case "done_pending_return":
      return "已完工待送回";
    default:
      return v;
  }
}

function eventTypeLabel(t: string): string {
  const map: Record<string, string> = {
    reported: "客戶回報／開單",
    accepted: "受理",
    assess_assigned: "派評估",
    onsite_completed_admin: "後台補登現場完成",
    assess_reported: "評估回報",
    loaner_marked: "標記需備用機",
    loaner_noted_at_report: "開單時登記需備用機",
    loaner_needed: "登記需臨時機",
    loaner_requested_by_customer: "客戶申請備用機",
    workshop_received: "確認入廠",
    in_workshop: "確認入廠",
    workshop_progress: "更新廠內進度",
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

function boolText(value: unknown): string {
  if (value === true || value === "true" || value === 1 || value === "1") return "是";
  if (value === false || value === "false" || value === 0 || value === "0") return "否";
  return String(value);
}

type PayloadItem = { label: string; value: string };

function payloadItem(key: string, value: unknown): PayloadItem | null {
  if (value == null || value === "") return null;
  switch (key) {
    case "via":
      if (value === "admin") return { label: "操作來源", value: "後台" };
      if (value === "liff") return { label: "操作來源", value: "LINE" };
      if (value === "driver") return { label: "操作來源", value: "司機端" };
      return { label: "操作來源", value: String(value) };
    case "outcome":
      return { label: "結果", value: assessOutcomeLabel(String(value)) };
    case "amount":
      return { label: "報價金額", value: moneyText(String(value)) };
    case "chargeAmount":
      return { label: "結案收費", value: moneyText(String(value)) };
    case "feeAmount":
      return { label: "現場費用", value: moneyText(String(value)) };
    case "collectedCash":
      return { label: "帶回現金", value: moneyText(String(value)) };
    case "collectedCheck":
      return { label: "帶回支票", value: moneyText(String(value)) };
    case "detail":
      return { label: "報價說明", value: String(value) };
    case "note":
      return { label: "備註", value: String(value) };
    case "workshopStatus":
      return { label: "廠內進度", value: workshopProgressLabel(String(value)) };
    case "serviceType":
      if (value === "cleaning") return { label: "服務類型", value: "清洗" };
      if (value === "repair") return { label: "服務類型", value: "維修" };
      if (value === "both") return { label: "服務類型", value: "清洗＋維修" };
      return { label: "服務類型", value: String(value) };
    case "preferredDate":
      return { label: "希望日", value: fmtDate(String(value)) };
    case "preferredSlot":
      return { label: "希望時段", value: String(value) };
    case "assessSlot":
      return { label: "評估時段", value: String(value) };
    case "assessDateYmd":
      return { label: "評估日", value: fmtDate(String(value)) };
    case "returnDateYmd":
      return { label: "送回日", value: fmtDate(String(value)) };
    case "collectionDate":
      return { label: "收款歸屬日", value: fmtDate(String(value)) };
    case "needLoaner":
      return { label: "需備用機", value: boolText(value) };
    case "loanerNote":
      return { label: "備用機說明", value: String(value) };
    case "agreed":
      return { label: "客戶同意現場處理", value: boolText(value) };
    case "alreadyInWorkshop":
      return {
        label: "入廠狀態",
        value: value === true || value === "true" ? "當時已在廠內" : "當時尚未入廠",
      };
    case "fromStatus":
      return { label: "前一狀態", value: ticketStatusLabel(String(value)) };
    case "nextStatus":
    case "nextTicketStatus":
    case "driverId":
    case "vehicleId":
    case "collectorDriverId":
    case "salesOrderId":
      return null;
    case "orderNo":
      return { label: "帳務訂單", value: String(value) };
    case "billingType":
      return { label: "結帳方式", value: billingLabel(String(value)) };
    case "billingCreated":
      return { label: "已建立帳務", value: boolText(value) };
    case "paymentPosted":
      return { label: "已入收款", value: boolText(value) };
    case "cashCollectedNow":
      return { label: "結案時司機已收款", value: boolText(value) };
    case "returnConfirmedByAdmin":
      return { label: "後台確認已送回", value: boolText(value) };
    default:
      return null;
  }
}

const PAYLOAD_ORDER = [
  "via",
  "outcome",
  "serviceType",
  "preferredDate",
  "preferredSlot",
  "assessDateYmd",
  "assessSlot",
  "returnDateYmd",
  "needLoaner",
  "loanerNote",
  "workshopStatus",
  "amount",
  "detail",
  "feeAmount",
  "chargeAmount",
  "note",
  "agreed",
  "alreadyInWorkshop",
  "fromStatus",
  "orderNo",
  "billingType",
  "billingCreated",
  "paymentPosted",
  "cashCollectedNow",
  "collectedCash",
  "collectedCheck",
  "collectionDate",
  "returnConfirmedByAdmin",
] as const;

function formatEventPayloadItems(payload: unknown): PayloadItem[] {
  if (payload == null) return [];
  if (typeof payload === "string") {
    const t = payload.trim();
    return t ? [{ label: "內容", value: t }] : [];
  }
  if (typeof payload !== "object") {
    return [{ label: "內容", value: String(payload) }];
  }
  const obj = payload as Record<string, unknown>;
  const seen = new Set<string>();
  const items: PayloadItem[] = [];
  for (const k of PAYLOAD_ORDER) {
    if (!(k in obj)) continue;
    seen.add(k);
    const item = payloadItem(k, obj[k]);
    if (item) items.push(item);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (seen.has(k)) continue;
    const item = payloadItem(k, v);
    if (item) items.push(item);
  }
  return items;
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

  const addressLabel = ticket.deliveryAddress?.label?.trim();
  const addressLine = ticket.deliveryAddress?.addressLine?.trim() || "—";
  const addressText =
    addressLabel && addressLabel !== "預設"
      ? `${addressLabel}｜${addressLine}`
      : addressLine;

  const preferredText =
    ticket.preferredDate || ticket.preferredSlot
      ? [fmtDate(ticket.preferredDate), ticket.preferredSlot?.trim()].filter(Boolean).join("　")
      : "未指定";

  const assessSchedule =
    ticket.assessDate || ticket.assessSlot
      ? [fmtDate(ticket.assessDate), ticket.assessSlot?.trim()].filter(Boolean).join("　")
      : "尚未安排";

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
              <span className="order-detail__stat-value" style={{ wordBreak: "break-all", fontSize: "0.9rem" }}>
                {ticket.salesOrder?.orderNo ?? "尚未立帳"}
              </span>
            </div>
            <div className="order-detail__stat">
              <span className="order-detail__stat-label">結案時間</span>
              <span className="order-detail__stat-value" style={{ fontSize: "0.95rem" }}>
                {ticket.closedAt ? fmtDateTime(ticket.closedAt) : "尚未結案"}
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
              <DetailRow label="客戶姓名">{ticket.customer?.name?.trim() || "—"}</DetailRow>
              <DetailRow label="客戶代號">{ticket.customer?.customerCode ?? "—"}</DetailRow>
              <DetailRow label="聯絡電話">{ticket.customer?.mobile || ticket.customer?.phone || "—"}</DetailRow>
              <DetailRow label="客戶預設結帳">{billingLabel(ticket.customer?.billingType)}</DetailRow>
              <DetailRow label="服務地址">{addressText}</DetailRow>
              <DetailRow label="開單來源">{sourceLabel(ticket.source)}</DetailRow>
              <DetailRow label="建立時間">{fmtDateTime(ticket.createdAt)}</DetailRow>
              {ticket.acceptedAt ? <DetailRow label="受理時間">{fmtDateTime(ticket.acceptedAt)}</DetailRow> : null}
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">問題與希望時間</h3>
              <DetailRow label="問題說明">{ticket.problemNote?.trim() || "未填寫"}</DetailRow>
              <DetailRow label="內部備註">{ticket.customerNote?.trim() || "無"}</DetailRow>
              <DetailRow label="客戶希望時段">{preferredText}</DetailRow>
              <DetailRow label="是否需備用機">{yesNo(ticket.needLoaner, "否")}</DetailRow>
              {ticket.needLoaner ? (
                <>
                  <DetailRow label="備用機說明">{ticket.loanerNote?.trim() || "無補充說明"}</DetailRow>
                  {ticket.loanerRequestedAt ? (
                    <DetailRow label="備用機登記時間">{fmtDateTime(ticket.loanerRequestedAt)}</DetailRow>
                  ) : null}
                </>
              ) : null}
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">評估與現場</h3>
              <DetailRow label="評估司機">{personLabel(ticket.assessDriver)}</DetailRow>
              <DetailRow label="評估車輛">{ticket.assessVehicle?.plateNo?.trim() || "未指定"}</DetailRow>
              <DetailRow label="評估安排日時">{assessSchedule}</DetailRow>
              <DetailRow label="評估結果">{assessOutcomeLabel(ticket.assessOutcome)}</DetailRow>
              <DetailRow label="現場費用">{ticket.assessFeeAmount != null ? moneyText(ticket.assessFeeAmount) : "無"}</DetailRow>
              <DetailRow label="客戶是否同意現場處理">
                {ticket.assessCustomerAgreed == null ? "未記錄" : yesNo(ticket.assessCustomerAgreed)}
              </DetailRow>
              <DetailRow label="司機備註">{ticket.assessDriverNote?.trim() || "無"}</DetailRow>
              <DetailRow label="評估回報時間">
                {ticket.assessReportedAt ? fmtDateTime(ticket.assessReportedAt) : "尚未回報"}
              </DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">廠內／報價／送回</h3>
              <DetailRow label="廠內進度">
                {ticket.workshopStatusLabel ??
                  (ticket.workshopStatus ? workshopProgressLabel(ticket.workshopStatus) : "尚未入廠")}
              </DetailRow>
              <DetailRow label="廠內備註">{ticket.workshopNote?.trim() || "無"}</DetailRow>
              <DetailRow label="報價金額">{ticket.quoteAmount != null ? moneyText(ticket.quoteAmount) : "尚未報價"}</DetailRow>
              <DetailRow label="報價說明">{ticket.quoteDetail?.trim() || "無"}</DetailRow>
              <DetailRow label="報價狀態">{quoteStatusLabel(ticket.quoteStatus)}</DetailRow>
              <DetailRow label="送回司機">{personLabel(ticket.returnDriver)}</DetailRow>
              <DetailRow label="送回車輛">{ticket.returnVehicle?.plateNo?.trim() || "未指定"}</DetailRow>
              <DetailRow label="預計送回日">{ticket.returnDate ? fmtDate(ticket.returnDate) : "尚未安排"}</DetailRow>
              <DetailRow label="實際送回時間">
                {ticket.returnedAt ? fmtDateTime(ticket.returnedAt) : "尚未送回"}
              </DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">帳務關聯</h3>
              <DetailRow label="結案收費金額">{ticket.chargeAmount != null ? moneyText(ticket.chargeAmount) : "—"}</DetailRow>
              <DetailRow label="本單結帳方式">{billingLabel(ticket.billingType)}</DetailRow>
              <DetailRow label="帳務訂單編號">{ticket.salesOrder?.orderNo ?? "尚未立帳"}</DetailRow>
              <DetailRow label="帳務訂單狀態">{orderStatusLabel(ticket.salesOrder?.status)}</DetailRow>
              <DetailRow label="訂單總額">{ticket.salesOrder ? moneyText(ticket.salesOrder.totalAmount) : "—"}</DetailRow>
              <DetailRow label="其中現金小計">{ticket.salesOrder ? moneyText(ticket.salesOrder.cashSubtotal) : "—"}</DetailRow>
              <DetailRow label="其中月結小計">{ticket.salesOrder ? moneyText(ticket.salesOrder.monthlySubtotal) : "—"}</DetailRow>
              <DetailRow label="收款司機">{personLabel(ticket.collectorDriver)}</DetailRow>
              <DetailRow label="收款歸屬日">{ticket.collectionDate ? fmtDate(ticket.collectionDate) : "—"}</DetailRow>
              <DetailRow label="司機帶回現金">{moneyText(ticket.driverCashReceived)}</DetailRow>
              <DetailRow label="司機帶回支票">{moneyText(ticket.driverCheckReceived)}</DetailRow>
              <DetailRow label="辦公室核銷時間">{fmtDateTime(ticket.salesOrder?.officeSettledAt)}</DetailRow>
              {ticket.cancelledReason ? <DetailRow label="取消原因">{ticket.cancelledReason}</DetailRow> : null}
            </section>
          </div>

          <section style={{ marginTop: "1rem" }}>
            <h3 className="modal-dialog__section-title">事件歷程</h3>
            {(ticket.events?.length ?? 0) === 0 ? (
              <p className="modal-dialog__empty">尚無事件紀錄</p>
            ) : (
              <ol className="svc-event-timeline">
                {(ticket.events ?? []).map((e) => {
                  const items = formatEventPayloadItems(e.payloadJson);
                  return (
                    <li key={e.id} className="svc-event-timeline__item">
                      <div className="svc-event-timeline__meta">
                        <time className="svc-event-timeline__time">{fmtDateTime(e.createdAt)}</time>
                        <strong className="svc-event-timeline__type">{eventTypeLabel(e.eventType)}</strong>
                      </div>
                      {items.length === 0 ? (
                        <p className="svc-event-timeline__empty">無額外說明</p>
                      ) : (
                        <dl className="svc-event-timeline__facts">
                          {items.map((item) => (
                            <div key={`${e.id}-${item.label}`} className="svc-event-timeline__fact">
                              <dt>{item.label}</dt>
                              <dd>{item.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </li>
                  );
                })}
              </ol>
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
