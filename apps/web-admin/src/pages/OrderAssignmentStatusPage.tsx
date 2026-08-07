import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  driverEmployeeCode,
  driverIsActive,
  fmtLocalYmd,
  moneyText,
  orderStatusBadgeClass,
  orderStatusLabel,
} from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { useDashboard } from "../DashboardContext";

type QueueScope = "unassigned" | "assigned";

type QueueOrder = OrderRecord & {
  orderBillableAmount?: string | number;
  source?: string;
  remark?: string | null;
  customer?: {
    id?: string | number;
    name?: string;
    customerCode?: string | null;
    phone?: string | null;
    mobile?: string | null;
  };
  deliveryAddress?: { label?: string | null; addressLine?: string | null };
  lines?: Array<{
    qtyOrdered?: number;
    linePurpose?: string | null;
    isPromotionGift?: boolean;
    isReplenishment?: boolean;
    product?: { name?: string | null; unit?: string | null } | null;
  }>;
  activeAssignments?: Array<{
    id: string;
    status?: string;
    assignmentDate?: string | null;
    driver?: { user?: { name?: string; employeeCode?: string | null } | null } | null;
    vehicle?: { plateNo?: string | null } | null;
  }>;
};

function goodsSummary(o: QueueOrder, maxLen = 48): string {
  const lines = Array.isArray(o.lines) ? o.lines : [];
  if (lines.length === 0) return "—";
  const parts = lines.map((l) => {
    const name = l.product?.name?.trim() || "商品";
    const qty = l.qtyOrdered ?? 0;
    const tag =
      l.linePurpose === "prepaid_barrel_topup"
        ? "（儲值）"
        : l.isPromotionGift
          ? "（贈）"
          : l.isReplenishment
            ? "（補）"
            : "";
    return `${name}×${qty}${tag}`;
  });
  const s = parts.join("、");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function describeActiveAssignment(o: QueueOrder): string {
  const a = o.activeAssignments?.[0];
  if (!a) return "—";
  const emp = a.driver?.user?.employeeCode ?? "";
  const name = a.driver?.user?.name ?? "";
  const st = deliveryAssignmentStatusLabel(a.status);
  const d = fmtLocalYmd(a.assignmentDate);
  const plate = a.vehicle?.plateNo ? ` · ${a.vehicle.plateNo}` : "";
  return `${st} · ${emp}/${name} · ${d}${plate}`;
}

type Props = {
  onGoAssign: (customerId: string, salesOrderId: string) => void;
};

/** 分派狀態佇列（嵌於分配訂單頁之分頁） */
export default function AssignmentStatusPanel({ onGoAssign }: Props) {
  const { drivers, vehicles } = useDashboard();
  const [scope, setScope] = useState<QueueScope>("unassigned");
  const [q, setQ] = useState("");
  const [qDraft, setQDraft] = useState("");
  const [rows, setRows] = useState<QueueOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [detailOrder, setDetailOrder] = useState<QueueOrder | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDriverId, setBatchDriverId] = useState("");
  const [batchVehicleId, setBatchVehicleId] = useState("");
  const [batchDate, setBatchDate] = useState(() => fmtLocalYmd(new Date()) || "");
  const [batchBusy, setBatchBusy] = useState(false);

  const activeDrivers = useMemo(
    () =>
      [...drivers]
        .filter(driverIsActive)
        .sort((a, b) => driverEmployeeCode(a).localeCompare(driverEmployeeCode(b), "zh-Hant")),
    [drivers],
  );
  const activeVehicles = useMemo(() => vehicles, [vehicles]);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const qs = new URLSearchParams({ scope });
      if (q.trim()) qs.set("q", q.trim());
      const res = await fetch(`/api/sales-orders/assignment-queue?${qs.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "載入分派狀態失敗");
        setRows([]);
        return;
      }
      const orders = Array.isArray(payload.data?.orders) ? (payload.data.orders as QueueOrder[]) : [];
      setRows(orders);
      setSelectedIds(new Set());
    } catch {
      setMessage("載入分派狀態時發生錯誤");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [scope, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const titleCount = loading ? "…" : `${rows.length} 筆`;
  const colCount = (scope === "assigned" ? 7 : 6) + (scope === "unassigned" ? 1 : 0);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === rows.length) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(rows.map((o) => String(o.id))));
  };

  const runBatchAssign = async () => {
    if (selectedIds.size === 0) {
      setMessage("請先勾選要分派的訂單");
      return;
    }
    if (!batchDriverId) {
      setMessage("請選擇批次分派司機");
      return;
    }
    if (!window.confirm(`確定將 ${selectedIds.size} 筆訂單批次分派給所選司機？失敗單會略過。`)) return;
    setBatchBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/orders/batch-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesOrderIds: [...selectedIds],
          driverId: batchDriverId,
          vehicleId: batchVehicleId || undefined,
          assignmentDate: batchDate || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        setMessage(payload?.message ?? "批次分派失敗");
        return;
      }
      const succeeded = Array.isArray(payload.data?.succeeded) ? payload.data.succeeded : [];
      const skipped = Array.isArray(payload.data?.skipped) ? payload.data.skipped : [];
      setMessage(
        `批次分派完成：成功 ${succeeded.length}、略過 ${skipped.length}` +
          (skipped.length
            ? `（例：${skipped
                .slice(0, 3)
                .map((s: { id: string; reason: string }) => `${s.id}:${s.reason}`)
                .join("；")}）`
            : ""),
      );
      await load();
    } catch {
      setMessage("批次分派時發生錯誤");
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="order-assign-status">
      <div className="order-assign-status__toolbar">
        <div className="order-assign-status__toolbar-left">
          <div className="order-assign-seg" role="tablist" aria-label="分派範圍">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "unassigned"}
              className={`order-assign-seg__btn${scope === "unassigned" ? " order-assign-seg__btn--active" : ""}`}
              onClick={() => setScope("unassigned")}
            >
              未分派
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === "assigned"}
              className={`order-assign-seg__btn${scope === "assigned" ? " order-assign-seg__btn--active" : ""}`}
              onClick={() => setScope("assigned")}
            >
              已分派
            </button>
          </div>
          <h3 className="order-assign-status__heading">
            {scope === "unassigned" ? "未分派訂單" : "已分派訂單"}
            <span className="card__title-count">{titleCount}</span>
          </h3>
        </div>
        <div className="order-assign-status__toolbar-right">
          <input
            type="search"
            className="order-assign-status__search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setQ(qDraft);
            }}
            placeholder="單號／客戶／電話"
            aria-label="關鍵字"
          />
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setQ(qDraft)} disabled={loading}>
            搜尋
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
            重新整理
          </button>
        </div>
      </div>

      {scope === "unassigned" ? (
        <div className="toolbar toolbar--filters order-assign-status__batch-bar">
          <div className="field field--sm">
            <span>批次司機</span>
            <select value={batchDriverId} onChange={(e) => setBatchDriverId(e.target.value)}>
              <option value="">選擇司機</option>
              {activeDrivers.map((d) => {
                const code = driverEmployeeCode(d);
                const name = d.user?.name ?? "（未命名）";
                return (
                  <option key={String(d.id)} value={String(d.id)}>
                    {code ? `${code} ${name}` : name}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="field field--sm">
            <span>車輛（選填）</span>
            <select value={batchVehicleId} onChange={(e) => setBatchVehicleId(e.target.value)}>
              <option value="">不指定</option>
              {activeVehicles.map((v) => (
                <option key={String(v.id)} value={String(v.id)}>
                  {v.plateNo}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--sm">
            <span>配送日</span>
            <input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} />
          </div>
          <div className="field field--sm order-assign-status__batch-action">
            <span aria-hidden="true">&nbsp;</span>
            <button
              type="button"
              className="btn btn--primary btn--sm order-assign-status__batch-submit"
              disabled={batchBusy || selectedIds.size === 0}
              onClick={() => void runBatchAssign()}
            >
              {batchBusy ? "分派中…" : `批次分派（${selectedIds.size}）`}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className={message.includes("失敗") || message.includes("錯誤") ? "feedback feedback--err" : "feedback"}>
          {message}
        </p>
      ) : null}

      <div className="table-wrap order-assign-status__table-wrap">
        <table className="data-table data-table--compact order-assign-status__table">
          <thead>
            <tr>
              {scope === "unassigned" ? (
                <th>
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selectedIds.size === rows.length}
                    onChange={toggleAll}
                    aria-label="全選"
                  />
                </th>
              ) : null}
              <th>訂單</th>
              <th>客戶／地址</th>
              <th>品項</th>
              <th>配送日</th>
              <th className="num">金額</th>
              {scope === "assigned" ? <th>配送任務</th> : null}
              <th className="order-assign-status__col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colCount} className="text-muted">
                  載入中…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-muted">
                  {scope === "unassigned" ? "目前沒有未分派訂單。" : "目前沒有進行中的已分派訂單。"}
                </td>
              </tr>
            ) : (
              rows.map((o) => {
                const id = String(o.id);
                const orderNo = String(o.orderNo ?? "");
                const active = o.activeAssignments?.[0];
                const customerId = String(o.customer?.id ?? (o as { customerId?: unknown }).customerId ?? "");
                const phone = String(o.customer?.mobile || o.customer?.phone || "");
                return (
                  <tr key={id}>
                    {scope === "unassigned" ? (
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(id)}
                          onChange={() => toggleSelected(id)}
                          aria-label={`選取 ${orderNo}`}
                        />
                      </td>
                    ) : null}
                    <td className="order-assign-status__cell-order">
                      <code className="order-assign-status__order-no" title={orderNo}>
                        {orderNo}
                      </code>
                      <div className="order-assign-status__order-meta">
                        <span className={orderStatusBadgeClass(String(o.status ?? ""))}>
                          {orderStatusLabel(String(o.status ?? ""))}
                        </span>
                        {String(o.source ?? "") === "liff" ? <span className="badge">LINE</span> : null}
                      </div>
                    </td>
                    <td className="order-assign-status__cell-customer">
                      <div className="order-assign-status__cust-name">
                        {o.customer?.customerCode ? (
                          <span className="mono-text order-assign-status__cust-code">{o.customer.customerCode}</span>
                        ) : null}
                        <strong>{o.customer?.name ?? "—"}</strong>
                      </div>
                      {phone ? <div className="text-muted order-assign-status__sub">{phone}</div> : null}
                      <div className="text-muted order-assign-status__sub" title={o.deliveryAddress?.addressLine ?? ""}>
                        {o.deliveryAddress?.addressLine ?? "—"}
                      </div>
                    </td>
                    <td className="order-assign-status__cell-goods" title={goodsSummary(o, 200)}>
                      {goodsSummary(o)}
                    </td>
                    <td className="order-assign-status__cell-date">{fmtLocalYmd(o.scheduledDeliveryDate)}</td>
                    <td className="num order-assign-status__cell-amt">{moneyText(o.orderBillableAmount ?? o.totalAmount)}</td>
                    {scope === "assigned" ? (
                      <td className="order-assign-status__cell-task">
                        {active ? (
                          <>
                            <span className={deliveryAssignmentStatusBadgeClass(String(active.status ?? ""))}>
                              {deliveryAssignmentStatusLabel(active.status)}
                            </span>
                            <div className="text-muted order-assign-status__sub">{describeActiveAssignment(o)}</div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : null}
                    <td className="order-assign-status__col-actions">
                      <div className="order-assign-status__actions">
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDetailOrder(o)}>
                          詳情
                        </button>
                        <button
                          type="button"
                          className={`btn btn--sm ${scope === "unassigned" ? "btn--primary" : "btn--secondary"}`}
                          disabled={!customerId}
                          onClick={() => onGoAssign(customerId, id)}
                        >
                          {scope === "unassigned" ? "去分派" : "查看"}
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
      <p className="order-assign-status__footnote text-muted">
        {scope === "unassigned"
          ? "可勾選多筆後批次分派（信用鎖定等失敗單會略過）；或按「去分派」切到分配分頁。"
          : "僅列出尚有進行中配送任務的訂單（已分派／配送中／待核銷）。"}
      </p>
      {detailOrder ? (
        <OrderDetailModal order={detailOrder} onClose={() => setDetailOrder(null)} />
      ) : null}
    </div>
  );
}
