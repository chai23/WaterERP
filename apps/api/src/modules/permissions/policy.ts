import catalog from "./catalog.json" with { type: "json" };
import type { PrismaClient, Prisma } from "@prisma/client";
export { catalog };
export const roles = ["admin", "accounting", "dispatcher", "warehouse", "driver"] as const;
export type Matrix = Record<string, Record<string, boolean>>;
export const defaults = (): Matrix => Object.fromEntries(roles.map(role => [role, Object.fromEntries(catalog.map(m => [m.key, m.roles.includes(role)]))]));
export function validateMatrix(value: unknown): Matrix {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("權限設定格式錯誤");
  const matrix = value as Matrix;
  if (Object.keys(matrix).length !== roles.length) throw new Error("角色清單不完整");
  for (const role of roles) {
    const row = matrix[role];
    if (!row || Object.keys(row).length !== catalog.length) throw new Error("功能清單不完整，請重新載入");
    for (const m of catalog) {
      if (typeof row[m.key] !== "boolean") throw new Error("權限必須為允許或禁止");
      if (role === "admin" && !row[m.key]) throw new Error("管理員權限不可關閉");
      if (role === "driver" && row[m.key]) throw new Error("司機不得使用後台功能");
      if (m.key === "settings.permissions" && role !== "admin" && row[m.key]) throw new Error("僅管理員可管理權限");
    }
  }
  return matrix;
}
type DB = PrismaClient | Prisma.TransactionClient;
export async function readPermissions(db: DB) {
  const rows = await db.$queryRaw<{revision: number; matrix: unknown}[]>`SELECT revision, matrix FROM role_permission_settings WHERE id=1`;
  if (!rows.length) return { revision: 0, matrix: defaults() };
  const raw = typeof rows[0]!.matrix === "string" ? JSON.parse(rows[0]!.matrix) : rows[0]!.matrix;
  return { revision: Number(rows[0]!.revision), matrix: validateMatrix(raw) };
}
export function allowed(matrix: Matrix, role: string, key: string) { return matrix[role]?.[key] === true; }

