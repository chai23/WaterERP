import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../DashboardContext";
import {
  deliveryAssignmentStatusLabel,
  driverEmployeeCode,
  driverIsActive,
  fmtLocalYmd,
} from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";

type LookupLine = {
  qtyOrdered?: number;
  linePurpose?: string;
  product?: { name?: string; unit?: string; countsDepositBarrel?: boolean };
};

type LookupOrder = {
  id?: string;
  orderNo?: string;
  status?: string;
  scheduledDeliveryDate?: string | null;
  preferredTimeNote?: string | null;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  remark?: string | null;
  customer?: { name?: string; customerCode?: string };
  deliveryAddress?: { addressLine?: string; label?: string };
  lines?: LookupLine[];
};

type LookupAssignment = {
  id: string;
  status?: string;
  assignmentDate?: string | null;
  estimatedDeliverySlot?: string | null;
  vehicle?: { plateNo?: string | null } | null;
  salesOrder?: LookupOrder | null;
};

type ProductTotal = { productId: string; label: string; unit: string; qtyTotal: number };

const clock = (value?: string | null) => value?.match(/(?:T|^)(\d{2}:\d{2})/)?.[1] ?? "";

function windowLabel(order: LookupOrder | null | undefined, slot?: string | null): string {
  if (slot?.trim()) return slot.trim();
  if (!order) return "未指定";
  if (order.preferredTimeNote?.trim()) return order.preferredTimeNote.trim();
  const range = [clock(order.deliveryWindowStart), clock(order.deliveryWindowEnd)].filter(Boolean).join("–");
  return range || "未指定";
}

function sortKey(row: LookupAssignment): string {
  const slot = row.estimatedDeliverySlot?.match(/(\d{2}:\d{2})/)?.[1];
  return slot || clock(row.salesOrder?.deliveryWindowStart) || "99:99";
}

function barrels(order: LookupOrder | null | undefined): number {
  return (order?.lines ?? []).reduce((sum, line) => {
    if (line.linePurpose === "prepaid_barrel_topup" || !line.product?.countsDepositBarrel) return sum;
    return sum + Number(line.qtyOrdered || 0);
  }, 0);
}

function goods(order: LookupOrder | null | undefined): string {
  const parts = (order?.lines ?? []).map((line) => {
    const name = line.product?.name || "商品";
    const unit = line.product?.unit || "";
    const extra = line.linePurpose === "prepaid_barrel_topup" ? "（儲值）" : "";
    return `${name} × ${line.qtyOrdered ?? 0}${unit}${extra}`;
  });
  return parts.join("、") || "無商品明細";
}

function statusTagClass(status?: string): string {
  return status === "not_delivered" ? "dispatch-tag is-warning" : "dispatch-tag";
}

