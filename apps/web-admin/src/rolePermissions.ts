import { useSyncExternalStore } from "react";
import catalog from "../../api/src/modules/permissions/catalog.json";
export { catalog as permissionCatalog };
let granted: Set<string> | null = null;
let version = 0;
const listeners = new Set<() => void>();
export function setMenuPermissions(keys: string[] | null) {
  const next = keys === null ? null : new Set(keys);
  if (granted === null && next === null || granted && next && granted.size === next.size && [...granted].every(key => next.has(key))) return;
  granted = next; version++; listeners.forEach(fn => fn());
}
export function usePermissionVersion() { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version); }
export async function refreshMenuPermissions() {
  const res = await fetch("/api/permissions/me");
  if (!res.ok) { setMenuPermissions([]); throw new Error("無法讀取權限設定"); }
  const data = await res.json();
  setMenuPermissions(Array.isArray(data.permissions) ? data.permissions : []);
}
const aliases: Record<string, string> = {
  "/orders/patrol": "/orders/new", "/orders/liff-review": "/orders/new",
  "/orders/assignment-status": "/orders/assign", "/expenses/today": "/expenses/analytics",
  "/expenses/reports": "/expenses/analytics", "/reports/billing-monthly": "/reports/billing-ar",
  "/data/legacy-cutover/methods": "/data/legacy-cutover",
};
export function canAccessPath(role: string | undefined, path: string): boolean {
  if (!role || role === "driver") return false;
  const pathname = path.split("?")[0].replace(/\/$/, "");
  const resolved = pathname.startsWith("/expenses/edit/") ? "/expenses/query" : aliases[pathname] ?? pathname;
  const entry = catalog.find(m => m.path === resolved);
  if (!entry) return false;
  return role === "admin" || Boolean(granted?.has(entry.key));
}
export function canAccessOverview(role: string | undefined): boolean { return canAccessPath(role, "/overview"); }
