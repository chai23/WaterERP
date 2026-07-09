import { buildOrderSlipHtml } from "./buildOrderSlipDocument";
import { loadOrderPrintLayout } from "./loadSaveLayout";
import type { OrderPrintLayoutV1, OrderSlipSource } from "./layoutTypes";

/**
 * 開新視窗寫入套印 HTML 並呼叫列印。
 * @returns 是否成功開啟視窗（false 表示可能被瀏覽器擋彈出）
 */
export function openOrderPrintWindow(order: OrderSlipSource, layout?: OrderPrintLayoutV1): boolean {
  const L = layout ?? loadOrderPrintLayout();
  const html = buildOrderSlipHtml(order, L);
  const w = window.open("", "_blank", "width=960,height=720");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  return true;
}
