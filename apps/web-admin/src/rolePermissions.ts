export type AdminRole = "admin" | "accounting" | "dispatcher" | "warehouse" | "driver";

export type PermModule =
  | "overview"
  | "orders"
  | "assign"
  | "barrelPickup"
  | "serviceTickets"
  | "expenses"
  | "expenseVerify"
  | "masters"
  | "drivers"
  | "accounting"
  | "users"
  | "settings"
  | "print";

type StaffRole = Exclude<AdminRole, "driver">;

export const PERM_MODULES: {
  key: PermModule;
  label: string;
  admin: boolean;
  accounting: boolean;
  dispatcher: boolean;
  warehouse: boolean;
}[] = [
  { key: "overview", label: "總覽", admin: true, accounting: true, dispatcher: true, warehouse: true },
  { key: "orders", label: "訂單新增/查詢/修改", admin: true, accounting: true, dispatcher: true, warehouse: false },
  { key: "assign", label: "派車與核銷", admin: true, accounting: true, dispatcher: true, warehouse: false },
  { key: "barrelPickup", label: "收空桶作業", admin: true, accounting: true, dispatcher: true, warehouse: true },
  { key: "serviceTickets", label: "飲水機服務單", admin: true, accounting: true, dispatcher: true, warehouse: false },
  { key: "expenses", label: "公司支出登錄與查詢", admin: true, accounting: true, dispatcher: true, warehouse: true },
  { key: "expenseVerify", label: "支出會計核銷", admin: true, accounting: true, dispatcher: false, warehouse: false },
  { key: "masters", label: "客戶/商品/車輛主檔", admin: true, accounting: true, dispatcher: true, warehouse: true },
  { key: "drivers", label: "司機資料", admin: true, accounting: true, dispatcher: true, warehouse: false },
  { key: "accounting", label: "AR 沖帳與會計報表", admin: true, accounting: true, dispatcher: true, warehouse: false },
  { key: "users", label: "使用者與密碼重設", admin: true, accounting: false, dispatcher: false, warehouse: false },
  { key: "print", label: "列印與公告設定", admin: true, accounting: false, dispatcher: false, warehouse: false },
  { key: "settings", label: "系統設定", admin: true, accounting: false, dispatcher: false, warehouse: false },
];

const PATH_PERMISSION: Record<string, PermModule> = {
  "/overview": "overview",
  "/orders/new": "orders",
  "/orders/patrol": "orders",
  "/orders/liff-review": "orders",
  "/orders/query": "orders",
  "/orders/assign": "assign",
  "/orders/proxy-report": "assign",
  "/orders/complete": "assign",
  "/orders/barrel-pickup/new": "barrelPickup",
  "/orders/barrel-pickup/settle": "barrelPickup",
  "/orders/barrel-pickup/query": "barrelPickup",
  "/orders/service-tickets/new": "serviceTickets",
  "/orders/service-tickets": "serviceTickets",
  "/orders/floor-bonus": "accounting",
  "/data/customers": "masters",
  "/data/legacy-orders": "masters",
  "/data/legacy-cutover": "accounting",
  "/data/products": "masters",
  "/data/vehicles": "masters",
  "/data/drivers": "drivers",
  "/data/users": "users",
  "/reports/daily": "accounting",
  "/reports/monthly": "accounting",
  "/reports/exceptions": "accounting",
  "/reports/customer-lifecycle": "accounting",
  "/reports/driver-daily": "accounting",
  "/reports/billing-ar": "accounting",
  "/reports/tax-invoices": "accounting",
  "/expenses/new": "expenses",
  "/expenses/query": "expenses",
  "/expenses/analytics": "expenses",
  "/expenses/today": "expenses",
  "/expenses/verify": "expenseVerify",
  "/expenses/reports": "expenses",
  "/settings/order-print": "print",
  "/settings/print-slogans": "print",
  "/settings/order-announcements": "print",
  "/settings/promotions": "settings",
  "/settings/customer-masters": "settings",
  "/settings/expense-categories": "settings",
  "/settings/ops": "settings",
  "/settings/permissions": "settings",
};

export function canAccessModule(role: string | undefined, module: PermModule): boolean {
  if (!role || role === "driver") return false;
  const mod = PERM_MODULES.find((m) => m.key === module);
  if (!mod) return false;
  return Boolean(mod[role as StaffRole]);
}

export function canAccessPath(role: string | undefined, path: string): boolean {
  const module = PATH_PERMISSION[path];
  if (!module) return role != null && role !== "driver";
  return canAccessModule(role, module);
}

export function canAccessOverview(role: string | undefined): boolean {
  return canAccessModule(role, "overview");
}
