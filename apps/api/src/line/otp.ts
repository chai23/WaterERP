import { createHmac, createHash, randomInt, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";

const BIND_TTL_MS = 10 * 60 * 1000;

export function normalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("09")) return digits;
  if (digits.length === 11 && digits.startsWith("8869")) return `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith("9")) return `0${digits}`;
  return null;
}

export function normalizeCustomerCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 6) return null;
  return digits.padStart(6, "0");
}

function hashBindCode(code: string, customerId: bigint): string {
  return createHash("sha256")
    .update(`${code}:${customerId.toString()}:${process.env.JWT_SECRET ?? "change-me"}`)
    .digest("hex");
}

export async function issueLineBindCode(
  prisma: PrismaClient,
  args: { customerId: bigint; createdByUserId: bigint },
): Promise<{ code: string; expiresAt: Date }> {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + BIND_TTL_MS);
  await prisma.lineBindChallenge.updateMany({
    where: { customerId: args.customerId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.lineBindChallenge.create({
    data: {
      customerId: args.customerId,
      codeHash: hashBindCode(code, args.customerId),
      createdByUserId: args.createdByUserId,
      expiresAt,
    },
  });
  return { code, expiresAt };
}

export async function verifyLineBindCode(
  prisma: PrismaClient,
  args: { customerId: bigint; code: string },
): Promise<{ ok: true; challengeId: bigint } | { ok: false; message: string }> {
  const code = String(args.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, message: "綁定碼須為 6 位數字" };

  const row = await prisma.lineBindChallenge.findFirst({
    where: {
      customerId: args.customerId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { id: "desc" },
  });
  if (!row) return { ok: false, message: "綁定碼無效或已過期，請聯繫客服重新核發" };

  const expected = Buffer.from(row.codeHash, "utf8");
  const actual = Buffer.from(hashBindCode(code, args.customerId), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const exhausted = await recordBindFailure(prisma, row.id);
    return {
      ok: false,
      message: exhausted ? "錯誤次數過多，此綁定碼已作廢，請聯繫客服重新核發" : "客戶編號或綁定碼錯誤",
    };
  }
  bindFailures.delete(row.id.toString());
  return { ok: true, challengeId: row.id };
}

const MAX_BIND_FAILURES = 5;
const bindFailures = new Map<string, number>();

/** 記錄綁定碼錯誤次數；達上限即作廢該綁定碼。回傳是否已作廢。 */
async function recordBindFailure(prisma: PrismaClient, challengeId: bigint): Promise<boolean> {
  const key = challengeId.toString();
  const n = (bindFailures.get(key) ?? 0) + 1;
  bindFailures.set(key, n);
  if (n < MAX_BIND_FAILURES) return false;
  bindFailures.delete(key);
  await prisma.lineBindChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return true;
}

/** 客戶編號不符時也計入該客戶目前綁定碼的錯誤次數，避免逐一猜測客戶編號 */
export async function noteBindMismatch(prisma: PrismaClient, customerId: bigint): Promise<void> {
  const row = await prisma.lineBindChallenge.findFirst({
    where: { customerId, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (row) await recordBindFailure(prisma, row.id);
}

export async function consumeLineBindCode(prisma: PrismaClient, challengeId: bigint): Promise<void> {
  await prisma.lineBindChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

export function verifyLineWebhookSignature(bodyRaw: Buffer | string, signature: string | undefined): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";
  if (!secret || !signature) return false;
  const digest = createHmac("sha256", secret).update(bodyRaw).digest("base64");
  try {
    const a = Buffer.from(digest);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
