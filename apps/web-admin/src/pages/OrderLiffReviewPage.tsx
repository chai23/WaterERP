import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fmtLocalYmd,
  moneyText,
  orderStatusBadgeClass,
  orderStatusLabel,
} from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { useDashboard } from "../DashboardContext";

type PendingOrder = OrderRecord & {
  source?: string;
  remark?: string | null;
  orderBillableAmount?: string | number;
  customer?: {
    name?: string;
    customerCode?: string | null;
    billingType?: string;
    taxId?: string | null;
    mobile?: string | null;
    phone?: string | null;
  };
  lines?: Array<{
    qtyOrdered?: number;
    lineAmount?: string | number;
    linePurpose?: string | null;
    product?: { name?: string } | null;
  }>;
};

function isTopupOrder(o: PendingOrder): boolean {
  const lines = Array.isArray(o.lines) ? o.lines : [];
  return lines.length > 0 && lines.every((l) => (l.linePurpose ?? "delivery") === "prepaid_barrel_topup");
}

function hasTopupLines(o: PendingOrder): boolean {
  const lines = Array.isArray(o.lines) ? o.lines : [];
  return lines.some((l) => (l.linePurpose ?? "delivery") === "prepaid_barrel_topup");
}

function goodsSummary(o: PendingOrder): string {
  const lines = Array.isArray(o.lines) ? o.lines : [];
  if (lines.length === 0) return "—";
  return lines
    .map((l) => {
      const name = l.product?.name ?? "商品";
      const qty = l.qtyOrdered ?? 0;
      const topup = (l.linePurpose ?? "delivery") === "prepaid_barrel_topup" ? "（儲值）" : "";
      return `${name}×${qty}${topup}`;
    })
    .join("、");
}

