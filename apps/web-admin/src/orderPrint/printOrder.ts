import { buildOrderSlipHtml } from "./buildOrderSlipDocument";
import { loadOrderPrintLayout } from "./loadSaveLayout";
import { openOrderPrintWindow } from "./openOrderPrintWindow";
import type { OrderSlipSource } from "./layoutTypes";

const stationStorageKey = "watererp_print_station_v1";
const pendingOrders = new Set<string>();
const resultMessages: Record<string, string> = {
  submitted: "已送至指定印表機。",
  failed: "列印助手無法使用指定的印表機，請檢查印表機後補印。",
  expired: "列印工作未被領取，請確認助手已啟用後補印。",
  unknown: "送印結果待確認。請先檢查出紙與 Windows 列印佇列，再決定是否補印。",
};

export function loadPrintStation(): string {
  return localStorage.getItem(stationStorageKey) ?? "";
}

export async function savePrintStation(value: string) {
  const stationKey = value.trim().toLowerCase();
  if (!stationKey) {
    localStorage.removeItem(stationStorageKey);
    return;
  }
  const response = await fetch("/api/order-print/station", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stationKey }),
  });
  if (!response.ok) throw new Error(await responseMessage(response, "無法配對列印助手。"));
  localStorage.setItem(stationStorageKey, stationKey);
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.message === "string" ? body.message : fallback;
}

export async function printOrderSlip(
  order: OrderSlipSource,
  notify: (message: string) => void,
  layout = loadOrderPrintLayout(),
) {
  const stationKey = loadPrintStation();
  if (!stationKey) {
    if (!openOrderPrintWindow(order, layout)) notify("無法開啟列印視窗，請允許瀏覽器彈出視窗。");
    return;
  }
  if (pendingOrders.has(order.orderNo)) return;
  pendingOrders.add(order.orderNo);
  try {
    const response = await fetch("/api/order-print/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stationKey,
        orderNo: order.orderNo,
        pageWidthMm: layout.pageWidthMm,
        pageHeightMm: layout.pageHeightMm,
        html: buildOrderSlipHtml(order, layout),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      notify(await responseMessage(response, resultMessages.unknown));
      return;
    }
    let job = await response.json() as { id: string; status: string };
    if (job.status === "queued") notify("等待列印助手接單…");
    const deadline = Date.now() + 245_000;
    while (!resultMessages[job.status] && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 1500));
      const result = await fetch(`/api/order-print/jobs/${encodeURIComponent(job.id)}`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (result?.ok) {
        const next = await result.json() as typeof job;
        if (next.status === "claimed" && job.status !== "claimed") notify("列印助手處理中…");
        job = next;
      }
      if (result?.status === 401 || result?.status === 403 || result?.status === 404) break;
    }
    notify(resultMessages[job.status] ?? resultMessages.unknown);
  } catch {
    notify(resultMessages.unknown);
  } finally {
    pendingOrders.delete(order.orderNo);
  }
}
