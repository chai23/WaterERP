import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import jwt, { type JwtPayload, type Secret, type SignOptions } from "jsonwebtoken";
import {
  formatOrderCreatedMessage,
  notifyCustomerViaLine,
  pushLineText,
  replyText,
  verifyLiffIdToken,
  WELCOME_MESSAGE,
} from "./messaging.js";
import {
  consumeLineBindCode,
  issueLineBindCode,
  normalizeCustomerCode,
  normalizeMobile,
  verifyLineBindCode,
  verifyLineWebhookSignature,
} from "./otp.js";
import { isProductionRuntime, publicErrorMessage } from "../security.js";
import {
  createServiceTicket,
  isServiceType,
  serializeServiceTicket,
  serviceTicketInclude,
  serviceTypeLabel,
} from "../serviceTickets.js";

export type LiffMember = {
  customerId: bigint;
  lineUserId: string;
};

type AuthPayload = JwtPayload & {
  typ?: string;
  sub?: string;
  lineUserId?: string;
};

type CreateSalesOrderFn = (
  body: Record<string, unknown>,
  opts: { source: string; createdByUserId: bigint | null; initialStatus?: string },
) => Promise<{ status: number; payload: Record<string, unknown> }>;

type ToBigIntFn = (value: unknown) => bigint | null;

export type LiffRouteDeps = {
  prisma: PrismaClient;
  jwtSecret: Secret;
  jwtSignOptions: SignOptions;
  createSalesOrder: CreateSalesOrderFn;
  toBigInt: ToBigIntFn;
  parseLocalYmdRange: (raw: string) => { start: Date; end: Date } | null;
};

function getLiffMember(req: Request): LiffMember | null {
  return (req as Request & { liffMember?: LiffMember }).liffMember ?? null;
}

