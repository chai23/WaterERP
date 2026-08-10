/** Feature flag：預設關閉，不影響既有人工派單 */
export function isDeliveryPlanningEnabled(): boolean {
  const v = (process.env.DELIVERY_PLANNING_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const GEOCODE_OK_STATUSES = new Set(["ok", "manual_confirmed"]);
