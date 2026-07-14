import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import jwt, { type JwtPayload, type Secret, type SignOptions } from "jsonwebtoken";
import {
  formatOrderCreatedMessage,
  notifyCustomerViaLine,
  replyText,
  verifyLiffIdToken,
  WELCOME_MESSAGE,
} from "./messaging.js";
import { issueLineOtp, normalizeMobile, verifyLineOtp, verifyLineWebhookSignature } from "./otp.js";

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

function findCustomerByMobile(prisma: PrismaClient, mobile: string) {
  return prisma.customer.findFirst({
    where: {
      OR: [{ mobile }, { phone: mobile }],
    },
    include: { addresses: { orderBy: { id: "asc" } } },
  });
}

export function registerLiffRoutes(app: Express, deps: LiffRouteDeps): void {
  const { prisma, jwtSecret, jwtSignOptions, createSalesOrder, toBigInt } = deps;

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
      const payload = jwt.verify(match[1], jwtSecret) as AuthPayload;
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
      if (raw && process.env.LINE_CHANNEL_SECRET) {
        const sig = Array.isArray(signature) ? signature[0] : signature;
        if (!verifyLineWebhookSignature(raw, sig)) {
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
      res.status(500).json({ ok: false, message: String(e) });
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
          customer: {
            id: customer.id.toString(),
            customerCode: customer.customerCode,
            name: customer.name,
            mobile: customer.mobile,
            phone: customer.phone,
            billingType: customer.billingType,
            addresses: customer.addresses,
          },
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/liff/otp/request", async (req, res) => {
    try {
      const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
      const mobileRaw = typeof req.body?.mobile === "string" ? req.body.mobile : "";
      const verified = await verifyLiffIdToken(idToken);
      if (!verified.ok) {
        res.status(401).json({ ok: false, message: verified.message });
        return;
      }
      const issued = await issueLineOtp(prisma, { mobile: mobileRaw, lineUserId: verified.lineUserId });
      if (!issued.ok) {
        res.status(400).json({ ok: false, message: issued.message });
        return;
      }
      res.json({
        ok: true,
        data: {
          expiresAt: issued.expiresAt.toISOString(),
          delivery: issued.delivery,
          ...(issued.devCode ? { devCode: issued.devCode } : {}),
          ...(issued.skipped ? { skipped: true } : {}),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/liff/bind", async (req, res) => {
    try {
      const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
      const mobileRaw = typeof req.body?.mobile === "string" ? req.body.mobile : "";
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const addressLine = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";
      const deliveryFloor =
        req.body?.deliveryFloor != null && String(req.body.deliveryFloor).trim() !== ""
          ? Number(req.body.deliveryFloor)
          : null;

      const verified = await verifyLiffIdToken(idToken);
      if (!verified.ok) {
        res.status(401).json({ ok: false, message: verified.message });
        return;
      }

      const otp = await verifyLineOtp(prisma, {
        mobile: mobileRaw,
        lineUserId: verified.lineUserId,
        code,
      });
      if (!otp.ok) {
        res.status(400).json({ ok: false, message: otp.message });
        return;
      }

      const existingByLine = await prisma.customer.findFirst({
        where: { lineUserId: verified.lineUserId },
      });
      if (existingByLine) {
        res.status(400).json({ ok: false, message: "此 LINE 帳號已綁定會員" });
        return;
      }

      let customer = await findCustomerByMobile(prisma, otp.mobile);
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
            mobile: otp.mobile,
            phone: otp.mobile,
            billingType: "cash",
            lineUserId: verified.lineUserId,
            lineBoundAt: new Date(),
            addresses: {
              create: {
                addressLine,
                deliveryFloor: Number.isFinite(deliveryFloor) ? deliveryFloor : null,
                contactMobile: otp.mobile,
                isDefault: true,
                label: "預設",
              },
            },
          },
          include: { addresses: { orderBy: { id: "asc" } } },
        });
      } else {
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: {
            lineUserId: verified.lineUserId,
            lineBoundAt: new Date(),
            mobile: customer.mobile || otp.mobile,
          },
          include: { addresses: { orderBy: { id: "asc" } } },
        });
      }

      const token = signMemberToken({ customerId: customer.id, lineUserId: verified.lineUserId });
      res.status(201).json({
        ok: true,
        data: {
          token,
          customer: {
            id: customer.id.toString(),
            customerCode: customer.customerCode,
            name: customer.name,
            mobile: customer.mobile,
            phone: customer.phone,
            billingType: customer.billingType,
            addresses: customer.addresses,
          },
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
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
        data: {
          id: customer.id.toString(),
          customerCode: customer.customerCode,
          name: customer.name,
          mobile: customer.mobile,
          phone: customer.phone,
          billingType: customer.billingType,
          addresses: customer.addresses,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/liff/products", requireMember, async (_req, res) => {
    try {
      const rows = await prisma.product.findMany({
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
      });
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
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
      res.status(500).json({ ok: false, message: String(e) });
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
        },
        orderBy: { id: "desc" },
        take: 50,
      });
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
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
        },
      });
      if (!row) {
        res.status(404).json({ ok: false, message: "找不到訂單" });
        return;
      }
      res.json({ ok: true, data: row });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
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
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/customers/:customerId/unbind-line", async (req, res) => {
    try {
      const customerId = toBigInt(req.params.customerId);
      if (!customerId) {
        res.status(400).json({ ok: false, message: "參數錯誤" });
        return;
      }
      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: { lineUserId: null, lineBoundAt: null },
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
      res.status(500).json({ ok: false, message: String(e) });
    }
  });
}

export function isLiffPublicPath(path: string): boolean {
  return (
    path === "/api/line/webhook" ||
    path === "/api/liff/session" ||
    path === "/api/liff/otp/request" ||
    path === "/api/liff/bind"
  );
}

export function isLiffApiPath(path: string): boolean {
  return path.startsWith("/api/liff/") || path === "/api/line/webhook";
}

export { normalizeMobile };