// Rules are matched against the server path and method, never against client headers.
// Shared read endpoints are dependencies of multiple menus; mutations have narrower rules.
const orders = ["orders.new", "orders.assign", "orders.proxy-report", "orders.complete", "orders.query"];
const reports = ["overview", "reports.daily", "reports.monthly", "reports.driver-daily", "reports.exceptions"];
const barrels = ["orders.barrel-pickup.new", "orders.barrel-pickup.settle", "orders.barrel-pickup.query"];
const services = ["orders.service-tickets.new", "orders.service-tickets"];
const expenses = ["expenses.new", "expenses.query", "expenses.analytics", "expenses.verify"];
const masterReads = ["data.customers", "data.products", "data.drivers", "data.vehicles", "data.legacy-orders", "data.legacy-cutover", "orders.floor-bonus", ...orders, ...reports, ...barrels, ...services, ...expenses, "reports.customer-lifecycle", "reports.billing-ar", "reports.tax-invoices", "settings.customer-masters", "settings.promotions", "settings.ops"];
export function apiPermissions(method: string, path: string, query: Record<string, unknown> = {}): string[] | null {
  const read = method === "GET" || method === "HEAD";
  const p = path.replace(/\/+$/, "");
  if (p === "/api/permissions/me") return null;
  if (p.startsWith("/api/settings/permissions")) return ["settings.permissions"];
  if (p.startsWith("/api/auth/") || p === "/api/health" || p.startsWith("/api/liff/") || p.startsWith("/api/line/")) return null;
  if (p.startsWith("/api/driver/")) return ["orders.proxy-report"]; // driver identities bypass this policy, not ownership checks
  if (p.startsWith("/api/legacy-cutover/")) return ["data.legacy-cutover"];
  if (p === "/api/legacy-history/sync-masters") return ["data.legacy-cutover"];
  if (p.startsWith("/api/legacy-history/") || /\/customers\/[^/]+\/legacy-orders$/.test(p)) return ["data.legacy-orders", "data.customers"];
  if (/\/customers\/[^/]+\/legacy-product-prices$/.test(p)) return ["orders.new", "data.customers", "data.legacy-orders"];
  if (p.startsWith("/api/users")) return ["data.users"];
  if (p.startsWith("/api/admin/") || p === "/api/notification-logs") return ["settings.ops"];
  if (p.startsWith("/api/address-zones") || p.startsWith("/api/affiliated-companies")) return read ? masterReads : ["settings.customer-masters"];
  if (p.startsWith("/api/delivery-addresses/") || p === "/api/ai/parse-delivery-constraints") return ["data.customers", "orders.assign"];
  if (p.startsWith("/api/delivery-planning") || p.startsWith("/api/delivery-plans") || /\/drivers(?:\/[^/]+)?\/attendance$/.test(p)) return ["orders.assign"];
  if (p.startsWith("/api/customers")) {
    if (/\/(prepayment-topup-money|prepaid-topup)$/.test(p)) return ["data.customers", "reports.billing-ar"];
    if (/\/(billing-summary|billing-ledger|payments)$/.test(p)) return ["data.customers", "reports.billing-ar", "orders.new", "orders.query"];
    return read ? masterReads : ["data.customers"];
  }
  if (p.startsWith("/api/customer-churn-reasons")) return ["data.customers", "reports.customer-lifecycle"];
  if (p.startsWith("/api/products")) return read ? masterReads : ["data.products"];
  if (p.startsWith("/api/vehicles")) return read ? masterReads : ["data.vehicles"];
  if (p.startsWith("/api/drivers")) return read && !query.includeInactive ? masterReads : ["data.drivers", "orders.floor-bonus"];
  if (p.startsWith("/api/print-slogans")) return read ? ["settings.print-slogans", ...orders] : ["settings.print-slogans"];
  if (p.startsWith("/api/order-announcements")) return read ? ["settings.order-announcements", ...orders] : ["settings.order-announcements"];
  if (p.startsWith("/api/promotion-")) return read || p.endsWith("/preview") ? ["settings.promotions", "orders.new"] : ["settings.promotions"];
  if (p.startsWith("/api/sales-orders")) {
    if (p.endsWith("/assignment-queue")) return ["orders.assign"];
    if (/\/(pending-review|patrol-preview|generate-patrol|confirm-review)$/.test(p)) return ["orders.new"];
    if (!read) return p.endsWith("/cancel") ? ["orders.query"] : ["orders.new"];
    return [...orders, ...reports, "reports.billing-ar"];
  }
  if (p.startsWith("/api/delivery-assignments") || p === "/api/orders/batch-assign") return read ? ["orders.assign", "orders.proxy-report", "orders.complete"] : ["orders.assign"];
  if (p.startsWith("/api/settlements") || p === "/api/completed-deliveries") return read ? ["orders.complete", ...reports] : ["orders.complete"];
  if (p.startsWith("/api/floor-delivery-bonuses") || p.startsWith("/api/payroll-settings") || p === "/api/reports/driver-payroll") return ["orders.floor-bonus"];
  if (p.startsWith("/api/billing/") || p.startsWith("/api/ar/")) return ["reports.billing-ar"];
  if (p.startsWith("/api/tax-invoices")) return ["reports.tax-invoices"];
  if (p === "/api/payments") return ["reports.billing-ar", ...reports];
  if (p === "/api/accounting/summary") return ["overview", "reports.daily", "reports.monthly"];
  if (p === "/api/reports/period-detail") return ["reports.daily", "reports.monthly"];
  if (p === "/api/reports/customer-lifecycle") return ["reports.customer-lifecycle"];
  if (/\/reports\/(driver-daily-collection|driver-cash-close)$/.test(p)) return ["reports.driver-daily"];
  if (/\/reports\/(ar-aging|ar-exceptions)$/.test(p)) return ["reports.billing-ar", "reports.exceptions"];
  if (/\/reports\/(exception-center|inventory-exceptions)$/.test(p)) return ["reports.exceptions"];
  if (p.startsWith("/api/barrel-pickups")) return read ? barrels : p.endsWith("/approve") ? ["orders.barrel-pickup.settle"] : method === "POST" && p === "/api/barrel-pickups" ? ["orders.barrel-pickup.new"] : ["orders.barrel-pickup.query"];
  if (p === "/api/barrel-collections" || p === "/api/barrel-movements") return [...barrels, "data.customers"];
  if (p.startsWith("/api/service-tickets")) return read ? services : p === "/api/service-tickets" ? ["orders.service-tickets.new"] : ["orders.service-tickets"];
  if (p.startsWith("/api/expense-categories")) return read ? ["settings.expense-categories", ...expenses] : ["settings.expense-categories"];
  if (p.startsWith("/api/expense-vouchers")) {
    if (p.endsWith("/batch-verify")) return ["expenses.verify"];
    if (/\/(daily-summary|today-summary|reports\/[^/]+)$/.test(p)) return ["expenses.analytics"];
    return read ? expenses : p === "/api/expense-vouchers" ? ["expenses.new"] : ["expenses.query", "expenses.verify"];
  }
  return []; // New back-office APIs must explicitly declare their menu permission.
}
