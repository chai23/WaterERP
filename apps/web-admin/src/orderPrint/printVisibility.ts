import type { OrderPrintLayoutV1 } from "./layoutTypes";

export type OrderPrintFieldKey = keyof OrderPrintLayoutV1["fields"];

export type OrderPrintLineColKey = "productId" | "productName" | "qty" | "unitPrice" | "lineAmount";

export type PrintVisibilityV1 = {
  fields: Record<OrderPrintFieldKey, boolean>;
  orderNoBarcode: boolean;
  lineColumns: Record<OrderPrintLineColKey, boolean>;
  /** 一般商品明細列 */
  normalLines: boolean;
  /** 「未收款月結單」類列 */
  footerNotice: boolean;
};

/** 與設定頁「欄位座標」表相同順序 */
export const ORDER_PRINT_FIELD_KEYS: OrderPrintFieldKey[] = [
  "customerCode",
  "customerName",
  "addressLine",
  "remark",
  "businessTaxId",
  "customerPhone",
  "orderNo",
  "scheduledDate",
  "lastBottleQty",
  "addressLabel",
  "addressPhone",
  "productRemark",
  "taxLine",
  "totalAmount",
  "billingType",
  "announcement",
  "driverName",
  "remainBalance",
  "bucketCount",
  "lastOrderDate",
];

export const ORDER_PRINT_LINE_COL_KEYS: OrderPrintLineColKey[] = [
  "productId",
  "productName",
  "qty",
  "unitPrice",
  "lineAmount",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function defaultPrintVisibility(): PrintVisibilityV1 {
  const fields = {} as Record<OrderPrintFieldKey, boolean>;
  for (const k of ORDER_PRINT_FIELD_KEYS) fields[k] = true;
  return {
    fields,
    orderNoBarcode: true,
    lineColumns: {
      productId: true,
      productName: true,
      qty: true,
      unitPrice: true,
      lineAmount: true,
    },
    normalLines: true,
    footerNotice: true,
  };
}

export function coercePrintVisibility(raw: unknown, legacyBarcodeEnabled?: boolean): PrintVisibilityV1 {
  const def = defaultPrintVisibility();
  if (!isRecord(raw)) {
    if (typeof legacyBarcodeEnabled === "boolean") {
      return { ...def, orderNoBarcode: legacyBarcodeEnabled };
    }
    return { ...def };
  }

  const rf = isRecord(raw.fields) ? raw.fields : {};
  const fields = { ...def.fields };
  for (const k of ORDER_PRINT_FIELD_KEYS) {
    if (typeof rf[k] === "boolean") fields[k] = rf[k];
  }

  const rlc = isRecord(raw.lineColumns) ? raw.lineColumns : {};
  const lineColumns = { ...def.lineColumns };
  for (const k of ORDER_PRINT_LINE_COL_KEYS) {
    if (typeof rlc[k] === "boolean") lineColumns[k] = rlc[k];
  }

  return {
    fields,
    orderNoBarcode:
      typeof raw.orderNoBarcode === "boolean"
        ? raw.orderNoBarcode
        : typeof legacyBarcodeEnabled === "boolean"
          ? legacyBarcodeEnabled
          : def.orderNoBarcode,
    lineColumns,
    normalLines: typeof raw.normalLines === "boolean" ? raw.normalLines : def.normalLines,
    footerNotice: typeof raw.footerNotice === "boolean" ? raw.footerNotice : def.footerNotice,
  };
}

export function isFieldPrintEnabled(layout: OrderPrintLayoutV1, key: OrderPrintFieldKey): boolean {
  return layout.printVisibility.fields[key] !== false;
}

export function isLineColPrintEnabled(layout: OrderPrintLayoutV1, key: OrderPrintLineColKey): boolean {
  return layout.printVisibility.lineColumns[key] !== false;
}
