import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtLocalYmd, orderStatusBadgeClass } from "../adminUtils";
import { useDashboard } from "../DashboardContext";
import { cashInvoiceModeLabel } from "../taxDisplay";
import { openOrderPrintWindow, slipFromDashboardOrderWithAnnouncement } from "../orderPrint";

function fmtYmd(value: unknown): string {
  return fmtLocalYmd(value);
}

function canCancelOrderStatus(status: unknown): boolean {
  const s = String(status ?? "");
  return s !== "completed" && s !== "cancelled" && s !== "assigned" && s !== "delivering";
}

function fmtDateTime(value: unknown): string {
  if (value == null || value === "") return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 19).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type OrderRecord = Record<string, unknown> & {
  id?: unknown;
  orderNo?: unknown;
  status?: unknown;
  scheduledDeliveryDate?: unknown;
  createdAt?: unknown;
  remark?: unknown;
  subtotal?: unknown;
  totalAmount?: unknown;
  cashInvoiceMode?: unknown;
  taxInvoices?: Array<{
    invoiceNo?: unknown;
    invoiceMode?: unknown;
    basisType?: unknown;
    untaxedAmount?: unknown;
    taxAmount?: unknown;
    totalAmount?: unknown;
    taxRate?: unknown;
    issuedAt?: unknown;
  }>;
  customer?: { name?: string };
  deliveryAddress?: {
    label?: string | null;
    addressLine?: string;
    contactName?: string | null;
    contactPhone?: string | null;
  };
  lines?: Array<{
    id?: unknown;
    qtyOrdered?: unknown;
    qtyDelivered?: unknown;
    unitPrice?: unknown;
    lineAmount?: unknown;
    product?: { name?: string; sku?: string | null; unit?: string | null };
  }>;
  assignments?: Array<{
    assignmentDate?: unknown;
    driverReportedAt?: unknown;
    completedAt?: unknown;
    officeSettledAt?: unknown;
  }>;
};

function getActualDeliveryYmd(order: OrderRecord): string | null {
  const assignments = Array.isArray(order.assignments) ? order.assignments : [];
  if (assignments.length === 0) return null;
  const picked = assignments
    .map((a) => a?.driverReportedAt ?? a?.assignmentDate ?? a?.completedAt ?? a?.officeSettledAt ?? null)
    .find((v) => v != null && String(v).trim() !== "");
  if (!picked) return null;
  return fmtYmd(picked);
}

function deliveryDateLabel(order: OrderRecord): string {
  const status = String(order.status ?? "");
  if (status === "completed" || status === "not_delivered") {
    return getActualDeliveryYmd(order) ?? fmtYmd(order.scheduledDeliveryDate);
  }
  return fmtYmd(order.scheduledDeliveryDate);
}

