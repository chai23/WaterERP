import type { OrderSlipSource } from "./layoutTypes";
import { slipFromDashboardOrder } from "./slipFromApiOrder";

function todayLocalYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 依配送日（或今日）取得合併後的套印公告文字 */
export async function fetchResolvedOrderAnnouncement(dateYmd?: string | null): Promise<string | null> {
  const ymd = (dateYmd ?? "").trim().slice(0, 10) || todayLocalYmd();
  try {
    const res = await fetch(`/api/order-announcements/resolved?date=${encodeURIComponent(ymd)}`);
    const data = await res.json();
    if (!res.ok || !data?.ok) return null;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

export async function slipWithOrderAnnouncement(slip: OrderSlipSource): Promise<OrderSlipSource> {
  const date = slip.scheduledDeliveryDate?.slice(0, 10) ?? todayLocalYmd();
  const text = await fetchResolvedOrderAnnouncement(date);
  if (!text) return slip;
  return { ...slip, announcement: text };
}

export async function slipFromDashboardOrderWithAnnouncement(row: Record<string, unknown>): Promise<OrderSlipSource> {
  return slipWithOrderAnnouncement(slipFromDashboardOrder(row));
}
