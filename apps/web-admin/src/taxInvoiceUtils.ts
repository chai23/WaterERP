import { cashInvoiceModeLabel } from "./taxDisplay";

export type TaxInvoiceRecord = {
  id: string;
  invoiceNo: string;
  externalInvoiceNo: string | null;
  customerId: string;
  customerName: string | null;
  basisType: string;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  billingStatementId: string | null;
  billingStatementNo: string | null;
  receiptVoucherId: string | null;
  receiptVoucherNo: string | null;
  invoiceMode: string;
  untaxedAmount: string;
  taxAmount: string;
  totalAmount: string;
  taxRate: string;
  status: string;
  buyerTaxId: string | null;
  buyerName: string | null;
  note: string | null;
  issuedAt: string;
  createdAt: string;
};

export function taxInvoiceStatusLabel(status: string | null | undefined): string {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "planned") return "待開票";
  if (s === "issued") return "已開票";
  if (s === "voided") return "已作廢";
  return status ? String(status) : "—";
}

export function taxInvoiceBasisLabel(basisType: string | null | undefined): string {
  const s = String(basisType ?? "").trim().toLowerCase();
  if (s === "sales_order") return "訂單（現金／儲值）";
  if (s === "billing_statement") return "月結批次";
  if (s === "prepayment_topup") return "預收儲值";
  return basisType ? String(basisType) : "—";
}

export function taxInvoiceModeLabel(mode: string | null | undefined): string {
  return cashInvoiceModeLabel(mode);
}

export function taxInvoiceDisplayNo(inv: Pick<TaxInvoiceRecord, "externalInvoiceNo" | "invoiceNo">): string {
  return inv.externalInvoiceNo?.trim() || inv.invoiceNo || "—";
}

export async function patchTaxInvoice(
  id: string,
  body: {
    externalInvoiceNo?: string;
    note?: string;
    buyerTaxId?: string;
    buyerName?: string;
    status?: "planned" | "issued" | "voided";
  },
): Promise<TaxInvoiceRecord> {
  const res = await fetch(`/api/tax-invoices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload?.message ?? "更新發票失敗");
  }
  return payload.data as TaxInvoiceRecord;
}