export default function DriverAssignmentLookupPanel() {
  const { drivers } = useDashboard();
  const [date, setDate] = useState(() => fmtLocalYmd(new Date()));
  const [driverId, setDriverId] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LookupAssignment[]>([]);
  const [totals, setTotals] = useState<ProductTotal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<OrderRecord | null>(null);
  const generation = useRef(0);

  const driverOptions = useMemo(
    () =>
      [...drivers].sort((a, b) => {
        const active = Number(driverIsActive(b)) - Number(driverIsActive(a));
        if (active !== 0) return active;
        return driverEmployeeCode(a).localeCompare(driverEmployeeCode(b), "zh-Hant", { numeric: true });
      }),
    [drivers],
  );

  const driver = driverOptions.find((item) => String(item.id) === driverId) ?? null;

  const load = useCallback(async () => {
    if (!driverId || !date) {
      setRows([]);
      setTotals([]);
      setError("");
      setLoading(false);
      return;
    }
    const gen = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ driverId, assignmentDate: date });
      const res = await fetch(`/api/delivery-assignments/by-driver-date?${params.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.message || "派單載入失敗");
      if (gen !== generation.current) return;
      setRows(Array.isArray(payload.data?.assignments) ? payload.data.assignments : []);
      setTotals(Array.isArray(payload.data?.productTotals) ? payload.data.productTotals : []);
    } catch (e) {
      if (gen !== generation.current) return;
      setRows([]);
      setTotals([]);
      setError(e instanceof Error ? e.message : "派單載入失敗");
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [date, driverId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...rows]
      .filter((row) => {
        if (!q) return true;
        const order = row.salesOrder;
        const haystack = `${order?.orderNo ?? ""} ${order?.customer?.name ?? ""} ${order?.customer?.customerCode ?? ""} ${order?.deliveryAddress?.addressLine ?? ""}`.toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || Number(a.id) - Number(b.id));
  }, [query, rows]);

  const barrelQty = rows.reduce((sum, row) => sum + barrels(row.salesOrder), 0);
  const maxBarrels = driver?.maxBarrelQty ?? 0;
  const remainingOrders = typeof driver?.maxOrderCount === "number" ? Math.max(0, driver.maxOrderCount - rows.length) : null;
  const plates = [...new Set(rows.map((row) => row.vehicle?.plateNo).filter((plate): plate is string => Boolean(plate)))];
  const driverTag = rows.some((row) => row.status === "delivering") ? "配送中" : rows.length ? "已派單" : "無派單";

  return (
    <div className="dispatch-board">
      <div className="dispatch-toolbar">
        <div>
          <h3>派單查詢</h3>
          <p>選擇日期與司機，查看該日已分配給這位司機的訂單。</p>
        </div>
        <label>
          配送日期
          <input
            aria-label="配送日期"
            type="date"
            value={date}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              setQuery("");
            }}
          />
        </label>
        <label className="dispatch-lookup-driver">
          司機
          <select
            aria-label="司機"
            value={driverId}
            onChange={(e) => {
              setDriverId(e.target.value);
              setQuery("");
            }}
          >
            <option value="">請選擇司機</option>
            {driverOptions.map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {driverEmployeeCode(item) || "—"} / {item.user?.name ?? "未命名司機"}
                {driverIsActive(item) ? "" : "（停用）"}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--secondary" disabled={!driverId || loading} onClick={() => void load()}>
          重新整理
        </button>
      </div>

      {error ? <p role="alert" className="feedback feedback--err">{error}</p> : null}

      {!driverId ? (
        <p className="dispatch-empty">請選擇司機與日期，查看該日派單。</p>
      ) : (
        <div className="dispatch-columns dispatch-columns--lookup">
          <section aria-label="當日派單">
            <header className="dispatch-section-head">
              <div>
                <span className="design-eyebrow">ASSIGNED ORDERS</span>
                <h3>當日派單 <span>{loading ? "…" : visible.length}</span></h3>
              </div>
              <span>{date}</span>
            </header>
            <div className="dispatch-filters">
              <input
                aria-label="搜尋派單"
                type="search"
                placeholder="搜尋單號、客戶或地址"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="dispatch-pool-list" aria-busy={loading}>
              {loading ? (
                <p className="dispatch-empty">載入派單中…</p>
              ) : visible.length === 0 ? (
                <p className="dispatch-empty">{query.trim() ? "沒有符合搜尋的派單" : "這位司機在這一天沒有派單"}</p>
              ) : (
                visible.map((row) => {
                  const order = row.salesOrder;
                  const day = fmtLocalYmd(row.assignmentDate) || date;
                  const slot = windowLabel(order, row.estimatedDeliverySlot);
                  return (
                    <article key={String(row.id)} className="dispatch-order dispatch-order--plain">
                      <div className="dispatch-order__main">
                        <div className="dispatch-order-top">
                          <span className="dispatch-order-title">
                            <h4>
                              {order?.customer?.name || "未提供客戶"} <small>{order?.customer?.customerCode}</small>
                            </h4>
                            <p className="dispatch-address">{order?.deliveryAddress?.addressLine || "未提供地址"}</p>
                          </span>
                        </div>
                        <p className="dispatch-goods">{goods(order)}</p>
                        <dl className="dispatch-order-facts">
                          <div><dt>單號</dt><dd title={order?.orderNo}>{order?.orderNo || "—"}</dd></div>
                          <div><dt>日期</dt><dd>{day}</dd></div>
                          <div><dt>時段</dt><dd>{slot}</dd></div>
                          <div><dt>桶數</dt><dd>{barrels(order)} 桶</dd></div>
                        </dl>
                        {row.vehicle?.plateNo ? <p className="dispatch-hint">車輛：{row.vehicle.plateNo}</p> : null}
                        {order?.remark ? <p className="dispatch-hint">備註：{order.remark}</p> : null}
                      </div>
                      <footer>
                        <span className={statusTagClass(row.status)}>{deliveryAssignmentStatusLabel(row.status)}</span>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!order}
                          onClick={() => {
                            if (!order) return;
                            const assignment = { ...row };
                            delete assignment.salesOrder;
                            setDetail({ ...order, assignments: [assignment] } as OrderRecord);
                          }}
                        >
                          詳情
                        </button>
                      </footer>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <section aria-label="司機當日概況">
            <header className="dispatch-section-head">
              <div>
                <span className="design-eyebrow">DRIVER</span>
                <h3>司機當日概況</h3>
              </div>
            </header>
            <article className="dispatch-driver" aria-label={`司機 ${driver?.user?.name || (driver ? driverEmployeeCode(driver) : "未命名司機")}`}>
              <header>
                <div className="dispatch-avatar">{driver?.user?.name?.slice(0, 1) || "駕"}</div>
                <div>
                  <h4>{driver?.user?.name || "未命名司機"}</h4>
                  <small>{driver ? driverEmployeeCode(driver) : "—"}</small>
                </div>
                <span className="dispatch-tag">{loading ? "載入中" : driverTag}</span>
              </header>
              <p className="dispatch-hint">{plates.length ? `車輛：${plates.join("、")}` : "本趟未指定車輛"}</p>
              <div className="dispatch-capacity">
                <div>
                  <strong>{loading ? "—" : rows.length}</strong>
                  <span>當日派單{remainingOrders !== null ? ` · 剩餘 ${remainingOrders} 單` : ""}</span>
                </div>
                <div>
                  <strong>{loading ? "—" : maxBarrels > 0 ? Math.max(0, maxBarrels - barrelQty) : barrelQty}</strong>
                  <span>{maxBarrels > 0 ? `剩餘桶數額度 / ${maxBarrels}` : "當日桶數 · 未設定上限"}</span>
                </div>
              </div>
              {maxBarrels > 0 ? (
                <progress max={maxBarrels} value={Math.min(barrelQty, maxBarrels)} aria-label={`已分配桶數 ${barrelQty} / ${maxBarrels}`} />
              ) : null}
              {maxBarrels > 0 && barrelQty > maxBarrels ? <p className="dispatch-hint">已超出桶數額度 {barrelQty - maxBarrels} 桶</p> : null}
              <h5>商品彙總 <small>依開單數量加總</small></h5>
              {loading ? (
                <p className="dispatch-empty">載入中…</p>
              ) : totals.length === 0 ? (
                <p className="dispatch-empty">沒有可彙總的商品</p>
              ) : (
                <ul className="dispatch-totals">
                  {totals.map((item) => (
                    <li key={`${item.productId}-${item.label}`}>
                      <span>{item.label}</span>
                      <strong>
                        {item.qtyTotal}
                        {item.unit ? ` ${item.unit}` : ""}
                      </strong>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>
        </div>
      )}

      {detail ? <OrderDetailModal order={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
