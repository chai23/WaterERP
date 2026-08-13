import { DEFAULT_ORDER_PRINT_LAYOUT } from "./defaultLayout";
import type { FieldPos, LineColumnPos, OrderPrintLayoutV1 } from "./layoutTypes";
import { coercePrintVisibility } from "./printVisibility";

export const ORDER_PRINT_STORAGE_KEY = "watererp_order_print_layout_v1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown, d: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : d;
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

/** 選填數值：缺省／空字串／非數字 → undefined（列印時改用預設字級等） */
function optionalFinite(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function cloneField(def: FieldPos): FieldPos {
  const out: FieldPos = { leftMm: def.leftMm, topMm: def.topMm };
  if (def.fontSizePt != null && def.fontSizePt > 0) out.fontSizePt = def.fontSizePt;
  if (def.maxWidthMm != null && def.maxWidthMm > 0) out.maxWidthMm = def.maxWidthMm;
  return out;
}

function cloneLineCol(def: LineColumnPos): LineColumnPos {
  const out: LineColumnPos = { leftMm: def.leftMm };
  if (def.fontSizePt != null && def.fontSizePt > 0) out.fontSizePt = def.fontSizePt;
  if (def.maxWidthMm != null && def.maxWidthMm > 0) out.maxWidthMm = def.maxWidthMm;
  return out;
}

/**
 * 已存在的欄位物件：只在 JSON 明確寫入 fontSizePt／maxWidthMm 時才保留。
 * 缺 key＝使用者清空選填，不可回填預設版面的 fontSizePt。
 * 整個欄位缺失時才用 def（含其選填預設）。
 */
function coerceFieldPos(src: unknown, def: FieldPos): FieldPos {
  if (!isRecord(src)) return cloneField(def);

  const out: FieldPos = {
    leftMm: num(src.leftMm, def.leftMm),
    topMm: num(src.topMm, def.topMm),
  };

  if ("fontSizePt" in src) {
    const fs = optionalFinite(src.fontSizePt);
    if (fs != null && fs > 0) out.fontSizePt = fs;
  }

  if ("maxWidthMm" in src) {
    const mw = optionalFinite(src.maxWidthMm);
    if (mw != null && mw > 0) out.maxWidthMm = mw;
  }

  return out;
}

function coerceLineCol(src: unknown, def: LineColumnPos): LineColumnPos {
  if (!isRecord(src)) return cloneLineCol(def);

  const out: LineColumnPos = {
    leftMm: num(src.leftMm, def.leftMm),
  };

  if ("fontSizePt" in src) {
    const fs = optionalFinite(src.fontSizePt);
    if (fs != null && fs > 0) out.fontSizePt = fs;
  }

  if ("maxWidthMm" in src) {
    const mw = optionalFinite(src.maxWidthMm);
    if (mw != null && mw > 0) out.maxWidthMm = mw;
  }

  return out;
}

function coerceLayout(raw: unknown): OrderPrintLayoutV1 {
  const base = DEFAULT_ORDER_PRINT_LAYOUT;
  if (!isRecord(raw) || raw.version !== 1) return sanitizeOrderPrintLayout({ ...base });

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

  return sanitizeOrderPrintLayout({
    version: 1,
    pageWidthMm: Math.max(20, num(raw.pageWidthMm, base.pageWidthMm)),
    pageHeightMm: Math.max(20, num(raw.pageHeightMm, base.pageHeightMm)),
    fontFamily: str(raw.fontFamily, base.fontFamily),
    baseFontPt: Math.max(5, num(raw.baseFontPt, base.baseFontPt)),
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
      orderNo: coerceFieldPos(f.orderNo, base.fields.orderNo),
      customerCode: coerceFieldPos(f.customerCode, base.fields.customerCode),
      customerName: coerceFieldPos(f.customerName, base.fields.customerName),
      customerPhone: coerceFieldPos(f.customerPhone, base.fields.customerPhone),
      businessTaxId: coerceFieldPos(f.businessTaxId, base.fields.businessTaxId),
      addressLabel: coerceFieldPos(f.addressLabel, base.fields.addressLabel),
      addressLine: coerceFieldPos(f.addressLine, base.fields.addressLine),
      addressPhone: coerceFieldPos(f.addressPhone, base.fields.addressPhone),
      scheduledDate: coerceFieldPos(f.scheduledDate, base.fields.scheduledDate),
      remark: coerceFieldPos(f.remark, base.fields.remark),
      productRemark: coerceFieldPos(f.productRemark, base.fields.productRemark),
      totalAmount: coerceFieldPos(f.totalAmount, base.fields.totalAmount),
      taxLine: coerceFieldPos(f.taxLine, base.fields.taxLine),
      billingType: coerceFieldPos(f.billingType, base.fields.billingType),
      announcement: coerceFieldPos(f.announcement, base.fields.announcement),
      driverName: coerceFieldPos(f.driverName, base.fields.driverName),
      remainBalance: coerceFieldPos(f.remainBalance, base.fields.remainBalance),
      bucketCount: coerceFieldPos(f.bucketCount, base.fields.bucketCount),
      lastOrderDate: coerceFieldPos(f.lastOrderDate, base.fields.lastOrderDate),
      lastBottleQty: coerceFieldPos(f.lastBottleQty, base.fields.lastBottleQty),
    },
    linesBlock: {
      startTopMm: num(lb.startTopMm, base.linesBlock.startTopMm),
      rowHeightMm: Math.max(0.5, num(lb.rowHeightMm, base.linesBlock.rowHeightMm)),
      maxRows: Math.max(1, Math.floor(num(lb.maxRows, base.linesBlock.maxRows))),
      productId: coerceLineCol(lb.productId, base.linesBlock.productId),
      productName: coerceLineCol(lb.productName, base.linesBlock.productName),
      qty: coerceLineCol(lb.qty, base.linesBlock.qty),
      unitPrice: coerceLineCol(lb.unitPrice, base.linesBlock.unitPrice),
      lineAmount: coerceLineCol(lb.lineAmount, base.linesBlock.lineAmount),
      footerNotice: (() => {
        const foot = isRecord(lb.footerNotice) ? lb.footerNotice : {};
        const fb = base.linesBlock.footerNotice;
        return {
          startTopMm: num(foot.startTopMm, fb.startTopMm),
          rowHeightMm: Math.max(0.5, num(foot.rowHeightMm, fb.rowHeightMm)),
          maxRows: Math.max(1, Math.floor(num(foot.maxRows, fb.maxRows))),
          title: coerceLineCol(foot.title, fb.title),
          amount: coerceLineCol(foot.amount, fb.amount),
        };
      })(),
    },
  });
}

