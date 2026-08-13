import type { OrderSlipSource } from "./layoutTypes";

/** 將後台訂單列表／詳情 API 的寬鬆物件轉成套印用結構 */
export function slipFromDashboardOrder(row: Record<string, unknown>): OrderSlipSource {
  const cust = (row.customer ?? {}) as Record<string, unknown>;
  const addr = (row.deliveryAddress ?? {}) as Record<string, unknown>;
  const linesRaw = Array.isArray(row.lines) ? row.lines : [];
  const lines = linesRaw.map((ln) => {
    const L = ln as Record<string, unknown>;
    const p = (L.product ?? {}) as Record<string, unknown>;
    return {
      productCode:
        L.productCode != null
          ? String(L.productCode)
          : p.productCode != null
            ? String(p.productCode)
            : L.sku != null
              ? String(L.sku)
              : undefined,
      qtyOrdered: Math.floor(Number(L.qtyOrdered ?? 0)) || 0,
      unitPrice: L.unitPrice != null ? (typeof L.unitPrice === "number" ? L.unitPrice : String(L.unitPrice)) : undefined,
      lineAmount: L.lineAmount != null ? (typeof L.lineAmount === "number" ? L.lineAmount : String(L.lineAmount)) : undefined,
      linePurpose: L.linePurpose != null ? String(L.linePurpose) : null,
      billingTypeAtLine: L.billingTypeAtLine != null ? String(L.billingTypeAtLine) : null,
      isPromotionGift: Boolean(L.isPromotionGift),
      isReplenishment: Boolean(L.isReplenishment),
      promotionNote: L.promotionNote != null ? String(L.promotionNote) : null,
      product: {
        name: p.name != null ? String(p.name) : undefined,
        unit: p.unit != null ? String(p.unit) : undefined,
      },
    };
  });
  const ta = row.totalAmount;
  const totalAmount: string | number | undefined =
    typeof ta === "number" || typeof ta === "string" ? ta : ta != null ? String(ta) : undefined;
  const tax = row.taxAmount ?? row.tex ?? row.tax;
  const strOpt = (v: unknown) => (v != null ? String(v) : undefined);
  return {
    orderNo: String(row.orderNo ?? ""),
    scheduledDeliveryDate: row.scheduledDeliveryDate != null ? String(row.scheduledDeliveryDate) : null,
    remark: row.remark != null ? String(row.remark) : null,
    taxAmount: tax != null ? (typeof tax === "number" ? tax : String(tax)) : undefined,
    totalAmount,
    billingTypeAtOrder: row.billingTypeAtOrder != null ? String(row.billingTypeAtOrder) : null,
    cashInvoiceMode: row.cashInvoiceMode != null ? String(row.cashInvoiceMode) : null,
    // 開單「備註」存 sales_orders.remark，套印對應「商品／訂單備註（紙上）」
    productRemark: strOpt(row.productRemark) ?? strOpt(row.remark),
    announcement: strOpt(row.announcement),
    driverName: strOpt(row.driverName),
    remainBalance: strOpt(row.remainBalance),
    bucketCount: strOpt(row.bucketCount),
    lastOrderDate: strOpt(row.lastOrderDate ?? row.lastTimeOrderDay),
    lastBottleQty: strOpt(row.lastBottleQty ?? row.lastTimeQuantity),
    customer: {
      customerCode: cust.customerCode != null ? String(cust.customerCode) : undefined,
      name: cust.name != null ? String(cust.name) : undefined,
      phone: cust.phone != null ? String(cust.phone) : undefined,
      mobile: cust.mobile != null ? String(cust.mobile) : undefined,
      billingType: cust.billingType != null ? String(cust.billingType) : undefined,
      businessTaxId: strOpt(cust.businessTaxId ?? cust.taxId ?? cust.customerInvoice ?? cust.invoice),
      standingRemark: strOpt(cust.standingRemark),
    },
    deliveryAddress: {
      label: addr.label != null ? String(addr.label) : undefined,
      addressLine: addr.addressLine != null ? String(addr.addressLine) : "",
      /** 優先客戶手機（送貨點電話欄位語意） */
      contactPhone:
        cust.mobile != null
          ? String(cust.mobile)
          : addr.contactPhone != null
            ? String(addr.contactPhone)
            : undefined,
    },
    lines,
  };
}
