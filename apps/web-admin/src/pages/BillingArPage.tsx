import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { billingTypeLabel, matchCustomerQuery, moneyText, todayLocalYmd } from "../adminUtils";
import { useDashboard } from "../DashboardContext";
import { cashInvoiceModeLabel } from "../taxDisplay";

type ArWorkspaceTab = "open" | "history" | "monthly" | "prepaid";

type OpenItemRow = {
  id: string;
  customerId: string;
  salesOrderId?: string | null;
  originalAmount: string;
  allocatedAmount: string;
  outstandingAmount: string;
  dueDate?: string | null;
  status: string;
  arDocument?: { arNo: string; billingType: string } | null;
  salesOrder?: { orderNo: string } | null;
};

type ReceiptVoucherRow = {
  id: string;
  voucherNo: string;
  voucherType: string;
  paymentMethod: string;
  totalAmount: string;
  status: string;
  paidAt?: string | null;
  createdAt?: string;
  note?: string | null;
};

type PaymentRow = {
  id: string;
  amount: string;
  paymentMethod: string;
  paidAt: string;
  note?: string | null;
  orderNo?: string | null;
};

type MonthlyUnsettledOrder = {
  id: string;
  orderNo: string;
  deliveryDate: string | null;
  monthlyAmount: string;
  monthlyReceivedAmount: string;
  outstandingAmount: string;
  monthlyPeriodPaid?: boolean;
};

type StatementRow = {
  rowKind?: string;
  openItemId?: string | null;
  salesOrderId?: string | null;
  arNo: string;
  orderNo: string | null;
  actualDeliveryDate: string | null;
  outstandingAmount: string;
  status: string;
  lineItems?: Array<{
    productName: string;
    unitPrice: string;
    qty: number;
    subtotal: string;
  }>;
};

function arStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "unpaid":
      return "未付款";
    case "partially_paid":
      return "部分付款";
    case "paid":
      return "已付款";
    case "overdue":
      return "逾期";
    case "open":
      return "未結清";
    case "partial":
      return "部分沖銷";
    case "applied":
      return "已沖銷";
    case "posted":
      return "已入帳";
    case "pending_post":
      return "待開立批次";
    default:
      return status ?? "—";
  }
}

function voucherTypeLabel(type: string): string {
  switch (type) {
    case "receipt":
      return "收款沖帳";
    case "prepayment":
      return "預收儲值";
    case "prepayment_apply":
      return "預收扣抵";
    default:
      return type;
  }
}

function paymentMethodLabel(method: string): string {
  switch (method) {
    case "cash":
      return "現金";
    case "transfer":
      return "匯款";
    case "check":
      return "支票";
    case "prepayment":
      return "預收錢包";
    case "other":
      return "其他";
    default:
      return method;
  }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-TW", { hour12: false });
  } catch {
    return iso;
  }
}

