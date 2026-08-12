import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import { billingTypeLabel, moneyText, sumCustomerBarrelsOnSite } from "../adminUtils";

function billingTypeBadgeClass(code: string | null | undefined): string {
  switch (code) {
    case "monthly":
      return "badge badge--confirmed";
    case "prepaid":
      return "badge badge--delivering";
    case "cash":
    default:
      return "badge badge--default";
  }
}

type LegacyStatus = {
  configured: boolean;
  connected: boolean;
  target: string | null;
  message: string | null;
};

type LegacyOrderSummary = {
  orderId: string;
  orderDay: string | null;
  orderedAt: string | null;
  customerId: string | null;
  billingLabel: string | null;
  billingType: "cash" | "monthly" | "prepaid";
  invoiceForm: string | null;
  driverCode: string | null;
  orderOk: boolean;
  assignOk: boolean;
  collectOk: boolean;
  billNumber: string | null;
  maker: string | null;
  shiftLabel: string | null;
  lineCount: number;
  qtyTotal: number;
  amountTotal: number;
  taxTotal: number;
  recycleQtyTotal: number;
  productNames: string[];
};

type LegacyOrderDetail = LegacyOrderSummary & {
  lines: Array<{
    productIndex: string | null;
    productId: string | null;
    productName: string | null;
    unitPrice: number;
    qty: number;
    giveFree: number;
    giveNofree: number;
    tax: number;
    subtotal: number;
    remark: string | null;
    recycleQty: number;
  }>;
  remittances: Array<{
    id: number;
    remittanceDay: string | null;
    bank: string | null;
    money: number;
    moneyRemittance: number;
    handMoney: number;
    overShortMoney: number;
    remark: string | null;
    maker: string | null;
  }>;
};

type ListPayload = {
  customer: { id: string | null; customerCode: string; name: string | null };
  total: number;
  orders: LegacyOrderSummary[];
};

const PAGE_SIZE = 50;

function billingBadge(o: LegacyOrderSummary): string {
  if (o.billingLabel) return o.billingLabel;
  if (o.billingType === "monthly") return "月結";
  if (o.billingType === "prepaid") return "預收";
  return "現金";
}

function flagLabel(ok: boolean, yes: string, no: string): string {
  return ok ? yes : no;
}

