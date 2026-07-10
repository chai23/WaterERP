import { paymentMethodLabel } from "./expenseUtils";
import { moneyText, settlementOutcomeLabel } from "./adminUtils";

export type ReportPeriodRange = "today" | "month";

export type ReportPeriodSummary = {
  periodRevenue: number;
  periodCollected: number;
  periodCollectedCash: number;
  periodCollectedTransfer: number;
  periodCollectedOther: number;
  todayCompletedCount: number;
  periodOrderOutstanding: number;
  driverCashCollected: number;
};

export type ReportDeliveryRow = {
  id: string | number | bigint;
  completedAt?: string | null;
  cashReceived?: string | number | null;
  settlementOutcome?: string | null;
  salesOrder?: {
    orderNo?: string | null;
    totalAmount?: string | number | null;
    orderBillableAmount?: string | number | null;
    customer?: { name?: string | null } | null;
  } | null;
  driver?: { user?: { name?: string | null; employeeCode?: string | null } | null; employeeCode?: string | null } | null;
  vehicle?: { plateNo?: string | null } | null;
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

export { paymentMethodLabel, moneyText, settlementOutcomeLabel };

export function downloadReportCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const toCell = (value: unknown): string => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(toCell).join(","), ...rows.map((r) => r.map(toCell).join(","))];
  const csv = `\uFEFF${lines.join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
