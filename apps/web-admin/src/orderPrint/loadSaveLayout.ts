import { DEFAULT_ORDER_PRINT_LAYOUT } from "./defaultLayout";
import type { OrderPrintLayoutV1 } from "./layoutTypes";
import { coercePrintVisibility } from "./printVisibility";

export const ORDER_PRINT_STORAGE_KEY = "watererp_order_print_layout_v1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function coerceLayout(raw: unknown): OrderPrintLayoutV1 {
  const base = DEFAULT_ORDER_PRINT_LAYOUT;
  if (!isRecord(raw) || raw.version !== 1) return { ...base };

  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() !== "" ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

  const fp = (src: unknown, def: OrderPrintLayoutV1["fields"]["orderNo"]) => {
    if (!isRecord(src)) return { ...def };
    return {
      leftMm: num(src.leftMm, def.leftMm),
      topMm: num(src.topMm, def.topMm),
      fontSizePt: src.fontSizePt != null ? num(src.fontSizePt, def.fontSizePt ?? base.baseFontPt) : def.fontSizePt,
      maxWidthMm: src.maxWidthMm != null ? num(src.maxWidthMm, def.maxWidthMm ?? 100) : def.maxWidthMm,
    };
  };

  const lc = (src: unknown, def: OrderPrintLayoutV1["linesBlock"]["productName"]) => {
    if (!isRecord(src)) return { ...def };
    return {
      leftMm: num(src.leftMm, def.leftMm),
      fontSizePt: src.fontSizePt != null ? num(src.fontSizePt, def.fontSizePt ?? base.baseFontPt) : def.fontSizePt,
      maxWidthMm: src.maxWidthMm != null ? num(src.maxWidthMm, def.maxWidthMm ?? 80) : def.maxWidthMm,
    };
  };

  const f = isRecord(raw.fields) ? raw.fields : {};
  const lb = isRecord(raw.linesBlock) ? raw.linesBlock : {};

  const barNew = isRecord(raw.orderNoBarcode) ? raw.orderNoBarcode : {};
  const barLeg = isRecord(raw.orderNoQr) ? raw.orderNoQr : {};
  const barDef = base.orderNoBarcode;

  const barEnabledLegacy = bool(barNew.enabled ?? barLeg.enabled, barDef.enabled);
  const printVisibility = coercePrintVisibility(raw.printVisibility, barEnabledLegacy);
  const barEnabled = printVisibility.orderNoBarcode;
  const barLeft = num(barNew.leftMm, num(barLeg.leftMm, barDef.leftMm));
  const barTop = num(barNew.topMm, num(barLeg.topMm, barDef.topMm));
  const newW = barNew.widthMm != null ? num(barNew.widthMm, NaN) : NaN;
  const newH = barNew.heightMm != null ? num(barNew.heightMm, NaN) : NaN;
  const legSize = barLeg.sizeMm != null ? num(barLeg.sizeMm, NaN) : NaN;
  let barW: number;
  let barH: number;
  if (Number.isFinite(newW) && newW > 0 && Number.isFinite(newH) && newH > 0) {
    barW = Math.max(12, newW);
    barH = Math.max(6, newH);
  } else if (Number.isFinite(legSize) && legSize > 0) {
    barW = Math.max(12, legSize * 2.35);
    barH = Math.max(6, legSize * 0.42);
  } else {
    barW = Math.max(12, num(barNew.widthMm, barDef.widthMm));
    barH = Math.max(6, num(barNew.heightMm, barDef.heightMm));
  }

  return {
    version: 1,
    pageWidthMm: num(raw.pageWidthMm, base.pageWidthMm),
    pageHeightMm: num(raw.pageHeightMm, base.pageHeightMm),
    fontFamily: str(raw.fontFamily, base.fontFamily),
    baseFontPt: num(raw.baseFontPt, base.baseFontPt),
    autoPrintAfterCreate: bool(raw.autoPrintAfterCreate, base.autoPrintAfterCreate),
    printVisibility,
    orderNoBarcode: {
      enabled: barEnabled,
      leftMm: barLeft,
      topMm: barTop,
      widthMm: barW,
      heightMm: barH,
    },
    fields: {
      orderNo: fp(f.orderNo, base.fields.orderNo),
      customerCode: fp(f.customerCode, base.fields.customerCode),
      customerName: fp(f.customerName, base.fields.customerName),
      customerPhone: fp(f.customerPhone, base.fields.customerPhone),
      businessTaxId: fp(f.businessTaxId, base.fields.businessTaxId),
      addressLabel: fp(f.addressLabel, base.fields.addressLabel),
      addressLine: fp(f.addressLine, base.fields.addressLine),
      addressPhone: fp(f.addressPhone, base.fields.addressPhone),
      scheduledDate: fp(f.scheduledDate, base.fields.scheduledDate),
      remark: fp(f.remark, base.fields.remark),
      productRemark: fp(f.productRemark, base.fields.productRemark),
      totalAmount: fp(f.totalAmount, base.fields.totalAmount),
      taxLine: fp(f.taxLine, base.fields.taxLine),
      billingType: fp(f.billingType, base.fields.billingType),
      announcement: fp(f.announcement, base.fields.announcement),
      driverName: fp(f.driverName, base.fields.driverName),
      remainBalance: fp(f.remainBalance, base.fields.remainBalance),
      bucketCount: fp(f.bucketCount, base.fields.bucketCount),
      lastOrderDate: fp(f.lastOrderDate, base.fields.lastOrderDate),
      lastBottleQty: fp(f.lastBottleQty, base.fields.lastBottleQty),
    },
    linesBlock: {
      startTopMm: num(lb.startTopMm, base.linesBlock.startTopMm),
      rowHeightMm: num(lb.rowHeightMm, base.linesBlock.rowHeightMm),
      maxRows: Math.max(1, Math.floor(num(lb.maxRows, base.linesBlock.maxRows))),
      productId: lc(lb.productId, base.linesBlock.productId),
      productName: lc(lb.productName, base.linesBlock.productName),
      qty: lc(lb.qty, base.linesBlock.qty),
      unitPrice: lc(lb.unitPrice, base.linesBlock.unitPrice),
      lineAmount: lc(lb.lineAmount, base.linesBlock.lineAmount),
      footerNotice: (() => {
        const foot = isRecord(lb.footerNotice) ? lb.footerNotice : {};
        const fb = base.linesBlock.footerNotice;
        return {
          startTopMm: num(foot.startTopMm, fb.startTopMm),
          rowHeightMm: num(foot.rowHeightMm, fb.rowHeightMm),
          maxRows: Math.max(1, Math.floor(num(foot.maxRows, fb.maxRows))),
          title: lc(foot.title, fb.title),
          amount: lc(foot.amount, fb.amount),
        };
      })(),
    },
  };
}

export function loadOrderPrintLayout(): OrderPrintLayoutV1 {
  try {
    const raw = localStorage.getItem(ORDER_PRINT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ORDER_PRINT_LAYOUT };
    return coerceLayout(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_ORDER_PRINT_LAYOUT };
  }
}

export function saveOrderPrintLayout(layout: OrderPrintLayoutV1): void {
  localStorage.setItem(ORDER_PRINT_STORAGE_KEY, JSON.stringify(layout));
}
