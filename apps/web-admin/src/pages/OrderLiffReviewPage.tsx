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

export default function OrderLiffReviewPage() {
  const { loadDashboard } = useDashboard();
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
      loadDashboard();
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
      loadDashboard();
    } catch {
      setMessage("駁回時發生錯誤");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card">
      <h2 className="card__title">
        確認 LINE 訂單{" "}
        <span className="card__title-count">{loading ? "…" : `${rows.length} 筆待確認`}</span>
      </h2>
      <p className="card__hint">
        客戶自 LINE 下單後會先進入<strong>待確認</strong>，請核對客戶、地址與品項後再確認。
        一般訂水確認後會出現在 <Link to="/orders/assign">分配訂單</Link>；若為<strong>預付儲值</strong>或<strong>配送＋儲值</strong>（品項含儲值），確認後請派車配送並於現場／AR 完成現金收款，沖清後桶數入帳。
        若打錯或異常可駁回（取消）。
      </p>

      <div className="form-actions" style={{ marginBottom: "1rem" }}>
        <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
          重新整理
        </button>
        {message ? (
          <span className={message.includes("失敗") || message.includes("錯誤") ? "feedback feedback--err" : "feedback feedback--ok"}>
            {message}
          </span>
        ) : null}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>單號</th>
              <th>客戶</th>
              <th>地址</th>
              <th>品項</th>
              <th>希望配送日</th>
              <th className="num">金額</th>
              <th>備註</th>
              <th>狀態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="text-muted">
                  載入中…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-muted">
                  目前沒有待確認的 LINE 訂單。
                </td>
              </tr>
            ) : (
              rows.map((o) => {
                const id = String(o.id);
                const busy = busyId === id;
                const topup = isTopupOrder(o);
                const mixedTopup = !topup && hasTopupLines(o);
                return (
                  <tr key={id}>
                    <td>
                      <code style={{ fontSize: "0.8em" }}>{String(o.orderNo ?? "")}</code>
                      {topup ? (
                        <div>
                          <span className="badge badge--pending" style={{ marginTop: "0.25rem" }}>
                            預付儲值
                          </span>
                        </div>
                      ) : null}
                      {mixedTopup ? (
                        <div>
                          <span className="badge badge--progress" style={{ marginTop: "0.25rem" }}>
                            配送＋儲值
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {o.customer?.name ?? "—"}
                      {o.customer?.mobile || o.customer?.phone ? (
                        <div className="text-muted" style={{ fontSize: "0.85em" }}>
                          {String(o.customer?.mobile || o.customer?.phone)}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ maxWidth: "14rem" }}>
                      {o.deliveryAddress?.addressLine ?? "—"}
                    </td>
                    <td style={{ maxWidth: "12rem" }}>{goodsSummary(o)}</td>
                    <td>{fmtLocalYmd(o.scheduledDeliveryDate)}</td>
                    <td className="num">{moneyText(o.orderBillableAmount ?? o.totalAmount)}</td>
                    <td style={{ maxWidth: "10rem" }}>{String(o.remark ?? "") || "—"}</td>
                    <td>
                      <span className={orderStatusBadgeClass(String(o.status ?? ""))}>
                        {orderStatusLabel(String(o.status ?? ""))}
                      </span>
                    </td>
                    <td>
                      <div className="form-actions" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
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

      {detailOrder ? (
        <OrderDetailModal order={detailOrder as OrderRecord} onClose={() => setDetailOrder(null)} />
      ) : null}
    </section>
  );
}
