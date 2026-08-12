import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { billingTypeLabel, moneyText, todayLocalYmd } from "../adminUtils";

type BillingType = "cash" | "monthly" | "prepaid";

type UnpaidOrder = {
  orderId: string;
  customerId: string;
  billingLabel: string | null;
  billingType: BillingType;
  orderDay: string | null;
  orderOk: boolean;
  amount: number;
  remitted: number;
  outstanding: number;
};

type CutoverRow = {
  customerCode: string;
  legacyCustomerIds: string[];
  newCustomerId: string | null;
  customerName: string | null;
  billingTypePreferred: BillingType | null;
  unpaidByType: Record<BillingType, { amount: number; orderCount: number }>;
  unpaidTotal: number;
  unpaidOrderCount: number;
  orders: UnpaidOrder[];
  newSystem: {
    prepaidBarrelBalance: number | null;
    barrelsOnSite: number | null;
    openArOutstanding: number | null;
    existingOpeningArCount: number;
  };
  legacyBalances: {
    prepaidBarrelBalance: number | null;
    barrelsOnSite: number | null;
  };
  mapped: boolean;
};

type PreviewData = {
  asOf: string | null;
  orderCount: number;
  customerCount: number;
  mappedCustomerCount: number;
  unmappedCustomerCount: number;
  totals: Record<BillingType, number>;
  rows: CutoverRow[];
};

type ApplyResult = {
  created: number;
  skipped: number;
  failed: number;
  createdArNos: string[];
  errors: string[];
};

type SyncResult = {
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
};

const ALL_TYPES: BillingType[] = ["cash", "monthly", "prepaid"];

