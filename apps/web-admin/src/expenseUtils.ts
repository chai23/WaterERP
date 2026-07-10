import type { Customer } from "./adminUtils";

export const TAX_RATE = 0.05;

export type ExpenseCategory = {
  id: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
  requiresCustomer?: boolean;
};

export type ExpenseTaxMode = "tax_inclusive" | "tax_exclusive" | "none";

export type ExpenseLineForm = {
  id: string;
  categoryId: string;
  itemName: string;
  customerCode: string;
  customerId: string;
  qty: string;
  unitPrice: string;
  taxMode: ExpenseTaxMode;
};

export type ExpenseVoucher = {
  id: string;
  voucherNo: string;
  expenseDate: string;
  vendorName: string;
  affiliatedCompanyId: string;
  invoiceDate?: string | null;
  paymentMethod: string;
  remark?: string | null;
  status: string;
  untaxedTotal: string;
  taxTotal: string;
  totalAmount: string;
  verifiedAt?: string | null;
  affiliatedCompany?: { id: string; name: string };
  createdBy?: { id: string; name: string; employeeCode?: string };
  verifiedBy?: { id: string; name: string; employeeCode?: string };
  lines: {
    id: string;
    categoryId?: string | null;
    itemName: string;
    customerId?: string | null;
    qty: number;
    unitPrice: string;
    taxMode: string;
    taxAmount: string;
    lineAmount: string;
    sortOrder?: number;
    category?: { id: string; name: string; requiresCustomer?: boolean } | null;
    customer?: { id: string; name: string; customerCode?: string | null } | null;
  }[];
};

export type ExpenseFlatLine = {
  lineId: string;
  voucherId: string;
  voucherNo: string;
  expenseDate: string;
  vendorName: string;
  companyId: string;
  companyName: string;
  invoiceDate: string | null;
  paymentMethod: string;
  voucherRemark: string | null;
  status: string;
  categoryId: string | null;
  categoryName: string | null;
  itemName: string;
  customerId: string | null;
  customerName: string | null;
  customerCode: string | null;
  qty: number;
  unitPrice: string;
  taxMode: string;
  taxAmount: string;
  lineAmount: string;
  createdByName: string | null;
  verifiedAt: string | null;
};

export type ExpenseSummary = {
  date: string;
  voucherCount: number;
  lineCount: number;
  untaxedTotal: string;
  taxTotal: string;
  totalAmount: string;
  verifiedCount: number;
  pendingCount: number;
  byCategory: { name: string; totalAmount: string; count: number }[];
  byCompany: { name: string; totalAmount: string; count: number }[];
  lines: ExpenseFlatLine[];
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "現金",
  transfer: "匯款",
  check: "支票",
  monthly: "月結",
  other: "其他",
};

export const TAX_MODE_LABELS: Record<string, string> = {
  tax_inclusive: "含稅",
  tax_exclusive: "未稅",
  none: "未開發票",
};

export function paymentMethodLabel(v: string): string {
  return PAYMENT_METHOD_LABELS[v] ?? v;
}

export function statusLabel(status: string): string {
  return status === "verified" ? "已核銷" : status === "pending" ? "待核銷" : status;
}

export function newExpenseLineForm(): ExpenseLineForm {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `EL${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    categoryId: "",
    itemName: "",
    customerCode: "",
    customerId: "",
    qty: "1",
    unitPrice: "",
    taxMode: "tax_exclusive",
  };
}

export function computeLineTotals(qty: number, unitPrice: number, taxMode: ExpenseTaxMode) {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
    return { untaxed: 0, tax: 0, total: 0 };
  }
  const subtotal = unitPrice * qty;
  if (taxMode === "none") {
    return { untaxed: subtotal, tax: 0, total: subtotal };
  }
  if (taxMode === "tax_exclusive") {
    const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
    return { untaxed: subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
  }
  const untaxed = Math.round((subtotal / (1 + TAX_RATE)) * 100) / 100;
  const tax = Math.round((subtotal - untaxed) * 100) / 100;
  return { untaxed, tax, total: subtotal };
}


export function resolveCustomerByCode(customers: Customer[], codeRaw: string): Customer | null {
  const digits = codeRaw.replace(/\D/g, "");
  if (!digits || digits.length > 6) return null;
  const padded = digits.padStart(6, "0");
  return (
    customers.find((c) => {
      const code = (c.customerCode ?? "").trim();
      return code === padded || code === digits;
    }) ?? null
  );
}

export function normalizeExpenseTaxMode(raw: string | undefined | null): ExpenseTaxMode {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "tax_inclusive" || s === "tax_exclusive" || s === "none") return s;
  return "tax_exclusive";
}

export function sumLineForms(lines: ExpenseLineForm[]) {
  let untaxed = 0;
  let tax = 0;
  let total = 0;
  for (const line of lines) {
    const qty = Number(line.qty);
    const unitPrice = Number(line.unitPrice);
    const t = computeLineTotals(qty, unitPrice, line.taxMode);
    untaxed += t.untaxed;
    tax += t.tax;
    total += t.total;
  }
  return {
    untaxedTotal: Math.round(untaxed * 100) / 100,
    taxTotal: Math.round(tax * 100) / 100,
    totalAmount: Math.round(total * 100) / 100,
  };
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportExpenseLinesCsv(filename: string, lines: ExpenseFlatLine[]) {
  downloadCsv(filename, [
    "支出日期",
    "單號",
    "公司",
    "廠商",
    "類別",
    "項目",
    "客戶",
    "數量",
    "單價",
    "含稅模式",
    "稅金",
    "總金額",
    "付款方式",
    "核銷狀態",
    "開票日期",
    "備註",
  ], lines.map((l) => [
    l.expenseDate,
    l.voucherNo,
    l.companyName,
    l.vendorName,
    l.categoryName ?? "",
    l.itemName,
    l.customerName ?? "",
    l.qty,
    l.unitPrice,
    TAX_MODE_LABELS[l.taxMode] ?? l.taxMode,
    l.taxAmount,
    l.lineAmount,
    paymentMethodLabel(l.paymentMethod),
    statusLabel(l.status),
    l.invoiceDate ?? "",
    l.voucherRemark ?? "",
  ]));
}
