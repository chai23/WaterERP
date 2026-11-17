import type { Prisma } from "@prisma/client";

/** 固定依台灣建立日期編號，不受主機時區或配送日期影響。 */
export function orderNumberDay(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("無效的開單日期");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now).replaceAll("-", "");
}

export function formatShortOrderNo(day: string, sequence: number): string {
  if (!/^\d{8}$/.test(day) || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("無效的訂單流水號");
  }
  // 三碼起跳；超過 999 後自然延長，不截斷或重用。
  return `${day.slice(2)}-${String(sequence).padStart(3, "0")}`;
}

/** 必須與 salesOrder.create 使用同一交易；MySQL 列鎖保證跨程序同日流水號唯一。 */
export async function allocateShortOrderNo(tx: Prisma.TransactionClient, now = new Date()): Promise<string> {
  const day = orderNumberDay(now);
  await tx.$executeRaw`
    INSERT INTO order_number_sequences (day_key, last_number) VALUES (${day}, 1)
    ON DUPLICATE KEY UPDATE last_number = last_number + 1
  `;
  const row = await tx.orderNumberSequence.findUniqueOrThrow({ where: { dayKey: day } });
  return formatShortOrderNo(day, row.lastValue);
}
