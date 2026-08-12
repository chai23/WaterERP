import type { Express, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { describeDbUrl, getLegacyPrisma, resolveLegacyDatabaseUrl } from "./client.js";
import {
  applyCutoverOpeningAr,
  buildCutoverPreview,
  syncLegacyBarrelBalances,
  type CutoverBillingType,
} from "./cutover.js";
import { getLegacyOrderDetail, listLegacyOrdersForCustomer } from "./queries.js";

type AuthUser = {
  id: bigint;
  employeeCode: string;
  name: string;
  role: string;
  driverId: bigint | null;
};

type RegisterArgs = {
  app: Express;
  prisma: PrismaClient;
  getAuthUser: (req: Request) => AuthUser | null;
  requireRole: (req: Request, res: Response, roles: readonly string[]) => AuthUser | null;
  toBigInt: (value: unknown) => bigint | null;
};

function parseYmd(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function parseLimit(raw: unknown, fallback = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function parseOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

export function registerLegacyHistoryRoutes(args: RegisterArgs): void {
  const { app, prisma, getAuthUser, requireRole, toBigInt } = args;

  app.get("/api/legacy-history/status", async (req, res) => {
    const auth = getAuthUser(req);
    if (!auth) {
      res.status(401).json({ ok: false, message: "請先登入" });
      return;
    }
    const url = resolveLegacyDatabaseUrl();
    if (!url) {
      res.json({
        ok: true,
        data: { configured: false, connected: false, target: null, message: "未設定 LEGACY_DATABASE_URL／DATABASE_URL" },
      });
      return;
    }
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.json({
        ok: true,
        data: { configured: false, connected: false, target: describeDbUrl(url), message: "無法建立舊庫連線" },
      });
      return;
    }
    try {
      await legacy.$queryRawUnsafe("SELECT 1 AS ok");
      res.json({
        ok: true,
        data: { configured: true, connected: true, target: describeDbUrl(url), message: null },
      });
    } catch (e) {
      res.json({
        ok: true,
        data: {
          configured: true,
          connected: false,
          target: describeDbUrl(url),
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  });

  app.get("/api/customers/:customerId/legacy-orders", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
    const customerId = toBigInt(req.params.customerId);
    if (customerId == null) {
      res.status(400).json({ ok: false, message: "無效的客戶 ID" });
      return;
    }
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerCode: true, name: true },
    });
    if (!customer) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    if (!customer.customerCode) {
      res.status(400).json({ ok: false, message: "此客戶沒有客戶代號，無法對應舊庫" });
      return;
    }

    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }

    const from = parseYmd(req.query.from);
    const to = parseYmd(req.query.to);
    if (req.query.from && !from) {
      res.status(400).json({ ok: false, message: "from 須為 YYYY-MM-DD" });
      return;
    }
    if (req.query.to && !to) {
      res.status(400).json({ ok: false, message: "to 須為 YYYY-MM-DD" });
      return;
    }

    try {
      const { total, orders } = await listLegacyOrdersForCustomer(legacy, {
        customerCode: customer.customerCode,
        from,
        to,
        limit: parseLimit(req.query.limit, 50),
        offset: parseOffset(req.query.offset),
      });
      res.json({
        ok: true,
        data: {
          customer: {
            id: customer.id.toString(),
            customerCode: customer.customerCode,
            name: customer.name,
          },
          total,
          orders,
        },
      });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `讀取舊庫失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  app.get("/api/legacy-history/orders/:orderId", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
    const orderId = String(req.params.orderId ?? "").trim();
    if (!orderId) {
      res.status(400).json({ ok: false, message: "缺少訂單編號" });
      return;
    }
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }
    try {
      const detail = await getLegacyOrderDetail(legacy, orderId);
      if (!detail) {
        res.status(404).json({ ok: false, message: "舊庫找不到此訂單" });
        return;
      }
      res.json({ ok: true, data: detail });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `讀取舊庫失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  /** 以客戶代號直接查（不必先有新系統客戶 id；主檔已轉換時建議走 /customers/:id/legacy-orders） */
  app.get("/api/legacy-history/by-code/:customerCode/orders", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
    const customerCode = String(req.params.customerCode ?? "").trim();
    if (!customerCode) {
      res.status(400).json({ ok: false, message: "缺少客戶代號" });
      return;
    }
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }
    const from = parseYmd(req.query.from);
    const to = parseYmd(req.query.to);
    if (req.query.from && !from) {
      res.status(400).json({ ok: false, message: "from 須為 YYYY-MM-DD" });
      return;
    }
    if (req.query.to && !to) {
      res.status(400).json({ ok: false, message: "to 須為 YYYY-MM-DD" });
      return;
    }
    try {
      const { total, orders } = await listLegacyOrdersForCustomer(legacy, {
        customerCode,
        from,
        to,
        limit: parseLimit(req.query.limit, 50),
        offset: parseOffset(req.query.offset),
      });
      const mapped = await prisma.customer.findFirst({
        where: { customerCode },
        select: { id: true, customerCode: true, name: true },
      });
      res.json({
        ok: true,
        data: {
          customer: mapped
            ? { id: mapped.id.toString(), customerCode: mapped.customerCode, name: mapped.name }
            : { id: null, customerCode, name: null },
          total,
          orders,
        },
      });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `讀取舊庫失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  function parseBillingTypes(raw: unknown): CutoverBillingType[] {
    const allowed: CutoverBillingType[] = ["cash", "monthly", "prepaid"];
    if (raw == null || raw === "") return [...allowed];
    const parts = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const picked = allowed.filter((t) => parts.includes(t));
    return picked.length ? picked : [...allowed];
  }

  app.get("/api/legacy-cutover/preview", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }
    const asOf = parseYmd(req.query.asOf);
    if (req.query.asOf && !asOf) {
      res.status(400).json({ ok: false, message: "asOf 須為 YYYY-MM-DD" });
      return;
    }
    const customerCode =
      typeof req.query.customer === "string" && req.query.customer.trim()
        ? req.query.customer.trim()
        : null;
    try {
      const data = await buildCutoverPreview(legacy, prisma, {
        asOf,
        customerCode,
        billingTypes: parseBillingTypes(req.query.billingTypes),
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `預覽失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  app.post("/api/legacy-cutover/apply", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]);
    if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cutoverDate = parseYmd(body.cutoverDate) ?? parseYmd(body.asOf);
    if (!cutoverDate) {
      res.status(400).json({ ok: false, message: "請提供 cutoverDate（YYYY-MM-DD）" });
      return;
    }
    const asOf = parseYmd(body.asOf) ?? cutoverDate;
    const granularity = body.granularity === "by_customer" ? "by_customer" : "by_order";
    const customerCode =
      typeof body.customer === "string" && body.customer.trim() ? body.customer.trim() : null;
    const customerCodes = Array.isArray(body.customerCodes)
      ? body.customerCodes.map((x) => String(x).trim()).filter(Boolean)
      : null;
    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.map((x) => String(x).trim()).filter(Boolean)
      : null;
    const dryRun = Boolean(body.dryRun);
    try {
      const data = await applyCutoverOpeningAr(legacy, prisma, {
        asOf,
        customerCode,
        billingTypes: parseBillingTypes(body.billingTypes),
        granularity,
        customerCodes,
        orderIds,
        cutoverDate,
        createdByUserId: auth.id,
        dryRun,
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `開帳失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  app.post("/api/legacy-cutover/sync-balances", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊庫連線未設定（LEGACY_DATABASE_URL）" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const customerCodes = Array.isArray(body.customerCodes)
      ? body.customerCodes.map((x) => String(x).trim()).filter(Boolean)
      : null;
    const dryRun = Boolean(body.dryRun);
    try {
      const data = await syncLegacyBarrelBalances(legacy, prisma, { customerCodes, dryRun });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: `同步桶數失敗：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}
