import { useMemo, useState } from "react";
import { billingTypeLabel, todayLocalYmd } from "../adminUtils";
import { useDashboard } from "../DashboardContext";
import { OrderDetailModal, type OrderRecord } from "./OrderQueryPage";

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

type StatementRow = {
  rowKind?: string;
  openItemId?: string | null;
  /** 開啟完整訂單詳情用 */
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
    default:
      return status ?? "—";
  }
}

export default function BillingArPage() {
  const { customers, loadDashboard } = useDashboard();
  const [customerId, setCustomerId] = useState("");
  const [mode, setMode] = useState<"all" | "cash" | "monthly" | "prepaid">("all");
  const [openItems, setOpenItems] = useState<OpenItemRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("transfer");
  const [statementCutoffDate, setStatementCutoffDate] = useState(() => todayLocalYmd());
  const [agingSummary, setAgingSummary] = useState<{ current: number; d30: number; d60: number; d90: number } | null>(null);
  const [exceptions, setExceptions] = useState<{ overdue?: unknown[]; cashMissing?: unknown[]; creditHold?: unknown[] } | null>(null);
  const [statementRows, setStatementRows] = useState<StatementRow[]>([]);
  const [statementPostMode, setStatementPostMode] = useState<"tax_exclusive" | "tax_inclusive" | "none">("tax_exclusive");
  const [statementPosting, setStatementPosting] = useState(false);
  const [invoiceTitle, setInvoiceTitle] = useState("");
  const [walletBalance, setWalletBalance] = useState("0");
  const [topupAmount, setTopupAmount] = useState("");
  const [applyOpenItemId, setApplyOpenItemId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [companyName, setCompanyName] = useState("WaterERP 公司");
  const [companyTaxId, setCompanyTaxId] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyBank, setCompanyBank] = useState("");
  const [statementDetailOrder, setStatementDetailOrder] = useState<OrderRecord | null>(null);

  const totalOutstanding = useMemo(
    () => openItems.reduce((s, r) => s + Number(r.outstandingAmount ?? 0), 0).toFixed(2),
    [openItems],
  );

  const selectedCustomer = useMemo(() => customers.find((c) => String(c.id) === customerId), [customers, customerId]);
  const statementTotal = useMemo(
    () => statementRows.reduce((sum, r) => sum + Number(r.outstandingAmount ?? 0), 0),
    [statementRows],
  );

  const loadOpenItems = async () => {
    if (!customerId) {
      setMsg("請先選擇客戶");
      return;
    }
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ customerId, cutoffDate: statementCutoffDate });
      if (mode !== "all") q.set("billingType", mode);
      const res = await fetch(`/api/ar/open-items?${q.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "讀取失敗");
        return;
      }
      const rows = payload.data ?? [];
      setOpenItems(rows);
      if (rows.length > 0) setApplyOpenItemId(String(rows[0].id));
      const sumRes = await fetch(`/api/customers/${customerId}/billing-summary`);
      const sumPayload = await sumRes.json();
      if (sumRes.ok && sumPayload?.ok) {
        setWalletBalance(String(sumPayload.data?.prepaymentMoneyBalance ?? "0"));
      }
    } catch {
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  };

  const receiveAllByFifo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) {
      setMsg("請先選擇客戶");
      return;
    }
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
      await loadOpenItems();
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
        body: JSON.stringify({ amount: v, note: "AR 作業台預收儲值" }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMsg(payload.message ?? "預收儲值失敗");
        return;
      }
      setTopupAmount("");
      setMsg("預收儲值成功");
      await loadOpenItems();
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
      setMsg("請先選擇客戶與應收項目");
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
      await loadOpenItems();
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  };

  const loadAging = async () => {
    const q = new URLSearchParams();
    if (customerId) q.set("customerId", customerId);
    const res = await fetch(`/api/reports/ar-aging?${q.toString()}`);
    const payload = await res.json();
    if (res.ok && payload.ok) setAgingSummary(payload.data?.summary ?? null);
  };

  const loadExceptions = async () => {
    const res = await fetch("/api/reports/ar-exceptions");
    const payload = await res.json();
    if (res.ok && payload.ok) setExceptions(payload.data ?? null);
  };

  const openStatementOrderDetail = async (salesOrderId: string) => {
    setMsg("");
    try {
      const res = await fetch("/api/sales-orders");
      const list: unknown = await res.json();
      if (!res.ok || !Array.isArray(list)) {
        setMsg("無法讀取訂單列表");
        return;
      }
      const row = list.find((o: { id?: unknown }) => String(o.id) === salesOrderId);
      if (!row) {
        setMsg("找不到該訂單");
        return;
      }
      setStatementDetailOrder(row as OrderRecord);
    } catch {
      setMsg("無法連線 API");
    }
  };

  const loadStatement = async () => {
    if (!customerId) {
      setMsg("請先選擇客戶");
      return;
    }
    const q = new URLSearchParams({ customerId, cutoffDate: statementCutoffDate });
    const res = await fetch(`/api/billing/statements?${q.toString()}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      setMsg(payload.message ?? "產生對帳單失敗");
      return;
    }
    setStatementRows(payload.data?.rows ?? []);
    setMsg("");
    if (!invoiceTitle.trim()) {
      const cName = selectedCustomer?.name?.trim() ?? "";
      if (cName) setInvoiceTitle(`${cName} 請款單`);
    }
  };

  const postMonthlyStatement = async () => {
    if (!customerId) {
      setMsg("請先選擇客戶");
      return;
    }
    const pendingCount = statementRows.filter((r) => r.rowKind === "pending_statement").length;
    if (pendingCount === 0) {
      setMsg("目前清單無「待開立批次」訂單（可能已全部立帳或無符合截止日之月結單）");
      return;
    }
    if (!window.confirm(`將依截止日 ${statementCutoffDate} 開立月結批次並立未稅 AR（共 ${pendingCount} 張訂單）。確定？`)) return;
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
      setMsg(`已開立批次：${payload.data?.billingStatement?.statementNo ?? ""}`);
      await loadStatement();
      await loadOpenItems();
      loadDashboard();
    } catch {
      setMsg("無法連線 API");
    } finally {
      setStatementPosting(false);
    }
  };

  const exportStatementCsv = () => {
    if (!selectedCustomer) {
      setMsg("請先選擇客戶");
      return;
    }
    if (statementRows.length === 0) {
      setMsg("請先產生對帳清單");
      return;
    }
    const title = invoiceTitle.trim() || `${selectedCustomer.name} 請款單`;
    const lines: string[] = [];
    lines.push(`請款抬頭,${title}`);
    lines.push(`開立公司,${companyName}`);
    lines.push(`統一編號,${companyTaxId}`);
    lines.push(`聯絡電話,${companyPhone}`);
    lines.push(`公司地址,${companyAddress}`);
    lines.push(`付款帳號,${companyBank}`);
    lines.push(`客戶名稱,${selectedCustomer.name}`);
    lines.push(`截止日,${statementCutoffDate}`);
    lines.push(`請款總額,${statementTotal.toFixed(2)}`);
    lines.push("");
    lines.push("AR No,訂單,實際配送日,商品,單價,數量,小計,狀態,尚欠");
    for (const r of statementRows) {
      const orderNo = r.orderNo ?? "—";
      const deliveryDate = r.actualDeliveryDate ?? "—";
      const items = Array.isArray(r.lineItems) && r.lineItems.length > 0 ? r.lineItems : [{ productName: "—", unitPrice: "", qty: 0, subtotal: "" }];
      for (const item of items) {
        lines.push([
          r.arNo,
          orderNo,
          deliveryDate,
          item.productName,
          item.unitPrice,
          String(item.qty),
          item.subtotal,
          arStatusLabel(r.status),
          r.outstandingAmount,
        ].join(","));
      }
    }
    const blob = new Blob([`\uFEFF${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-${selectedCustomer.name}-${statementCutoffDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportStatementPdf = () => {
    if (!selectedCustomer) {
      setMsg("請先選擇客戶");
      return;
    }
    if (statementRows.length === 0) {
      setMsg("請先產生對帳清單");
      return;
    }
    const title = invoiceTitle.trim() || `${selectedCustomer.name} 請款單`;
    const rowsHtml = statementRows
      .map((r, i) => {
        const items = Array.isArray(r.lineItems) && r.lineItems.length > 0 ? r.lineItems : [{ productName: "—", unitPrice: "", qty: 0, subtotal: "" }];
        return items
          .map(
            (item, idx) => `
              <tr>
                <td>${idx === 0 ? i + 1 : ""}</td>
                <td>${idx === 0 ? r.arNo : ""}</td>
                <td>${idx === 0 ? (r.orderNo ?? "—") : ""}</td>
                <td>${idx === 0 ? (r.actualDeliveryDate ?? "—") : ""}</td>
                <td>${item.productName}</td>
                <td style="text-align:right;">${item.unitPrice || "—"}</td>
                <td style="text-align:right;">${item.qty || "—"}</td>
                <td style="text-align:right;">${item.subtotal || "—"}</td>
                <td>${idx === 0 ? arStatusLabel(r.status) : ""}</td>
                <td style="text-align:right;">${idx === 0 ? r.outstandingAmount : ""}</td>
              </tr>`,
          )
          .join("");
      })
      .join("");
    const html = `
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${title}</title>
          <style>
            body { font-family: Arial, "Microsoft JhengHei", sans-serif; padding: 24px; color: #111; }
            h1 { margin: 0 0 12px; font-size: 22px; }
            .meta { margin-bottom: 16px; line-height: 1.7; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #999; padding: 8px; font-size: 12px; }
            th { background: #f3f3f3; }
            .total { margin-top: 12px; text-align: right; font-size: 14px; font-weight: 700; }
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <div class="meta">
            <div>開立公司：${companyName}</div>
            <div>統一編號：${companyTaxId || "—"}</div>
            <div>聯絡電話：${companyPhone || "—"}</div>
            <div>公司地址：${companyAddress || "—"}</div>
            <div>付款帳號：${companyBank || "—"}</div>
            <div>------------------------------------</div>
            <div>客戶名稱：${selectedCustomer.name}</div>
            <div>截止日：${statementCutoffDate}</div>
            <div>產生時間：${new Date().toLocaleString()}</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>AR No</th>
                <th>訂單</th>
                <th>實際配送日</th>
                <th>商品</th>
                <th>單價</th>
                <th>數量</th>
                <th>小計</th>
                <th>狀態</th>
                <th>尚欠</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div class="total">請款總額：${statementTotal.toFixed(2)}</div>
        </body>
      </html>`;
    const w = window.open("", "_blank", "width=960,height=720");
    if (!w) {
      setMsg("瀏覽器阻擋了彈出視窗，請允許後再試");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <>
      <section className="card">
        <h2 className="card__title">操作導引（Step 1~3）</h2>
        <ol className="card__hint" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li><strong>Step 1：</strong>先選「操作模式」與「客戶」，再按「查詢未沖銷 AR」。</li>
          <li><strong>Step 2：</strong>依客戶類型操作：現金/月結都用通用收款入帳；預收先儲值再扣抵。</li>
          <li><strong>Step 3：</strong>完成後檢查「未沖銷明細」與「稽核與對帳」確認餘額、帳齡、異常是否正確。</li>
        </ol>
      </section>

      <section className="card">
        <h2 className="card__title">AR 收款沖帳作業台（現金 / 月結 / 預收整合）</h2>
        <div className="form-grid form-grid--wide">
          <div className="field">
            <span>操作模式</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "all" | "cash" | "monthly" | "prepaid")}>
              <option value="all">全部客戶類型</option>
              <option value="cash">現金客戶</option>
              <option value="monthly">月結客戶</option>
              <option value="prepaid">預收客戶</option>
            </select>
          </div>
          <div className="field">
            <span>客戶</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">請選擇</option>
              {customers.map((c) => (
                <option key={String(c.id)} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>結帳截止日（月結/對帳）</span>
            <input type="date" value={statementCutoffDate} onChange={(e) => setStatementCutoffDate(e.target.value)} />
          </div>
          <div className="form-actions ar-query-actions">
            <button type="button" className="btn btn--primary" onClick={() => void loadOpenItems()} disabled={loading || !customerId}>
              {loading ? "讀取中…" : "查詢未沖銷 AR"}
            </button>
          </div>
        </div>
        <div className="ar-summary-lines">
          <p className="card__hint ar-summary-line">
            目前客戶類型：<strong>{billingTypeLabel(selectedCustomer?.billingType)}</strong>
            {mode === "cash" ? "｜建議先查未沖銷，再收款 FIFO 沖帳" : ""}
            {mode === "monthly" ? "｜月結同樣走通用收款；可搭配截止日縮小範圍" : ""}
            {mode === "prepaid" ? "｜可先儲值預收，再扣抵指定 AR" : ""}
          </p>
          <p className="card__hint ar-summary-line">未沖銷合計：<strong>{totalOutstanding}</strong></p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">通用收款入帳（FIFO）</h3>
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
            <button type="submit" className="btn btn--primary" disabled={loading || !customerId}>建立收款單並沖帳</button>
            {msg ? <span className={msg.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{msg}</span> : null}
          </div>
        </form>
      </section>

      {mode === "prepaid" ? (
        <section className="card">
          <h3 className="card__title">預收專用：儲值與扣抵</h3>
          <p className="card__hint">金額預收餘額：<strong>{walletBalance}</strong></p>
          <form onSubmit={topupPrepayment} className="form-grid form-grid--wide">
            <div className="form-row-2">
              <div className="field">
                <span>儲值金額</span>
                <input type="number" min={0} step="0.01" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} />
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn--primary" disabled={loading || !customerId}>預收儲值</button>
              </div>
            </div>
          </form>

          <form onSubmit={applyPrepayment} className="form-grid form-grid--wide" style={{ marginTop: "1rem" }}>
            <div className="field">
              <span>扣抵目標 AR</span>
              <select value={applyOpenItemId} onChange={(e) => setApplyOpenItemId(e.target.value)}>
                <option value="">請選擇</option>
                {openItems.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.arDocument?.arNo ?? o.id} / {o.salesOrder?.orderNo ?? "無訂單"} / 尚欠 {o.outstandingAmount}
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
                <button type="submit" className="btn btn--primary" disabled={loading || !customerId || !applyOpenItemId}>預收扣抵</button>
              </div>
            </div>
          </form>
        </section>
      ) : null}

      <section className="card">
        <h3 className="card__title">未沖銷明細</h3>
        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>AR No</th>
                <th>訂單</th>
                <th>狀態</th>
                <th className="num">原始</th>
                <th className="num">已沖</th>
                <th className="num">尚欠</th>
              </tr>
            </thead>
            <tbody>
              {openItems.length === 0 ? (
                <tr><td colSpan={6} className="text-muted">{loading ? "讀取中…" : "無資料"}</td></tr>
              ) : openItems.map((r) => (
                <tr key={r.id}>
                  <td className="mono-text">{r.arDocument?.arNo ?? "—"}</td>
                  <td>{r.salesOrder?.orderNo ?? "—"}</td>
                  <td>{arStatusLabel(r.status)}</td>
                  <td className="num">{r.originalAmount}</td>
                  <td className="num">{r.allocatedAmount}</td>
                  <td className="num">{r.outstandingAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">稽核與對帳</h3>
        <div className="form-actions" style={{ marginBottom: "1rem" }}>
          <button type="button" className="btn" onClick={() => void loadAging()}>更新帳齡</button>
          <button type="button" className="btn" onClick={() => void loadExceptions()}>更新異常清單</button>
        </div>
        {agingSummary ? (
          <p className="card__hint">
            Current {agingSummary.current.toFixed(2)} / 30+ {agingSummary.d30.toFixed(2)} / 60+ {agingSummary.d60.toFixed(2)} / 90+ {agingSummary.d90.toFixed(2)}
          </p>
        ) : null}
        {exceptions ? (
          <p className="card__hint">
            逾期 {exceptions.overdue?.length ?? 0} 筆；待補收 {exceptions.cashMissing?.length ?? 0} 筆；超額客戶 {exceptions.creditHold?.length ?? 0} 家
          </p>
        ) : null}
      </section>

      <section className="card">
        <h3 className="card__title">對帳單（Statement）</h3>
        <div className="form-row-2">
          <div className="field">
            <span>開立公司</span>
            <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
          <div className="field">
            <span>統一編號</span>
            <input type="text" value={companyTaxId} onChange={(e) => setCompanyTaxId(e.target.value)} />
          </div>
        </div>
        <div className="form-row-2">
          <div className="field">
            <span>聯絡電話</span>
            <input type="text" value={companyPhone} onChange={(e) => setCompanyPhone(e.target.value)} />
          </div>
          <div className="field">
            <span>公司地址</span>
            <input type="text" value={companyAddress} onChange={(e) => setCompanyAddress(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <span>付款帳號</span>
          <input type="text" value={companyBank} onChange={(e) => setCompanyBank(e.target.value)} placeholder="銀行/分行/帳號" />
        </div>
        <div className="field">
          <span>請款抬頭</span>
          <input
            type="text"
            value={invoiceTitle}
            onChange={(e) => setInvoiceTitle(e.target.value)}
            placeholder="例如：某某公司 5 月月結請款單"
          />
        </div>
        <div className="form-row-2">
          <div className="field">
            <span>截止日</span>
            <input type="date" value={statementCutoffDate} onChange={(e) => setStatementCutoffDate(e.target.value)} />
          </div>
          <div className="field">
            <span>開立批次發票模式</span>
            <select value={statementPostMode} onChange={(e) => setStatementPostMode(e.target.value as "tax_exclusive" | "tax_inclusive" | "none")}>
              <option value="tax_exclusive">稅外加（整期未稅加總後算稅）</option>
              <option value="tax_inclusive">含稅（僅憑證拆額；AR 仍為未稅）</option>
              <option value="none">不開發票紀錄</option>
            </select>
          </div>
          <div className="form-actions ar-statement-actions">
            <button type="button" className="btn" onClick={() => void loadStatement()} disabled={!customerId}>產生對帳清單</button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void postMonthlyStatement()}
              disabled={!customerId || statementPosting}
            >
              {statementPosting ? "開立中…" : "開立月結批次並立帳"}
            </button>
            <button type="button" className="btn" onClick={exportStatementCsv} disabled={!customerId || statementRows.length === 0}>匯出 CSV</button>
            <button type="button" className="btn" onClick={exportStatementPdf} disabled={!customerId || statementRows.length === 0}>匯出 PDF</button>
          </div>
        </div>
        <p className="card__hint ar-statement-meta">
          客戶：<strong>{selectedCustomer?.name ?? "—"}</strong>｜截止日：<strong>{statementCutoffDate}</strong>｜請款總額（含待開批次＋舊制未沖）：<strong>{statementTotal.toFixed(2)}</strong>
        </p>
        <p className="card__hint">
          下方<strong>商品明細僅列月結列</strong>（與「尚欠」之月結應收一致）。混單若含現金／預付列，請按<strong>詳細訂單</strong>檢視完整明細。
        </p>
        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>AR No</th>
                <th>訂單</th>
                <th>實際配送日</th>
                <th>商品明細（僅月結列）</th>
                <th>狀態</th>
                <th className="num">尚欠</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {statementRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted">
                    無資料
                  </td>
                </tr>
              ) : (
                statementRows.map((r, idx) => (
                  <tr key={`${r.rowKind ?? "row"}-${r.arNo}-${r.orderNo ?? "na"}-${idx}`}>
                    <td className="mono-text">{r.arNo}</td>
                    <td>{r.orderNo ?? "—"}</td>
                    <td>{r.actualDeliveryDate ?? "—"}</td>
                    <td>
                      {(r.lineItems ?? []).length === 0
                        ? "—"
                        : (r.lineItems ?? []).map((it) => `${it.productName} × ${it.qty} @ ${it.unitPrice} = ${it.subtotal}`).join("；")}
                    </td>
                    <td>{arStatusLabel(r.status)}</td>
                    <td className="num">{r.outstandingAmount}</td>
                    <td>
                      {r.salesOrderId ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => void openStatementOrderDetail(String(r.salesOrderId))}
                        >
                          詳細訂單
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {statementDetailOrder ? (
        <OrderDetailModal order={statementDetailOrder} onClose={() => setStatementDetailOrder(null)} />
      ) : null}
    </>
  );
}
