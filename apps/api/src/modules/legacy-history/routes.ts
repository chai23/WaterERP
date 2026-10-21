import type { Express, Request, Response } from "express";
import { syncLegacyMasters } from "./master-sync.js";
import type { PrismaClient } from "@prisma/client";
import { describeDbUrl, getLegacyPrisma, resolveLegacyDatabaseUrl } from "./client.js";
import { getLegacyOrderDetail, listLegacyOrdersForCustomer } from "./queries.js";
import { applyHandover, buildHandover, mergeDraft, readHandover, saveHandover, totals, validationErrors } from "./handover.js";

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
  let syncingMasters = false;
  app.post("/api/legacy-history/sync-masters", async (req, res) => {
    if (!requireRole(req, res, ["admin"])) return;
    if (syncingMasters) { res.status(409).json({ ok: false, message: "同步進行中，請稍後再試。" }); return; }
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    syncingMasters = true;
    try { res.json({ ok: true, data: await syncLegacyMasters(legacy, prisma) }); }
    catch (e) { console.error("Master sync failed", e); res.status(409).json({ ok: false, message: "同步失敗，所有變更已回復。請檢查舊庫連線、資料長度及舊新對照後重試。" }); }
    finally { syncingMasters = false; }
  });

  app.all(["/api/legacy-cutover/preview", "/api/legacy-cutover/apply", "/api/legacy-cutover/sync-balances"], (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    res.status(410).json({ ok: false, message: "舊版開帳及覆寫同步已停用，請改用上線交接草稿。" });
  });
  const handoverResponse = (s: Awaited<ReturnType<typeof readHandover>>) => ({ ...s,
    totals: s.snapshot ? totals(s.snapshot) : null, errors: s.snapshot ? validationErrors(s.snapshot) : [],
  });
  const handoverError = (res: Response, e: unknown) => {
    const detail = e instanceof Error ? e.message : String(e);
    const message = /doesn't exist|does not exist|P2021/.test(detail)
      ? "請先執行資料庫結構升級（004_cutover_handover），再使用上線交接。" : detail;
    res.status(409).json({ ok: false, message });
  };
  app.get("/api/legacy-cutover/handover", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    try { res.json({ ok: true, data: handoverResponse(await readHandover(prisma)) }); }
    catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/draft", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    try {
      const current = await readHandover(prisma);
      if (current.status === "applied") throw new Error("交接已啟用，不能重新產生");
      if (current.revision !== req.body?.revision) throw new Error("草稿版本不同，請重新載入");
      const snapshot = await buildHandover(legacy, prisma, req.body?.startDate);
      res.json({ ok: true, data: handoverResponse(await saveHandover(prisma, current.revision, snapshot, auth.id)) });
    } catch (e) { handoverError(res, e); }
  });
  app.put("/api/legacy-cutover/handover/draft", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    try {
      const current = await readHandover(prisma);
      if (!current.snapshot || current.revision !== req.body?.revision) throw new Error("草稿版本不同，請重新載入");
      const snapshot = mergeDraft(current.snapshot, req.body?.snapshot);
      res.json({ ok: true, data: handoverResponse(await saveHandover(prisma, current.revision, snapshot, auth.id)) });
    } catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/apply", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    try {
      res.json({ ok: true, data: handoverResponse(await applyHandover(legacy, prisma, req.body?.revision, auth.id)) });
    } catch (e) { handoverError(res, e); }
  });

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

}