/** 確認 LINE 訂單內容區（供建立訂單分頁嵌入） */
export function OrderLiffReviewPanel() {
  const { loadOrders } = useDashboard();
  const [rows, setRows] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailOrder, setDetailOrder] = useState<PendingOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/sales-orders/pending-review");
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "載入待確認訂單失敗");
        setRows([]);
        return;
      }
      setRows(Array.isArray(payload.data) ? payload.data : []);
    } catch {
      setMessage("載入待確認訂單時發生錯誤");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmOrder = async (id: string) => {
    setBusyId(id);
    setMessage("");
    const row = rows.find((r) => String(r.id) === id);
    const topup = row ? isTopupOrder(row) : false;
    const mixedTopup = row ? !topup && hasTopupLines(row) : false;
    try {
      const res = await fetch(`/api/sales-orders/${encodeURIComponent(id)}/confirm-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "確認失敗");
        return;
      }
      setMessage(
        topup
          ? `已確認儲值申請：${payload.data?.orderNo ?? id}，請完成現金收款後桶數會自動入帳`
          : mixedTopup
            ? `已確認：${payload.data?.orderNo ?? id}（含儲值），請派車；配送收款沖清後入帳`
            : `已確認：${payload.data?.orderNo ?? id}，可至分配訂單派車`,
      );
      await load();
      await loadOrders();
    } catch {
      setMessage("確認時發生錯誤");
    } finally {
      setBusyId(null);
    }
  };

  const rejectOrder = async (id: string, orderNo: string) => {
    const reason = window.prompt(`駁回訂單 ${orderNo}（選填說明，會通知客戶）`, "訂單內容有誤，請重新下單");
    if (reason === null) return;
    setBusyId(id);
    setMessage("");
    try {
      const res = await fetch(`/api/sales-orders/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || "辦公室未通過確認" }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "駁回失敗");
        return;
      }
      setMessage(`已駁回：${orderNo}`);
      await load();
      await loadOrders();
    } catch {
      setMessage("駁回時發生錯誤");
    } finally {
      setBusyId(null);
    }
  };

  const titleCount = loading ? "…" : `${rows.length} 筆`;

  return (
    <div className="order-new__form order-new__form--layout order-create-panel">
      <section className="order-new__zone order-new__zone--lines" aria-labelledby="order-liff-zone-title">
        <header className="order-new__zone-head">
          <span className="order-new__zone-index" aria-hidden="true">
            1
          </span>
          <div className="order-new__zone-head-text">
            <p className="order-new__zone-eyebrow">LINE · 待確認</p>
            <div className="order-new__lines-title-row">
              <h3 id="order-liff-zone-title" className="order-new__zone-title">
                待確認佇列
              </h3>
              <span className="order-new__zone-tag">{titleCount}</span>
            </div>
          </div>
          <div className="order-create-panel__zone-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? "載入中…" : "重新整理"}
            </button>
            <Link to="/orders/assign" className="btn btn--ghost btn--sm">
              去分配訂單
            </Link>
          </div>
        </header>
        <div className="order-new__zone-body order-new__zone-body--lines">
          {message ? (
            <p
              className={
                message.includes("失敗") || message.includes("錯誤") ? "feedback feedback--err" : "feedback feedback--ok"
              }
            >
              {message}
            </p>
          ) : null}

          {!loading && rows.length === 0 ? (
            <div className="order-new__empty-state">
              <p className="order-new__empty-state-title">目前沒有待確認的 LINE 訂單</p>
              <p className="order-new__empty-state-desc">客戶自 LINE 下單後會出現在此，核對後即可確認或駁回。</p>
            </div>
          ) : (
            <div className="table-wrap order-create-panel__table-wrap">
              <table className="data-table data-table--compact order-create-panel__table order-create-panel__table--liff">
                <thead>
                  <tr>
                    <th>訂單</th>
                    <th>客戶／地址</th>
                    <th>品項</th>
                    <th>希望配送日</th>
                    <th className="num">金額</th>
                    <th className="order-create-panel__col-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="text-muted">
                        載入中…
                      </td>
                    </tr>
                  ) : (
                    rows.map((o) => {
                      const id = String(o.id);
                      const busy = busyId === id;
                      const topup = isTopupOrder(o);
                      const mixedTopup = !topup && hasTopupLines(o);
                      const phone = o.customer?.mobile || o.customer?.phone;
                      const remark = String(o.remark ?? "").trim();
                      return (
                        <tr key={id}>
                          <td className="order-create-panel__cell-order">
                            <code className="order-create-panel__order-no">{String(o.orderNo ?? "")}</code>
                            <div className="order-create-panel__order-meta">
                              <span className={orderStatusBadgeClass(String(o.status ?? ""))}>
                                {orderStatusLabel(String(o.status ?? ""))}
                              </span>
                              {topup ? <span className="badge badge--pending">預付儲值</span> : null}
                              {mixedTopup ? <span className="badge badge--progress">配送＋儲值</span> : null}
                            </div>
                          </td>
                          <td className="order-create-panel__cell-customer">
                            <div className="order-create-panel__cust-name">
                              {o.customer?.customerCode ? (
                                <span className="mono-text order-create-panel__cust-code">{o.customer.customerCode}</span>
                              ) : null}
                              <span>{o.customer?.name ?? "—"}</span>
                            </div>
                            {phone ? <div className="order-create-panel__sub">{String(phone)}</div> : null}
                            <div className="order-create-panel__sub">
                              {o.deliveryAddress?.addressLine ?? "—"}
                            </div>
                            {remark ? <div className="order-create-panel__remark">備註：{remark}</div> : null}
                          </td>
                          <td className="order-create-panel__cell-goods">{goodsSummary(o)}</td>
                          <td className="order-create-panel__cell-date mono-text">
                            {fmtLocalYmd(o.scheduledDeliveryDate)}
                          </td>
                          <td className="num order-create-panel__cell-amt">
                            {moneyText(o.orderBillableAmount ?? o.totalAmount)}
                          </td>
                          <td className="order-create-panel__col-actions">
                            <div className="order-create-panel__row-actions">
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => setDetailOrder(o)}
                              >
                                詳情
                              </button>
                              <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                disabled={busy}
                                onClick={() => void confirmOrder(id)}
                              >
                                {busy ? "處理中…" : "確認"}
                              </button>
                              <button
                                type="button"
                                className="btn btn--danger btn--sm"
                                disabled={busy}
                                onClick={() => void rejectOrder(id, String(o.orderNo ?? id))}
                              >
                                駁回
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          <p className="order-create-panel__footnote text-muted">
            一般訂水確認後可至分配訂單派車；預付儲值或配送＋儲值需完成現金收款後桶數才會入帳。
          </p>
        </div>
      </section>

      {detailOrder ? (
        <OrderDetailModal order={detailOrder as OrderRecord} onClose={() => setDetailOrder(null)} />
      ) : null}
    </div>
  );
}

export default function OrderLiffReviewPage() {
  return <OrderLiffReviewPanel />;
}