export default function BillingArPage() {
  const { customers, loadDashboard } = useDashboard();

  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<ArWorkspaceTab>("open");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [openItems, setOpenItems] = useState<OpenItemRow[]>([]);
  const [receiptVouchers, setReceiptVouchers] = useState<ReceiptVoucherRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [monthlyPending, setMonthlyPending] = useState<MonthlyUnsettledOrder[]>([]);
  const [monthlyPendingTotal, setMonthlyPendingTotal] = useState("0");
  const [accountBalance, setAccountBalance] = useState("0");
  const [walletBalance, setWalletBalance] = useState("0");
  const [agingSummary, setAgingSummary] = useState<{ current: number; d30: number; d60: number; d90: number } | null>(null);

  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("transfer");
  const [topupAmount, setTopupAmount] = useState("");
  const [topupInvoiceMode, setTopupInvoiceMode] = useState<"none" | "tax_exclusive" | "tax_inclusive">("none");
  const [applyOpenItemId, setApplyOpenItemId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");

  const [statementCutoffDate, setStatementCutoffDate] = useState(() => todayLocalYmd());
  const [statementRows, setStatementRows] = useState<StatementRow[]>([]);
  const [statementPostMode, setStatementPostMode] = useState<"tax_exclusive" | "tax_inclusive" | "none">("tax_exclusive");
  const [statementPosting, setStatementPosting] = useState(false);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementPreviewed, setStatementPreviewed] = useState(false);
  const [invoiceTitle, setInvoiceTitle] = useState("");

  const selectedCustomer = useMemo(() => customers.find((c) => String(c.id) === customerId), [customers, customerId]);

  const customerSearchResults = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    let list = customers;
    if (q) list = list.filter((c) => matchCustomerQuery(c, q));
    return list.slice(0, 12);
  }, [customers, customerSearch]);

  const totalOutstanding = useMemo(
    () => openItems.reduce((s, r) => s + Number(r.outstandingAmount ?? 0), 0),
    [openItems],
  );

  const monthlyOpenItems = useMemo(
    () => openItems.filter((r) => (r.arDocument?.billingType ?? "") === "monthly"),
    [openItems],
  );

  const monthlyOpenTotal = useMemo(
    () => monthlyOpenItems.reduce((s, r) => s + Number(r.outstandingAmount ?? 0), 0),
    [monthlyOpenItems],
  );

  const statementTotal = useMemo(
    () => statementRows.reduce((sum, r) => sum + Number(r.outstandingAmount ?? 0), 0),
    [statementRows],
  );

  const workspaceTabs: { id: ArWorkspaceTab; label: string; hint: string; count?: number }[] = useMemo(
    () => [
      { id: "open", label: "未沖帳應收", hint: "收款沖帳", count: openItems.length },
      { id: "history", label: "沖帳紀錄", hint: "收款單", count: receiptVouchers.length },
      {
        id: "monthly",
        label: "月結待結",
        hint: "待開批次＋月結 AR",
        count: monthlyPending.length + monthlyOpenItems.length,
      },
      { id: "prepaid", label: "預收錢包", hint: "儲值／扣抵" },
    ],
    [openItems.length, receiptVouchers.length, monthlyPending.length, monthlyOpenItems.length],
  );

  const resetWorkspaceData = () => {
    setOpenItems([]);
    setReceiptVouchers([]);
    setPayments([]);
    setMonthlyPending([]);
    setMonthlyPendingTotal("0");
    setAccountBalance("0");
    setWalletBalance("0");
    setAgingSummary(null);
    setStatementRows([]);
    setStatementPreviewed(false);
    setApplyOpenItemId("");
    setMsg("");
  };

  const loadCustomerWorkspace = useCallback(async (id: string) => {
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ customerId: id });
      const [openRes, sumRes, voucherRes, payRes, monthlyRes, agingRes] = await Promise.all([
        fetch(`/api/ar/open-items?${q}`),
        fetch(`/api/customers/${id}/billing-summary`),
        fetch(`/api/ar/receipt-vouchers?${q}`),
        fetch(`/api/customers/${id}/payments?limit=80`),
        fetch(`/api/billing/monthly-unsettled?${q}`),
        fetch(`/api/reports/ar-aging?${q}`),
      ]);

      if (openRes.ok) {
        const payload = await openRes.json();
        const rows = (payload.ok ? payload.data : []) as OpenItemRow[];
        setOpenItems(rows);
        if (rows.length > 0) setApplyOpenItemId(String(rows[0].id));
      } else {
        setOpenItems([]);
      }

      if (sumRes.ok) {
        const sj = await sumRes.json();
        if (sj?.ok && sj.data) {
          setAccountBalance(String(sj.data.accountBalance ?? "0"));
          setWalletBalance(String(sj.data.prepaymentMoneyBalance ?? "0"));
        }
      }

      if (voucherRes.ok) {
        const vj = await voucherRes.json();
        setReceiptVouchers(vj.ok ? (vj.data as ReceiptVoucherRow[]) : []);
      } else {
        setReceiptVouchers([]);
      }

      if (payRes.ok) {
        const pj = await payRes.json();
        setPayments(pj?.ok && pj.data?.payments ? (pj.data.payments as PaymentRow[]) : []);
      } else {
        setPayments([]);
      }

      if (monthlyRes.ok) {
        const mj = await monthlyRes.json();
        if (mj?.ok && mj.data) {
          setMonthlyPending((mj.data.orders as MonthlyUnsettledOrder[]) ?? []);
          setMonthlyPendingTotal(String(mj.data.totalPending ?? "0"));
        } else {
          setMonthlyPending([]);
          setMonthlyPendingTotal("0");
        }
      } else {
        setMonthlyPending([]);
        setMonthlyPendingTotal("0");
      }

      if (agingRes.ok) {
        const aj = await agingRes.json();
        setAgingSummary(aj.ok ? aj.data?.summary ?? null : null);
      } else {
        setAgingSummary(null);
      }
    } catch {
      setMsg("無法連線 API");
      resetWorkspaceData();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!customerId) {
      resetWorkspaceData();
      return;
    }
    void loadCustomerWorkspace(customerId);
  }, [customerId, loadCustomerWorkspace]);

  const selectCustomer = (id: string) => {
    const c = customers.find((x) => String(x.id) === id);
    setCustomerId(id);
    setCustomerSearch(c ? `${c.customerCode ?? ""} · ${c.name}`.replace(/^ · /, "") : "");
    setCustomerPickerOpen(false);
    setWorkspaceTab("open");
    setStatementRows([]);
    setStatementPreviewed(false);
    setMsg("");
  };

  const clearSelectedCustomer = () => {
    setCustomerId("");
    setCustomerSearch("");
    setCustomerPickerOpen(false);
    resetWorkspaceData();
  };

  const receiveAllByFifo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) {
      setMsg("收款金額需大於 0");
      return;
    }
    setLoading(true);
    setMsg("");
    try {
      const res = await fetch("/api/ar/receipt-vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, amount: v, paymentMethod }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "入帳失敗");
        return;
      }
      setMsg(`收款成功，收款單 ${payload.data?.voucherNo ?? ""}`);
      setAmount("");
      await loadCustomerWorkspace(customerId);
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  };

  const topupPrepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    const v = Number(topupAmount);
    if (!Number.isFinite(v) || v <= 0) {
      setMsg("預收儲值金額需大於 0");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/prepayment-topup-money`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: v,
          note: "AR 作業台預收儲值",
          invoiceMode: topupInvoiceMode,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "預收儲值失敗");
        return;
      }
      setTopupAmount("");
      const ti = payload.data?.taxInvoice;
      setMsg(
        ti
          ? `預收儲值成功；已建立待開票紀錄 ${ti.invoiceNo}，請至發票查詢補登號碼`
          : "預收儲值成功",
      );
      await loadCustomerWorkspace(customerId);
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  };

  const applyPrepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId || !applyOpenItemId) {
      setMsg("請選擇要扣抵的應收項目");
      return;
    }
    const v = Number(applyAmount);
    if (!Number.isFinite(v) || v <= 0) {
      setMsg("扣抵金額需大於 0");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/ar/prepayment-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, openItemId: applyOpenItemId, amount: v }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "預收扣抵失敗");
        return;
      }
      setApplyAmount("");
      setMsg(`預收扣抵成功：${payload.data?.appliedAmount ?? v}`);
      await loadCustomerWorkspace(customerId);
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  };

  const loadStatement = async () => {
    if (!customerId) return;
    setStatementLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ customerId, cutoffDate: statementCutoffDate });
      const res = await fetch(`/api/billing/statements?${q.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "產生對帳清單失敗");
        setStatementRows([]);
        setStatementPreviewed(false);
        return;
      }
      const rows = payload.data?.rows ?? [];
      setStatementRows(rows);
      setStatementPreviewed(true);
      if (rows.length === 0) {
        setMsg("此截止日沒有可對帳的月結訂單／未沖清 AR");
      }
      if (!invoiceTitle.trim() && selectedCustomer?.name) {
        setInvoiceTitle(`${selectedCustomer.name} 請款單`);
      }
    } catch {
      setMsg("無法連線 API");
      setStatementRows([]);
      setStatementPreviewed(false);
    } finally {
      setStatementLoading(false);
    }
  };

  const postMonthlyStatement = async () => {
    if (!customerId) return;
    const pendingCount = statementRows.filter((r) => r.rowKind === "pending_statement").length;
    if (pendingCount === 0) {
      setMsg("請先產生對帳清單，且清單中需有待開立批次的訂單");
      return;
    }
    if (!window.confirm(`將開立月結批次（截止 ${statementCutoffDate}，共 ${pendingCount} 張訂單）。確定？`)) return;
    setStatementPosting(true);
    setMsg("");
    try {
      const res = await fetch("/api/billing/statements/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          cutoffDate: statementCutoffDate,
          invoiceMode: statementPostMode,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "開立批次失敗");
        return;
      }
      const stmtNo = payload.data?.billingStatement?.statementNo ?? "";
      setMsg(`已開立月結批次：${stmtNo}`);
      await loadStatement();
      await loadCustomerWorkspace(customerId);
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setStatementPosting(false);
    }
  };

  const exportStatementCsv = () => {
    if (!selectedCustomer || statementRows.length === 0) {
      setMsg("請先產生對帳清單");
      return;
    }
    const title = invoiceTitle.trim() || `${selectedCustomer.name} 請款單`;
    const lines: string[] = [];
    lines.push(`請款抬頭,${title}`);
    lines.push(`客戶名稱,${selectedCustomer.name}`);
    lines.push(`截止日,${statementCutoffDate}`);
    lines.push(`請款總額,${statementTotal.toFixed(2)}`);
    lines.push("");
    lines.push("AR No,訂單,實際配送日,狀態,尚欠");
    for (const r of statementRows) {
      lines.push([r.arNo, r.orderNo ?? "—", r.actualDeliveryDate ?? "—", arStatusLabel(r.status), r.outstandingAmount].join(","));
    }
    const blob = new Blob([`\uFEFF${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-${selectedCustomer.name}-${statementCutoffDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const customerPicker = (
    <div className="field ar-customer-search">
      <span>搜尋客戶</span>
      {selectedCustomer ? (
        <div className="ar-customer-search__selected ar-customer-search__selected--hero">
          <div className="ar-customer-search__selected-main">
            <span className="ar-customer-search__selected-code mono-text">
              {selectedCustomer.customerCode ?? "—"} · ID {String(selectedCustomer.id)}
            </span>
            <strong className="ar-customer-search__selected-name">{selectedCustomer.name}</strong>
            <span className="badge badge--default">{billingTypeLabel(selectedCustomer.billingType)}</span>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={clearSelectedCustomer}>
            換客戶
          </button>
        </div>
      ) : (
        <>
          <input
            type="search"
            value={customerSearch}
            onChange={(e) => {
              setCustomerSearch(e.target.value);
              setCustomerPickerOpen(true);
            }}
            onFocus={() => setCustomerPickerOpen(true)}
            onBlur={() => window.setTimeout(() => setCustomerPickerOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customerSearchResults.length === 1) {
                e.preventDefault();
                selectCustomer(String(customerSearchResults[0].id));
              }
            }}
            placeholder="客戶編號、名稱、電話、手機、統編…"
            autoComplete="off"
          />
          {customerPickerOpen && customerSearchResults.length > 0 ? (
            <ul className="ar-customer-search__results" role="listbox">
              {customerSearchResults.map((c) => (
                <li key={String(c.id)} role="presentation">
                  <button
                    type="button"
                    role="option"
                    className="ar-customer-search__result"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectCustomer(String(c.id))}
                  >
                    <span className="ar-customer-search__result-code mono-text">{c.customerCode ?? "—"}</span>
                    <span className="ar-customer-search__result-name">{c.name}</span>
                    <span className="ar-customer-search__result-meta">
                      {billingTypeLabel(c.billingType)}
                      {c.mobile || c.phone ? ` · ${c.mobile || c.phone}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : customerPickerOpen && customerSearch.trim() ? (
            <p className="card__hint ar-customer-search__empty">沒有符合的客戶</p>
          ) : (
            <p className="card__hint ar-customer-search__hint">輸入關鍵字搜尋客戶</p>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <section className="card ar-hub">
        <h2 className="card__title">AR 收款沖帳與稽核</h2>
        <p className="ar-hub__lead">先選客戶，系統自動載入未沖帳與沖帳紀錄；月結、預收分頁操作。</p>
        {customerPicker}
      </section>

      {!selectedCustomer ? (
        <section className="card ar-step-awaiting">
          <p className="ar-step-awaiting__lead">請先搜尋並選擇客戶</p>
          <p className="card__hint">選定後會自動列出全部未沖帳應收、沖帳紀錄與月結待結項目。</p>
        </section>
      ) : (
        <section className="card ar-workspace">
          <div className="ar-workspace__head">
            <div className="ar-workspace__kpi-row">
              <div className="ar-workspace__kpi ar-workspace__kpi--highlight">
                <span className="ar-workspace__kpi-label">未沖帳合計</span>
                <strong className="ar-workspace__kpi-value">$ {moneyText(totalOutstanding)}</strong>
              </div>
              <div className="ar-workspace__kpi">
                <span className="ar-workspace__kpi-label">往來餘額</span>
                <strong className="ar-workspace__kpi-value">$ {moneyText(accountBalance)}</strong>
                <span className="ar-workspace__kpi-hint">正＝客戶欠公司</span>
              </div>
              <div className="ar-workspace__kpi">
                <span className="ar-workspace__kpi-label">月結待開批次</span>
                <strong className="ar-workspace__kpi-value">{monthlyPending.length} 筆</strong>
                <span className="ar-workspace__kpi-hint">$ {moneyText(monthlyPendingTotal)}</span>
              </div>
              <div className="ar-workspace__kpi">
                <span className="ar-workspace__kpi-label">預收錢包</span>
                <strong className="ar-workspace__kpi-value">$ {moneyText(walletBalance)}</strong>
              </div>
            </div>
            <div className="ar-workspace__head-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadCustomerWorkspace(customerId)} disabled={loading}>
                {loading ? "載入中…" : "重新載入"}
              </button>
            </div>
          </div>

          {msg ? (
            <p className={msg.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{msg}</p>
          ) : null}

          <nav className="ar-workspace__tabs" role="tablist">
            {workspaceTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={workspaceTab === tab.id}
                className={`ar-workspace__tab${workspaceTab === tab.id ? " ar-workspace__tab--active" : ""}`}
                onClick={() => setWorkspaceTab(tab.id)}
              >
                <span className="ar-workspace__tab-label">{tab.label}</span>
                <span className="ar-workspace__tab-hint">{tab.hint}</span>
                {tab.count != null && tab.count > 0 ? <span className="ar-workspace__tab-count">{tab.count}</span> : null}
              </button>
            ))}
          </nav>

          {workspaceTab === "open" ? (
            <div className="ar-workspace__panel">
              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">收款沖帳（FIFO）</h3>
                <p className="card__hint">客戶實際付款時使用；系統依到期日自動沖銷全部未清應收。</p>
                <form onSubmit={receiveAllByFifo} className="form-grid form-grid--wide">
                  <div className="form-row-2">
                    <div className="field">
                      <span>收款方式</span>
                      <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                        <option value="cash">現金</option>
                        <option value="transfer">匯款</option>
                        <option value="check">支票</option>
                        <option value="other">其他</option>
                      </select>
                    </div>
                    <div className="field">
                      <span>收款金額</span>
                      <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    </div>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn--primary" disabled={loading}>
                      建立收款單並沖帳
                    </button>
                  </div>
                </form>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">未沖帳應收明細（{openItems.length}）</h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>AR 單號</th>
                        <th>類型</th>
                        <th>訂單</th>
                        <th>狀態</th>
                        <th className="num">原始</th>
                        <th className="num">已沖</th>
                        <th className="num">尚欠</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openItems.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-muted">
                            {loading ? "載入中…" : "此客戶目前沒有未沖帳應收"}
                          </td>
                        </tr>
                      ) : (
                        openItems.map((r) => (
                          <tr key={r.id}>
                            <td className="mono-text">{r.arDocument?.arNo ?? "—"}</td>
                            <td>{billingTypeLabel(r.arDocument?.billingType)}</td>
                            <td>{r.salesOrder?.orderNo ?? "—"}</td>
                            <td>{arStatusLabel(r.status)}</td>
                            <td className="num">{moneyText(r.originalAmount)}</td>
                            <td className="num">{moneyText(r.allocatedAmount)}</td>
                            <td className="num">
                              <strong>{moneyText(r.outstandingAmount)}</strong>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {agingSummary ? (
                  <p className="card__hint ar-panel-block__foot">
                    帳齡：當期 {moneyText(agingSummary.current)}／30+ {moneyText(agingSummary.d30)}／60+{" "}
                    {moneyText(agingSummary.d60)}／90+ {moneyText(agingSummary.d90)}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {workspaceTab === "history" ? (
            <div className="ar-workspace__panel">
              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">收款單／沖帳紀錄（{receiptVouchers.length}）</h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>單號</th>
                        <th>類型</th>
                        <th>方式</th>
                        <th className="num">金額</th>
                        <th>狀態</th>
                        <th>時間</th>
                        <th>備註</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptVouchers.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-muted">
                            {loading ? "載入中…" : "尚無收款單紀錄"}
                          </td>
                        </tr>
                      ) : (
                        receiptVouchers.map((v) => (
                          <tr key={v.id}>
                            <td className="mono-text">{v.voucherNo}</td>
                            <td>{voucherTypeLabel(v.voucherType)}</td>
                            <td>{paymentMethodLabel(v.paymentMethod)}</td>
                            <td className="num">{moneyText(v.totalAmount)}</td>
                            <td>{arStatusLabel(v.status)}</td>
                            <td className="cell-nowrap">{fmtDateTime(v.paidAt ?? v.createdAt)}</td>
                            <td>
                              <small className="text-muted">{v.note ?? "—"}</small>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">銷單收款（payments，{payments.length}）</h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>時間</th>
                        <th className="num">金額</th>
                        <th>方式</th>
                        <th>訂單</th>
                        <th>備註</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-muted">
                            尚無收款紀錄
                          </td>
                        </tr>
                      ) : (
                        payments.map((p) => (
                          <tr key={p.id}>
                            <td className="cell-nowrap">{fmtDateTime(p.paidAt)}</td>
                            <td className="num">{moneyText(p.amount)}</td>
                            <td>{paymentMethodLabel(p.paymentMethod)}</td>
                            <td className="mono-text">{p.orderNo ?? "—"}</td>
                            <td>
                              <small className="text-muted">{p.note ?? "—"}</small>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          {workspaceTab === "monthly" ? (
            <div className="ar-workspace__panel">
              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">待開立月結批次（{monthlyPending.length}）</h3>
                <p className="card__hint">已完成配送、含月結金額、尚未納入任何月結批次的訂單。</p>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>訂單</th>
                        <th>送貨日</th>
                        <th className="num">月結應收</th>
                        <th className="num">已收</th>
                        <th className="num">尚欠</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyPending.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-muted">
                            沒有待開批次的月結訂單
                          </td>
                        </tr>
                      ) : (
                        monthlyPending.map((o) => (
                          <tr key={o.id}>
                            <td className="mono-text">{o.orderNo}</td>
                            <td>{o.deliveryDate ?? "—"}</td>
                            <td className="num">{moneyText(o.monthlyAmount)}</td>
                            <td className="num">{moneyText(o.monthlyReceivedAmount)}</td>
                            <td className="num">
                              <strong>{moneyText(o.outstandingAmount)}</strong>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="card__hint ar-panel-block__foot">
                  待開批次合計：<strong>$ {moneyText(monthlyPendingTotal)}</strong>
                </p>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">已立帳未沖清之月結 AR（{monthlyOpenItems.length}）</h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>AR 單號</th>
                        <th>訂單</th>
                        <th className="num">尚欠</th>
                        <th>狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyOpenItems.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-muted">
                            沒有未沖清的月結 AR
                          </td>
                        </tr>
                      ) : (
                        monthlyOpenItems.map((r) => (
                          <tr key={r.id}>
                            <td className="mono-text">{r.arDocument?.arNo ?? "—"}</td>
                            <td>{r.salesOrder?.orderNo ?? "月結批次"}</td>
                            <td className="num">
                              <strong>{moneyText(r.outstandingAmount)}</strong>
                            </td>
                            <td>{arStatusLabel(r.status)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="card__hint ar-panel-block__foot">
                  月結 AR 未沖合計：<strong>$ {moneyText(monthlyOpenTotal)}</strong>
                </p>
              </div>

              <div className="ar-panel-block ar-panel-block--actions">
                <h3 className="ar-panel-block__title">開立月結批次／請款</h3>
                <p className="card__hint">僅在要開立本期月結批次、產生請款單時需設定截止日。</p>
                <div className="form-row-2">
                  <div className="field">
                    <span>本期截止日</span>
                    <input type="date" value={statementCutoffDate} onChange={(e) => setStatementCutoffDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <span>批次發票</span>
                    <select
                      value={statementPostMode}
                      onChange={(e) => setStatementPostMode(e.target.value as "tax_exclusive" | "tax_inclusive" | "none")}
                    >
                      <option value="tax_exclusive">稅外加</option>
                      <option value="tax_inclusive">含稅</option>
                      <option value="none">不開發票</option>
                    </select>
                  </div>
                </div>
                <div className="form-actions ar-statement-actions">
                  <button type="button" className="btn" onClick={() => void loadStatement()} disabled={statementLoading}>
                    {statementLoading ? "載入中…" : "預覽對帳清單"}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => void postMonthlyStatement()} disabled={statementPosting}>
                    {statementPosting ? "開立中…" : "開立月結批次"}
                  </button>
                  <button type="button" className="btn" onClick={exportStatementCsv} disabled={statementRows.length === 0}>
                    匯出 CSV
                  </button>
                </div>
                {statementPreviewed ? (
                  <div className="ar-statement-preview" style={{ marginTop: "0.85rem" }}>
                    <h4 className="ar-panel-block__title" style={{ fontSize: "0.95rem", marginBottom: "0.45rem" }}>
                      對帳清單預覽
                      {statementRows.length > 0 ? (
                        <span className="card__title-count" style={{ marginLeft: "0.35rem" }}>
                          {statementRows.length} 筆 · $ {moneyText(statementTotal)}
                          {statementPostMode !== "none" ? ` · ${cashInvoiceModeLabel(statementPostMode)}` : ""}
                        </span>
                      ) : null}
                    </h4>
                    <div className="table-wrap">
                      <table className="data-table data-table--compact">
                        <thead>
                          <tr>
                            <th>類型</th>
                            <th>AR 單號</th>
                            <th>訂單</th>
                            <th>實際配送日</th>
                            <th>品項摘要</th>
                            <th>狀態</th>
                            <th className="num">尚欠</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statementRows.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="text-muted">
                                此截止日沒有可對帳資料
                              </td>
                            </tr>
                          ) : (
                            statementRows.map((r, idx) => {
                              const lineSummary =
                                (r.lineItems ?? [])
                                  .map((l) => `${l.productName}×${l.qty}`)
                                  .join("、") || "—";
                              const kindLabel =
                                r.rowKind === "pending_statement"
                                  ? "待開立批次"
                                  : r.rowKind === "legacy_monthly_ar"
                                    ? "已立帳未沖"
                                    : r.rowKind ?? "—";
                              return (
                                <tr key={`${r.openItemId ?? r.salesOrderId ?? r.orderNo ?? "row"}-${idx}`}>
                                  <td>
                                    <span className="pill pill--subtle">{kindLabel}</span>
                                  </td>
                                  <td className="mono-text">{r.arNo || "—"}</td>
                                  <td className="mono-text">{r.orderNo ?? "—"}</td>
                                  <td>{r.actualDeliveryDate ?? "—"}</td>
                                  <td style={{ maxWidth: "14rem", fontSize: "0.8125rem" }} title={lineSummary}>
                                    {lineSummary}
                                  </td>
                                  <td>{arStatusLabel(r.status)}</td>
                                  <td className="num">
                                    <strong>{moneyText(r.outstandingAmount)}</strong>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                        {statementRows.length > 0 ? (
                          <tfoot>
                            <tr>
                              <td colSpan={6} className="num">
                                <strong>合計</strong>
                              </td>
                              <td className="num">
                                <strong>$ {moneyText(statementTotal)}</strong>
                              </td>
                            </tr>
                          </tfoot>
                        ) : null}
                      </table>
                    </div>
                  </div>
                ) : (
                  <p className="card__hint ar-panel-block__foot">按「預覽對帳清單」後，下方會顯示本期可對帳／請款明細。</p>
                )}
                <p className="card__hint ar-panel-block__foot">
                  開票請至
                  <Link to="/reports/tax-invoices" style={{ marginLeft: "0.25rem" }}>
                    發票查詢與補登
                  </Link>
                </p>
              </div>
            </div>
          ) : null}

          {workspaceTab === "prepaid" ? (
            <div className="ar-workspace__panel">
              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">預收錢包餘額</h3>
                <p className="ar-prepaid-balance">
                  $ <strong>{moneyText(walletBalance)}</strong>
                </p>
                <p className="card__hint">
                  金額預收與「預付桶」不同：此處為現金預存，可扣抵應收。預付桶在開單／核銷處理。
                </p>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">預收儲值</h3>
                <form onSubmit={topupPrepayment} className="form-grid form-grid--wide">
                  <div className="form-row-2">
                    <div className="field">
                      <span>儲值金額</span>
                      <input type="number" min={0} step="0.01" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} />
                    </div>
                    <div className="field">
                      <span>發票</span>
                      <select
                        value={topupInvoiceMode}
                        onChange={(e) => setTopupInvoiceMode(e.target.value as "none" | "tax_exclusive" | "tax_inclusive")}
                      >
                        <option value="none">不開</option>
                        <option value="tax_exclusive">稅外加</option>
                        <option value="tax_inclusive">含稅</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn--primary" disabled={loading}>
                      儲值入帳
                    </button>
                  </div>
                </form>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">預收扣抵應收</h3>
                <form onSubmit={applyPrepayment} className="form-grid form-grid--wide">
                  <div className="field">
                    <span>扣抵目標</span>
                    <select value={applyOpenItemId} onChange={(e) => setApplyOpenItemId(e.target.value)}>
                      <option value="">請選擇未沖帳應收</option>
                      {openItems.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.arDocument?.arNo ?? o.id} · {o.salesOrder?.orderNo ?? "無訂單"} · 尚欠 {o.outstandingAmount}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row-2">
                    <div className="field">
                      <span>扣抵金額</span>
                      <input type="number" min={0} step="0.01" value={applyAmount} onChange={(e) => setApplyAmount(e.target.value)} />
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="btn btn--primary" disabled={loading || !applyOpenItemId}>
                        從錢包扣抵
                      </button>
                    </div>
                  </div>
                </form>
              </div>

              <div className="ar-panel-block">
                <h3 className="ar-panel-block__title">預收相關紀錄</h3>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>單號</th>
                        <th>類型</th>
                        <th className="num">金額</th>
                        <th>時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptVouchers.filter((v) => v.voucherType === "prepayment" || v.voucherType === "prepayment_apply").length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-muted">
                            尚無預收儲值或扣抵紀錄
                          </td>
                        </tr>
                      ) : (
                        receiptVouchers
                          .filter((v) => v.voucherType === "prepayment" || v.voucherType === "prepayment_apply")
                          .map((v) => (
                            <tr key={v.id}>
                              <td className="mono-text">{v.voucherNo}</td>
                              <td>{voucherTypeLabel(v.voucherType)}</td>
                              <td className="num">{moneyText(v.totalAmount)}</td>
                              <td className="cell-nowrap">{fmtDateTime(v.paidAt ?? v.createdAt)}</td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      )}

    </>
  );
}
