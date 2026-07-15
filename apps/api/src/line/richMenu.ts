/**
 * LINE 官方帳號圖文選單（Rich Menu）
 *
 * 正式 LIFF：https://liff.line.me/2010707717-Z1PnsVQn
 * 佈署腳本：apps/api/scripts/setup-rich-menu.mjs
 * 圖檔：tools/line-assets/richmenu-2500x1686.jpg（2500×1686）
 *
 * 三欄（左→右）：
 * - 線上訂水 → LIFF?tab=order
 * - 我的訂單 → LIFF?tab=orders
 * - 會員中心 → LIFF?tab=account
 */
export const LIFF_ENTRY_URL = "https://liff.line.me/2010707717-Z1PnsVQn";

export const RICH_MENU_HINT = {
  size: { width: 2500, height: 1686 },
  chatBarText: "選單",
  areas: [
    { label: "線上訂水", action: "uri", uri: `${LIFF_ENTRY_URL}?tab=order` },
    { label: "我的訂單", action: "uri", uri: `${LIFF_ENTRY_URL}?tab=orders` },
    { label: "會員中心", action: "uri", uri: `${LIFF_ENTRY_URL}?tab=account` },
  ],
} as const;
