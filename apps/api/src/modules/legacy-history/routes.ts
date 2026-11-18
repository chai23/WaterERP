import { resetBatchHandover } from "./batch-reset.js";
import { batchPreview, postBatchItem } from "./batch.js";
import type { Express, Request, Response } from "express";
import { syncLegacyMasters } from "./master-sync.js";
import type { PrismaClient } from "@prisma/client";
import { describeDbUrl, getLegacyPrisma, resolveLegacyDatabaseUrl } from "./client.js";
import { getLegacyOrderDetail, listLegacyOrdersForCustomer, listLegacyUsualProductPrices } from "./queries.js";
import { legacyCustomersWithOrders } from "./order-presence.js";
import { applyCustomerHandover, buildCustomerDraft, buildHandover, keepHandedOver, mergeDraft, readHandover, saveHandover, saveCustomerDraft, saveCustomerEdits, customerVersion, totals, validationErrors } from "./handover.js";
import { buildHandoverMethodReport } from "./method-report.js";

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
    if (syncingMasters || job?.running || resetting) { res.status(409).json({ ok: false, message: "同步進行中，請稍後再試。" }); return; }
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    syncingMasters = true;
    try { const data = await syncLegacyMasters(legacy, prisma, true); job = null; res.json({ ok: true, data }); }
    catch (e) { console.error("Master sync failed", e); res.status(409).json({ ok: false, message: e instanceof Error && e.message.includes("客戶已有") ? e.message : "同步失敗，所有變更已回復。請檢查舊庫連線、資料長度及舊新對照後重試。" }); }
    finally { syncingMasters = false; }
  });

  app.all(["/api/legacy-cutover/preview", "/api/legacy-cutover/apply", "/api/legacy-cutover/sync-balances"], (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    res.status(410).json({ ok: false, message: "舊版開帳及覆寫同步已停用，請改用上線交接草稿。" });
  });
  const handoverResponse = (s: Awaited<ReturnType<typeof readHandover>>) => ({ ...s,
    snapshot: s.snapshot ? { ...s.snapshot, rows: s.snapshot.rows.map(r => ({ ...r, startDate: r.startDate ?? s.snapshot!.startDate, cutoffDate: r.cutoffDate ?? s.snapshot!.cutoffDate, version: customerVersion(s.snapshot!, r) })) } : null,
    totals: s.snapshot ? totals(s.snapshot) : null, errors: s.snapshot ? validationErrors(s.snapshot) : [],
  });
  const handoverError = (res: Response, e: unknown) => {
    const detail = e instanceof Error ? e.message : String(e);
    const message = /handover_completed_at/.test(detail)
      ? "請先執行資料庫結構升級（005_customer_handover），再完成單一客戶交接。"
      : /doesn't exist|does not exist|P2021/.test(detail)
      ? "請先執行資料庫結構升級（004_cutover_handover），再使用上線交接。" : detail;
    res.status(409).json({ ok: false, message });
  };
  app.get("/api/legacy-cutover/handover", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ ok: true, data: handoverResponse(await readHandover(prisma)) }); }
    catch (e) { handoverError(res, e); }
  });
  app.get("/api/legacy-cutover/handover/revision", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    res.setHeader("Cache-Control", "no-store");
    try {
      const rows = await prisma.$queryRaw<{ revision: number }[]>`SELECT revision FROM cutover_handover WHERE id=1`;
      if (!rows[0]) throw new Error("請先執行資料庫結構升級（004_cutover_handover）");
      res.json({ ok: true, data: rows[0] });
    } catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/draft", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    try {
      const current = await readHandover(prisma);
      if (current.status === "applied") throw new Error("交接已全部啟用，不能重新產生");
      const customerCode = typeof req.body?.customerCode === "string" ? req.body.customerCode.trim() : "";
      if (customerCode && Object.prototype.hasOwnProperty.call(req.body, "customerVersion")) {
        const one = await buildHandover(legacy, prisma, req.body?.startDate, customerCode);
        res.json({ ok: true, data: handoverResponse(await saveCustomerDraft(prisma, one, req.body.customerVersion, auth.id)) });
        return;
      }
      if (current.revision !== req.body?.revision) throw new Error("草稿版本不同，請重新載入");
      const snapshot = customerCode
        ? await buildCustomerDraft(legacy, prisma, req.body?.startDate, customerCode, current.snapshot)
        : keepHandedOver(current.snapshot, await buildHandover(legacy, prisma, req.body?.startDate));
      res.json({ ok: true, data: handoverResponse(await saveHandover(prisma, current.revision, snapshot, auth.id)) });
    } catch (e) { handoverError(res, e); }
  });
  app.put("/api/legacy-cutover/handover/draft", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    try {
      if (req.body?.customerVersions === true) {
        res.json({ ok: true, data: handoverResponse(await saveCustomerEdits(prisma, req.body?.snapshot, auth.id)) });
        return;
      }
      const current = await readHandover(prisma);
      if (!current.snapshot || current.revision !== req.body?.revision) throw new Error("草稿版本不同，請重新載入");
      const snapshot = mergeDraft(current.snapshot, req.body?.snapshot, req.body?.partial === true);
      res.json({ ok: true, data: handoverResponse(await saveHandover(prisma, current.revision, snapshot, auth.id)) });
    } catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/apply-customer", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    try {
      const customerCode = typeof req.body?.customerCode === "string" ? req.body.customerCode : "";
      res.json({ ok: true, data: handoverResponse(await applyCustomerHandover(legacy, prisma, req.body?.revision, auth.id, customerCode, req.body?.customerVersion)) });
    } catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/apply", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    res.status(409).json({ ok: false, message: "已改為一次只交接一位客戶。請重新整理頁面，展開該客戶後按「完成此客戶交接」。" });
  });
  app.get("/api/legacy-cutover/handover/no-order-candidates", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    res.setHeader("Cache-Control", "no-store");
    try {
      const ordered = await legacyCustomersWithOrders(legacy);
      const current = await readHandover(prisma);
      if (!current.snapshot) throw new Error("請先產生交接草稿");
      const rows = current.snapshot.rows.filter(r => !ordered.has(r.code)).map(r => ({
        key: r.key, code: r.code, name: r.name, version: customerVersion(current.snapshot!, r),
        details: { ...r, startDate: r.startDate ?? current.snapshot!.startDate, cutoffDate: r.cutoffDate ?? current.snapshot!.cutoffDate },
        reason: r.handedOver ? "已完成交接，保留原狀" : !r.customerId ? "尚未對應新系統客戶"
          : r.warnings.some(w => w.startsWith("新系統已有交易")) ? "新系統已有交易，需人工處理"
          : r.warnings.length ? `來源金額或桶數需人工核對：${r.warnings.join("；")}` : "",
      }));
      res.json({ ok: true, data: { checkedAt: new Date().toISOString(), rows } });
    } catch (e) { handoverError(res, e); }
  });
  app.post("/api/legacy-cutover/handover/auto-no-orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "accounting"]); if (!auth) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    try {
      if (typeof req.body?.customerVersion !== "string" || !/^[a-f0-9]{64}$/.test(req.body.customerVersion)) throw new Error("請先篩選無歷史訂單客戶，再執行自動交接");
      const customerCode = typeof req.body?.customerCode === "string" ? req.body.customerCode : "";
      const result = await applyCustomerHandover(legacy, prisma, 0, auth.id, customerCode, req.body.customerVersion, true);
      const row = result.snapshot?.rows.find(r => r.code === customerCode);
      if (!row?.noLegacyOrders) throw new Error("此客戶已完成交接，未重新入帳或改為流失");
      res.json({ ok: true, data: { customerCode, completed: true } });
    } catch (e) { handoverError(res, e); }
  });

  type Job = { total: number; processed: number; succeeded: number; running: boolean; errors: {code:string; reason:string}[] };
  let job: Job | null = null;
  let stopRequested = false;
  let resetting = false;
  app.post("/api/legacy-cutover/batch/stop", (req,res) => {
    if (!requireRole(req,res,["admin","accounting"])) return;
    if (job?.running) stopRequested = true;
    res.json({ok:true,data:job});
  });
  app.get("/api/legacy-cutover/batch", (req,res) => {
    if (!requireRole(req,res,["admin","accounting"])) return;
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,data:job});
  });
  app.post("/api/legacy-cutover/batch/:action", async (req,res) => {
    const auth = requireRole(req,res,["admin","accounting"]);
    if (!auth) return;
    const legacy = getLegacyPrisma();
    const date = parseYmd(req.body?.startDate);
    if (!legacy || !date) { res.status(400).json({ok:false,message:"請檢查舊庫連線與日期"}); return; }
    try {
      if (req.params.action === "reset") {
        if (job?.running || resetting || syncingMasters) throw new Error("請等目前作業停止");
        if (req.body?.confirmReset !== true) throw new Error("請確認還原已交接客戶");
        resetting = true;
        try {
          const count = await resetBatchHandover(prisma);
          job = null;
          res.json({ok:true,data:{count}});
        } finally { resetting = false; }
        return;
      }
      if (resetting || syncingMasters) throw new Error("交接還原或客戶同步中");
      if (req.params.action === "preview") {
        const {report,items} = await batchPreview(legacy,prisma,date);
        res.json({ok:true,data:{...report,rows:items.map(i=>({...i.method,eligibility:i.reason,version:i.version}))}});
        return;
      }
      if (req.params.action !== "start") { res.sendStatus(404); return; }
      const versions = req.body?.versions;
      if (!Array.isArray(versions) || !versions.length || versions.length>20000 || versions.some(v=>typeof v!=="string" || !/^[a-f0-9]{64}$/.test(v))) throw new Error("請重新產生預覽");
      if (job?.running) throw new Error("已有批次執行中");
      const requested = new Set<string>(versions);
      const current:Job = {total:requested.size,processed:0,succeeded:0,running:true,errors:[]};
      stopRequested=false;
      job=current;
      res.json({ok:true,data:current});
      try {
        const {items}=await batchPreview(legacy,prisma,date);
        const selected=items.filter(i=>requested.has(i.version) && !i.reason);
        current.processed=current.total-selected.length;
        if(current.processed) current.errors.push({code:"",reason:current.processed+" 位資料已變更或已完成，請重新分析"});
        for(const item of selected) {
          if (stopRequested) { current.errors.push({code:"",reason:"已停止交接"}); break; }
          try { await postBatchItem(legacy,prisma,item,date,auth.id); current.succeeded++; }
          catch(e) {current.errors.push({code:item.code,reason:e instanceof Error?e.message:"交接失敗"});}
          current.processed++;
        }
      } catch(e) {current.errors.push({code:"",reason:e instanceof Error?e.message:"批次失敗"});}
      finally {current.running=false;}
    } catch(e) {handoverError(res,e);}
  });

  app.get("/api/legacy-cutover/manual/options", async (req,res) => {
    if (!requireRole(req,res,["admin","accounting"])) return;
    const legacy = getLegacyPrisma();
    const date = parseYmd(req.query.date);
    const code = String(req.query.code ?? "");
    if (!legacy || !date || !/^\d{6}$/.test(code)) {res.status(400).json({ok:false,message:"請確認客戶及截止日"});return;}
    try {
      const [report,products] = await Promise.all([
        buildHandoverMethodReport(legacy,prisma,date,code),
        prisma.product.findMany({where:{isActive:true,consumesPrepaidBarrel:true,productCode:{not:null}},select:{productCode:true,name:true},orderBy:{productCode:"asc"}}),
      ]);
      res.json({ok:true,data:{products,candidates:report.rows.find(r=>r.code===code)?.productCandidates ?? []}});
    } catch(e) {handoverError(res,e);}
  });

  let buildingMethodReport = false;
  app.post("/api/legacy-cutover/handover/method-report", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting"])) return;
    const legacy = getLegacyPrisma();
    if (!legacy) { res.status(503).json({ ok: false, message: "未設定舊庫連線" }); return; }
    if (buildingMethodReport) { res.status(409).json({ ok: false, message: "報表正在產生，請稍後再按一次。" }); return; }
    const startDate = parseYmd(req.body?.startDate);
    if (!startDate) { res.status(400).json({ ok: false, message: "請輸入有效的啟用日期" }); return; }
    buildingMethodReport = true;
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ ok: true, data: await buildHandoverMethodReport(legacy, prisma, startDate) }); }
    catch (e) { handoverError(res, e); }
    finally { buildingMethodReport = false; }
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

  /** 開單提醒：舊系統最近叫過的商品，以及單價大於 0 的正確價格（預收配送常為 0） */
  app.get("/api/customers/:customerId/legacy-product-prices", async (req, res) => {
    if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
    const customerId = toBigInt(req.params.customerId);
    if (customerId == null) {
      res.status(400).json({ ok: false, message: "無效的客戶 ID" });
      return;
    }
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerCode: true },
    });
    if (!customer) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    if (!customer.customerCode?.trim()) {
      res.status(400).json({ ok: false, message: "此客戶沒有客戶代號，無法對照舊系統" });
      return;
    }
    const legacy = getLegacyPrisma();
    if (!legacy) {
      res.status(503).json({ ok: false, message: "舊系統連線未設定，無法查詢先前的商品與價格" });
      return;
    }
    try {
      const data = await listLegacyUsualProductPrices(legacy, customer.customerCode);
      res.json({ ok: true, data });
    } catch (e) {
      console.error("legacy product prices", e);
      res.status(502).json({ ok: false, message: "舊系統商品價格暫時無法載入" });
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
