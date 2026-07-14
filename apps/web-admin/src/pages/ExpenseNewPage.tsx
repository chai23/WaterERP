import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import type { ExpenseCategory, ExpenseLineForm, ExpenseTaxMode, ExpenseVoucher } from "../expenseUtils";
import {
  computeLineTotals,
  newExpenseLineForm,
  normalizeExpenseTaxMode,
  paymentMethodLabel,
  resolveCustomerByCode,
  sumLineForms,
} from "../expenseUtils";

const PAYMENT_OPTIONS = ["cash", "transfer", "check", "monthly", "other"] as const;

function voucherToForm(v: ExpenseVoucher, customers: ReturnType<typeof useDashboard>["customers"]): {
  expenseDate: string;
  vendorName: string;
  affiliatedCompanyId: string;
  invoiceDate: string;
  paymentMethod: string;
  remark: string;
  lines: ExpenseLineForm[];
} {
  const expenseDate = String(v.expenseDate).slice(0, 10);
  const invoiceDate = v.invoiceDate ? String(v.invoiceDate).slice(0, 10) : "";
  return {
    expenseDate,
    vendorName: v.vendorName,
    affiliatedCompanyId: String(v.affiliatedCompanyId),
    invoiceDate,
    paymentMethod: v.paymentMethod,
    remark: v.remark ?? "",
    lines: v.lines.map((line) => {
      const cust = line.customerId ? customers.find((c) => String(c.id) === String(line.customerId)) : undefined;
      return {
        id: String(line.id),
        categoryId: line.categoryId ? String(line.categoryId) : "",
        itemName: line.itemName,
        customerCode: cust?.customerCode ?? line.customer?.customerCode ?? "",
        customerId: line.customerId ? String(line.customerId) : "",
        qty: String(line.qty),
        unitPrice: String(line.unitPrice),
        taxMode: normalizeExpenseTaxMode(line.taxMode),
      };
    }),
  };
}

function customerNameForLine(customers: ReturnType<typeof useDashboard>["customers"], line: ExpenseLineForm): string {
  if (line.customerId) {
    const c = customers.find((x) => String(x.id) === line.customerId);
    if (c) return c.name;
  }
  return resolveCustomerByCode(customers, line.customerCode)?.name ?? "";
}