export default function CustomerLegacyOrdersPage() {
  const { customers } = useDashboard();
  const [searchParams, setSearchParams] = useSearchParams();
  const customerIdParam = searchParams.get("customerId")?.trim() ?? "";
  const codeParam = searchParams.get("code")?.trim() ?? "";

  const [status, setStatus] = useState<LegacyStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LegacyOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");

  const selectedCustomer = useMemo(() => {
    if (!customerIdParam) return null;
    return customers.find((c) => String(c.id) === customerIdParam) ?? null;
  }, [customers, customerIdParam]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/legacy-history/status");
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          setStatusErr(data?.message ?? "無法確認舊庫狀態");
          return;
        }
        setStatus(data.data as LegacyStatus);
      } catch {
        if (!cancelled) setStatusErr("無法確認舊庫狀態");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadList = useCallback(async () => {
    if (!customerIdParam && !codeParam) {
      setPayload(null);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      const url = customerIdParam
        ? `/api/customers/${customerIdParam}/legacy-orders?${qs}`
        : `/api/legacy-history/by-code/${encodeURIComponent(codeParam)}/orders?${qs}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setPayload(null);
        setErr(typeof data?.message === "string" ? data.message : "讀取歷史訂單失敗");
        return;
      }
      setPayload(data.data as ListPayload);
    } catch {
      setPayload(null);
      setErr("讀取歷史訂單失敗");
    } finally {
      setLoading(false);
    }
  }, [customerIdParam, codeParam, from, to, offset]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    setOffset(0);
    setExpandedId(null);
    setDetail(null);
  }, [customerIdParam, codeParam]);

  const openDetail = async (orderId: string) => {
    if (expandedId === orderId) {
      setExpandedId(null);
      setDetail(null);
      setDetailErr(null);
      return;
    }
    setExpandedId(orderId);
    setDetail(null);
    setDetailErr(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/legacy-history/orders/${encodeURIComponent(orderId)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setDetailErr(typeof data?.message === "string" ? data.message : "讀取明細失敗");
        return;
      }
      setDetail(data.data as LegacyOrderDetail);
    } catch {
      setDetailErr("讀取明細失敗");
    } finally {
      setDetailLoading(false);
    }
  };

  const pickCustomer = (id: string) => {
    setSearchParams({ customerId: id });
    setPickerQuery("");
  };

  const showCustomerPicker = !customerIdParam || pickerQuery.trim().length > 0;

  const filteredCustomers = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return customers.slice(0, 24);
    return customers
      .filter((c) => {
        const hay = [
          c.customerCode,
          c.name,
          c.contactName,
          c.phone,
          c.mobile,
          c.taxId,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 36);
  }, [customers, pickerQuery]);

  const total = payload?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const headingCustomer =
    selectedCustomer ??
    (payload?.customer
      ? {
          id: payload.customer.id ?? "",
          customerCode: payload.customer.customerCode,
          name: payload.customer.name ?? "（舊庫客戶）",
        }
      : null);

  return (
    <section className="card">
      <header className="card__header" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="card__title">舊系統歷史訂單</h2>
          <p className="card__hint">
            唯讀查詢舊庫訂單，不會寫入新系統訂單／應收。新訂單請用「新增訂單」建立。
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn btn--ghost" to="/data/legacy-cutover">
            切換日開帳
          </Link>
          <Link className="btn btn--ghost" to="/data/customers">
            返回客戶資料
          </Link>
        </div>
      </header>

      {statusErr ? <div className="alert alert--error">{statusErr}</div> : null}
      {status ? (
        <p className="card__hint">
          舊庫連線：{" "}
          {status.connected ? (
            <span className="badge badge--ok">已連線</span>
          ) : status.configured ? (
            <span className="badge badge--warn">連線失敗</span>
          ) : (
            <span className="badge badge--default">未設定</span>
          )}
          {status.target ? ` · ${status.target}` : null}
          {status.message ? ` · ${status.message}` : null}
        </p>
      ) : null}

      <div className="toolbar" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", marginTop: 12 }}>
        <div className="field" style={{ minWidth: 240, flex: 1 }}>
          <span>搜尋客戶</span>
          <input
            type="search"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="搜尋編號、名稱、電話…"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <span>出貨日起</span>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </div>
        <div className="field">
          <span>出貨日迄</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void loadList()} disabled={loading || (!customerIdParam && !codeParam)}>
          重新整理
        </button>
        {customerIdParam ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setSearchParams({});
              setPickerQuery("");
            }}
          >
            重選客戶
          </button>
        ) : null}
      </div>

      {showCustomerPicker ? (
        <div className="legacy-customer-picker" role="listbox" aria-label="搜尋到的客戶">
          {filteredCustomers.length === 0 ? (
            <p className="card__hint">找不到客戶</p>
          ) : (
            filteredCustomers.map((c) => {
              const defaultAddr =
                (c.addresses ?? []).find((a) => a.isDefault) ?? (c.addresses ?? [])[0] ?? null;
              const selected = String(c.id) === customerIdParam;
              return (
                <button
                  key={String(c.id)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`customer-hub__list-item${selected ? " customer-hub__list-item--selected" : ""}`}
                  onClick={() => pickCustomer(String(c.id))}
                >
                  <div className="customer-hub__list-item-head">
                    <span className="customer-hub__list-code mono-text">{c.customerCode ?? "—"}</span>
                    <span className={billingTypeBadgeClass(c.billingType)}>{billingTypeLabel(c.billingType)}</span>
                  </div>
                  <strong className="customer-hub__list-name">{c.name}</strong>
                  <div className="customer-hub__list-meta">
                    {c.contactName ? <span>{c.contactName}</span> : null}
                    {c.mobile || c.phone ? <span>{c.mobile || c.phone}</span> : null}
                  </div>
                  {defaultAddr ? (
                    <p className="customer-hub__list-addr">
                      {defaultAddr.label ? `${defaultAddr.label} · ` : ""}
                      {defaultAddr.addressLine}
                    </p>
                  ) : null}
                  <div className="customer-hub__list-stats">
                    <span>空桶 {sumCustomerBarrelsOnSite(c)}</span>
                    {c.billingType === "prepaid" ? <span>預付 {c.prepaidBarrelBalance ?? 0}</span> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      {headingCustomer && !showCustomerPicker ? (
        <div className="legacy-selected-customer">
          <div className="legacy-selected-customer__main">
            <span className="legacy-selected-customer__label">目前客戶</span>
            <div className="legacy-selected-customer__identity">
              <span className="legacy-selected-customer__code mono-text">
                {headingCustomer.customerCode ?? "—"}
              </span>
              <strong className="legacy-selected-customer__name">{headingCustomer.name}</strong>
              {selectedCustomer?.billingType ? (
                <span className={billingTypeBadgeClass(selectedCustomer.billingType)}>
                  {billingTypeLabel(selectedCustomer.billingType)}
                </span>
              ) : null}
              {selectedCustomer?.lifecycleStatus === "churned" ? (
                <span className="badge badge--cancelled">已流失</span>
              ) : null}
            </div>
            {selectedCustomer ? (
              <div className="legacy-selected-customer__meta">
                {selectedCustomer.contactName ? <span>{selectedCustomer.contactName}</span> : null}
                {selectedCustomer.mobile || selectedCustomer.phone ? (
                  <span>{selectedCustomer.mobile || selectedCustomer.phone}</span>
                ) : null}
                <span>空桶 {sumCustomerBarrelsOnSite(selectedCustomer)}</span>
                {selectedCustomer.billingType === "prepaid" ? (
                  <span>預付 {selectedCustomer.prepaidBarrelBalance ?? 0}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="legacy-selected-customer__actions">
            {headingCustomer.id ? (
              <Link className="btn btn--ghost btn--sm" to="/data/customers">
                開啟客戶資料
              </Link>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setSearchParams({});
                setPickerQuery("");
              }}
            >
              更換客戶
            </button>
          </div>
        </div>
      ) : null}

      {!headingCustomer && !showCustomerPicker ? (
        <p className="card__hint" style={{ marginTop: 12 }}>
          請先選擇客戶以查看舊系統歷史訂單。
        </p>
      ) : null}

      {err ? <div className="alert alert--error">{err}</div> : null}
      {loading ? <p className="card__hint">載入中…</p> : null}

      {!loading && payload ? (
        <>
          <div className="customer-edit-stats" style={{ marginTop: 12 }}>
            <div className="customer-edit-stat">
              <span className="customer-edit-stat__label">歷史訂單</span>
              <strong className="customer-edit-stat__value">{total}</strong>
            </div>
            <div className="customer-edit-stat">
              <span className="customer-edit-stat__label">本頁顯示</span>
              <strong className="customer-edit-stat__value">
                {total === 0 ? "—" : `${pageStart}–${pageEnd}`}
              </strong>
            </div>
          </div>

          {payload.orders.length === 0 ? (
            <p className="legacy-order-empty">此條件下沒有舊系統訂單</p>
          ) : (
            <ul className="legacy-order-list">
              {payload.orders.map((o) => {
                const expanded = expandedId === o.orderId;
                return (
                  <li
                    key={o.orderId}
                    className={`legacy-order-row${expanded ? " legacy-order-row--open" : ""}`}
                  >
                    <button
                      type="button"
                      className="legacy-order-row__main"
                      onClick={() => void openDetail(o.orderId)}
                      aria-expanded={expanded}
                    >
                      <div className="legacy-order-row__top">
                        <span className="legacy-order-row__no mono-text">{o.orderId}</span>
                        <span className={`badge badge--sm ${o.orderOk ? "badge--ok" : "badge--warn"}`}>
                          {flagLabel(o.orderOk, "已完成", "未完成")}
                        </span>
                        <span className="badge badge--sm badge--default">{billingBadge(o)}</span>
                        {o.shiftLabel ? (
                          <span className="badge badge--sm badge--default">{o.shiftLabel}</span>
                        ) : null}
                        <span className="legacy-order-row__amount">$ {moneyText(o.amountTotal)}</span>
                      </div>
                      <div className="legacy-order-row__meta">
                        <span>
                          <em>出貨</em> {o.orderDay ?? "—"}
                        </span>
                        <span>
                          <em>下單</em> {o.orderedAt ?? "—"}
                        </span>
                        <span>
                          <em>司機</em> {o.driverCode ?? "—"}
                        </span>
                        <span className={o.collectOk ? "" : "legacy-order-row__flag--warn"}>
                          <em>收款</em> {flagLabel(o.collectOk, "已收", "未收")}
                        </span>
                        <span className={o.assignOk ? "" : "legacy-order-row__flag--muted"}>
                          <em>派車</em> {flagLabel(o.assignOk, "已派", "未派")}
                        </span>
                        <span className="legacy-order-row__products">
                          <em>品項</em>{" "}
                          {o.productNames.slice(0, 3).join("、") || "—"}
                          {o.productNames.length > 3 ? "…" : ""}
                        </span>
                        <span className="legacy-order-row__toggle">{expanded ? "收合" : "明細"}</span>
                      </div>
                    </button>

                    {expanded ? (
                      <div className="legacy-order-row__detail">
                        {detailLoading ? <p className="card__hint">明細載入中…</p> : null}
                        {detailErr ? <div className="alert alert--error">{detailErr}</div> : null}
                        {detail && detail.orderId === o.orderId ? (
                          <>
                            <table className="legacy-order-detail-table">
                              <thead>
                                <tr>
                                  <th>商品</th>
                                  <th>數量</th>
                                  <th>贈／補</th>
                                  <th>回桶</th>
                                  <th>小計</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.lines.map((ln, idx) => (
                                  <tr key={`${ln.productId ?? "p"}-${idx}`}>
                                    <td>
                                      {ln.productName ?? "商品"}
                                      {ln.productId ? (
                                        <span className="mono-text legacy-order-detail-table__code">
                                          {" "}
                                          {ln.productId}
                                        </span>
                                      ) : null}
                                    </td>
                                    <td>{ln.qty}</td>
                                    <td>
                                      {ln.giveFree > 0 || ln.giveNofree > 0
                                        ? `${ln.giveFree > 0 ? `贈${ln.giveFree}` : ""}${
                                            ln.giveFree > 0 && ln.giveNofree > 0 ? " " : ""
                                          }${ln.giveNofree > 0 ? `補${ln.giveNofree}` : ""}`
                                        : "—"}
                                    </td>
                                    <td>{ln.recycleQty || "—"}</td>
                                    <td>$ {moneyText(ln.subtotal)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="legacy-order-row__notes">
                              {detail.maker ? <span>製單／備註：{detail.maker}</span> : null}
                              {detail.billNumber ? <span>發票：{detail.billNumber}</span> : null}
                              {detail.invoiceForm ? <span>開立：{detail.invoiceForm}</span> : null}
                              {detail.taxTotal > 0 ? <span>稅額：$ {moneyText(detail.taxTotal)}</span> : null}
                            </div>
                            {detail.remittances.length > 0 ? (
                              <table className="legacy-order-detail-table legacy-order-detail-table--remit">
                                <thead>
                                  <tr>
                                    <th>匯款日</th>
                                    <th>銀行／方式</th>
                                    <th>金額</th>
                                    <th>備註</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.remittances.map((r) => (
                                    <tr key={r.id}>
                                      <td>{r.remittanceDay ?? "—"}</td>
                                      <td>{r.bank || "—"}</td>
                                      <td>$ {moneyText(r.moneyRemittance || r.money)}</td>
                                      <td>{r.remark || r.maker || "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {total > 0 ? (
            <div className="legacy-order-pager">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!canPrev || loading}
                onClick={() => setOffset((v) => Math.max(0, v - PAGE_SIZE))}
              >
                上一頁
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!canNext || loading}
                onClick={() => setOffset((v) => v + PAGE_SIZE)}
              >
                下一頁
              </button>
              <span className="legacy-order-pager__info">
                第 {Math.floor(offset / PAGE_SIZE) + 1} 頁／共 {Math.max(1, Math.ceil(total / PAGE_SIZE))} 頁
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
