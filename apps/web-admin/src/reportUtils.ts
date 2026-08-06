import { paymentMethodLabel } from "./expenseUtils";
import { moneyText, settlementOutcomeLabel } from "./adminUtils";

export type ReportPeriodRange = "today" | "day" | "month" | "custom";

export type ReportPeriodSummary = {
  periodRevenue: number;
  periodCollected: number;
  periodCollectedCash: number;
  periodCollectedTransfer: number;
  periodCollectedOther: number;
  todayCompletedCount: number;
  periodOrderOutstanding: number;
  periodPendingMonthly?: number;
  periodPendingMonthlyCount?: number;
  periodReceivableTotal?: number;
  revenueCash?: number;
  revenueMonthly?: number;
  revenuePrepaidTopup?: number;
  revenuePrepaidConsume?: number;
  prepaidConsumeBarrels?: number;
  arOpening?: number;
  arPeriodAccrual?: number;
  arPeriodCollected?: number;
  arClosing?: number;
  driverCashCollected: number;
  deliveryRevenue?: number;
  serviceRevenue?: number;
};

export type ReportFilters = {
  customerId: string;
  driverId: string;
  billingType: "" | "cash" | "monthly" | "prepaid";
};

export type ReportDeliveryRow = {
  id: string | number | bigint;
  completedAt?: string | null;
  cashReceived?: string | number | null;
  checkReceived?: string | number | null;
  expectedAmount?: string | number | null;
  settlementOutcome?: string | null;
  salesOrder?: {
    orderNo?: string | null;
    totalAmount?: string | number | null;
    orderBillableAmount?: string | number | null;
    billingTypeAtOrder?: string | null;
    customer?: { name?: string | null } | null;
  } | null;
  driver?: { user?: { name?: string | null; employeeCode?: string | null } | null; employeeCode?: string | null } | null;
  vehicle?: { plateNo?: string | null } | null;
};

export type ReportServiceTicketRow = {
  id: string;
  ticketNo: string;
  closedAt?: string | null;
  billingType?: string | null;
  chargeAmount?: string | null;
  customer?: { name?: string | null; customerCode?: string | null } | null;
  salesOrder?: {
    orderNo?: string | null;
    totalAmount?: string | number | null;
    orderBillableAmount?: string | number | null;
    billingTypeAtOrder?: string | null;
  } | null;
};

export type ReportPaymentRow = {
  id: string | number | bigint;
  paidAt?: string | null;
  amount?: string | number | null;
  paymentMethod?: string | null;
  note?: string | null;
  customer?: { name?: string | null } | null;
  salesOrder?: { orderNo?: string | null } | null;
};

export type ReportPeriodDetail = {
  range: ReportPeriodRange;
  startDate: string;
  endDate: string;
  summary: ReportPeriodSummary;
  deliveries: ReportDeliveryRow[];
  serviceTickets?: ReportServiceTicketRow[];
  payments: ReportPaymentRow[];
};

export function driverDisplayName(driver: ReportDeliveryRow["driver"]): string {
  if (!driver) return "—";
  const name = driver.user?.name?.trim();
  const code = driver.user?.employeeCode ?? driver.employeeCode;
  if (name && code) return `${code} ${name}`;
  return name || code || "—";
}

export function orderBillableDisplay(order: ReportDeliveryRow["salesOrder"]): string {
  return moneyText(order?.orderBillableAmount ?? order?.totalAmount);
}

export function deliverySettlementLabel(row: ReportDeliveryRow): string {
  return settlementOutcomeLabel(row.settlementOutcome, {
    billingTypeAtOrder: row.salesOrder?.billingTypeAtOrder,
    expectedAmount: row.expectedAmount != null ? Number(row.expectedAmount) : null,
    cashReceived: row.cashReceived != null ? Number(row.cashReceived) : 0,
    checkReceived: row.checkReceived != null ? Number(row.checkReceived) : 0,
  });
}

export function appendReportFilterParams(qs: URLSearchParams, filters: ReportFilters): void {
  if (filters.customerId) qs.set("customerId", filters.customerId);
  if (filters.driverId) qs.set("driverId", filters.driverId);
  if (filters.billingType) qs.set("billingType", filters.billingType);
}

export { paymentMethodLabel, moneyText, settlementOutcomeLabel };

export function downloadReportCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const escape = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
