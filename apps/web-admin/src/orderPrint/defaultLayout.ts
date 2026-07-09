import type { OrderPrintLayoutV1 } from "./layoutTypes";
import { defaultPrintVisibility } from "./printVisibility";

/**
 * 舊版 WinForms `DrawString(..., x, y)` 之像素座標，依常見 96 DPI 換算為 mm：
 * `mm = px * 25.4 / 96`（與瀏覽器 @page mm 一致，便於套舊紙對位）。
 */
const P = (px: number) => Math.round((px * 25.4) / 96 * 100) / 100;

/** 241mm 寬連續紙；高度依最底列 (y=436) 換算並留邊 */
export const DEFAULT_ORDER_PRINT_LAYOUT: OrderPrintLayoutV1 = {
  version: 1,
  pageWidthMm: 241,
  pageHeightMm: Math.max(120, P(436) + 8),
  fontFamily: "PMingLiU, 新細明體, MingLiU, serif",
  baseFontPt: 10,
  autoPrintAfterCreate: false,
  printVisibility: defaultPrintVisibility(),
  /** 訂單編號 Code 128；預設在單號文字左側、略上移以利掃描 */
  orderNoBarcode: {
    enabled: true,
    leftMm: P(320),
    topMm: P(128),
    widthMm: 48,
    heightMm: 14,
  },
  fields: {
    customerCode: { leftMm: P(110), topMm: P(102), maxWidthMm: 95 },
    customerName: { leftMm: P(110), topMm: P(120), maxWidthMm: 95 },
    addressLine: { leftMm: P(110), topMm: P(138), maxWidthMm: 95 },
    remark: { leftMm: P(110), topMm: P(156), maxWidthMm: 95, fontSizePt: 10 },
    businessTaxId: { leftMm: P(514), topMm: P(120), maxWidthMm: 55 },
    customerPhone: { leftMm: P(514), topMm: P(138), maxWidthMm: 55 },
    orderNo: { leftMm: P(514), topMm: P(156), maxWidthMm: 70, fontSizePt: 10 },
    scheduledDate: { leftMm: P(648), topMm: P(155), maxWidthMm: 45, fontSizePt: 10 },
    lastBottleQty: { leftMm: P(750), topMm: P(80), maxWidthMm: 55, fontSizePt: 10 },
    /** 舊版無獨立欄位；置於左上 y=80 列以利對位 */
    addressLabel: { leftMm: P(40), topMm: P(80), maxWidthMm: 45, fontSizePt: 10 },
    /** 舊版無送貨點電話欄；置於客戶區下方 */
    addressPhone: { leftMm: P(110), topMm: P(174), maxWidthMm: 95, fontSizePt: 10 },
    productRemark: { leftMm: P(40), topMm: P(295), maxWidthMm: 200, fontSizePt: 10 },
    taxLine: { leftMm: P(500), topMm: P(300), maxWidthMm: 80, fontSizePt: 10 },
    totalAmount: { leftMm: P(535), topMm: P(320), maxWidthMm: 55, fontSizePt: 10 },
    announcement: { leftMm: P(615), topMm: P(210), maxWidthMm: 70, fontSizePt: 10 },
    billingType: { leftMm: P(40), topMm: P(65), maxWidthMm: 90, fontSizePt: 9 },
    driverName: { leftMm: P(440), topMm: P(436), maxWidthMm: 50, fontSizePt: 10 },
    remainBalance: { leftMm: P(725), topMm: P(436), maxWidthMm: 45, fontSizePt: 10 },
    bucketCount: { leftMm: P(435), topMm: P(358), maxWidthMm: 40, fontSizePt: 10 },
    lastOrderDate: { leftMm: P(390), topMm: P(358), maxWidthMm: 40, fontSizePt: 10 },
  },
  linesBlock: {
    startTopMm: P(200),
    rowHeightMm: P(17),
    maxRows: 14,
    productId: { leftMm: P(53), maxWidthMm: 14, fontSizePt: 10 },
    productName: { leftMm: P(110), maxWidthMm: 62, fontSizePt: 10 },
    qty: { leftMm: P(365), maxWidthMm: 18, fontSizePt: 10 },
    unitPrice: { leftMm: P(440), maxWidthMm: 22, fontSizePt: 10 },
    lineAmount: { leftMm: P(525), maxWidthMm: 28, fontSizePt: 10 },
    footerNotice: {
      startTopMm: P(358),
      rowHeightMm: P(17),
      maxRows: 8,
      title: { leftMm: P(53), maxWidthMm: 85, fontSizePt: 10 },
      amount: { leftMm: P(230), maxWidthMm: 40, fontSizePt: 10 },
    },
  },
};
