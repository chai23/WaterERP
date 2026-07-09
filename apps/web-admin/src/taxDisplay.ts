/** 與 API `VAT_RATE`／`DEFAULT_VAT_RATE` 預設一致（預設 5%） */
export const DEFAULT_VAT_RATE = 0.05;

export type CashInvoiceModeUi = "none" | "tax_inclusive" | "tax_exclusive";

function normalizeMode(raw: string): CashInvoiceModeUi {
  const s = raw.trim().toLowerCase();
  if (s === "tax_inclusive" || s === "tax_exclusive") return s;
  return "none";
}

/** 現金列發票預覽（金額四捨五入至小數 2 位，對齊後端 Decimal） */
export function breakdownCashTaxInvoicePreview(
  cashSubtotal: number,
  modeRaw: string,
  rate = DEFAULT_VAT_RATE,
): { mode: CashInvoiceModeUi; untaxedAmount: number; taxAmount: number; totalWithTax: number; taxRate: number } | null {
  const mode = normalizeMode(modeRaw);
  if (mode === "none" || !Number.isFinite(cashSubtotal) || cashSubtotal <= 0) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (mode === "tax_exclusive") {
    const untaxedAmount = r2(cashSubtotal);
    const taxAmount = r2(untaxedAmount * rate);
    const totalWithTax = r2(untaxedAmount + taxAmount);
    return { mode, untaxedAmount, taxAmount, totalWithTax, taxRate: rate };
  }
  const denom = 1 + rate;
  const untaxedAmount = r2(cashSubtotal / denom);
  const taxAmount = r2(cashSubtotal - untaxedAmount);
  return { mode, untaxedAmount, taxAmount, totalWithTax: r2(cashSubtotal), taxRate: rate };
}

export function cashInvoiceModeLabel(mode: string | null | undefined): string {
  const m = normalizeMode(typeof mode === "string" ? mode : "");
  if (m === "tax_exclusive") return "開發票（稅外加）";
  if (m === "tax_inclusive") return "開發票（含稅）";
  return "不開發票紀錄";
}
