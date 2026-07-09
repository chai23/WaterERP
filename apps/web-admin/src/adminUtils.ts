export type Address = {
  id: string;
  addressLine: string;
  label?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactMobile?: string | null;
  isDefault?: boolean;
  /** 此送貨點未收回空桶數 */
  barrelsOnSite?: number;
};

/** 加總客戶各送貨地址未收回空桶（相容舊 barrelsOnSite 欄位） */
export function sumCustomerBarrelsOnSite(c: { barrelsOnSite?: number; addresses?: Address[] }): number {
  if (c.addresses?.length) {
    return c.addresses.reduce((sum, a) => sum + (a.barrelsOnSite ?? 0), 0);
  }
  return c.barrelsOnSite ?? 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 以本地時區輸出 YYYY-MM-DD；若本身已是 YYYY-MM-DD 字串則原樣回傳。 */
export function fmtLocalYmd(value: unknown): string {
  if (value == null || value === "") return "—";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10) || "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayLocalYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayLocalYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export type BillingTypeCode = "cash" | "monthly" | "prepaid" | "mixed";

export type CustomerMasterOption = {
  id: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
};

export type Customer = {
  id: string;
  customerCode?: string | null;
  name: string;
  contactName?: string | null;
  phone?: string | null;
  mobile?: string | null;
  taxId?: string | null;
  billingType?: string;
  /** none | tax_inclusive | tax_exclusive */
  defaultCashInvoiceMode?: string | null;
  addressZoneId?: string | null;
  affiliatedCompanyId?: string | null;
  addressZone?: { id: string; name: string; isActive?: boolean } | null;
  affiliatedCompany?: { id: string; name: string; isActive?: boolean } | null;
  standingRemark?: string | null;
  /** API 以字串回傳 Decimal */
  creditLimit?: string | number;
  notes?: string | null;
  /** 各送貨地址未收回空桶加總（API 計算；舊客戶主檔欄位已廢止寫入） */
  barrelsOnSite?: number;
  /** 月結：每月幾號為結帳／對帳參考日 */
  monthlySettlementDay?: number | null;
  /** 預付客戶可用桶數 */
  prepaidBarrelBalance?: number;
  allowPrepaidOverdraft?: boolean;
  addresses: Address[];
};

/** GET /api/customers/:id 含訂單明細 */
export type CustomerSalesOrderLine = {
  id: string;
  qtyOrdered: number;
  unitPrice: string;
  lineAmount: string;
  /** 此列結帳方式；null 則沿用訂單／客戶 */
  billingTypeAtLine?: string | null;
  /** delivery | prepaid_barrel_topup */
  linePurpose?: string | null;
  product?: { id: string; name: string; unit?: string | null };
};

export type CustomerSalesOrder = {
  id: string;
  orderNo: string;
  status: string;
  scheduledDeliveryDate?: string | null;
  totalAmount: string;
  remark?: string | null;
  billingTypeAtOrder?: string | null;
  billingPeriodKey?: string | null;
  officeSettledAt?: string | null;
  monthlyReceivedAmount?: string;
  monthlyPeriodPaid?: boolean;
  /** 預付桶儲值：已核銷但現金應收尚未全沖清前之待入帳桶數 */
  pendingPrepaidTopupBarrels?: number;
  orderCashAdjustment?: string | number;
  deliveryAddress?: { id: string; label?: string | null; addressLine: string };
  lines?: CustomerSalesOrderLine[];
  assignments?: Array<{
    driverReportedAt?: string | null;
    assignmentDate?: string | null;
    officeSettledAt?: string | null;
    completedAt?: string | null;
    status?: string;
  }>;
};

export type CustomerDetail = Customer & {
  salesOrders?: CustomerSalesOrder[];
};

export function billingTypeLabel(code: string | null | undefined): string {
  switch (code) {
    case "monthly":
      return "月結";
    case "prepaid":
      return "預付（桶）";
    case "mixed":
      return "混用（依明細）";
    case "cash":
    default:
      return "現金";
  }
}

export type CustomerBillingSummary = {
  billingType: string;
  monthlySettlementDay: number | null;
  prepaidBarrelBalance: number;
  prepaidBarrelByProduct?: Array<{
    productId: string;
    productName: string;
    barrels: number;
  }>;
  allowPrepaidOverdraft: boolean;
  prepaymentMoneyBalance?: string | number;
  arOutstandingAmount?: string | number;
  /** 往來餘額：正＝客戶欠公司；負＝預收／多收 */
  accountBalance: number;
};

/** GET /api/customers/:id/billing-ledger */
export type CustomerLedgerEntryRow = {
  id: string;
  entryType: string;
  amount: string;
  barrelDelta: number;
  salesOrderId: string | null;
  orderNo: string | null;
  paymentId: string | null;
  payment: {
    id: string;
    amount: string;
    paidAt: string;
    paymentMethod: string;
  } | null;
  note: string | null;
  createdAt: string;
  createdBy: { name: string; employeeCode: string | null } | null;
  /** 本筆入帳後之客戶往來餘額（與全帳連續） */
  balanceAfter: number;
};

export type CustomerBillingLedgerData = {
  customerId: string;
  totalCount: number;
  limit: number;
  accountBalance: number;
  entries: CustomerLedgerEntryRow[];
};

/** GET /api/customers/:id/payments */
export type CustomerPaymentRow = {
  id: string;
  amount: string;
  paymentMethod: string;
  paidAt: string;
  note: string | null;
  salesOrderId: string | null;
  orderNo: string | null;
};

export function ledgerEntryTypeLabel(entryType: string): string {
  const map: Record<string, string> = {
    cash_ar_accrual: "現金·應收立帳",
    cash_receipt_alloc: "現金·收款沖銷（FIFO）",
    cash_variance_short: "現金·少收（舊）",
    cash_variance_over: "現金·多收",
    cash_offset_order: "現金·沖銷（舊）",
    monthly_accrual: "月結·應收",
    statement_monthly_ar: "月結·批次立帳（未稅 AR）",
    monthly_payment: "月結·收款（整期一筆，舊）",
    monthly_receipt_alloc: "月結·收款沖銷（FIFO）",
    ar_accrual: "AR·應收立帳",
    ar_receipt_alloc: "AR·收款沖帳",
    prepayment_wallet_txn: "預收錢包異動",
    credit_note_alloc: "折讓沖銷",
    prepaid_topup: "預付·儲值",
    prepaid_consumption: "預付·扣桶",
  };
  return map[entryType] ?? entryType;
}

export type Product = {
  id: string;
  /** 3 碼數字編號（與後端 product_code 對應） */
  productCode?: string | null;
  sku?: string | null;
  name: string;
  unit?: string;
  /** 核銷送達時是否將數量計入客戶未收回空桶（與單位無關） */
  countsDepositBarrel?: boolean;
  /** 預付結帳列出貨時是否扣預付桶餘額 */
  consumesPrepaidBarrel?: boolean;
  salePrice: string;
  costPrice?: string;
  isActive?: boolean;
  inventory?: { qtyOnHand: number } | null;
};

export type Vehicle = {
  id: string;
  plateNo: string;
  description?: string | null;
};

export type Driver = {
  id: string;
  employeeCode?: string | null;
  maxOrderCount?: number;
  maxBarrelQty?: number;
  isActive?: boolean;
  user?: { name: string; employeeCode?: string | null; phone?: string | null; isActive?: boolean } | null;
  vehicle?: { id: string; plateNo: string } | null;
};

export function driverIsActive(d: Driver): boolean {
  return d.isActive ?? d.user?.isActive ?? true;
}

export function driverEmployeeCode(d: Driver): string {
  return d.user?.employeeCode ?? d.employeeCode ?? "";
}

/** 配送任務狀態（delivery_assignments.status） */
export function deliveryAssignmentStatusLabel(code: string | null | undefined): string {
  switch (code) {
    case "pending_settlement":
      return "待辦公室核銷";
    case "assigned":
      return "已分派";
    case "delivering":
      return "配送中";
    case "completed":
      return "已結案（送達）";
    case "not_delivered":
      return "已結案（未送達）";
    case "cancelled":
      return "已取消";
    default:
      return code ?? "—";
  }
}

/** 配送核銷結果（delivery_assignments.settlement_outcome） */
export function settlementOutcomeLabel(code: string | null | undefined): string {
  switch (code) {
    case "not_delivered":
      return "未送達";
    case "delivered_cash_exact":
      return "已送達·足額收款";
    case "delivered_cash_short":
      return "已送達·少收";
    case "delivered_cash_over":
      return "已送達·多收";
    case "delivered_no_cash":
      return "已送達·未收款";
    default:
      return "已送達（舊資料）";
  }
}

export function deliveryAssignmentStatusBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case "pending_settlement":
      return "badge badge--warn";
    case "completed":
      return "badge badge--completed";
    case "not_delivered":
      return "badge badge--cancelled";
    case "assigned":
      return "badge badge--assigned";
    case "delivering":
      return "badge badge--delivering";
    default:
      return "badge badge--default";
  }
}

