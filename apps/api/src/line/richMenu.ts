/**
 * Rich Menu 設定輔助（需已設定 LINE_CHANNEL_ACCESS_TOKEN）。
 *
 * 建議在 LINE Official Account Manager 建立圖文選單：
 * - 訂水 → LIFF URL（https://你的網域/liff/）
 * - 我的訂單 → 同一 LIFF（客戶開啟後點訂單分頁）
 * - 客服 → 切換至聊天
 *
 * 或以 Messaging API 建立：
 * POST https://api.line.me/v2/bot/richmenu
 * 再上傳圖片與連結 default rich menu。
 *
 * Webhook 已於加好友時回覆 WELCOME_MESSAGE；完整 Rich Menu 圖檔
 * 請於官方後台設定並指向 LIFF Endpoint。
 */
export const RICH_MENU_HINT = {
  areas: [
    { label: "訂水", action: "uri", uriEnv: "PUBLIC_LIFF_URL" },
    { label: "我的訂單", action: "uri", uriEnv: "PUBLIC_LIFF_URL" },
    { label: "客服", action: "message", text: "我想聯絡客服" },
  ],
} as const;
