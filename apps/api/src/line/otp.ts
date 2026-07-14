import { createHash, createHmac, randomInt, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";

const OTP_TTL_MS = 10 * 60 * 1000;

export function normalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("09")) return digits;
  if (digits.length === 11 && digits.startsWith("8869")) return `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith("9")) return `0${digits}`;
  return null;
}

function hashOtp(code: string, lineUserId: string): string {
  return createHash("sha256").update(`${code}:${lineUserId}:${process.env.JWT_SECRET ?? "change-me"}`).digest("hex");
}

export async function issueLineOtp(
  prisma: PrismaClient,
  args: { mobile: string; lineUserId: string },
): Promise<{ ok: true; expiresAt: Date; devCode?: string } | { ok: false; message: string }> {
  const mobile = normalizeMobile(args.mobile);
  if (!mobile) return { ok: false, message: "手機號碼格式錯誤（請用 09 開頭）" };
  const lineUserId = args.lineUserId.trim();
  if (!lineUserId) return { ok: false, message: "缺少 LINE 使用者識別" };

  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await prisma.lineOtpChallenge.create({
    data: {
      mobile,
      lineUserId,
      codeHash: hashOtp(code, lineUserId),
      expiresAt,
    },
  });

  const devMode =
    process.env.LINE_OTP_DEV_MODE === "1" ||
    process.env.LINE_OTP_DEV_MODE === "true" ||
    !process.env.LINE_CHANNEL_ACCESS_TOKEN;

  console.info(`[line-otp] mobile=${mobile} lineUserId=${lineUserId} code=${code} (devLog)`);

  return {
    ok: true,
    expiresAt,
    ...(devMode ? { devCode: code } : {}),
  };
}

export async function verifyLineOtp(
  prisma: PrismaClient,
  args: { mobile: string; lineUserId: string; code: string },
): Promise<{ ok: true; mobile: string } | { ok: false; message: string }> {
  const mobile = normalizeMobile(args.mobile);
  if (!mobile) return { ok: false, message: "手機號碼格式錯誤" };
  const lineUserId = args.lineUserId.trim();
  const code = String(args.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, message: "驗證碼須為 6 位數字" };

  const row = await prisma.lineOtpChallenge.findFirst({
    where: {
      mobile,
      lineUserId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { id: "desc" },
  });
  if (!row) return { ok: false, message: "驗證碼無效或已過期，請重新取得" };

  const expected = Buffer.from(row.codeHash, "utf8");
  const actual = Buffer.from(hashOtp(code, lineUserId), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, message: "驗證碼錯誤" };
  }

  await prisma.lineOtpChallenge.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true, mobile };
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