export function barrelPickupStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "pending_settlement":
      return "待辦公室核銷";
    case "assigned":
      return "已分派";
    case "completed":
      return "已核銷結案";
    case "cancelled":
      return "已取消";
    default:
      return status ?? "—";
  }
}

export function barrelPickupStatusBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case "pending_settlement":
      return "badge badge--warn";
    case "completed":
      return "badge badge--completed";
    case "cancelled":
      return "badge badge--cancelled";
    case "assigned":
      return "badge badge--assigned";
    default:
      return "badge badge--default";
  }
}

export function settlementBadgeClass(code: string | null | undefined): string {
  switch (code) {
    case "not_delivered":
      return "badge badge--cancelled";
    case "delivered_cash_short":
      return "badge badge--warn";
    case "delivered_cash_over":
      return "badge badge--draft";
    case "delivered_cash_exact":
      return "badge badge--completed";
    case "delivered_no_cash":
      return "badge badge--assigned";
    default:
      return "badge badge--completed";
  }
}

export function orderStatusBadgeClass(status: string): string {
  switch (status) {
    case "draft":
      return "badge badge--draft";
    case "confirmed":
      return "badge badge--confirmed";
    case "assigned":
      return "badge badge--assigned";
    case "delivering":
      return "badge badge--delivering";
    case "completed":
      return "badge badge--completed";
    case "not_delivered":
      return "badge badge--cancelled";
    case "cancelled":
      return "badge badge--cancelled";
    default:
      return "badge badge--default";
  }
}

export function healthLedClass(raw: string): string {
  try {
    const h = JSON.parse(raw) as { ok?: boolean; db?: string };
    if (h.ok === true || h.db === "connected") return "status-led status-led--ok";
  } catch {
    /* ignore */
  }
  return "status-led status-led--bad";
}

export function formatHealthStatus(raw: string): string {
  if (raw === "…") return "檢查中…";

  try {
    const h = JSON.parse(raw) as { ok?: boolean; db?: string; message?: string };
    if (h.ok === true && h.db === "connected") {
      return "系統正常 · 資料庫已連線";
    }
    if (h.ok === false || h.db === "error") {
      return h.message ? `連線異常 · 資料庫無法連線（${h.message}）` : "連線異常 · 資料庫無法連線";
    }
    if (h.ok === true) {
      return "系統正常";
    }
    return "連線狀態未知";
  } catch {
    return raw || "無法取得連線狀態";
  }
}
