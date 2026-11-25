import type { Request } from "express";

export function isProductionRuntime(): boolean {
  return (process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

export function publicErrorMessage(e: unknown): string {
  console.error(e);
  return "伺服器發生錯誤";
}

export const MIN_PASSWORD_LENGTH = 8;

export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `密碼長度至少 ${MIN_PASSWORD_LENGTH} 碼`;
  }
  return null;
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * 取得真實來源 IP。
 * 只有在連線來自本機反向代理（Nginx）時才信任 X-Real-IP（Nginx 一律以 $remote_addr 覆寫）；
 * 不採用 X-Forwarded-For，因為其內容可由客戶端偽造。
 */
export function clientIp(req: Request): string {
  const peer = req.socket?.remoteAddress;
  if (isLoopback(peer)) {
    const realIp = req.headers["x-real-ip"];
    const real = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim();
    if (real) return real;
  }
  return peer || "unknown";
}

type LoginGate = { fails: number; windowStart: number; lockedUntil: number };

const loginGates = new Map<string, LoginGate>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

export function loginThrottleKey(req: Request, employeeCode: string): string {
  return `${clientIp(req)}|${employeeCode.trim().toLowerCase()}`;
}

export function inspectLoginThrottle(key: string): { ok: true } | { ok: false; message: string } {
  const now = Date.now();
  const row = loginGates.get(key);
  if (row && row.lockedUntil > now) {
    const mins = Math.max(1, Math.ceil((row.lockedUntil - now) / 60000));
    return { ok: false, message: `嘗試次數過多，請 ${mins} 分鐘後再試` };
  }
  return { ok: true };
}

export function noteLoginFailure(key: string): void {
  const now = Date.now();
  const prev = loginGates.get(key);
  const windowStart = prev && now - prev.windowStart < LOGIN_WINDOW_MS ? prev.windowStart : now;
  const fails = (prev && windowStart === prev.windowStart ? prev.fails : 0) + 1;
  const lockedUntil = fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0;
  loginGates.set(key, { fails, windowStart, lockedUntil });
}

export function noteLoginSuccess(key: string): void {
  loginGates.delete(key);
}

export function assertJwtSecret(secret: string): void {
  const configured = process.env.JWT_SECRET?.trim() ?? "";
  const weak = !configured || configured === "change-me" || configured.length < 16;
  if (!weak) return;
  const message = "JWT_SECRET 未設定或過弱，請改成至少 16 字元的隨機字串";
  if (isProductionRuntime()) {
    throw new Error(message);
  }
  console.warn(`[security] ${message}`);
}

export function allowLiffDevBypass(): boolean {
  if (isProductionRuntime()) return false;
  const v = process.env.LIFF_DEV_BYPASS?.trim();
  return v === "1" || v === "true";
}

type RateBucket = { count: number; windowStart: number };
const rateBuckets = new Map<string, RateBucket>();

/** 簡易固定視窗限流（單機記憶體）。回傳 false 表示已超過上限。 */
export function hitRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const prev = rateBuckets.get(key);
  if (!prev || now - prev.windowStart >= windowMs) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  prev.count += 1;
  return prev.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now - v.windowStart > 60 * 60 * 1000) rateBuckets.delete(k);
  for (const [k, v] of loginGates) if (v.lockedUntil < now && now - v.windowStart > LOGIN_WINDOW_MS) loginGates.delete(k);
}, 10 * 60 * 1000).unref();