async function allocateCustomerCode(prisma: PrismaClient): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const n = Math.floor(Math.random() * 900000) + 100000;
    const code = String(n).padStart(6, "0");
    const exists = await prisma.customer.findFirst({ where: { customerCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  const fallback = String(Date.now()).slice(-6);
  return fallback.padStart(6, "0");
}

function getStaffAuth(req: Request): { id: bigint; role: string } | null {
  return (req as Request & { authUser?: { id: bigint; role: string } }).authUser ?? null;
}

function requireStaffRole(
  req: Request,
  res: Response,
  roles: readonly string[],
): { id: bigint; role: string } | null {
  const user = getStaffAuth(req);
  if (!user) {
    res.status(401).json({ ok: false, message: "請先登入" });
    return null;
  }
  if (!roles.includes(user.role)) {
    res.status(403).json({ ok: false, message: "權限不足" });
    return null;
  }
  return user;
}

async function findCustomersByMobile(prisma: PrismaClient, mobile: string) {
  const rows = await prisma.customer.findMany({
    where: {
      OR: [{ mobile }, { phone: mobile }],
    },
    include: { addresses: { orderBy: { id: "asc" } } },
  });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.id.toString();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type LiffCustomerRow = {
  id: bigint;
  customerCode: string | null;
  name: string;
  mobile: string | null;
  phone: string | null;
  billingType: string;
  prepaidBarrelBalance: number;
  addresses: unknown;
};

async function sumCashUnpaidTotal(prisma: PrismaClient, customerId: bigint): Promise<number> {
  const agg = await prisma.arOpenItem.aggregate({
    where: {
      customerId,
      outstandingAmount: { gt: 0 },
      arDocument: { billingType: "cash", status: { not: "voided" } },
      OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }],
    },
    _sum: { outstandingAmount: true },
  });
  const n = Number(agg._sum.outstandingAmount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function sumMonthlyUnpaidTotal(prisma: PrismaClient, customerId: bigint): Promise<number> {
  const agg = await prisma.arOpenItem.aggregate({
    where: {
      customerId,
      outstandingAmount: { gt: 0 },
      arDocument: { billingType: "monthly", status: { not: "voided" } },
      OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }],
    },
    _sum: { outstandingAmount: true },
  });
  const n = Number(agg._sum.outstandingAmount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** DateTime：以本地曆日顯示 */
function liffYmd(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Prisma @db.Date：以 UTC 午夜存曆日，讀取時用 UTC 元件避免時區偏一天 */
function liffDbDateYmd(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 實際送貨日：司機回報 → 派車日 → 預定配送日（與後台月結清單一致；勿用 officeSettledAt） */
function liffActualDeliveryYmd(so: {
  scheduledDeliveryDate: Date | null;
  assignments?: Array<{ driverReportedAt: Date | null; assignmentDate: Date | null }> | null;
}): string | null {
  const a = so.assignments?.[0];
  if (a?.driverReportedAt) return liffYmd(a.driverReportedAt);
  if (a?.assignmentDate) return liffDbDateYmd(a.assignmentDate);
  if (so.scheduledDeliveryDate) return liffDbDateYmd(so.scheduledDeliveryDate);
  return null;
}

async function listLiffMonthlyStatements(prisma: PrismaClient, customerId: bigint) {
  const statements = await prisma.billingStatement.findMany({
    where: { customerId, status: { not: "voided" } },
    include: {
      orders: {
        include: {
          salesOrder: {
            select: {
              id: true,
              orderNo: true,
              scheduledDeliveryDate: true,
              lines: {
                where: { billingTypeAtLine: "monthly" },
                include: { product: { select: { name: true, unit: true } } },
                orderBy: { id: "asc" },
              },
              assignments: {
                where: { status: { in: ["completed", "not_delivered"] } },
                select: { driverReportedAt: true, assignmentDate: true },
                orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
                take: 1,
              },
            },
          },
        },
        orderBy: { id: "asc" },
      },
      arDocuments: {
        where: { status: { not: "voided" }, billingType: "monthly" },
        include: { openItems: true },
      },
    },
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    take: 24,
  });

  return statements.map((stmt) => {
    let outstanding = 0;
    let original = 0;
    for (const doc of stmt.arDocuments) {
      for (const oi of doc.openItems) {
        outstanding += Number(oi.outstandingAmount ?? 0);
        original += Number(oi.originalAmount ?? 0);
      }
    }
    if (!Number.isFinite(outstanding)) outstanding = 0;
    if (!Number.isFinite(original)) original = 0;
    const totalWithTax = Number(stmt.totalWithTax ?? 0);
    const payStatus: "unpaid" | "partial" | "paid" =
      outstanding <= 0.0001 ? "paid" : outstanding + 0.0001 < Math.max(original, totalWithTax) ? "partial" : "unpaid";

    return {
      id: stmt.id.toString(),
      statementNo: stmt.statementNo,
      cutoffDate: liffDbDateYmd(stmt.cutoffDate),
      postedAt: stmt.postedAt.toISOString(),
      untaxedTotal: stmt.untaxedTotal.toString(),
      taxAmount: stmt.taxAmount.toString(),
      totalWithTax: stmt.totalWithTax.toString(),
      invoiceMode: stmt.invoiceMode,
      outstandingAmount: String(Math.max(0, outstanding)),
      payStatus,
      payStatusLabel:
        payStatus === "paid" ? "已結清" : payStatus === "partial" ? "部分付款" : "尚未結清",
      orders: stmt.orders.map((row) => {
        const so = row.salesOrder;
        const lines = (so.lines ?? []).map((l) => ({
          productName: l.product?.name ?? "商品",
          unit: l.product?.unit ?? "",
          qty: l.qtyDelivered > 0 ? l.qtyDelivered : l.qtyOrdered,
          lineAmount: l.lineAmount.toString(),
        }));
        return {
          salesOrderId: so.id.toString(),
          orderNo: so.orderNo,
          monthlyAmount: row.monthlyUntaxedAmount.toString(),
          deliveryDate: liffActualDeliveryYmd(so),
          lines,
        };
      }),
    };
  });
}

async function toLiffCustomerPayload(prisma: PrismaClient, customer: LiffCustomerRow) {
  const prepaidByProduct = await prisma.customerPrepaidProductBalance.findMany({
    where: { customerId: customer.id, balanceBarrels: { gt: 0 } },
    include: { product: { select: { id: true, name: true, unit: true } } },
    orderBy: [{ productId: "asc" }],
  });
  const byProduct = prepaidByProduct.map((r) => ({
    productId: r.productId.toString(),
    productName: r.product.name,
    unit: r.product.unit,
    barrels: r.balanceBarrels,
  }));
  const prepaidBarrelBalance =
    byProduct.length > 0 ? byProduct.reduce((s, r) => s + r.barrels, 0) : customer.prepaidBarrelBalance;
  const [cashUnpaidTotal, monthlyUnpaidTotal, monthlyStatements] = await Promise.all([
    sumCashUnpaidTotal(prisma, customer.id),
    sumMonthlyUnpaidTotal(prisma, customer.id),
    listLiffMonthlyStatements(prisma, customer.id),
  ]);
  return {
    id: customer.id.toString(),
    customerCode: customer.customerCode,
    name: customer.name,
    mobile: customer.mobile,
    phone: customer.phone,
    billingType: customer.billingType,
    prepaidBarrelBalance,
    prepaidBarrelByProduct: byProduct,
    cashUnpaidTotal: String(cashUnpaidTotal),
    monthlyUnpaidTotal: String(monthlyUnpaidTotal),
    monthlyStatements,
    addresses: customer.addresses,
  };
}

function liffMonthlyCap(o: {
  monthlySubtotal?: { toString(): string } | string | number | null;
  totalAmount: { toString(): string } | string | number;
  billingTypeAtOrder: string | null;
}): number {
  const ms = Number(o.monthlySubtotal ?? 0);
  if (Number.isFinite(ms) && ms > 0) return ms;
  if ((o.billingTypeAtOrder ?? "") === "monthly") {
    const t = Number(o.totalAmount);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function liffCashCap(o: {
  cashSubtotal?: { toString(): string } | string | number | null;
  totalAmount: { toString(): string } | string | number;
  billingTypeAtOrder: string | null;
}): number {
  const cs = Number(o.cashSubtotal ?? 0);
  if (Number.isFinite(cs) && cs > 0) return cs;
  if ((o.billingTypeAtOrder ?? "") === "cash") {
    const t = Number(o.totalAmount);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

type LiffOrderEnrichInput = {
  id: bigint;
  status: string;
  totalAmount: { toString(): string } | string | number;
  cashSubtotal?: { toString(): string } | string | number | null;
  monthlySubtotal?: { toString(): string } | string | number | null;
  monthlyReceivedAmount?: { toString(): string } | string | number | null;
  monthlyPeriodPaid?: boolean;
  billingTypeAtOrder: string | null;
  billingStatementOrder?: { id: bigint } | null;
};

type LiffBillStatus = "none" | "awaiting_delivery" | "unpaid" | "paid";

async function enrichLiffOrders<T extends LiffOrderEnrichInput>(
  prisma: PrismaClient,
  customerId: bigint,
  rows: T[],
): Promise<
  Array<
    T & {
      monthlyCapAmount: string;
      monthlyOutstandingAmount: string;
      monthlySettlementStatus: LiffBillStatus;
      monthlySettlementLabel: string;
      cashCapAmount: string;
      cashOutstandingAmount: string;
      cashSettlementStatus: LiffBillStatus;
      cashSettlementLabel: string;
    }
  >
> {
  const monthlyIds = rows.filter((o) => liffMonthlyCap(o) > 0).map((o) => o.id);
  const cashIds = rows
    .filter((o) => liffCashCap(o) > 0 || (o.billingTypeAtOrder ?? "") === "cash")
    .map((o) => o.id);
  const unpaidByAr = new Set<string>();
  const statementPaidOrderIds = new Set<string>();
  const cashOutstandingByOrder = new Map<string, number>();
  const cashOriginalByOrder = new Map<string, number>();

  if (monthlyIds.length > 0) {
    const unpaid = await prisma.arOpenItem.groupBy({
      by: ["salesOrderId"],
      where: {
        customerId,
        salesOrderId: { in: monthlyIds },
        outstandingAmount: { gt: 0 },
        arDocument: { billingType: "monthly", status: { not: "voided" } },
      },
      _sum: { outstandingAmount: true },
    });
    for (const r of unpaid) {
      if (r.salesOrderId == null) continue;
      const sum = Number(r._sum.outstandingAmount ?? 0);
      if (sum > 0) unpaidByAr.add(String(r.salesOrderId));
    }

    // 月結批次 AR（salesOrderId 為 null）：依批次尚欠回填所屬訂單帳款狀態
    const statementLinks = await prisma.billingStatementOrder.findMany({
      where: { salesOrderId: { in: monthlyIds } },
      include: {
        billingStatement: {
          include: {
            arDocuments: {
              where: { billingType: "monthly", status: { not: "voided" } },
              include: { openItems: true },
            },
          },
        },
      },
    });
    for (const link of statementLinks) {
      let outstanding = 0;
      for (const doc of link.billingStatement.arDocuments) {
        for (const oi of doc.openItems) {
          outstanding += Number(oi.outstandingAmount ?? 0);
        }
      }
      const idKey = String(link.salesOrderId);
      if (outstanding > 0.0001) unpaidByAr.add(idKey);
      else statementPaidOrderIds.add(idKey);
    }
  }

  if (cashIds.length > 0) {
    const cashRows = await prisma.arOpenItem.groupBy({
      by: ["salesOrderId"],
      where: {
        customerId,
        salesOrderId: { in: cashIds },
        arDocument: { billingType: "cash", status: { not: "voided" } },
      },
      _sum: { outstandingAmount: true, originalAmount: true },
    });
    for (const r of cashRows) {
      if (r.salesOrderId == null) continue;
      const key = String(r.salesOrderId);
      cashOutstandingByOrder.set(key, Number(r._sum.outstandingAmount ?? 0));
      cashOriginalByOrder.set(key, Number(r._sum.originalAmount ?? 0));
    }
  }

  return rows.map((o) => {
    const cap = liffMonthlyCap(o);
    const received = Number(o.monthlyReceivedAmount ?? 0);
    const outstandingRaw = Math.max(0, cap - (Number.isFinite(received) ? received : 0));
    const idKey = String(o.id);
    const inStatement = o.billingStatementOrder != null;
    const arUnpaid = unpaidByAr.has(idKey);

    let monthlySettlementStatus: LiffBillStatus = "none";
    let monthlySettlementLabel = "";
    let monthlyOutstandingAmount = "0";
    let monthlyPeriodPaid = o.monthlyPeriodPaid;

    if (cap <= 0 || o.status === "cancelled" || o.status === "not_delivered") {
      monthlySettlementStatus = "none";
    } else if (o.status !== "completed") {
      monthlySettlementStatus = "awaiting_delivery";
      monthlySettlementLabel = "帳款：配送完成後列入月結";
    } else {
      let paid = Boolean(o.monthlyPeriodPaid);
      if (arUnpaid) paid = false;
      else if (statementPaidOrderIds.has(idKey)) paid = true;
      else if (!inStatement && cap > 0) paid = false;
      else if (outstandingRaw > 0) paid = false;

      if (paid) {
        monthlySettlementStatus = "paid";
        monthlySettlementLabel = "帳款：月結已結清";
        monthlyPeriodPaid = true;
        monthlyOutstandingAmount = "0";
      } else {
        const showAmt = outstandingRaw > 0 ? outstandingRaw : cap;
        monthlySettlementStatus = "unpaid";
        monthlySettlementLabel = `帳款：月結未結清（尚欠 $${Math.round(showAmt).toLocaleString("zh-TW")}）`;
        monthlyPeriodPaid = false;
        monthlyOutstandingAmount = String(showAmt);
      }
    }

    const cashCap = liffCashCap(o);
    const cashOutstandingAr = cashOutstandingByOrder.get(idKey);
    const cashOriginalAr = cashOriginalByOrder.get(idKey) ?? 0;
    const hasCashAr = cashOutstandingAr != null || cashOriginalAr > 0;
    const cashOutstanding =
      cashOutstandingAr != null && Number.isFinite(cashOutstandingAr)
        ? Math.max(0, cashOutstandingAr)
        : cashCap > 0
          ? cashCap
          : 0;

    let cashSettlementStatus: LiffBillStatus = "none";
    let cashSettlementLabel = "";
    let cashOutstandingAmount = "0";

    if (o.status === "cancelled" || o.status === "not_delivered") {
      cashSettlementStatus = "none";
    } else if (cashCap > 0 || hasCashAr) {
      if (cashOutstanding > 0.0001) {
        cashSettlementStatus = "unpaid";
        cashSettlementLabel = `帳款：尚未付清（尚欠 $${Math.round(cashOutstanding).toLocaleString("zh-TW")}）`;
        cashOutstandingAmount = String(cashOutstanding);
      } else if (hasCashAr || cashCap > 0) {
        cashSettlementStatus = "paid";
        cashSettlementLabel = "帳款：已付清";
        cashOutstandingAmount = "0";
      }
    }

    return {
      ...o,
      monthlyCapAmount: String(cap),
      monthlyOutstandingAmount,
      monthlySettlementStatus,
      monthlySettlementLabel,
      monthlyPeriodPaid,
      cashCapAmount: String(cashCap),
      cashOutstandingAmount,
      cashSettlementStatus,
      cashSettlementLabel,
    };
  });
}

export function registerLiffRoutes(app: Express, deps: LiffRouteDeps): void {
  const { prisma, jwtSecret, jwtSignOptions, createSalesOrder, toBigInt, parseLocalYmdRange } = deps;

  const signMemberToken = (member: LiffMember) =>
    jwt.sign(
      { typ: "member", sub: member.customerId.toString(), lineUserId: member.lineUserId },
      jwtSecret,
      jwtSignOptions,
    );

  const requireMember = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] ?? "" : header);
    if (!match) {
      res.status(401).json({ ok: false, message: "請先登入會員" });
      return;
    }
    try {
      const payload = jwt.verify(match[1], jwtSecret, { algorithms: ["HS256"] }) as AuthPayload;
      if (payload.typ !== "member") {
        res.status(401).json({ ok: false, message: "無效的會員憑證" });
        return;
      }
      const customerId = toBigInt(payload.sub);
      const lineUserId = typeof payload.lineUserId === "string" ? payload.lineUserId : "";
      if (!customerId || !lineUserId) {
        res.status(401).json({ ok: false, message: "會員憑證已失效" });
        return;
      }
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, lineUserId: true },
      });
      if (!customer || customer.lineUserId !== lineUserId) {
        res.status(401).json({ ok: false, message: "會員綁定已失效，請重新登入" });
        return;
      }
      (req as Request & { liffMember?: LiffMember }).liffMember = { customerId, lineUserId };
      next();
    } catch {
      res.status(401).json({ ok: false, message: "會員憑證已失效，請重新登入" });
    }
  };

  app.post("/api/line/webhook", async (req, res) => {
    try {
      const signature = req.headers["x-line-signature"];
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      const secret = process.env.LINE_CHANNEL_SECRET?.trim();
      if (!secret) {
        if (isProductionRuntime()) {
          res.status(401).json({ ok: false, message: "invalid signature" });
          return;
        }
        console.warn("[line-webhook] 未設定 LINE_CHANNEL_SECRET，開發模式略過驗簽");
      } else {
        const sig = Array.isArray(signature) ? signature[0] : signature;
        if (!raw || !verifyLineWebhookSignature(raw, sig)) {
          res.status(401).json({ ok: false, message: "invalid signature" });
          return;
        }
      }

      const body = req.body as {
        events?: Array<{
          type?: string;
          replyToken?: string;
          source?: { userId?: string };
          message?: { type?: string; text?: string };
        }>;
      };
      const events = Array.isArray(body.events) ? body.events : [];
      for (const ev of events) {
        if (ev.type === "follow" && ev.replyToken) {
          await replyText(ev.replyToken, WELCOME_MESSAGE);
        } else if (ev.type === "message" && ev.message?.type === "text" && ev.replyToken) {
          const text = (ev.message.text ?? "").trim();
          if (/訂水|下單|會員|幫助|help/i.test(text)) {
            await replyText(ev.replyToken, WELCOME_MESSAGE);
          }
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/session", async (req, res) => {
    try {
      const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
      const verified = await verifyLiffIdToken(idToken);
      if (!verified.ok) {
        res.status(401).json({ ok: false, message: verified.message });
        return;
      }

      const customer = await prisma.customer.findFirst({
        where: { lineUserId: verified.lineUserId },
        include: { addresses: { orderBy: { id: "asc" } } },
      });

      if (!customer) {
        res.json({
          ok: true,
          data: {
            bound: false,
            lineUserId: verified.lineUserId,
            displayName: verified.name ?? null,
          },
        });
        return;
      }

      const token = signMemberToken({ customerId: customer.id, lineUserId: verified.lineUserId });
      res.json({
        ok: true,
        data: {
          bound: true,
          token,
          lineUserId: verified.lineUserId,
          customer: await toLiffCustomerPayload(prisma, customer),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  // 舊版 LIFF 仍會呼叫此路徑；回 JSON 提示重整，避免 Nginx 404 HTML 被顯示成「連線失敗」。
  app.post("/api/liff/otp/request", (_req, res) => {
    res.status(410).json({
      ok: false,
      message: "驗證碼已取消。請完全關閉此頁，從官方帳號選單重新開啟訂水後再綁定。",
    });
  });

  app.post("/api/liff/bind", async (req, res) => {
    try {
      const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
      const mobileRaw = typeof req.body?.mobile === "string" ? req.body.mobile : "";
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const addressLine = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";
      const customerCodeRaw = typeof req.body?.customerCode === "string" ? req.body.customerCode : "";
      const bindCodeRaw = typeof req.body?.bindCode === "string" ? req.body.bindCode : "";
      const deliveryFloor =
        req.body?.deliveryFloor != null && String(req.body.deliveryFloor).trim() !== ""
          ? Number(req.body.deliveryFloor)
          : null;

      const verified = await verifyLiffIdToken(idToken);
      if (!verified.ok) {
        res.status(401).json({ ok: false, message: verified.message });
        return;
      }

      const mobile = normalizeMobile(mobileRaw);
      if (!mobile) {
        res.status(400).json({ ok: false, message: "手機號碼格式錯誤（請用 09 開頭）" });
        return;
      }

      const existingByLine = await prisma.customer.findFirst({
        where: { lineUserId: verified.lineUserId },
      });
      if (existingByLine) {
        res.status(400).json({ ok: false, message: "此 LINE 帳號已綁定會員" });
        return;
      }

      const matches = await findCustomersByMobile(prisma, mobile);
      if (matches.length > 1) {
        res.status(400).json({ ok: false, message: "此手機對應多筆客戶資料，請聯繫客服協助綁定" });
        return;
      }

      let customer = matches[0] ?? null;
      if (customer?.lineUserId && customer.lineUserId !== verified.lineUserId) {
        res.status(400).json({ ok: false, message: "此手機已綁定其他 LINE 帳號，請聯繫客服" });
        return;
      }

      if (!customer) {
        if (!name || !addressLine) {
          res.status(400).json({
            ok: false,
            message: "找不到既有客戶資料，請填寫姓名與配送地址以完成註冊",
            needRegister: true,
          });
          return;
        }
        const customerCode = await allocateCustomerCode(prisma);
        customer = await prisma.customer.create({
          data: {
            customerCode,
            name,
            mobile,
            phone: mobile,
            billingType: "cash",
            lineUserId: verified.lineUserId,
            lineBoundAt: new Date(),
            addresses: {
              create: {
                addressLine,
                deliveryFloor: Number.isFinite(deliveryFloor) ? deliveryFloor : null,
                contactMobile: mobile,
                isDefault: true,
                label: "住家",
              },
            },
          },
          include: { addresses: { orderBy: { id: "asc" } } },
        });
      } else {
        const customerCode = normalizeCustomerCode(customerCodeRaw);
        if (!customerCode || !bindCodeRaw.trim()) {
          res.status(400).json({
            ok: false,
            message: "此手機已有會員資料，請向客服申請綁定，並輸入客戶編號與一次性綁定碼",
            needExistingBind: true,
          });
          return;
        }
        if (!customer.customerCode || customer.customerCode !== customerCode) {
          res.status(400).json({ ok: false, message: "客戶編號不符，請向客服確認" });
          return;
        }
        const bind = await verifyLineBindCode(prisma, { customerId: customer.id, code: bindCodeRaw });
        if (!bind.ok) {
          res.status(400).json({ ok: false, message: bind.message, needExistingBind: true });
          return;
        }
        await consumeLineBindCode(prisma, bind.challengeId);
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: {
            lineUserId: verified.lineUserId,
            lineBoundAt: new Date(),
            mobile: customer.mobile || mobile,
          },
          include: { addresses: { orderBy: { id: "asc" } } },
        });
      }

      const token = signMemberToken({ customerId: customer.id, lineUserId: verified.lineUserId });
      res.status(201).json({
        ok: true,
        data: {
          token,
          customer: await toLiffCustomerPayload(prisma, customer),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/me", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const customer = await prisma.customer.findUnique({
        where: { id: member.customerId },
        include: { addresses: { orderBy: { id: "asc" } } },
      });
      if (!customer) {
        res.status(404).json({ ok: false, message: "找不到客戶資料" });
        return;
      }
      res.json({
        ok: true,
        data: await toLiffCustomerPayload(prisma, customer),
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/products", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const [rows, boughtLines] = await Promise.all([
        prisma.product.findMany({
          where: { isActive: true, availableOnLiff: true },
          orderBy: [{ productCode: "asc" }, { id: "asc" }],
          select: {
            id: true,
            productCode: true,
            name: true,
            unit: true,
            salePrice: true,
            consumesPrepaidBarrel: true,
          },
        }),
        prisma.salesOrderLine.findMany({
          where: {
            salesOrder: {
              customerId: member.customerId,
              status: { not: "cancelled" },
            },
          },
          select: {
            productId: true,
            salesOrder: { select: { createdAt: true } },
          },
          orderBy: [{ id: "desc" }],
          take: 800,
        }),
      ]);

      const lastOrderedAt = new Map<string, Date>();
      for (const line of boughtLines) {
        const key = line.productId.toString();
        if (lastOrderedAt.has(key)) continue;
        lastOrderedAt.set(key, line.salesOrder.createdAt);
      }

      const data = rows
        .map((r) => {
          const key = r.id.toString();
          const orderedAt = lastOrderedAt.get(key) ?? null;
          return {
            ...r,
            previouslyPurchased: orderedAt != null,
            lastOrderedAt: orderedAt ? orderedAt.toISOString() : null,
          };
        })
        .sort((a, b) => {
          const aT = a.lastOrderedAt ? Date.parse(a.lastOrderedAt) : 0;
          const bT = b.lastOrderedAt ? Date.parse(b.lastOrderedAt) : 0;
          if (aT !== bT) return bT - aT;
          const ac = (a.productCode ?? "").trim();
          const bc = (b.productCode ?? "").trim();
          if (ac !== bc) return ac.localeCompare(bc, "zh-Hant");
          return Number(a.id) - Number(b.id);
        });

      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/addresses", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const addressLine = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";
      if (!addressLine) {
        res.status(400).json({ ok: false, message: "地址必填" });
        return;
      }
      const label = typeof req.body?.label === "string" ? req.body.label.trim() || null : null;
      const deliveryFloor =
        req.body?.deliveryFloor != null && String(req.body.deliveryFloor).trim() !== ""
          ? Number(req.body.deliveryFloor)
          : null;
      const created = await prisma.deliveryAddress.create({
        data: {
          customerId: member.customerId,
          addressLine,
          label,
          deliveryFloor: Number.isFinite(deliveryFloor) ? deliveryFloor : null,
          isDefault: false,
        },
      });
      res.status(201).json({ ok: true, data: created });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/orders", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const rows = await prisma.salesOrder.findMany({
        where: { customerId: member.customerId },
        include: {
          deliveryAddress: true,
          lines: { include: { product: true } },
          assignments: {
            orderBy: { id: "desc" },
            take: 3,
            include: { driver: { include: { user: true } } },
          },
          billingStatementOrder: { select: { id: true } },
        },
        orderBy: { id: "desc" },
        take: 50,
      });
      res.json({ ok: true, data: await enrichLiffOrders(prisma, member.customerId, rows) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/orders/:salesOrderId", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const salesOrderId = toBigInt(req.params.salesOrderId);
      if (!salesOrderId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const row = await prisma.salesOrder.findFirst({
        where: { id: salesOrderId, customerId: member.customerId },
        include: {
          deliveryAddress: true,
          lines: { include: { product: true } },
          assignments: {
            orderBy: { id: "desc" },
            include: { driver: { include: { user: true } } },
          },
          billingStatementOrder: { select: { id: true } },
        },
      });
      if (!row) {
        res.status(404).json({ ok: false, message: "找不到訂單" });
        return;
      }
      const [enriched] = await enrichLiffOrders(prisma, member.customerId, [row]);
      res.json({ ok: true, data: enriched });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/orders", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const body = {
        ...(typeof req.body === "object" && req.body ? req.body : {}),
        customerId: member.customerId.toString(),
      } as Record<string, unknown>;

      const result = await createSalesOrder(body, {
        source: "liff",
        createdByUserId: null,
        initialStatus: "pending_review",
      });
      res.status(result.status).json(result.payload);

      if (result.status === 201 && result.payload.ok && result.payload.data) {
        const data = result.payload.data as {
          id?: bigint | string;
          orderNo?: string;
          totalAmount?: { toString(): string } | string;
          scheduledDeliveryDate?: Date | string | null;
          customerId?: bigint | string;
          lines?: Array<{ qtyOrdered?: number; product?: { name?: string } | null }>;
        };
        const lineSummary =
          Array.isArray(data.lines) && data.lines.length > 0
            ? data.lines
                .map((l) => `${l.product?.name ?? "商品"}×${l.qtyOrdered ?? 0}`)
                .join("、")
            : "（詳見訂單）";
        const scheduled =
          data.scheduledDeliveryDate instanceof Date
            ? data.scheduledDeliveryDate.toISOString().slice(0, 10)
            : data.scheduledDeliveryDate
              ? String(data.scheduledDeliveryDate).slice(0, 10)
              : null;
        const customerId = toBigInt(data.customerId) ?? member.customerId;
        const salesOrderId = toBigInt(data.id);
        void notifyCustomerViaLine(prisma, {
          customerId,
          eventType: "order_created",
          salesOrderId,
          text: formatOrderCreatedMessage({
            orderNo: data.orderNo ?? "",
            totalAmount: String(data.totalAmount ?? "0"),
            scheduledDeliveryDate: scheduled,
            lineSummary,
            awaitingReview: true,
          }),
        }).catch((err) => console.error("[line-notify] order_created", err));
      }
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/service-tickets", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const rows = await prisma.serviceTicket.findMany({
        where: { customerId: member.customerId },
        include: serviceTicketInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      });
      res.json({ ok: true, data: rows.map(serializeServiceTicket) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.get("/api/liff/service-tickets/:ticketId", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const ticketId = toBigInt(req.params.ticketId);
      if (!ticketId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const row = await prisma.serviceTicket.findFirst({
        where: { id: ticketId, customerId: member.customerId },
        include: serviceTicketInclude,
      });
      if (!row) {
        res.status(404).json({ ok: false, message: "找不到服務單" });
        return;
      }
      res.json({ ok: true, data: serializeServiceTicket(row) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/service-tickets", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const serviceTypeRaw = req.body?.serviceType;
      if (!isServiceType(serviceTypeRaw)) {
        res.status(400).json({ ok: false, message: "請選擇服務類型（清洗／維修／兩者）" });
        return;
      }
      const deliveryAddressId = toBigInt(req.body?.deliveryAddressId);
      if (!deliveryAddressId) {
        res.status(400).json({ ok: false, message: "請選擇服務地址" });
        return;
      }
      const addr = await prisma.deliveryAddress.findFirst({
        where: { id: deliveryAddressId, customerId: member.customerId },
        select: { id: true },
      });
      if (!addr) {
        res.status(400).json({ ok: false, message: "地址不屬於此會員" });
        return;
      }

      const preferredDateRaw =
        typeof req.body?.preferredDate === "string" ? req.body.preferredDate.trim() : "";
      let preferredDate: Date | null = null;
      if (preferredDateRaw) {
        const range = parseLocalYmdRange(preferredDateRaw);
        if (!range) {
          res.status(400).json({ ok: false, message: "希望日期格式須為 YYYY-MM-DD" });
          return;
        }
        const [y, mo, d] = preferredDateRaw.split("-").map(Number);
        preferredDate = new Date(Date.UTC(y, mo - 1, d));
      }

      const preferredSlot =
        typeof req.body?.preferredSlot === "string" ? req.body.preferredSlot.trim() || null : null;
      const problemNote =
        typeof req.body?.problemNote === "string" ? req.body.problemNote.trim() || null : null;
      const customerNote =
        typeof req.body?.customerNote === "string" ? req.body.customerNote.trim() || null : null;
      const needLoaner = req.body?.needLoaner === true || req.body?.needLoaner === "true" || req.body?.needLoaner === 1;
      const loanerNote =
        typeof req.body?.loanerNote === "string" ? req.body.loanerNote.trim() || null : null;

      if (!problemNote) {
        res.status(400).json({ ok: false, message: "請填寫問題說明" });
        return;
      }

      const created = await createServiceTicket(prisma, {
        customerId: member.customerId,
        deliveryAddressId,
        serviceType: serviceTypeRaw,
        preferredDate,
        preferredSlot,
        problemNote,
        customerNote,
        needLoaner,
        loanerNote: needLoaner
          ? loanerNote ?? "客戶回報：若需載回廠維修，請提供備用機"
          : null,
        source: "liff",
      });

      void notifyCustomerViaLine(prisma, {
        customerId: member.customerId,
        eventType: "service_ticket_created",
        text: `已收到您的飲水機服務回報（${created.ticketNo}｜${serviceTypeLabel(created.serviceType)}），客服受理後會安排人員評估，謝謝。`,
        payload: { serviceTicketId: created.id.toString(), ticketNo: created.ticketNo },
      }).catch((err) => console.error("[line-notify] service_ticket_created", err));

      res.status(201).json({ ok: true, data: serializeServiceTicket(created) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/service-tickets/:ticketId/request-loaner", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const ticketId = toBigInt(req.params.ticketId);
      if (!ticketId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;
      const existing = await prisma.serviceTicket.findFirst({
        where: { id: ticketId, customerId: member.customerId },
      });
      if (!existing) {
        res.status(404).json({ ok: false, message: "找不到服務單" });
        return;
      }
      if (!["pending_pickup", "pending_loaner"].includes(existing.status)) {
        res.status(400).json({ ok: false, message: "目前狀態無法申請臨時機（需為待載回）" });
        return;
      }
      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        await tx.serviceTicket.update({
          where: { id: ticketId },
          data: {
            status: "pending_loaner",
            needLoaner: true,
            loanerNote: note,
            loanerRequestedAt: existing.loanerRequestedAt ?? now,
          },
        });
        await tx.serviceTicketEvent.create({
          data: {
            serviceTicketId: ticketId,
            eventType: "loaner_requested_by_customer",
            payloadJson: { note },
          },
        });
        return tx.serviceTicket.findUniqueOrThrow({
          where: { id: ticketId },
          include: serviceTicketInclude,
        });
      });
      void notifyCustomerViaLine(prisma, {
        customerId: member.customerId,
        eventType: "service_ticket_loaner_needed",
        text: `已收到您的臨時機需求（${existing.ticketNo}），客服會安排司機攜帶臨時機前往換機。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo },
      }).catch((err) => console.error("[line-notify] loaner_requested_by_customer", err));
      res.json({ ok: true, data: serializeServiceTicket(updated) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/liff/service-tickets/:ticketId/quote-respond", requireMember, async (req, res) => {
    try {
      const member = getLiffMember(req)!;
      const ticketId = toBigInt(req.params.ticketId);
      const accept = req.body?.accept === true || req.body?.accept === "true";
      if (!ticketId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const existing = await prisma.serviceTicket.findFirst({
        where: { id: ticketId, customerId: member.customerId },
      });
      if (!existing || existing.status !== "quote_pending") {
        res.status(400).json({ ok: false, message: "目前沒有待確認的報價" });
        return;
      }
      const now = new Date();
      const nextStatus = accept ? "quote_accepted" : "quote_rejected";
      const updated = await prisma.$transaction(async (tx) => {
        await tx.serviceTicket.update({
          where: { id: ticketId },
          data: {
            status: nextStatus,
            quoteStatus: accept ? "accepted" : "rejected",
            quoteRespondedAt: now,
            chargeAmount: accept ? existing.quoteAmount : existing.chargeAmount,
          },
        });
        await tx.serviceTicketEvent.create({
          data: {
            serviceTicketId: ticketId,
            eventType: accept ? "quote_accepted" : "quote_rejected",
            payloadJson: { via: "liff" },
          },
        });
        return tx.serviceTicket.findUniqueOrThrow({
          where: { id: ticketId },
          include: serviceTicketInclude,
        });
      });
      res.json({ ok: true, data: serializeServiceTicket(updated) });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/customers/:customerId/line-bind-code", async (req, res) => {
    const auth = requireStaffRole(req, res, ["admin", "accounting", "dispatcher"]);
    if (!auth) return;
    try {
      const customerId = toBigInt(req.params.customerId);
      if (!customerId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, customerCode: true, lineUserId: true },
      });
      if (!customer) {
        res.status(404).json({ ok: false, message: "找不到客戶" });
        return;
      }
      if (customer.lineUserId) {
        res.status(400).json({ ok: false, message: "此客戶已綁定 LINE，請先解除綁定" });
        return;
      }
      let customerCode = customer.customerCode;
      if (!customerCode) {
        customerCode = await allocateCustomerCode(prisma);
        await prisma.customer.update({
          where: { id: customer.id },
          data: { customerCode },
        });
      }
      const issued = await issueLineBindCode(prisma, {
        customerId: customer.id,
        createdByUserId: auth.id,
      });
      await prisma.operationAuditLog.create({
        data: {
          actorUserId: auth.id,
          action: "line_bind_code_issue",
          entityType: "customer",
          entityId: customer.id.toString(),
          afterJson: {
            customerCode,
            expiresAt: issued.expiresAt.toISOString(),
          },
        },
      });
      res.status(201).json({
        ok: true,
        data: {
          customerCode,
          bindCode: issued.code,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });

  app.post("/api/customers/:customerId/unbind-line", async (req, res) => {
    const auth = requireStaffRole(req, res, ["admin"]);
    if (!auth) return;
    try {
      const customerId = toBigInt(req.params.customerId);
      if (!customerId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const existing = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, lineUserId: true, lineBoundAt: true, name: true },
      });
      if (!existing) {
        res.status(404).json({ ok: false, message: "找不到客戶" });
        return;
      }
      if (existing.lineUserId) {
        await pushLineText(
          existing.lineUserId,
          "【超好企業】您的 LINE 訂水綁定已由客服解除。若要再次使用，請向客服申請綁定碼。",
        ).catch((err) => console.error("[line-unbind-notify]", err));
      }
      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: { lineUserId: null, lineBoundAt: null },
      });
      await prisma.operationAuditLog.create({
        data: {
          actorUserId: auth.id,
          action: "line_unbind",
          entityType: "customer",
          entityId: customerId.toString(),
          beforeJson: { lineUserId: existing.lineUserId, lineBoundAt: existing.lineBoundAt },
          afterJson: { lineUserId: null, lineBoundAt: null },
        },
      });
      res.json({
        ok: true,
        data: {
          id: updated.id.toString(),
          lineUserId: updated.lineUserId,
          lineBoundAt: updated.lineBoundAt,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: publicErrorMessage(e) });
    }
  });
}

export function isLiffPublicPath(path: string): boolean {
  return (
    path === "/api/line/webhook" ||
    path === "/api/liff/session" ||
    path === "/api/liff/bind"
  );
}

export function isLiffApiPath(path: string): boolean {
  return path.startsWith("/api/liff/") || path === "/api/line/webhook";
}

export { normalizeMobile };
