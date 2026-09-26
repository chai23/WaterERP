import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtLocalYmd, moneyText, orderStatusBadgeClass, orderStatusLabel } from "../adminUtils";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { useDashboard } from "../DashboardContext";
import { openOrderPrintWindow, slipFromDashboardOrderWithAnnouncement } from "../orderPrint";
import { breakdownCashTaxInvoicePreview } from "../taxDisplay";
import { useMediaQuery } from "../useMediaQuery";

const MOBILE_PAGE_SIZE = 40;
const STATUS_FILTERS = [
  "pending_review",
  "confirmed",
  "assigned",
  "delivering",
  "completed",
  "not_delivered",
  "cancelled",
] as const;

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

function formatGroupDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd || "未定配送日";
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", weekday: "short" }).format(d);
}

function orderSource(order: OrderRecord): "liff" | "admin" {
  return String((order as OrderRecord & { source?: string }).source ?? "admin") === "liff" ? "liff" : "admin";
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
  const { orders, loadOrders, onCancelOrder } = useDashboard();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "liff" | "admin">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [visibleCount, setVisibleCount] = useState(MOBILE_PAGE_SIZE);
  const [detailOrder, setDetailOrder] = useState<OrderRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const closeDetail = useCallback(() => setDetailOrder(null), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setRefreshing(true);
      try {
        await loadOrders();
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOrders]);

  useEffect(() => {
    setVisibleCount(MOBILE_PAGE_SIZE);
  }, [q, sourceFilter, statusFilter]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return orders.filter((o) => {
      const rec = o as OrderRecord;
      const source = orderSource(rec);
      if (sourceFilter !== "all" && source !== sourceFilter) return false;
      if (statusFilter !== "all" && String(rec.status ?? "") !== statusFilter) return false;
      if (!s) return true;
      const no = String(rec.orderNo ?? "").toLowerCase();
      const cust = String(rec.customer?.name ?? "").toLowerCase();
      const code = String(rec.customer?.customerCode ?? "").toLowerCase();
      const addr = String(rec.deliveryAddress?.addressLine ?? "").toLowerCase();
      return no.includes(s) || cust.includes(s) || code.includes(s) || addr.includes(s);
    });
  }, [orders, q, sourceFilter, statusFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, OrderRecord[]>();
    for (const o of filtered) {
      const rec = o as OrderRecord;
      const key = deliveryDateLabel(rec) || "未定配送日";
      const list = map.get(key) ?? [];
      list.push(rec);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  }, [filtered]);

  const visibleGroups = useMemo(() => {
    if (!isMobile) return grouped.map(([date, list]) => ({ date, list, total: list.length }));
    let remaining = visibleCount;
    const next: { date: string; list: OrderRecord[]; total: number }[] = [];
    for (const [date, list] of grouped) {
      if (remaining <= 0) break;
      const slice = list.slice(0, remaining);
      next.push({ date, list: slice, total: list.length });
      remaining -= slice.length;
    }
    return next;
  }, [grouped, isMobile, visibleCount]);

  const printOrder = (order: OrderRecord) => {
    void (async () => {
      const slip = await slipFromDashboardOrderWithAnnouncement(order as unknown as Record<string, unknown>);
      const ok = openOrderPrintWindow(slip);
      if (!ok) window.alert("無法開啟列印視窗，請允許此網站的彈出視窗後再試。");
    })();
  };

  return (
    <>
      {isMobile ? (
        <div className="oq-mobile">
          <div className="oq-mobile__toolbar">
            <label className="oq-mobile__search">
              <span className="sr-only">搜尋訂單</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="單號、客戶、編號或地址"
                enterKeyHint="search"
              />
            </label>
          </div>
          <div className="oq-mobile__filters">
            <div className="oq-mobile__chips" role="group" aria-label="訂單來源">
              {(
                [
                  ["all", "全部"],
                  ["liff", "LINE"],
                  ["admin", "後台"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={sourceFilter === value ? "is-active" : ""}
                  onClick={() => setSourceFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="oq-mobile__chips" role="group" aria-label="訂單狀態">
              <button
                type="button"
                className={statusFilter === "all" ? "is-active" : ""}
                onClick={() => setStatusFilter("all")}
              >
                所有狀態
              </button>
              {STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={statusFilter === status ? "is-active" : ""}
                  onClick={() => setStatusFilter(status)}
                >
                  {orderStatusLabel(status)}
                </button>
              ))}
            </div>
            <p className="oq-mobile__count">
              {refreshing ? "更新中…" : `${filtered.length} 筆`}
              {q.trim() || sourceFilter !== "all" || statusFilter !== "all" ? "（已篩選）" : ""}
            </p>
          </div>

          {filtered.length === 0 ? (
            <p className="oq-mobile__empty">{refreshing ? "載入訂單中…" : "找不到符合的訂單"}</p>
          ) : (
            visibleGroups.map(({ date, list, total }) => (
              <section key={date} className="oq-mobile__group">
                <h3>
                  {formatGroupDate(date)}
                  <span>{total} 筆</span>
                </h3>
                <div className="oq-mobile__list">
                  {list.map((o) => {
                    const lineCount = Array.isArray(o.lines) ? o.lines.length : 0;
                    const source = orderSource(o);
                    return (
                      <article key={String(o.id)} className="oq-mobile__card" data-status={String(o.status ?? "")}>
                        <button type="button" className="oq-mobile__card-main" onClick={() => setDetailOrder(o)}>
                          <div className="oq-mobile__card-top">
                            <strong>{o.customer?.name ?? "未指定客戶"}</strong>
                            <b>${orderTaxInclusiveAmount(o)}</b>
                          </div>
                          <p className="oq-mobile__card-addr">
                            {o.deliveryAddress?.addressLine?.trim() || "未填地址"}
                          </p>
                          <div className="oq-mobile__card-meta">
                            <span className={orderStatusBadgeClass(String(o.status ?? ""))}>
                              {orderStatusLabel(String(o.status ?? ""))}
                            </span>
                            <span>{source === "liff" ? "LINE" : "後台"}</span>
                            <span>{lineCount} 項</span>
                            <code>{String(o.orderNo ?? "—")}</code>
                          </div>
                        </button>
                        {canCancelOrderStatus(o.status) ? (
                          <button
                            type="button"
                            className="oq-mobile__cancel"
                            onClick={() => void onCancelOrder(String(o.id))}
                          >
                            取消此單
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))
          )}

          {visibleCount < filtered.length ? (
            <button
              type="button"
              className="btn btn--secondary oq-mobile__more"
              onClick={() => setVisibleCount((n) => n + MOBILE_PAGE_SIZE)}
            >
              再顯示 {Math.min(MOBILE_PAGE_SIZE, filtered.length - visibleCount)} 筆
            </button>
          ) : null}
        </div>
      ) : (
        <section className="card">
          <h2 className="card__title">
            查詢訂單
            {refreshing ? <span className="card__title-count">更新中…</span> : null}
          </h2>
          <p className="card__hint">
            以單號、客戶名稱或客戶編號篩選；未結案訂單可取消。<strong>滑鼠移到列上</strong>會高亮該筆訂單；<strong>點一下訂單列</strong>或點<strong>明細欄「詳情」</strong>可開啟詳情並檢視多筆商品明細。
            配送日欄位：<strong>已結案顯示實際配送日</strong>，未結案顯示預計配送日。
            套印單上一維條碼內容為<strong>訂單編號字串</strong>，可用掃描槍掃描後貼入上方關鍵字以快速查單。
          </p>
          <div className="field" style={{ maxWidth: "24rem", marginBottom: "1rem" }}>
            <span>關鍵字</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、客戶名稱或客戶編號" />
          </div>
          <div className="field" style={{ maxWidth: "16rem", marginBottom: "1rem" }}>
            <span>訂單來源</span>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as "all" | "liff" | "admin")}>
              <option value="all">全部</option>
              <option value="liff">LINE 訂購</option>
              <option value="admin">後台開單</option>
            </select>
          </div>
          <h3 className="card__title" style={{ fontSize: "1rem", marginTop: 0 }}>
            結果 <span className="card__title-count">{filtered.length} 筆</span>
          </h3>
          <div className="table-wrap">
            <table className="data-table data-table--orders-query">
              <thead>
                <tr>
                  <th>單號</th>
                  <th>來源</th>
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
                  const rec = o as OrderRecord;
                  const lineCount = Array.isArray(rec.lines) ? rec.lines.length : 0;
                  return (
                    <tr
                      key={String(rec.id)}
                      className="order-row--clickable"
                      title="點一下此列開啟訂單詳情"
                      onClick={() => setDetailOrder(rec)}
                    >
                      <td>
                        <code style={{ fontSize: "0.8em" }}>{String(rec.orderNo ?? "")}</code>
                      </td>
                      <td>
                        {orderSource(rec) === "liff" ? <span className="badge">LINE</span> : <span className="text-muted">後台</span>}
                      </td>
                      <td>{rec.customer?.name ?? "—"}</td>
                      <td>
                        <span className={orderStatusBadgeClass(String(rec.status ?? ""))}>{orderStatusLabel(String(rec.status ?? ""))}</span>
                      </td>
                      <td>{deliveryDateLabel(rec)}</td>
                      <td className="num">{orderTaxInclusiveAmount(rec)}</td>
                      <td>
                        <div className="order-detail-cell">
                          <span className="order-detail-cell__count" title="商品明細筆數">
                            {lineCount} 項
                          </span>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            aria-label={`查看訂單 ${String(rec.orderNo ?? "")} 詳情`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailOrder(rec);
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
                            printOrder(rec);
                          }}
                        >
                          套印
                        </button>
                      </td>
                      <td>
                        {canCancelOrderStatus(rec.status) ? (
                          <button
                            type="button"
                            className="btn btn--danger btn--sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onCancelOrder(String(rec.id));
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
        </section>
      )}

      {detailOrder ? <OrderDetailModal order={detailOrder} onClose={closeDetail} /> : null}
    </>
  );
}