export default function ExpenseNewPage() {
  const { voucherId } = useParams();
  const isEdit = Boolean(voucherId);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { customers, affiliatedCompanies } = useDashboard();

  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [expenseDate, setExpenseDate] = useState(todayLocalYmd());
  const [vendorName, setVendorName] = useState("");
  const [affiliatedCompanyId, setAffiliatedCompanyId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [remark, setRemark] = useState("");
  const [lines, setLines] = useState<ExpenseLineForm[]>([newExpenseLineForm()]);
  const [status, setStatus] = useState("pending");
  const [voucherNo, setVoucherNo] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/expense-categories")
      .then((r) => r.json())
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!isEdit || !voucherId) return;
    setLoading(true);
    fetch(`/api/expense-vouchers/${voucherId}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.message ?? "讀取失敗");
        return data as ExpenseVoucher;
      })
      .then((v) => {
        if (v.status === "verified") {
          setMsg("此憑證已核銷，不可修改");
        }
        setStatus(v.status);
        setVoucherNo(v.voucherNo);
        const form = voucherToForm(v, customers);
        setExpenseDate(form.expenseDate);
        setVendorName(form.vendorName);
        setAffiliatedCompanyId(form.affiliatedCompanyId);
        setInvoiceDate(form.invoiceDate);
        setPaymentMethod(form.paymentMethod);
        setRemark(form.remark);
        setLines(form.lines.length > 0 ? form.lines : [newExpenseLineForm()]);
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => setLoading(false));
  }, [isEdit, voucherId, customers]);

  useEffect(() => {
    if (!affiliatedCompanyId && affiliatedCompanies.length > 0) {
      setAffiliatedCompanyId(affiliatedCompanies[0].id);
    }
  }, [affiliatedCompanies, affiliatedCompanyId]);

  const totals = useMemo(() => sumLineForms(lines), [lines]);
  const readOnly = status === "verified";

  const updateLine = (id: string, patch: Partial<ExpenseLineForm>) => {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;
        const next = { ...line, ...patch };
        if (patch.customerCode !== undefined) {
          const digits = patch.customerCode.replace(/\D/g, "").slice(0, 6);
          next.customerCode = digits;
          const matched = resolveCustomerByCode(customers, digits);
          next.customerId = matched ? String(matched.id) : "";
        }
        if (patch.categoryId !== undefined) {
          const cat = categories.find((c) => c.id === patch.categoryId);
          if (!cat?.requiresCustomer) {
            next.customerCode = "";
            next.customerId = "";
          } else if (cat.name === "退押金") {
            next.taxMode = "none";
          }
        }
        return next;
      }),
    );
  };

  const addLine = () => setLines((prev) => [...prev, newExpenseLineForm()]);
  const removeLine = (id: string) => setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.id !== id)));

  const validate = (): string | null => {
    if (!expenseDate || !vendorName.trim() || !affiliatedCompanyId) {
      return "請填寫支出日期、廠商／對象、發票歸屬公司";
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.itemName.trim()) return `第 ${i + 1} 行：項目名稱為必填`;
      const cat = categories.find((c) => c.id === line.categoryId);
      if (cat?.requiresCustomer) {
        if (!line.customerCode.trim()) return `第 ${i + 1} 行：「${cat.name}」須輸入客戶編號`;
        if (!line.customerId) return `第 ${i + 1} 行：找不到客戶編號「${line.customerCode}」`;
      }
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty <= 0) return `第 ${i + 1} 行：數量須為正整數`;
      if (!Number.isFinite(Number(line.unitPrice))) return `第 ${i + 1} 行：單價格式錯誤`;
    }
    return null;
  };

  const buildPayload = () => ({
    expenseDateYmd: expenseDate,
    vendorName: vendorName.trim(),
    affiliatedCompanyId,
    invoiceDateYmd: invoiceDate || undefined,
    paymentMethod,
    remark,
    lines: lines.map((line) => ({
      categoryId: line.categoryId || undefined,
      itemName: line.itemName.trim(),
      customerId: line.customerId || undefined,
      qty: Number(line.qty),
      unitPrice: line.unitPrice,
      taxMode: line.taxMode,
    })),
  });

  const submit = async (continueNext: boolean) => {
    setMsg("");
    const err = validate();
    if (err) {
      setMsg(err);
      return;
    }
    setSaving(true);
    try {
      const url = isEdit ? `/api/expense-vouchers/${voucherId}` : "/api/expense-vouchers";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setMsg(data.message ?? "儲存失敗");
        return;
      }
      const no = data.data?.voucherNo ?? voucherNo;
      if (continueNext && !isEdit) {
        setMsg(`已儲存 ${no}，可繼續新增下一張`);
        setVendorName("");
        setRemark("");
        setInvoiceDate("");
        setLines([newExpenseLineForm()]);
        return;
      }
      setMsg(`已儲存 ${no}`);
      if (!isEdit) navigate(`/expenses/edit/${data.data?.id}`);
    } catch {
      setMsg("儲存時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const removeVoucher = async () => {
    if (!voucherId || !window.confirm("確定刪除此支出憑證？")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/expense-vouchers/${voucherId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setMsg(data.message ?? "刪除失敗");
        return;
      }
      navigate("/expenses/query");
    } catch {
      setMsg("刪除時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <p className="text-muted">讀取支出憑證…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">{isEdit ? `編輯支出 ${voucherNo}` : "新增支出"}</h2>
        <p className="page__desc text-muted">
          記錄公司支出憑證（一張多品項）。有開發票者依未稅／含稅計 5% 稅；退押金等無發票項目請選「未開發票」。
          {user?.role === "accounting" || user?.role === "admin" ? " 會計可修改待核銷的他人單據。" : " 僅可修改自己建立的待核銷單據。"}
        </p>
      </header>

      <section className="card expense-form">
        <div className="expense-form__section">
          <header className="expense-form__section-head">
            <h3 className="expense-form__section-title">憑證資訊</h3>
            {isEdit && voucherNo ? (
              <span className="expense-form__voucher-no mono-text">{voucherNo}</span>
            ) : null}
            {readOnly ? <span className="badge badge--completed">已核銷（唯讀）</span> : null}
          </header>

          <div className="expense-form__meta">
            <label className="field">
              <span>支出日期 *</span>
              <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} disabled={readOnly || saving} />
            </label>
            <label className="field expense-form__field--grow">
              <span>廠商／對象 *</span>
              <input
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                disabled={readOnly || saving}
                placeholder="加油站、修車廠、客戶名…"
              />
            </label>
            <label className="field">
              <span>發票歸屬公司 *</span>
              <select value={affiliatedCompanyId} onChange={(e) => setAffiliatedCompanyId(e.target.value)} disabled={readOnly || saving}>
                <option value="">請選擇</option>
                {affiliatedCompanies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>開票日期</span>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} disabled={readOnly || saving} />
            </label>
            <label className="field">
              <span>付款方式 *</span>
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} disabled={readOnly || saving}>
                {PAYMENT_OPTIONS.map((p) => (
                  <option key={p} value={p}>{paymentMethodLabel(p)}</option>
                ))}
              </select>
            </label>
            <label className="field expense-form__field--full">
              <span>備註</span>
              <input value={remark} onChange={(e) => setRemark(e.target.value)} disabled={readOnly || saving} placeholder="選填" />
            </label>
          </div>
        </div>

        <div className="expense-form__section">
          <header className="expense-form__section-head">
            <div>
              <h3 className="expense-form__section-title">支出明細</h3>
              <p className="expense-form__section-hint text-muted">每一行一項支出；類別為「退押金」時會自動改為未開發票，並需填客戶編號。</p>
            </div>
            {!readOnly ? (
              <button type="button" className="btn btn--secondary btn--sm" onClick={addLine} disabled={saving}>
                + 新增一行
              </button>
            ) : null}
          </header>

          <div className="expense-lines" role="group" aria-label="支出明細列">
            <div className="expense-lines__head" aria-hidden="true">
              <span>類別</span>
              <span>項目 *</span>
              <span>客戶編號</span>
              <span>客戶名稱</span>
              <span>數量</span>
              <span>單價</span>
              <span>發票</span>
              <span className="num">稅金</span>
              <span className="num">總額</span>
              {!readOnly ? <span /> : null}
            </div>

            {lines.map((line, idx) => {
              const cat = categories.find((c) => c.id === line.categoryId);
              const t = computeLineTotals(Number(line.qty), Number(line.unitPrice), line.taxMode);
              const customerName = cat?.requiresCustomer ? customerNameForLine(customers, line) : "";
              const codeInvalid = Boolean(cat?.requiresCustomer && line.customerCode.trim() && !line.customerId);
              return (
                <div key={line.id} className="expense-lines__row">
                  <label className="expense-lines__cell">
                    <span className="expense-lines__label">類別</span>
                    <select
                      value={line.categoryId}
                      onChange={(e) => updateLine(line.id, { categoryId: e.target.value })}
                      disabled={readOnly || saving}
                    >
                      <option value="">—</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="expense-lines__cell expense-lines__cell--item">
                    <span className="expense-lines__label">項目 *</span>
                    <input
                      value={line.itemName}
                      onChange={(e) => updateLine(line.id, { itemName: e.target.value })}
                      disabled={readOnly || saving}
                      placeholder={`項目 ${idx + 1}`}
                    />
                  </label>
                  <label className="expense-lines__cell">
                    <span className="expense-lines__label">客戶編號</span>
                    <input
                      value={line.customerCode}
                      onChange={(e) => updateLine(line.id, { customerCode: e.target.value })}
                      disabled={readOnly || saving || !cat?.requiresCustomer}
                      placeholder={cat?.requiresCustomer ? "6 碼" : "—"}
                      inputMode="numeric"
                      maxLength={6}
                      className={codeInvalid ? "input--invalid" : undefined}
                    />
                  </label>
                  <div className="expense-lines__cell expense-lines__cell--readonly">
                    <span className="expense-lines__label">客戶名稱</span>
                    {cat?.requiresCustomer ? (
                      <span className={customerName ? "expense-lines__value" : codeInvalid ? "text-danger" : "text-muted"}>
                        {customerName || (codeInvalid ? "找不到客戶" : "—")}
                      </span>
                    ) : (
                      <span className="text-muted expense-lines__value">—</span>
                    )}
                  </div>
                  <label className="expense-lines__cell">
                    <span className="expense-lines__label">數量</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={line.qty}
                      onChange={(e) => updateLine(line.id, { qty: e.target.value })}
                      disabled={readOnly || saving}
                    />
                  </label>
                  <label className="expense-lines__cell">
                    <span className="expense-lines__label">單價</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.id, { unitPrice: e.target.value })}
                      disabled={readOnly || saving}
                    />
                  </label>
                  <label className="expense-lines__cell">
                    <span className="expense-lines__label">發票</span>
                    <select
                      value={line.taxMode}
                      onChange={(e) => updateLine(line.id, { taxMode: e.target.value as ExpenseTaxMode })}
                      disabled={readOnly || saving}
                    >
                      <option value="tax_exclusive">未稅</option>
                      <option value="tax_inclusive">含稅</option>
                      <option value="none">未開發票</option>
                    </select>
                  </label>
                  <div className="expense-lines__cell expense-lines__cell--readonly num">
                    <span className="expense-lines__label">稅金</span>
                    <span className="expense-lines__value mono-text">{t.tax.toFixed(2)}</span>
                  </div>
                  <div className="expense-lines__cell expense-lines__cell--readonly num">
                    <span className="expense-lines__label">總額</span>
                    <span className="expense-lines__value expense-lines__value--strong mono-text">{t.total.toFixed(2)}</span>
                  </div>
                  {!readOnly ? (
                    <div className="expense-lines__cell expense-lines__cell--act">
                      <span className="expense-lines__label">操作</span>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => removeLine(line.id)}
                        disabled={saving || lines.length <= 1}
                        aria-label={`刪除第 ${idx + 1} 行`}
                      >
                        刪
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="expense-form__totals" aria-live="polite">
            <span>未稅 <strong>{totals.untaxedTotal.toLocaleString()}</strong></span>
            <span>稅金 <strong>{totals.taxTotal.toLocaleString()}</strong></span>
            <span className="expense-form__totals-main">
              含稅總額 <strong>{totals.totalAmount.toLocaleString()}</strong>
            </span>
          </div>
        </div>

        {msg ? (
          <div className={`alert ${msg.includes("失敗") || msg.includes("不可") || msg.includes("須") || msg.includes("找不到") ? "alert--error" : "alert--success"}`}>
            {msg}
          </div>
        ) : null}

        <div className="form-actions expense-form__actions">
          {!readOnly ? (
            <>
              <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void submit(false)}>
                {saving ? "儲存中…" : "儲存"}
              </button>
              {!isEdit ? (
                <button type="button" className="btn btn--secondary" disabled={saving} onClick={() => void submit(true)}>
                  儲存並新增下一張
                </button>
              ) : null}
              {isEdit ? (
                <button type="button" className="btn btn--danger" disabled={saving} onClick={() => void removeVoucher()}>
                  刪除憑證
                </button>
              ) : null}
            </>
          ) : null}
          <Link className="btn btn--secondary" to="/expenses/query">返回查詢</Link>
        </div>
      </section>
    </div>
  );
}