export default function LegacyCutoverPage() {
  const [asOf, setAsOf] = useState(todayLocalYmd());
  const [cutoverDate, setCutoverDate] = useState(todayLocalYmd());
  const [customerFilter, setCustomerFilter] = useState("");
  const [billingTypes, setBillingTypes] = useState<BillingType[]>([...ALL_TYPES]);
  const [granularity, setGranularity] = useState<"by_order" | "by_customer">("by_order");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyMapped, setOnlyMapped] = useState(true);
  const [onlyUnsyncedOpening, setOnlyUnsyncedOpening] = useState(false);

  const toggleType = (t: BillingType) => {
    setBillingTypes((prev) => {
      if (prev.includes(t)) {
        const next = prev.filter((x) => x !== t);
        return next.length ? next : prev;
      }
      return [...prev, t];
    });
  };

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const qs = new URLSearchParams();
      if (asOf) qs.set("asOf", asOf);
      if (customerFilter.trim()) qs.set("customer", customerFilter.trim());
      qs.set("billingTypes", billingTypes.join(","));
      const res = await fetch(`/api/legacy-cutover/preview?${qs}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setPreview(null);
        setErr(typeof data?.message === "string" ? data.message : "預覽失敗");
        return;
      }
      const payload = data.data as PreviewData;
      setPreview(payload);
      setSelectedCodes(new Set(payload.rows.filter((r) => r.mapped).map((r) => r.customerCode)));
    } catch {
      setPreview(null);
      setErr("預覽失敗");
    } finally {
      setLoading(false);
    }
  }, [asOf, customerFilter, billingTypes]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const visibleRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows.filter((r) => {
      if (onlyMapped && !r.mapped) return false;
      if (onlyUnsyncedOpening && r.newSystem.existingOpeningArCount > 0) return false;
      return true;
    });
  }, [preview, onlyMapped, onlyUnsyncedOpening]);

  const selectedVisible = useMemo(
    () => visibleRows.filter((r) => selectedCodes.has(r.customerCode)),
    [visibleRows, selectedCodes],
  );

  const selectedTotals = useMemo(() => {
    const t = { cash: 0, monthly: 0, prepaid: 0, customers: 0, orders: 0 };
    for (const r of selectedVisible) {
      t.customers += 1;
      t.orders += r.unpaidOrderCount;
      t.cash += r.unpaidByType.cash.amount;
      t.monthly += r.unpaidByType.monthly.amount;
      t.prepaid += r.unpaidByType.prepaid.amount;
    }
    return t;
  }, [selectedVisible]);

  const toggleCode = (code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedCodes(new Set(visibleRows.filter((r) => r.mapped).map((r) => r.customerCode)));
  };

  const clearSelection = () => setSelectedCodes(new Set());

  const applyOpening = async (dryRun: boolean) => {
    if (selectedVisible.length === 0) {
      window.alert("請先勾選已對應主檔的客戶");
      return;
    }
    if (!dryRun) {
      const ok = window.confirm(
        `將為 ${selectedVisible.length} 位客戶寫入期初應收（粒度：${
          granularity === "by_order" ? "每舊單一筆" : "每客戶每結帳方式一筆"
        }）。\n不會建立新系統訂單。\n確定繼續？`,
      );
      if (!ok) return;
    }
    setApplying(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/legacy-cutover/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cutoverDate,
          asOf,
          billingTypes,
          granularity,
          customerCodes: selectedVisible.map((r) => r.customerCode),
          dryRun,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setErr(typeof data?.message === "string" ? data.message : "開帳失敗");
        return;
      }
      const r = data.data as ApplyResult;
      setMsg(
        `${dryRun ? "預估" : "完成"}：建立 ${r.created}、略過 ${r.skipped}、失敗 ${r.failed}` +
          (r.errors.length ? `；錯誤例：${r.errors.slice(0, 3).join("；")}` : ""),
      );
      if (!dryRun) void loadPreview();
    } catch {
      setErr("開帳失敗");
    } finally {
      setApplying(false);
    }
  };

  const syncBalances = async (dryRun: boolean) => {
    if (selectedVisible.length === 0) {
      window.alert("請先勾選客戶");
      return;
    }
    if (!dryRun) {
      const ok = window.confirm(
        `將從舊庫同步 ${selectedVisible.length} 位客戶的空桶數與預付剩餘桶到新系統主檔。確定？`,
      );
      if (!ok) return;
    }
    setSyncing(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/legacy-cutover/sync-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerCodes: selectedVisible.map((r) => r.customerCode),
          dryRun,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setErr(typeof data?.message === "string" ? data.message : "同步失敗");
        return;
      }
      const r = data.data as SyncResult;
      setMsg(
        `${dryRun ? "預估同步" : "同步完成"}：更新 ${r.updated}、略過 ${r.skipped}、失敗 ${r.failed}`,
      );
      if (!dryRun) void loadPreview();
    } catch {
      setErr("同步失敗");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="card cutover-page">
      <header className="cutover-page__header">
        <div>
          <h2 className="card__title">切換日開帳</h2>
          <p className="cutover-page__lead">
            舊庫未收款 → 新系統期初應收（不建訂單）。之後到 AR 沖帳收款。
          </p>
        </div>
        <div className="cutover-page__header-links">
          <Link className="btn btn--ghost btn--sm" to="/data/legacy-orders">
            歷史訂單
          </Link>
          <Link className="btn btn--ghost btn--sm" to="/reports/billing-ar">
            AR 沖帳
          </Link>
        </div>
      </header>

      <div className="cutover-panel">
        <div className="cutover-panel__filters">
          <label className="cutover-field">
            <span>未收款截止</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <label className="cutover-field">
            <span>切換日</span>
            <input type="date" value={cutoverDate} onChange={(e) => setCutoverDate(e.target.value)} />
          </label>
          <label className="cutover-field cutover-field--grow">
            <span>客戶代號</span>
            <input
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              placeholder="空白＝全部"
              autoComplete="off"
            />
          </label>
          <div className="cutover-field">
            <span>結帳類型</span>
            <div className="cutover-type-pills" role="group" aria-label="結帳類型">
              {ALL_TYPES.map((t) => {
                const on = billingTypes.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`cutover-type-pill${on ? " cutover-type-pill--on" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggleType(t)}
                  >
                    {billingTypeLabel(t)}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm cutover-panel__reload"
            disabled={loading}
            onClick={() => void loadPreview()}
          >
            {loading ? "載入中…" : "預覽"}
          </button>
        </div>

        {preview ? (
          <div className="cutover-summary" aria-label="預覽彙總">
            <div className="cutover-summary__item">
              <span className="cutover-summary__label">客戶</span>
              <strong className="cutover-summary__value">{preview.customerCount}</strong>
              <span className="cutover-summary__hint">
                對應 {preview.mappedCustomerCount}／未對應 {preview.unmappedCustomerCount}
              </span>
            </div>
            <div className="cutover-summary__item">
              <span className="cutover-summary__label">舊單</span>
              <strong className="cutover-summary__value">{preview.orderCount}</strong>
            </div>
            <div className="cutover-summary__item">
              <span className="cutover-summary__label">現金</span>
              <strong className="cutover-summary__value">$ {moneyText(preview.totals.cash)}</strong>
            </div>
            <div className="cutover-summary__item">
              <span className="cutover-summary__label">月結</span>
              <strong className="cutover-summary__value">$ {moneyText(preview.totals.monthly)}</strong>
            </div>
            <div className="cutover-summary__item">
              <span className="cutover-summary__label">預收$</span>
              <strong className="cutover-summary__value">$ {moneyText(preview.totals.prepaid)}</strong>
            </div>
          </div>
        ) : null}
      </div>

      {err ? <div className="alert alert--error">{err}</div> : null}
      {msg ? <div className="alert alert--success">{msg}</div> : null}

      {preview ? (
        <>
          <div className="cutover-toolbar">
            <div className="cutover-toolbar__left">
              <label className="cutover-check">
                <input type="checkbox" checked={onlyMapped} onChange={(e) => setOnlyMapped(e.target.checked)} />
                只看已對應
              </label>
              <label className="cutover-check">
                <input
                  type="checkbox"
                  checked={onlyUnsyncedOpening}
                  onChange={(e) => setOnlyUnsyncedOpening(e.target.checked)}
                />
                隱藏已開期初
              </label>
              <button type="button" className="btn btn--ghost btn--sm" onClick={selectAllVisible}>
                全選
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={clearSelection}>
                清除
              </button>
              <label className="cutover-granularity">
                <span>粒度</span>
                <select
                  value={granularity}
                  onChange={(e) => setGranularity(e.target.value as "by_order" | "by_customer")}
                >
                  <option value="by_order">每舊單一筆</option>
                  <option value="by_customer">每客戶×類型一筆</option>
                </select>
              </label>
            </div>
            <div className="cutover-toolbar__right">
              <span className="cutover-toolbar__selected">
                已選 <strong>{selectedVisible.length}</strong> 戶
                <span className="cutover-toolbar__selected-amt">
                  $ {moneyText(selectedTotals.cash + selectedTotals.monthly + selectedTotals.prepaid)}
                </span>
                <span className="cutover-toolbar__selected-break">
                  現 {moneyText(selectedTotals.cash)}／月 {moneyText(selectedTotals.monthly)}／預{" "}
                  {moneyText(selectedTotals.prepaid)} · {selectedTotals.orders} 單
                </span>
              </span>
              <div className="cutover-toolbar__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={applying || selectedVisible.length === 0}
                  onClick={() => void applyOpening(true)}
                >
                  預估筆數
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={applying || selectedVisible.length === 0}
                  onClick={() => void applyOpening(false)}
                >
                  {applying ? "寫入中…" : "寫入期初應收"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={syncing || selectedVisible.length === 0}
                  onClick={() => void syncBalances(false)}
                  title="從舊庫同步空桶與預付剩餘桶"
                >
                  {syncing ? "同步中…" : "同步桶數"}
                </button>
              </div>
            </div>
          </div>

          <div className="cutover-table-wrap">
            <table className="cutover-table">
              <thead>
                <tr>
                  <th className="cutover-table__check" />
                  <th className="cutover-table__customer">客戶</th>
                  <th>類型</th>
                  <th className="cutover-table__num">未收合計</th>
                  <th className="cutover-table__num">現金</th>
                  <th className="cutover-table__num">月結</th>
                  <th className="cutover-table__num">預收$</th>
                  <th className="cutover-table__bal">舊庫桶／預付</th>
                  <th className="cutover-table__bal">新系統桶／預付</th>
                  <th className="cutover-table__num">現有 AR</th>
                  <th className="cutover-table__actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={11}>
                      <p className="legacy-order-empty" style={{ marginTop: 0 }}>
                        此條件沒有未收款資料
                      </p>
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((r) => (
                    <Fragment key={r.customerCode}>
                      <tr className={!r.mapped ? "cutover-table__row--muted" : undefined}>
                        <td className="cutover-table__check">
                          <input
                            type="checkbox"
                            disabled={!r.mapped}
                            checked={selectedCodes.has(r.customerCode)}
                            onChange={() => toggleCode(r.customerCode)}
                          />
                        </td>
                        <td className="cutover-table__customer">
                          <div className="cutover-table__code mono-text">{r.customerCode}</div>
                          <div className="cutover-table__name" title={r.customerName ?? undefined}>
                            {r.customerName ?? "—"}
                          </div>
                          <div className="cutover-table__tags">
                            {!r.mapped ? <span className="badge badge--warn">未對應主檔</span> : null}
                            {r.newSystem.existingOpeningArCount > 0 ? (
                              <span className="badge badge--default">已有期初 {r.newSystem.existingOpeningArCount}</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="cutover-table__type">
                          {r.billingTypePreferred ? billingTypeLabel(r.billingTypePreferred) : "—"}
                        </td>
                        <td className="cutover-table__num">
                          <strong>$ {moneyText(r.unpaidTotal)}</strong>
                          <span className="cutover-table__sub">{r.unpaidOrderCount} 單</span>
                        </td>
                        <td className="cutover-table__num">$ {moneyText(r.unpaidByType.cash.amount)}</td>
                        <td className="cutover-table__num">$ {moneyText(r.unpaidByType.monthly.amount)}</td>
                        <td className="cutover-table__num">$ {moneyText(r.unpaidByType.prepaid.amount)}</td>
                        <td className="cutover-table__bal">
                          <span>{r.legacyBalances.barrelsOnSite ?? "—"}</span>
                          <span className="cutover-table__sep">／</span>
                          <span>{r.legacyBalances.prepaidBarrelBalance ?? "—"}</span>
                        </td>
                        <td className="cutover-table__bal">
                          <span>{r.newSystem.barrelsOnSite ?? "—"}</span>
                          <span className="cutover-table__sep">／</span>
                          <span>{r.newSystem.prepaidBarrelBalance ?? "—"}</span>
                        </td>
                        <td className="cutover-table__num">
                          {r.newSystem.openArOutstanding == null
                            ? "—"
                            : `$ ${moneyText(r.newSystem.openArOutstanding)}`}
                        </td>
                        <td className="cutover-table__actions">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setExpanded((v) => (v === r.customerCode ? null : r.customerCode))}
                          >
                            {expanded === r.customerCode ? "收合" : "明細"}
                          </button>
                          {r.newCustomerId ? (
                            <Link
                              className="btn btn--ghost btn--sm"
                              to={`/data/legacy-orders?customerId=${r.newCustomerId}`}
                            >
                              歷史
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                      {expanded === r.customerCode ? (
                        <tr className="cutover-table__detail-row">
                          <td colSpan={11}>
                            <div className="cutover-order-detail">
                              <table className="legacy-order-detail-table">
                                <thead>
                                  <tr>
                                    <th>舊單號</th>
                                    <th>出貨日</th>
                                    <th>結帳</th>
                                    <th>狀態</th>
                                    <th className="cutover-table__num">應收</th>
                                    <th className="cutover-table__num">已匯</th>
                                    <th className="cutover-table__num">未收</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.orders.map((o) => (
                                    <tr key={o.orderId}>
                                      <td className="mono-text">{o.orderId}</td>
                                      <td>{o.orderDay ?? "—"}</td>
                                      <td>{o.billingLabel ?? billingTypeLabel(o.billingType)}</td>
                                      <td>{o.orderOk ? "已完成" : "未完成"}</td>
                                      <td className="cutover-table__num">$ {moneyText(o.amount)}</td>
                                      <td className="cutover-table__num">$ {moneyText(o.remitted)}</td>
                                      <td className="cutover-table__num">
                                        <strong>$ {moneyText(o.outstanding)}</strong>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="cutover-help">
            <p className="cutover-help__title">說明</p>
            <ul>
              <li>未收款＝舊庫 collect_OK ≠ True，並已扣該單匯款。</li>
              <li>預收$＝舊單標「預收」但錢未收齊；預付剩餘桶請用「同步桶數」。</li>
              <li>月結建議切換前先在舊系統結完本期，再核對後開帳。</li>
              <li>重複開帳會略過已寫入項目；清空交易資料可一併清除期初。</li>
            </ul>
          </div>
        </>
      ) : null}
    </section>
  );
}