/** 去掉 undefined 選填欄，避免 JSON 往返後被預設值回填 */
export function sanitizeOrderPrintLayout(layout: OrderPrintLayoutV1): OrderPrintLayoutV1 {
  const cleanField = (f: FieldPos): FieldPos => {
    const out: FieldPos = {
      leftMm: Number.isFinite(f.leftMm) ? f.leftMm : 0,
      topMm: Number.isFinite(f.topMm) ? f.topMm : 0,
    };
    if (f.fontSizePt != null && Number.isFinite(f.fontSizePt) && f.fontSizePt > 0) {
      out.fontSizePt = f.fontSizePt;
    }
    if (f.maxWidthMm != null && Number.isFinite(f.maxWidthMm) && f.maxWidthMm > 0) {
      out.maxWidthMm = f.maxWidthMm;
    }
    return out;
  };

  const cleanCol = (c: LineColumnPos): LineColumnPos => {
    const out: LineColumnPos = {
      leftMm: Number.isFinite(c.leftMm) ? c.leftMm : 0,
    };
    if (c.fontSizePt != null && Number.isFinite(c.fontSizePt) && c.fontSizePt > 0) {
      out.fontSizePt = c.fontSizePt;
    }
    if (c.maxWidthMm != null && Number.isFinite(c.maxWidthMm) && c.maxWidthMm > 0) {
      out.maxWidthMm = c.maxWidthMm;
    }
    return out;
  };

  const fields = { ...layout.fields };
  for (const key of Object.keys(fields) as (keyof OrderPrintLayoutV1["fields"])[]) {
    fields[key] = cleanField(fields[key]);
  }

  return {
    ...layout,
    pageWidthMm: Math.max(
      20,
      Number.isFinite(layout.pageWidthMm) ? layout.pageWidthMm : DEFAULT_ORDER_PRINT_LAYOUT.pageWidthMm,
    ),
    pageHeightMm: Math.max(
      20,
      Number.isFinite(layout.pageHeightMm) ? layout.pageHeightMm : DEFAULT_ORDER_PRINT_LAYOUT.pageHeightMm,
    ),
    baseFontPt: Math.max(
      5,
      Number.isFinite(layout.baseFontPt) ? layout.baseFontPt : DEFAULT_ORDER_PRINT_LAYOUT.baseFontPt,
    ),
    fontFamily: layout.fontFamily?.trim() || DEFAULT_ORDER_PRINT_LAYOUT.fontFamily,
    fields,
    linesBlock: {
      ...layout.linesBlock,
      startTopMm: Number.isFinite(layout.linesBlock.startTopMm) ? layout.linesBlock.startTopMm : 0,
      rowHeightMm: Math.max(0.5, Number.isFinite(layout.linesBlock.rowHeightMm) ? layout.linesBlock.rowHeightMm : 5),
      maxRows: Math.max(1, Math.floor(Number.isFinite(layout.linesBlock.maxRows) ? layout.linesBlock.maxRows : 1)),
      productId: cleanCol(layout.linesBlock.productId),
      productName: cleanCol(layout.linesBlock.productName),
      qty: cleanCol(layout.linesBlock.qty),
      unitPrice: cleanCol(layout.linesBlock.unitPrice),
      lineAmount: cleanCol(layout.linesBlock.lineAmount),
      footerNotice: {
        ...layout.linesBlock.footerNotice,
        startTopMm: Number.isFinite(layout.linesBlock.footerNotice.startTopMm)
          ? layout.linesBlock.footerNotice.startTopMm
          : 0,
        rowHeightMm: Math.max(
          0.5,
          Number.isFinite(layout.linesBlock.footerNotice.rowHeightMm) ? layout.linesBlock.footerNotice.rowHeightMm : 5,
        ),
        maxRows: Math.max(
          1,
          Math.floor(
            Number.isFinite(layout.linesBlock.footerNotice.maxRows) ? layout.linesBlock.footerNotice.maxRows : 1,
          ),
        ),
        title: cleanCol(layout.linesBlock.footerNotice.title),
        amount: cleanCol(layout.linesBlock.footerNotice.amount),
      },
    },
    orderNoBarcode: {
      ...layout.orderNoBarcode,
      leftMm: Number.isFinite(layout.orderNoBarcode.leftMm) ? layout.orderNoBarcode.leftMm : 0,
      topMm: Number.isFinite(layout.orderNoBarcode.topMm) ? layout.orderNoBarcode.topMm : 0,
      widthMm: Math.max(12, Number.isFinite(layout.orderNoBarcode.widthMm) ? layout.orderNoBarcode.widthMm : 12),
      heightMm: Math.max(6, Number.isFinite(layout.orderNoBarcode.heightMm) ? layout.orderNoBarcode.heightMm : 6),
    },
  };
}

export function loadOrderPrintLayout(): OrderPrintLayoutV1 {
  try {
    const raw = localStorage.getItem(ORDER_PRINT_STORAGE_KEY);
    if (!raw) return sanitizeOrderPrintLayout({ ...DEFAULT_ORDER_PRINT_LAYOUT });
    return coerceLayout(JSON.parse(raw) as unknown);
  } catch {
    return sanitizeOrderPrintLayout({ ...DEFAULT_ORDER_PRINT_LAYOUT });
  }
}

export function saveOrderPrintLayout(layout: OrderPrintLayoutV1): void {
  const clean = sanitizeOrderPrintLayout(layout);
  localStorage.setItem(ORDER_PRINT_STORAGE_KEY, JSON.stringify(clean));
}
