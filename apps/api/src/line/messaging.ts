import type { PrismaClient } from "@prisma/client";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

export type LinePushResult = { ok: true } | { ok: false; message: string };

export function lineMessagingConfigured(): boolean {
  return Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim());
}

export async function verifyLiffIdToken(idToken: string): Promise<
  | { ok: true; lineUserId: string; name?: string }
  | { ok: false; message: string }
> {
  const token = idToken.trim();
  if (!token) return { ok: false, message: "缺少 LIFF ID Token" };

  const channelId = (process.env.LINE_LOGIN_CHANNEL_ID ?? process.env.LINE_CHANNEL_ID ?? "").trim();
  const devBypass =
    process.env.LIFF_DEV_BYPASS === "1" ||
    process.env.LIFF_DEV_BYPASS === "true" ||
    // 未設定正式 LINE Channel 時，允許本機使用前端的 dev:<lineUserId> token
    (!channelId && token.startsWith("dev:"));

  if (devBypass && token.startsWith("dev:")) {
    const lineUserId = token.slice(4).trim();
    if (!lineUserId) return { ok: false, message: "開發模式 token 格式錯誤（dev:<lineUserId>）" };
    return { ok: true, lineUserId, name: "開發使用者" };
  }

  if (!channelId) {
    if (devBypass) {
      return { ok: true, lineUserId: token.slice(0, 64) || "U_dev_user", name: "開發使用者" };
    }
    return {
      ok: false,
      message:
        "伺服器未設定 LINE_LOGIN_CHANNEL_ID。本機開發請在 apps/api/.env 加上 LIFF_DEV_BYPASS=1，或設定正式 LINE Login Channel ID。",
    };
  }

  try {
    const body = new URLSearchParams({ id_token: token, client_id: channelId });
    const res = await fetch(LINE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { sub?: string; name?: string; error_description?: string; error?: string };
    if (!res.ok || !data.sub) {
      return { ok: false, message: data.error_description || data.error || "LIFF ID Token 驗證失敗" };
    }
    return { ok: true, lineUserId: data.sub, name: data.name };
  } catch (e) {
    return { ok: false, message: `驗證 LIFF Token 失敗：${String(e)}` };
  }
}

/** 對指定 LINE 使用者推播純文字（OTP、訂單通知共用）。 */
export async function pushLineText(lineUserId: string, text: string): Promise<LinePushResult> {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    console.info(`[line-push:skip] to=${lineUserId} text=${text.slice(0, 80)}`);
    return { ok: false, message: "未設定 LINE_CHANNEL_ACCESS_TOKEN，已略過推播" };
  }
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, message: `LINE push 失敗：${res.status} ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

async function pushText(lineUserId: string, text: string): Promise<LinePushResult> {
  return pushLineText(lineUserId, text);
}

export async function replyText(replyToken: string, text: string): Promise<LinePushResult> {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!accessToken) return { ok: false, message: "未設定 LINE_CHANNEL_ACCESS_TOKEN" };
  try {
    const res = await fetch(LINE_REPLY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, message: `LINE reply 失敗：${res.status} ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

export type NotifyEventType =
  | "order_created"
  | "order_confirmed"
  | "order_assigned"
  | "order_delivered"
  | "order_not_delivered"
  | "order_rejected"
  | "welcome";

export async function notifyCustomerViaLine(
  prisma: PrismaClient,
  args: {
    customerId: bigint;
    eventType: NotifyEventType;
    text: string;
    salesOrderId?: bigint | null;
    deliveryAssignmentId?: bigint | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { id: args.customerId },
    select: { id: true, lineUserId: true, name: true },
  });
  if (!customer?.lineUserId) {
    await prisma.notificationLog.create({
      data: {
        customerId: args.customerId,
        channel: "line",
        eventType: args.eventType,
        salesOrderId: args.salesOrderId ?? null,
        deliveryAssignmentId: args.deliveryAssignmentId ?? null,
        payloadJson: { ...(args.payload ?? {}), text: args.text, skipped: "no_line_user_id" },
        status: "skipped",
        errorMessage: "客戶尚未綁定 LINE",
      },
    });
    return;
  }

  const result = await pushText(customer.lineUserId, args.text);
  await prisma.notificationLog.create({
    data: {
      customerId: args.customerId,
      lineUserId: customer.lineUserId,
      channel: "line",
      eventType: args.eventType,
      salesOrderId: args.salesOrderId ?? null,
      deliveryAssignmentId: args.deliveryAssignmentId ?? null,
      payloadJson: { ...(args.payload ?? {}), text: args.text },
      status: result.ok ? "sent" : "failed",
      errorMessage: result.ok ? null : result.message.slice(0, 500),
    },
  });
}

export function formatOrderCreatedMessage(args: {
  orderNo: string;
  totalAmount: string;
  scheduledDeliveryDate?: string | null;
  lineSummary: string;
  awaitingReview?: boolean;
}): string {
  const lines = [
    args.awaitingReview ? "【訂水已送出，待確認】" : "【訂水成功】",
    `訂單編號：${args.orderNo}`,
    `品項：${args.lineSummary}`,
    `金額：$${args.totalAmount}`,
  ];
  if (args.scheduledDeliveryDate) lines.push(`希望配送日：${args.scheduledDeliveryDate}`);
  if (args.awaitingReview) {
    lines.push("辦公室確認後會再通知您；若品項有誤請於官方帳號留言。");
  } else {
    lines.push("我們會盡快為您安排配送，派車後會再通知預計時段。");
  }
  return lines.join("\n");
}

export function formatOrderAssignedMessage(args: {
  orderNo: string;
  assignmentDate: string;
  estimatedSlot?: string | null;
  note?: string | null;
}): string {
  const lines = [
    "【配送安排通知】",
    `訂單編號：${args.orderNo}`,
    `配送日：${args.assignmentDate}`,
  ];
  if (args.estimatedSlot) lines.push(`預計時段：${args.estimatedSlot}`);
  if (args.note) lines.push(`備註：${args.note}`);
  lines.push("當天請保持電話暢通，謝謝。");
  return lines.join("\n");
}

export function formatDeliveredMessage(args: { orderNo: string }): string {
  return ["【配送完成】", `訂單 ${args.orderNo} 已送達。`, "感謝您的訂購，如有問題請於官方帳號留言。"].join("\n");
}

export function formatNotDeliveredMessage(args: { orderNo: string; reason?: string | null }): string {
  const lines = ["【未能送達】", `訂單 ${args.orderNo} 此次未能完成配送。`];
  if (args.reason) lines.push(`原因：${args.reason}`);
  lines.push("我們會與您聯繫改約，或請直接於官方帳號回覆。");
  return lines.join("\n");
}

export const WELCOME_MESSAGE =
  "歡迎加入超好企業官方帳號！\n請點選選單「訂水」即可辦會員並下單；派車後會用訊息通知預計配送時段。";