export function OrderDetailModal({ order, onClose }: { order: OrderRecord; onClose: () => void }) {
  const lines = Array.isArray(order.lines) ? [...order.lines] : [];
  lines.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));

  const addr = order.deliveryAddress;
  const addressText = addr
    ? [addr.label ? `${addr.label}` : null, addr.addressLine].filter(Boolean).join(" — ") || "—"
    : "—";

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

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <h2 id="order-detail-title" className="modal-dialog__title">
            訂單詳情 · <code className="modal-dialog__order-no">{String(order.orderNo ?? "")}</code>
          </h2>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉視窗">
            ×
          </button>
        </header>

        <div className="modal-dialog__body">
          <dl className="detail-grid">
            <dt>狀態</dt>
            <dd>
              <span className={orderStatusBadgeClass(String(order.status ?? ""))}>{String(order.status ?? "—")}</span>
            </dd>
            <dt>客戶</dt>
            <dd>{order.customer?.name ?? "—"}</dd>
            <dt>送貨地址</dt>
            <dd>{addressText}</dd>
            {(addr?.contactName || addr?.contactPhone) && (
              <>
                <dt>聯絡人</dt>
                <dd>
                  {[addr?.contactName, addr?.contactPhone].filter(Boolean).join(" / ") || "—"}
                </dd>
              </>
            )}
            <dt>預計配送日</dt>
            <dd>{fmtYmd(order.scheduledDeliveryDate)}</dd>
            <dt>實際配送日</dt>
            <dd>{getActualDeliveryYmd(order) ?? "—"}</dd>
            <dt>建立時間</dt>
            <dd>{fmtDateTime(order.createdAt)}</dd>
            <dt>備註</dt>
            <dd>{order.remark ? String(order.remark) : "—"}</dd>
            <dt>現金／儲值發票設定</dt>
            <dd>{cashInvoiceModeLabel(order.cashInvoiceMode != null ? String(order.cashInvoiceMode) : null)}</dd>
            <dt>小計</dt>
            <dd className="num">{order.subtotal != null ? String(order.subtotal) : "—"}</dd>
            <dt>合計</dt>
            <dd className="num">
              <strong>{order.totalAmount != null ? String(order.totalAmount) : "—"}</strong>
            </dd>
          </dl>

          {Array.isArray(order.taxInvoices) && order.taxInvoices.length > 0 ? (
            <>
              <h3 className="modal-dialog__section-title">發票（稅額）</h3>
              <div className="table-wrap modal-dialog__table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>發票號碼</th>
                      <th>依據</th>
                      <th>模式</th>
                      <th className="num">未稅</th>
                      <th className="num">稅額</th>
                      <th className="num">含稅／總額</th>
                      <th className="num">稅率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.taxInvoices.map((ti, i) => (
                      <tr key={`${String(ti.invoiceNo ?? i)}`}>
                        <td className="mono-text">{ti.invoiceNo != null ? String(ti.invoiceNo) : "—"}</td>
                        <td>{ti.basisType != null ? String(ti.basisType) : "—"}</td>
                        <td>{cashInvoiceModeLabel(ti.invoiceMode != null ? String(ti.invoiceMode) : null)}</td>
                        <td className="num">{ti.untaxedAmount != null ? String(ti.untaxedAmount) : "—"}</td>
                        <td className="num">{ti.taxAmount != null ? String(ti.taxAmount) : "—"}</td>
                        <td className="num">
                          <strong>{ti.totalAmount != null ? String(ti.totalAmount) : "—"}</strong>
                        </td>
                        <td className="num">{ti.taxRate != null ? String(ti.taxRate) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted" style={{ fontSize: "0.82rem", marginTop: "0.35rem" }}>
                訂單合計仍為明細未稅加總；上表為憑證／營業稅參考。月結另有批次發票時見月結作業。
              </p>
            </>
          ) : order.cashInvoiceMode != null && String(order.cashInvoiceMode).trim() !== "" && String(order.cashInvoiceMode) !== "none" ? (
            <p className="text-muted modal-dialog__empty">已設定開票模式但尚無發票紀錄（可能為舊資料或尚未確認訂單）。</p>
          ) : null}

          <h3 className="modal-dialog__section-title">商品明細</h3>
          {lines.length === 0 ? (
            <p className="modal-dialog__empty">此訂單無明細資料。</p>
          ) : (
            <div className="table-wrap modal-dialog__table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>品名</th>
                    <th>SKU</th>
                    <th>單位</th>
                    <th className="num">訂購</th>
                    <th className="num">已送</th>
                    <th className="num">單價</th>
                    <th className="num">小計</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={String(line.id ?? i)}>
                      <td className="num">{i + 1}</td>
                      <td>
                        <strong>{line.product?.name ?? "—"}</strong>
                      </td>
                      <td>{line.product?.sku ?? "—"}</td>
                      <td>{line.product?.unit ?? "—"}</td>
                      <td className="num">{line.qtyOrdered != null && line.qtyOrdered !== "" ? String(line.qtyOrdered) : "—"}</td>
                      <td className="num">{line.qtyDelivered != null && line.qtyDelivered !== "" ? String(line.qtyDelivered) : "—"}</td>
                      <td className="num">{line.unitPrice != null && line.unitPrice !== "" ? String(line.unitPrice) : "—"}</td>
                      <td className="num">{line.lineAmount != null && line.lineAmount !== "" ? String(line.lineAmount) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
    </div>
  );
}

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
              <th className="num">金額</th>
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
                  <td className="num">{o.totalAmount}</td>
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
