import type { OrderSlipSource } from "./layoutTypes";
import { slipFromDashboardOrder } from "./slipFromApiOrder";

function todayLocalYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 依配送日（或今日）取得合併後的套印公告文字 */
export async function fetchResolvedOrderAnnouncement(dateYmd?: string | null): Promise<string | null> {
  const ymd = (dateYmd ?? "").trim().slice(0, 10) || todayLocalYmd();
  try {
    const res = await fetch(`/api/order-announcements/resolved?date=${encodeURIComponent(ymd)}`);
    const data = await res.json();
    if (!res.ok || !data?.ok) return null;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

type PrintEnrichment = {
  customerMobile?: string | null;
  taxAmount?: string | number | null;
  cashInvoiceMode?: string | null;
  driverName?: string | null;
  prepaidBarrelBalance?: number | null;
  barrelsOnSite?: number | null;
  lastOrderDate?: string | null;
  lastBottleQty?: number | null;
};

/** 套印補強：手機／稅額／司機／預付剩餘桶／空桶／同地址上次配送 */
export async function fetchOrderPrintEnrichment(salesOrderId: string | number | bigint | null | undefined): Promise<PrintEnrichment | null> {
  const id = salesOrderId != null ? String(salesOrderId).trim() : "";
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    const res = await fetch(`/api/sales-orders/${encodeURIComponent(id)}/print-enrichment`);
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.data || typeof data.data !== "object") return null;
    return data.data as PrintEnrichment;
  } catch {
    return null;
  }
}

function applyPrintEnrichment(slip: OrderSlipSource, en: PrintEnrichment): OrderSlipSource {
  const mobile = en.customerMobile?.trim() || null;
  const remain =
    en.prepaidBarrelBalance != null && Number.isFinite(Number(en.prepaidBarrelBalance))
      ? String(en.prepaidBarrelBalance)
      : slip.remainBalance;
  const buckets =
    en.barrelsOnSite != null && Number.isFinite(Number(en.barrelsOnSite))
      ? String(en.barrelsOnSite)
      : slip.bucketCount;
  const lastQty =
    en.lastBottleQty != null && Number.isFinite(Number(en.lastBottleQty))
      ? String(en.lastBottleQty)
      : slip.lastBottleQty;
  return {
    ...slip,
    taxAmount: en.taxAmount != null && en.taxAmount !== "" ? en.taxAmount : null,
    cashInvoiceMode: en.cashInvoiceMode ?? slip.cashInvoiceMode,
    driverName: en.driverName?.trim() || null,
    remainBalance: remain ?? null,
    bucketCount: buckets ?? null,
    lastOrderDate: en.lastOrderDate?.trim() || null,
    lastBottleQty: lastQty ?? null,
    customer: {
      ...slip.customer,
      mobile: mobile || slip.customer?.mobile || null,
    },
    deliveryAddress: {
      ...slip.deliveryAddress,
      addressLine: slip.deliveryAddress?.addressLine ?? "",
      /** 紙上「送貨點電話」改印客戶手機 */
      contactPhone: mobile || null,
    },
  };
}

export async function slipWithOrderAnnouncement(slip: OrderSlipSource): Promise<OrderSlipSource> {
  const date = slip.scheduledDeliveryDate?.slice(0, 10) ?? todayLocalYmd();
  const text = await fetchResolvedOrderAnnouncement(date);
  if (!text) return slip;
  return { ...slip, announcement: text };
}

export async function slipFromDashboardOrderWithAnnouncement(row: Record<string, unknown>): Promise<OrderSlipSource> {
  const base = slipFromDashboardOrder(row);
  const orderId = row.id ?? row.salesOrderId;
  const [withAnn, enrichment] = await Promise.all([
    slipWithOrderAnnouncement(base),
    fetchOrderPrintEnrichment(orderId as string | number | bigint | null | undefined),
  ]);
  return enrichment ? applyPrintEnrichment(withAnn, enrichment) : withAnn;
}
