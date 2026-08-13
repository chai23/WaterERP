import type { PrintVisibilityV1 } from "./printVisibility";

/** 單一文字欄位在紙上的位置（mm，左上角為原點） */
export type FieldPos = {
  leftMm: number;
  topMm: number;
  /** 未指定則用 layout.baseFontPt */
  fontSizePt?: number;
  maxWidthMm?: number;
};

/** 明細列：每列共用 startTop + rowIndex * rowHeight；各欄僅水平 offset */
export type LineColumnPos = {
  leftMm: number;
  fontSizePt?: number;
  maxWidthMm?: number;
};

/** 舊版「未收款月結單」類列：僅品名 + 金額，自獨立 Y 起算（對應 WinForms num1） */
export type FooterNoticeLineBlock = {
  startTopMm: number;
  rowHeightMm: number;
  maxRows: number;
  title: LineColumnPos;
  amount: LineColumnPos;
};

/** 訂單編號一維條碼（Code 128；內容為訂單編號字串，供掃描槍讀取後查單／分派） */
export type OrderNoBarcodeLayout = {
  enabled: boolean;
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
};

export type OrderPrintLayoutV1 = {
  version: 1;
  pageWidthMm: number;
  pageHeightMm: number;
  fontFamily: string;
  baseFontPt: number;
  /** 建立訂單成功後是否自動開啟列印視窗 */
  autoPrintAfterCreate: boolean;
  /** 各欄位／明細是否實際列印（未勾選則略過，座標仍保留供日後啟用） */
  printVisibility: PrintVisibilityV1;
  orderNoBarcode: OrderNoBarcodeLayout;
  fields: {
    orderNo: FieldPos;
    customerCode: FieldPos;
    customerName: FieldPos;
    customerPhone: FieldPos;
    /** 統一編號（舊版 Customer_invoice） */
    businessTaxId: FieldPos;
    addressLabel: FieldPos;
    addressLine: FieldPos;
    addressPhone: FieldPos;
    scheduledDate: FieldPos;
    /** 客戶常態備註（主檔 standingRemark；套印「客戶常態備註」） */
    remark: FieldPos;
    /** 紙上商品／訂單備註（開單備註／sales_orders.remark；舊版 Product_remark） */
    productRemark: FieldPos;
    totalAmount: FieldPos;
    /** 顯示為「稅金：」+ 金額（舊版 Tex） */
    taxLine: FieldPos;
    billingType: FieldPos;
    announcement: FieldPos;
    driverName: FieldPos;
    remainBalance: FieldPos;
    bucketCount: FieldPos;
    lastOrderDate: FieldPos;
    lastBottleQty: FieldPos;
  };
  linesBlock: {
    startTopMm: number;
    rowHeightMm: number;
    maxRows: number;
    /** 品號（舊版 ProductID） */
    productId: LineColumnPos;
    productName: LineColumnPos;
    qty: LineColumnPos;
    unitPrice: LineColumnPos;
    lineAmount: LineColumnPos;
    footerNotice: FooterNoticeLineBlock;
  };
};

/** 建立訂單 API 回傳或查詢訂單等皆可套用的最小欄位 */
export type OrderSlipSource = {
  orderNo: string;
  scheduledDeliveryDate?: string | null;
  /** 開單備註（sales_orders.remark）；套印時對應 productRemark */
  remark?: string | null;
  totalAmount?: string | number;
  /** 稅金（舊版 Tex）；列印為「稅金：」+ 格式化金額 */
  taxAmount?: string | number | null;
  billingTypeAtOrder?: string | null;
  cashInvoiceMode?: string | null;
  customer?: {
    customerCode?: string | null;
    name?: string | null;
    phone?: string | null;
    /** 客戶手機；紙上「送貨點電話」用此欄 */
    mobile?: string | null;
    billingType?: string | null;
    /** 統一編號（舊版 Customer_invoice） */
    businessTaxId?: string | null;
    /** 客戶主檔常態備註；套印「客戶常態備註」 */
    standingRemark?: string | null;
  } | null;
  deliveryAddress?: {
    label?: string | null;
    addressLine?: string;
    /** 實際套印時由 enrichment 覆寫為客戶手機 */
    contactPhone?: string | null;
  } | null;
  /** 紙上商品／訂單備註；缺省時可由 remark 帶入 */
  productRemark?: string | null;
  announcement?: string | null;
  driverName?: string | null;
  remainBalance?: string | null;
  bucketCount?: string | null;
  lastOrderDate?: string | null;
  lastBottleQty?: string | null;
  lines?: Array<{
    /** 品號；舊版「000」且品名含「未收款月結單」時改印於下方獨立區 */
    productCode?: string | null;
    qtyOrdered: number;
    unitPrice?: string | number;
    lineAmount?: string | number;
    linePurpose?: string | null;
    billingTypeAtLine?: string | null;
    isPromotionGift?: boolean;
    isReplenishment?: boolean;
    promotionNote?: string | null;
    product?: { name?: string | null; unit?: string | null };
  }>;
};
