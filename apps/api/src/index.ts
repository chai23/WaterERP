import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import { randomBytes } from "crypto";
import jwt, { type JwtPayload, type Secret, type SignOptions } from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  applyPromotions,
  serializeDispenserGiftRule,
  serializePromotionRule,
  validatePrepaidTopupBonusConfig,
  type DraftOrderLine,
} from "./promotions.js";
import { isLiffApiPath, registerLiffRoutes } from "./line/liffRoutes.js";
import { normalizeMobile } from "./line/otp.js";
import {
  formatDeliveredMessage,
  formatNotDeliveredMessage,
  formatOrderAssignedMessage,
  notifyCustomerViaLine,
} from "./line/messaging.js";
import {
  assertJwtSecret,
  inspectLoginThrottle,
  isProductionRuntime,
  loginThrottleKey,
  noteLoginFailure,
  noteLoginSuccess,
  passwordPolicyError,
  publicErrorMessage,
} from "./security.js";
import {
  createServiceTicket,
  isServiceType,
  serializeServiceTicketAdmin,
  serviceTicketAdminInclude,
  serviceTicketStatusLabel,
  serviceTypeLabel,
} from "./serviceTickets.js";
import { createDeliveryAssignment } from "./createDeliveryAssignment.js";
import { registerDeliveryPlanningRoutes } from "./modules/delivery-planning/routes.js";
import { isDeliveryPlanningEnabled } from "./modules/delivery-planning/flag.js";
import { registerLegacyHistoryRoutes } from "./modules/legacy-history/routes.js";
import {
  generalEffectiveLatest,
  patrolWindow,
} from "./modules/delivery-planning/shiftSla.js";
import { loadPlanningSettings, slaConfigFromSettings } from "./modules/delivery-planning/settings.js";

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST ?? "127.0.0.1";
const DEFAULT_CREATOR_USER_ID = 1n;
const JWT_SECRET: Secret = process.env.JWT_SECRET ?? "change-me";
const JWT_SIGN_OPTIONS = { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d", algorithm: "HS256" } as SignOptions;
assertJwtSecret(String(JWT_SECRET));

type AuthUser = {
  id: bigint;
  employeeCode: string;
  name: string;
  role: string;
  driverId: bigint | null;
};

type AuthPayload = JwtPayload & {
  sub?: string;
  role?: string;
  employeeCode?: string;
  typ?: string;
};

const publicApiPaths = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/bootstrap",
  "/api/line/webhook",
  "/api/liff/session",
  "/api/liff/bind",
]);

const toPublicUser = (user: { id: bigint; employeeCode: string; phone: string | null; name: string; role: string; isActive: boolean; driver?: { id: bigint } | null }) => ({
  id: user.id.toString(),
  employeeCode: user.employeeCode,
  phone: user.phone,
  name: user.name,
  role: user.role,
  isActive: user.isActive,
  driverId: user.driver?.id?.toString() ?? null,
});

function getAuthUser(req: express.Request): AuthUser | null {
  return ((req as express.Request & { authUser?: AuthUser }).authUser ?? null);
}

function requireRole(req: express.Request, res: express.Response, roles: readonly string[]): AuthUser | null {
  const user = getAuthUser(req);
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

/** Prisma Json 可接受的值：bigint → string */
function toAuditJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

async function writeOperationAuditLog(
  client: Prisma.TransactionClient | PrismaClient,
  args: {
    actorUserId?: bigint | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await client.operationAuditLog.create({
    data: {
      actorUserId: args.actorUserId ?? null,
      action: args.action,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
      beforeJson: args.before === undefined ? undefined : toAuditJson(args.before),
      afterJson: args.after === undefined ? undefined : toAuditJson(args.after),
    },
  });
}

const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

const toBigInt = (value: unknown): bigint | null => {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  } catch {
    return null;
  }
  return null;
};

const parsePositiveInt = (value: unknown, fallback: number): number => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const normalizeCustomerCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code;
};

const normalizeProductCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!/^\d{3}$/.test(code)) return null;
  return code;
};

const generateTimestampNo = (prefix: string): string => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const suf = randomBytes(2).toString("hex");
  return `${prefix}${yyyy}${mm}${dd}${hh}${min}${ss}${ms}${suf}`;
};

const generateOrderNo = (): string => {
  return generateTimestampNo("SO");
};

const generateArNo = (): string => {
  return generateTimestampNo("AR");
};

const generateReceiptVoucherNo = (): string => {
  return generateTimestampNo("RV");
};

const generateCreditNo = (): string => {
  return generateTimestampNo("CN");
};

/** 營業稅率（未稅為本位）；可用環境變數 VAT_RATE 覆寫，例如 0.05 */
const DEFAULT_VAT_RATE = new Prisma.Decimal(String(process.env.VAT_RATE ?? "0.05"));

const generateStatementNo = (): string => {
  return generateTimestampNo("BS");
};

const generateTaxInvoiceNo = (): string => {
  return generateTimestampNo("TI");
};

/** @db.Date（UTC 午夜）→ 編號用曆日字串 */
const allocatePickupNo = async (tx: Prisma.TransactionClient, pickupDate: Date): Promise<string> => {
  const yyyy = pickupDate.getUTCFullYear();
  const mm = String(pickupDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(pickupDate.getUTCDate()).padStart(2, "0");
  const prefix = `BP${yyyy}${mm}${dd}`;
  const last = await tx.barrelPickup.findFirst({
    where: { pickupNo: { startsWith: prefix } },
    orderBy: { pickupNo: "desc" },
    select: { pickupNo: true },
  });
  let seq = 1;
  if (last) {
    const tail = last.pickupNo.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

const barrelPickupInclude = {
  customer: true,
  deliveryAddress: true,
  driver: { include: { user: true } },
  vehicle: true,
  events: { orderBy: { id: "asc" as const } },
} as const;

const deliveryBarrelCollectionInclude = {
  salesOrder: {
    include: {
      customer: true,
      deliveryAddress: true,
      lines: { include: { product: { select: { countsDepositBarrel: true } } } },
    },
  },
  driver: { include: { user: true } },
  vehicle: true,
} as const;

function countDepositBarrelsDelivered(
  lines: Array<{
    qtyOrdered: number;
    qtyDelivered: number;
    linePurpose?: string | null;
    product?: { countsDepositBarrel?: boolean } | null;
  }>,
): number {
  let total = 0;
  for (const line of lines) {
    const purpose = line.linePurpose ?? "delivery";
    if (purpose === "prepaid_barrel_topup") continue;
    if (line.product?.countsDepositBarrel === true) {
      total += effectiveLineDeliveryQty(line);
    }
  }
  return total;
}

function mapAssignmentStatusForCollection(status: string): string {
  if (status === "delivering") return "assigned";
  return status;
}

function collectionDateFromAssignment(a: { driverReportedAt: Date | null; assignmentDate: Date }): string {
  if (a.driverReportedAt) return toLocalYmd(a.driverReportedAt);
  return toLocalYmd(a.assignmentDate);
}

function collectionDateInRange(collectionDate: string, dateFrom: string, dateTo: string): boolean {
  if (dateFrom && collectionDate < dateFrom) return false;
  if (dateTo && collectionDate > dateTo) return false;
  return true;
}

function barrelCollectionHaystack(row: {
  refNo: string;
  customer?: { name?: string | null; customerCode?: string | null } | null;
  deliveryAddress?: { addressLine?: string | null; label?: string | null } | null;
  driver?: { user?: { employeeCode?: string | null; name?: string | null } | null } | null;
}): string {
  return [
    row.refNo,
    row.customer?.name,
    row.customer?.customerCode,
    row.deliveryAddress?.addressLine,
    row.deliveryAddress?.label,
    row.driver?.user?.employeeCode,
    row.driver?.user?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function recordBarrelMovement(
  tx: Prisma.TransactionClient,
  args: {
    sourceType: "pickup" | "delivery";
    sourceRefId: bigint;
    refNo: string;
    movementDate: Date;
    occurredAt: Date;
    customerId: bigint;
    deliveryAddressId: bigint;
    barrelsReturned: number;
    barrelsDelivered: number;
    barrelDelta: number;
    barrelsOnSiteBefore: number;
    barrelsOnSiteAfter: number;
    driverId?: bigint | null;
    vehicleId?: bigint | null;
    salesOrderId?: bigint | null;
    barrelPickupId?: bigint | null;
    deliveryAssignmentId?: bigint | null;
    note?: string | null;
    createdByUserId?: bigint | null;
  },
): Promise<void> {
  const localYmd = toLocalYmd(args.movementDate);
  const parsed = parseLocalYmdRange(localYmd);
  const movementDate = parsed?.start ?? args.movementDate;
  await tx.barrelMovement.upsert({
    where: {
      sourceType_sourceRefId: {
        sourceType: args.sourceType,
        sourceRefId: args.sourceRefId,
      },
    },
    create: {
      movementDate,
      occurredAt: args.occurredAt,
      sourceType: args.sourceType,
      sourceRefId: args.sourceRefId,
      refNo: args.refNo,
      customerId: args.customerId,
      deliveryAddressId: args.deliveryAddressId,
      barrelsReturned: args.barrelsReturned,
      barrelsDelivered: args.barrelsDelivered,
      barrelDelta: args.barrelDelta,
      barrelsOnSiteBefore: args.barrelsOnSiteBefore,
      barrelsOnSiteAfter: args.barrelsOnSiteAfter,
      driverId: args.driverId ?? null,
      vehicleId: args.vehicleId ?? null,
      salesOrderId: args.salesOrderId ?? null,
      barrelPickupId: args.barrelPickupId ?? null,
      deliveryAssignmentId: args.deliveryAssignmentId ?? null,
      note: args.note ?? null,
      createdByUserId: args.createdByUserId ?? null,
    },
    update: {
      movementDate,
      occurredAt: args.occurredAt,
      refNo: args.refNo,
      barrelsReturned: args.barrelsReturned,
      barrelsDelivered: args.barrelsDelivered,
      barrelDelta: args.barrelDelta,
      barrelsOnSiteBefore: args.barrelsOnSiteBefore,
      barrelsOnSiteAfter: args.barrelsOnSiteAfter,
      note: args.note ?? null,
    },
  });
}

const salesOrderDetailInclude = {
  customer: true,
  deliveryAddress: true,
  lines: { include: { product: true } },
  taxInvoices: { orderBy: { id: "asc" as const } },
  assignments: {
    include: {
      driver: { include: { user: true } },
      vehicle: true,
    },
    orderBy: { id: "desc" as const },
  },
} as const;

const barrelMovementListInclude = {
  customer: true,
  deliveryAddress: true,
  driver: { include: { user: true } },
  vehicle: true,
} as const;

function formatBarrelSiteChangeSummary(row: {
  sourceType?: string | null;
  status?: string | null;
  barrelsOnSiteBefore?: number | null;
  barrelsDelivered?: number | null;
  barrelsReturned?: number | null;
  barrelsOnSiteAfter?: number | null;
  barrelSitePreview?: boolean;
}): string | null {
  if (row.barrelsOnSiteBefore == null || row.barrelsOnSiteAfter == null) return null;
  const before = row.barrelsOnSiteBefore;
  const delivered = Math.max(0, Number(row.barrelsDelivered ?? 0));
  const returned = Math.max(0, Number(row.barrelsReturned ?? 0));
  const after = row.barrelsOnSiteAfter;
  const pending = row.status === "pending_settlement" || row.barrelSitePreview;
  const suffix = pending ? "（待核銷）" : "";
  if (row.sourceType === "delivery" && delivered > 0) {
    return `原 ${before} → 送 ${delivered} 收 ${returned} → 餘 ${after}${suffix}`;
  }
  if (returned > 0) {
    return `原 ${before} → 收 ${returned} → 餘 ${after}${suffix}`;
  }
  return `原 ${before} → 餘 ${after}${suffix}`;
}

function reconcileAddressBarrelBalances(
  movements: Array<{ id: bigint; barrelDelta: number }>,
  currentOnSite: number,
): Map<string, { before: number; after: number }> {
  const result = new Map<string, { before: number; after: number }>();
  if (movements.length === 0) return result;
  const totalDelta = movements.reduce((sum, row) => sum + row.barrelDelta, 0);
  let balance = currentOnSite - totalDelta;
  for (const movement of movements) {
    const before = balance;
    const after = before + movement.barrelDelta;
    result.set(movement.id.toString(), { before, after });
    balance = after;
  }
  return result;
}

async function attachBarrelSiteBalances(
  rows: Array<Record<string, unknown>>,
  db: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  if (rows.length === 0) return;

  const addressIds = new Set<bigint>();
  for (const row of rows) {
    const addr = row.deliveryAddress as { id?: string } | null | undefined;
    if (addr?.id) addressIds.add(BigInt(String(addr.id)));
  }
  if (addressIds.size === 0) return;

  const addresses = await db.deliveryAddress.findMany({
    where: { id: { in: [...addressIds] } },
    select: { id: true, barrelsOnSite: true },
  });
  const onSiteMap = new Map(addresses.map((a) => [a.id.toString(), a.barrelsOnSite]));

  const allMovements = await db.barrelMovement.findMany({
    where: { deliveryAddressId: { in: [...addressIds] } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { id: true, sourceType: true, sourceRefId: true, deliveryAddressId: true, barrelDelta: true },
  });

  const movementsByAddress = new Map<string, Array<{ id: bigint; barrelDelta: number }>>();
  const movementRefKey = new Map<string, string>();
  for (const movement of allMovements) {
    const addrId = movement.deliveryAddressId.toString();
    if (!movementsByAddress.has(addrId)) movementsByAddress.set(addrId, []);
    movementsByAddress.get(addrId)!.push({ id: movement.id, barrelDelta: movement.barrelDelta });
    movementRefKey.set(`${movement.sourceType}:${movement.sourceRefId.toString()}`, movement.id.toString());
  }

  const reconciledByMovementId = new Map<string, { before: number; after: number }>();
  for (const [addrId, movements] of movementsByAddress) {
    const current = onSiteMap.get(addrId) ?? 0;
    const reconciled = reconcileAddressBarrelBalances(movements, current);
    for (const [id, value] of reconciled) reconciledByMovementId.set(id, value);
  }

  for (const row of rows) {
    const status = String(row.status ?? "");
    const sourceType = String(row.sourceType ?? "");
    const addr = row.deliveryAddress as { id?: string; barrelsOnSite?: number } | null | undefined;
    const addrId = addr?.id ? String(addr.id) : "";

    if (status === "completed") {
      const movementId =
        row.ledgerId != null
          ? String(row.ledgerId)
          : movementRefKey.get(`${sourceType}:${String(row.id)}`);
      if (movementId && reconciledByMovementId.has(movementId)) {
        const site = reconciledByMovementId.get(movementId)!;
        row.barrelsOnSiteBefore = site.before;
        row.barrelsOnSiteAfter = site.after;
      }
    } else if (status === "pending_settlement") {
      const current = addrId ? (onSiteMap.get(addrId) ?? 0) : 0;
      const returned = Math.max(0, Number(row.barrelsReturned ?? 0));
      const delivered = Math.max(0, Number(row.barrelsDelivered ?? 0));
      const delta =
        sourceType === "delivery"
          ? row.barrelNet != null
            ? Number(row.barrelNet)
            : delivered - returned
          : -returned;
      row.barrelsOnSiteBefore = current;
      row.barrelsOnSiteAfter = Math.max(0, current + delta);
      row.barrelSitePreview = true;
    }

    row.barrelSiteChangeSummary = formatBarrelSiteChangeSummary({
      sourceType,
      status,
      barrelsOnSiteBefore: row.barrelsOnSiteBefore as number | null | undefined,
      barrelsDelivered: row.barrelsDelivered as number | null | undefined,
      barrelsReturned: row.barrelsReturned as number | null | undefined,
      barrelsOnSiteAfter: row.barrelsOnSiteAfter as number | null | undefined,
      barrelSitePreview: row.barrelSitePreview as boolean | undefined,
    });
  }
}

/** 稅外加：未稅為本位；四捨五入至小數點後 2 位 */
function computeTaxFromUntaxed(untaxed: Prisma.Decimal, rate: Prisma.Decimal): { taxAmount: Prisma.Decimal; totalWithTax: Prisma.Decimal } {
  const taxAmount = untaxed.mul(rate).toDecimalPlaces(2);
  return { taxAmount, totalWithTax: untaxed.plus(taxAmount) };
}

function normalizeCashInvoiceMode(raw: unknown): "none" | "tax_inclusive" | "tax_exclusive" {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "tax_inclusive" || s === "tax_exclusive" || s === "none") return s;
  return "none";
}

function trimOptionalString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** 統一編號：8 碼數字；空值允許 */
function normalizeTaxId(raw: unknown): string | null | "INVALID" {
  const s = trimOptionalString(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 8) return "INVALID";
  return digits;
}

function normalizeLineInvoiceMode(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "tax_inclusive" || s === "tax_exclusive" || s === "none") return s;
  return null;
}

function computeMonthlyDueDate(monthlySettlementDay: number | null, ref: Date): Date | null {
  if (monthlySettlementDay == null || monthlySettlementDay < 1 || monthlySettlementDay > 31) return null;
  let dueDate = new Date(ref.getFullYear(), ref.getMonth(), monthlySettlementDay);
  if (dueDate.getTime() < ref.getTime()) {
    dueDate = new Date(ref.getFullYear(), ref.getMonth() + 1, monthlySettlementDay);
  }
  return dueDate;
}

const toLocalYmd = (date: Date): string => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

/** 解析 YYYY-MM-DD 為本地日期的起訖（供 assignment_date 區間查詢，避免時區偏一天） */
const parseLocalYmdRange = (ymd: string): { start: Date; end: Date } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const start = new Date(y, mo - 1, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  const end = new Date(y, mo - 1, d + 1);
  return { start, end };
};

/** Prisma @db.Date：以 UTC 午夜表示曆日（讀寫與查詢一致，避免本地午夜 equality 差 8 小時） */
const parseLocalYmdToDbDate = (ymd: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
};

/** 收款／匯款日：paidAtYmd（YYYY-MM-DD 本地）優先；paidAt 可為 YYYY-MM-DD 或 ISO；未傳則為現在 */
function resolvePaidAtFromBody(body: { paidAt?: unknown; paidAtYmd?: unknown }): Date | { error: string } {
  const ymdRaw = typeof body.paidAtYmd === "string" ? body.paidAtYmd.trim() : "";
  if (ymdRaw) {
    const parsed = parseLocalYmdRange(ymdRaw);
    if (!parsed) return { error: "paidAtYmd 須為 YYYY-MM-DD" };
    return parsed.start;
  }
  const paidAtRaw = typeof body.paidAt === "string" ? body.paidAt.trim() : "";
  if (paidAtRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(paidAtRaw)) {
      const parsed = parseLocalYmdRange(paidAtRaw);
      if (!parsed) return { error: "paidAt 須為有效 YYYY-MM-DD" };
      return parsed.start;
    }
    const d = new Date(paidAtRaw);
    if (Number.isNaN(d.getTime())) return { error: "paidAt 須為有效日期時間" };
    return d;
  }
  return new Date();
}

/** 單日 @db.Date 查詢條件 */
const dbDateEqualsFilter = (ymd: string): Prisma.DateTimeFilter | null => {
  const day = parseLocalYmdToDbDate(ymd);
  if (!day) return null;
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + 1);
  return { gte: day, lt: next };
};

const fmtDbDateYmd = (d: Date): string => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

/** 月結 v1：依核銷完成日所屬曆月 */
const billingPeriodKeyFromDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const decMin = (a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal => (a.lessThan(b) ? a : b);
const decMax = (a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal => (a.greaterThan(b) ? a : b);

function arStatusFromOutstanding(outstanding: Prisma.Decimal, _dueDate: Date | null | undefined): string {
  if (outstanding.lessThanOrEqualTo(0)) return "paid";
  return "unpaid";
}

/** 有效 AR open item：排除已作廢立帳與已取消訂單 */
function activeArOpenItemWhere(extra?: Prisma.ArOpenItemWhereInput): Prisma.ArOpenItemWhereInput {
  const filters: Prisma.ArOpenItemWhereInput[] = [
    { outstandingAmount: { gt: new Prisma.Decimal(0) } },
    { arDocument: { status: { not: "voided" } } },
    { OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }] },
  ];
  if (extra && Object.keys(extra).length > 0) filters.unshift(extra);
  return filters.length === 1 ? filters[0]! : { AND: filters };
}

/** 有效 AR 立帳文件：排除已作廢與已取消訂單 */
function activeArDocumentWhere(extra?: Prisma.ArDocumentWhereInput): Prisma.ArDocumentWhereInput {
  const filters: Prisma.ArDocumentWhereInput[] = [
    { status: { not: "voided" } },
    { OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }] },
  ];
  if (extra && Object.keys(extra).length > 0) filters.unshift(extra);
  return filters.length === 1 ? filters[0]! : { AND: filters };
}

const NON_CANCELLABLE_ORDER_STATUSES = ["assigned", "delivering", "completed"] as const;
const NON_CANCELLABLE_ASSIGNMENT_STATUSES = [
  "assigned",
  "delivering",
  "pending_settlement",
  "completed",
  "not_delivered",
] as const;

/** 取消訂單時作廢開單時建立之 AR（須在交易內呼叫；呼叫前應已確認無沖帳） */
async function voidArForCancelledSalesOrder(tx: Prisma.TransactionClient, salesOrderId: bigint): Promise<void> {
  const docs = await tx.arDocument.findMany({
    where: { salesOrderId, status: { not: "voided" } },
    include: { openItems: { include: { allocations: true } } },
  });
  for (const d of docs) {
    for (const oi of d.openItems) {
      if (oi.allocations.length > 0 || new Prisma.Decimal(oi.allocatedAmount).greaterThan(0)) {
        throw new Error("AR_ALREADY_ALLOCATED");
      }
      await tx.arOpenItem.update({
        where: { id: oi.id },
        data: {
          outstandingAmount: new Prisma.Decimal(0),
          status: "paid",
        },
      });
    }
    await tx.arDocument.update({
      where: { id: d.id },
      data: { status: "voided" },
    });
  }
  await tx.taxInvoice.updateMany({
    where: { salesOrderId, status: { in: ["planned", "issued"] } },
    data: { status: "voided" },
  });
}

async function ensurePrepaymentWallet(tx: Prisma.TransactionClient, customerId: bigint) {
  const existing = await tx.customerPrepaymentWallet.findUnique({ where: { customerId } });
  if (existing) return existing;
  return tx.customerPrepaymentWallet.create({ data: { customerId, balanceAmount: new Prisma.Decimal(0) } });
}

/**
 * 自動預收抵扣：有預收餘額時，自動沖最近未清 AR（id 新到舊）。
 * 會寫入 receipt_voucher / ar_allocation_map / prepayment_txn。
 */
async function autoApplyPrepaymentToLatestOpenAr(
  tx: Prisma.TransactionClient,
  args: { customerId: bigint; note?: string },
): Promise<{ appliedAmount: Prisma.Decimal; balanceAfter: Prisma.Decimal }> {
  const wallet = await ensurePrepaymentWallet(tx, args.customerId);
  let remain = new Prisma.Decimal(wallet.balanceAmount);
  if (remain.lessThanOrEqualTo(0)) return { appliedAmount: new Prisma.Decimal(0), balanceAfter: remain };

  const opens = await tx.arOpenItem.findMany({
    where: activeArOpenItemWhere({ customerId: args.customerId }),
    include: {
      salesOrder: { select: { status: true, lines: { select: { qtyDelivered: true } } } },
    },
    orderBy: [{ id: "desc" }],
  });
  if (opens.length === 0) return { appliedAmount: new Prisma.Decimal(0), balanceAfter: remain };

  const allocRows: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];
  for (const open of opens) {
    if (remain.lessThanOrEqualTo(0)) break;
    if (open.salesOrderId != null && !isCollectiblePriorSalesOrderAr(open.salesOrder)) continue;
    const take = decMin(remain, new Prisma.Decimal(open.outstandingAmount));
    if (take.lessThanOrEqualTo(0)) continue;
    allocRows.push({ openItemId: open.id, amount: take });
    remain = remain.minus(take);
  }
  const appliedAmount = allocRows.reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0));
  if (appliedAmount.lessThanOrEqualTo(0)) {
    return { appliedAmount: new Prisma.Decimal(0), balanceAfter: new Prisma.Decimal(wallet.balanceAmount) };
  }

  const voucher = await tx.receiptVoucher.create({
    data: {
      voucherNo: generateReceiptVoucherNo(),
      customerId: args.customerId,
      voucherType: "prepayment_apply",
      paymentMethod: "prepayment",
      totalAmount: appliedAmount,
      unappliedAmount: new Prisma.Decimal(0),
      status: "applied",
      note: args.note ?? "自動預收抵扣未清 AR",
      createdByUserId: DEFAULT_CREATOR_USER_ID,
    },
  });
  await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: allocRows });
  const nextBalance = new Prisma.Decimal(wallet.balanceAmount).minus(appliedAmount);
  await tx.customerPrepaymentWallet.update({
    where: { customerId: args.customerId },
    data: { balanceAmount: nextBalance },
  });
  await tx.prepaymentTxn.create({
    data: {
      customerId: args.customerId,
      receiptVoucherId: voucher.id,
      txnType: "apply",
      amount: appliedAmount.negated(),
      balanceAfter: nextBalance,
      note: args.note ?? "自動預收抵扣未清 AR",
    },
  });
  return { appliedAmount, balanceAfter: nextBalance };
}

async function createArForSalesOrder(tx: Prisma.TransactionClient, args: {
  salesOrderId: bigint;
  orderNo: string;
  customerId: bigint;
  billingTypeAtOrder: string | null;
  totalAmount: Prisma.Decimal;
  cashSubtotal: Prisma.Decimal;
  monthlySubtotal: Prisma.Decimal;
  monthlySettlementDay: number | null;
  createdByUserId: bigint;
  cashInvoiceMode?: string | null;
}) {
  /** 現金列應收：稅外加時為含稅（與司機收款／發票一致）；月結改 R2 批次立帳 */
  const cashUntaxedBase = args.cashSubtotal.greaterThan(0)
    ? args.cashSubtotal
    : (args.billingTypeAtOrder === "cash" ? args.totalAmount : new Prisma.Decimal(0));
  const mode = normalizeCashInvoiceMode(args.cashInvoiceMode ?? "none");
  const br = breakdownCashTaxInvoice(cashUntaxedBase, mode);
  const cashPortion = br ? br.totalWithTax : cashUntaxedBase;

  const docs: Array<{ billingType: string; amount: Prisma.Decimal; dueDate: Date | null }> = [];
  if (cashPortion.greaterThan(0)) docs.push({ billingType: "cash", amount: cashPortion, dueDate: new Date() });

  for (const d of docs) {
    const ar = await tx.arDocument.create({
      data: {
        arNo: generateArNo(),
        customerId: args.customerId,
        salesOrderId: args.salesOrderId,
        documentType: "delivery",
        billingType: d.billingType,
        documentAmount: d.amount,
        dueDate: d.dueDate,
        status: "open",
        postedAt: new Date(),
        createdByUserId: args.createdByUserId,
      },
    });
    await tx.arOpenItem.create({
      data: {
        arDocumentId: ar.id,
        customerId: args.customerId,
        salesOrderId: args.salesOrderId,
        originalAmount: d.amount,
        allocatedAmount: new Prisma.Decimal(0),
        outstandingAmount: d.amount,
        dueDate: d.dueDate,
        expectedCollectDate: d.dueDate,
        status: arStatusFromOutstanding(d.amount, d.dueDate),
      },
    });
  }
}

/** 核銷／出庫用之實際配送桶數：回報後以 qtyDelivered 為準；舊資料未回報時 fallback qtyOrdered */
function effectiveLineDeliveryQty(line: {
  qtyOrdered: number;
  qtyDelivered: number;
  linePurpose?: string | null;
}): number {
  const purpose = line.linePurpose ?? "delivery";
  if (purpose === "prepaid_barrel_topup") return line.qtyOrdered;
  if (line.qtyDelivered > 0) return line.qtyDelivered;
  if (line.qtyOrdered === 0) return 0;
  return line.qtyOrdered;
}

function lineCountsInOrderTotal(
  line: { billingTypeAtLine: string | null; linePurpose?: string | null; productId?: bigint },
  allLines: Array<{ linePurpose?: string | null; productId?: bigint }>,
): boolean {
  const purpose = line.linePurpose ?? "delivery";
  if (purpose !== "delivery" || line.billingTypeAtLine !== "prepaid") return true;
  if (line.productId == null) return true;
  return !allLines.some(
    (l) => (l.linePurpose ?? "delivery") === "prepaid_barrel_topup" && l.productId === line.productId,
  );
}

function computeOrderTotalsFromLineAmounts(
  lines: Array<{
    lineAmount: Prisma.Decimal;
    billingTypeAtLine: string | null;
    linePurpose?: string | null;
    productId?: bigint;
  }>,
): {
  subtotal: Prisma.Decimal;
  cashSubtotal: Prisma.Decimal;
  monthlySubtotal: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
} {
  let subtotal = new Prisma.Decimal(0);
  let cashSubtotal = new Prisma.Decimal(0);
  let monthlySubtotal = new Prisma.Decimal(0);
  for (const line of lines) {
    if (!lineCountsInOrderTotal(line, lines)) continue;
    subtotal = subtotal.add(line.lineAmount);
    if (line.billingTypeAtLine === "cash") cashSubtotal = cashSubtotal.add(line.lineAmount);
    else if (line.billingTypeAtLine === "monthly") monthlySubtotal = monthlySubtotal.add(line.lineAmount);
  }
  return { subtotal, cashSubtotal, monthlySubtotal, totalAmount: subtotal };
}

/** 本單應向客戶收取之金額（現金應收含稅＋月結份額） */
function orderBillableAmount(o: {
  cashSubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
  cashInvoiceMode?: string | null;
  monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
}): Prisma.Decimal {
  return orderCashReceivablePortion(o).plus(orderMonthlyCap(o));
}

/** 司機回報之現場收款合計（現金＋支票） */
function assignmentFieldCollectedTotal(row: {
  cashReceived: Prisma.Decimal | number | { toString(): string };
  checkReceived?: Prisma.Decimal | number | { toString(): string } | null;
}): Prisma.Decimal {
  return new Prisma.Decimal(String(row.cashReceived ?? 0)).plus(new Prisma.Decimal(String(row.checkReceived ?? 0)));
}

function driverCollectionStatusLabel(args: {
  status: string;
  settlementOutcome: string | null;
  failureReason?: string | null;
  expectedAmount: number;
  collectedTotal: number;
}): string {
  if (args.status === "cancelled") return "已取消";
  if (args.status === "assigned" || args.status === "delivering") return "配送中（尚未回報）";
  if (args.settlementOutcome === "not_delivered" || args.status === "not_delivered") {
    return args.failureReason?.trim() ? `未送達：${args.failureReason.trim()}` : "未送達";
  }
  const exp = args.expectedAmount;
  const got = args.collectedTotal;
  if (exp <= 0 && got <= 0) {
    return args.status === "completed" ? "已結案·無現金應收" : "無現金應收（待核銷）";
  }
  if (args.status === "pending_settlement") {
    if (got === exp) return "回報足額·待核銷";
    if (got < exp) return `回報少收 ${(exp - got).toFixed(0)}·待核銷`;
    if (got > exp) return `回報多收 ${(got - exp).toFixed(0)}·待核銷`;
    return "待核銷";
  }
  switch (args.settlementOutcome) {
    case "delivered_cash_exact":
      return "已結案·足額";
    case "delivered_cash_short":
      return "已結案·少收";
    case "delivered_cash_over":
      return "已結案·多收";
    case "delivered_no_cash":
      return "已結案·未收款";
    default:
      return "已結案";
  }
}

/** 依回報後訂單金額重建未沖帳 AR；待開票發票僅就地更新，不作廢重建（實務上多於核銷後才開票） */
async function refreshOpenArForSalesOrder(
  tx: Prisma.TransactionClient,
  args: {
    salesOrderId: bigint;
    orderNo: string;
    customerId: bigint;
    billingTypeAtOrder: string | null;
    totalAmount: Prisma.Decimal;
    cashSubtotal: Prisma.Decimal;
    monthlySubtotal: Prisma.Decimal;
    monthlySettlementDay: number | null;
    createdByUserId: bigint;
    cashInvoiceMode?: string | null;
  },
): Promise<void> {
  const mode = normalizeCashInvoiceMode(args.cashInvoiceMode ?? "none");
  const cashUntaxedBase = args.cashSubtotal.greaterThan(0)
    ? args.cashSubtotal
    : (args.billingTypeAtOrder === "cash" ? args.totalAmount : new Prisma.Decimal(0));
  const cashBreakdown = breakdownCashTaxInvoice(cashUntaxedBase, mode);
  const expectedCashPortion = cashBreakdown ? cashBreakdown.totalWithTax : cashUntaxedBase;
  const docs = await tx.arDocument.findMany({
    where: { salesOrderId: args.salesOrderId, status: { not: "voided" } },
    include: { openItems: { include: { allocations: true } } },
  });
  const arUnchanged =
    expectedCashPortion.greaterThan(0)
      ? docs.length === 1 &&
        docs[0].billingType === "cash" &&
        new Prisma.Decimal(docs[0].documentAmount).equals(expectedCashPortion) &&
        docs[0].openItems.length === 1 &&
        new Prisma.Decimal(docs[0].openItems[0].originalAmount).equals(expectedCashPortion) &&
        new Prisma.Decimal(docs[0].openItems[0].outstandingAmount).equals(expectedCashPortion) &&
        new Prisma.Decimal(docs[0].openItems[0].allocatedAmount).equals(0)
      : docs.length === 0;

  if (!arUnchanged) {
    for (const d of docs) {
      for (const oi of d.openItems) {
        if (oi.allocations.length > 0 || new Prisma.Decimal(oi.allocatedAmount).greaterThan(0)) {
          throw new Error("AR_ALREADY_ALLOCATED");
        }
        await tx.arOpenItem.update({
          where: { id: oi.id },
          data: {
            outstandingAmount: new Prisma.Decimal(0),
            status: "paid",
          },
        });
      }
      await tx.arDocument.update({
        where: { id: d.id },
        data: { status: "voided" },
      });
    }
    await createArForSalesOrder(tx, args);
  }

  await syncPlannedCashTaxInvoice(tx, {
    customerId: args.customerId,
    salesOrderId: args.salesOrderId,
    cashInvoiceMode: mode,
    cashSubtotal: args.cashSubtotal,
  });
}

type ParsedLineDelivery = { lineId: bigint; qtyDelivered: number };

function parseLineDeliveriesFromBody(
  bodyLines: unknown,
  orderLines: Array<{ id: bigint; qtyOrdered: number; linePurpose?: string | null }>,
): { ok: true; lines: ParsedLineDelivery[] } | { ok: false; message: string } {
  const deliveryLines = orderLines.filter((l) => (l.linePurpose ?? "delivery") === "delivery");
  if (!Array.isArray(bodyLines) || bodyLines.length === 0) {
    return {
      ok: true,
      lines: deliveryLines.map((l) => ({ lineId: l.id, qtyDelivered: l.qtyOrdered })),
    };
  }
  const map = new Map<string, number>();
  for (const row of bodyLines) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as { lineId?: unknown; qtyDelivered?: unknown };
    const lineId = toBigInt(r.lineId);
    const q = Number(r.qtyDelivered);
    if (!lineId || !Number.isInteger(q) || q < 0) {
      return { ok: false, message: "lines 每列需 lineId 與 qtyDelivered（非負整數）" };
    }
    map.set(lineId.toString(), q);
  }
  const result: ParsedLineDelivery[] = [];
  for (const line of deliveryLines) {
    const explicit = map.get(line.id.toString());
    const qtyDelivered = explicit !== undefined ? explicit : line.qtyOrdered;
    result.push({ lineId: line.id, qtyDelivered });
  }
  return { ok: true, lines: result };
}

/** 從資料庫已確認的 qty_delivered 組出配送數（未確認時 fallback qty_ordered） */
function lineDeliveriesFromDb(
  orderLines: Array<{ id: bigint; qtyOrdered: number; qtyDelivered: number; linePurpose?: string | null }>,
): ParsedLineDelivery[] {
  return orderLines
    .filter((l) => (l.linePurpose ?? "delivery") === "delivery")
    .map((l) => ({
      lineId: l.id,
      qtyDelivered: l.qtyDelivered > 0 || l.qtyOrdered === 0 ? l.qtyDelivered : l.qtyOrdered,
    }));
}

function deliveryLinesQtyConfirmed(
  orderLines: Array<{ qtyOrdered: number; qtyDelivered: number; linePurpose?: string | null }>,
): boolean {
  const deliveryLines = orderLines.filter((l) => (l.linePurpose ?? "delivery") === "delivery");
  if (deliveryLines.length === 0) return true;
  return deliveryLines.every((l) => {
    if (l.qtyOrdered === 0) return l.qtyDelivered > 0;
    return l.qtyDelivered > 0;
  });
}

/** 司機／辦公室回報時寫入實際配送桶數並重算訂單金額與 AR */
async function applyLineDeliveriesAtReport(
  tx: Prisma.TransactionClient,
  order: {
    id: bigint;
    orderNo: string;
    customerId: bigint;
    billingTypeAtOrder: string | null;
    cashInvoiceMode: string | null;
    orderCashAdjustment: Prisma.Decimal | { toString(): string };
    customer: { monthlySettlementDay: number | null };
  },
  lineDeliveries: ParsedLineDelivery[],
): Promise<void> {
  const dbLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: order.id } });
  const deliveryMap = new Map(lineDeliveries.map((l) => [l.lineId.toString(), l.qtyDelivered]));
  const lineAmountRows: Array<{
    lineAmount: Prisma.Decimal;
    billingTypeAtLine: string | null;
    linePurpose?: string | null;
    productId?: bigint;
  }> = [];

  for (const line of dbLines) {
    const purpose = line.linePurpose ?? "delivery";
    if (purpose === "delivery") {
      const qtyDelivered = deliveryMap.get(line.id.toString()) ?? line.qtyOrdered;
      const unitPrice = new Prisma.Decimal(line.unitPrice.toString());
      const lineAmount = unitPrice.mul(qtyDelivered);
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { qtyDelivered, lineAmount },
      });
      lineAmountRows.push({ lineAmount, billingTypeAtLine: line.billingTypeAtLine, linePurpose: purpose, productId: line.productId });
    } else {
      lineAmountRows.push({
        lineAmount: new Prisma.Decimal(line.lineAmount.toString()),
        billingTypeAtLine: line.billingTypeAtLine,
        linePurpose: purpose,
        productId: line.productId,
      });
    }
  }

  const totals = computeOrderTotalsFromLineAmounts(lineAmountRows);
  await tx.salesOrder.update({
    where: { id: order.id },
    data: {
      subtotal: totals.subtotal,
      totalAmount: totals.totalAmount,
      cashSubtotal: totals.cashSubtotal,
      monthlySubtotal: totals.monthlySubtotal,
      lockVersion: { increment: 1 },
    },
  });

  await refreshOpenArForSalesOrder(tx, {
    salesOrderId: order.id,
    orderNo: order.orderNo,
    customerId: order.customerId,
    billingTypeAtOrder: order.billingTypeAtOrder,
    totalAmount: totals.totalAmount,
    cashSubtotal: totals.cashSubtotal,
    monthlySubtotal: totals.monthlySubtotal,
    monthlySettlementDay: order.customer.monthlySettlementDay ?? null,
    createdByUserId: DEFAULT_CREATOR_USER_ID,
    cashInvoiceMode: order.cashInvoiceMode,
  });
}

/** 月結批次 AR 全數沖清後，回填各訂單 monthly_received / monthly_period_paid */
async function syncOneBillingStatementPaidFields(tx: Prisma.TransactionClient, billingStatementId: bigint): Promise<void> {
  const junctionRows = await tx.billingStatementOrder.findMany({
    where: { billingStatementId },
  });
  if (junctionRows.length === 0) return;

  const docs = await tx.arDocument.findMany({
    where: { billingStatementId },
    include: { openItems: true },
  });
  let hasOutstanding = false;
  for (const d of docs) {
    for (const oi of d.openItems) {
      if (new Prisma.Decimal(oi.outstandingAmount).greaterThan(0)) {
        hasOutstanding = true;
        break;
      }
    }
    if (hasOutstanding) break;
  }

  if (!hasOutstanding) {
    for (const row of junctionRows) {
      await tx.salesOrder.update({
        where: { id: row.salesOrderId },
        data: {
          monthlyReceivedAmount: row.monthlyUntaxedAmount,
          monthlyPeriodPaid: true,
        },
      });
    }
  }
}

async function syncBillingStatementsAfterAllocations(tx: Prisma.TransactionClient, touchedOpenItemIds: bigint[]): Promise<void> {
  const uniq = [...new Set(touchedOpenItemIds)];
  if (uniq.length === 0) return;
  const items = await tx.arOpenItem.findMany({
    where: { id: { in: uniq } },
    include: { arDocument: true },
  });
  const stmtIds = new Set<bigint>();
  const monthlySalesOrderIds = new Set<bigint>();
  for (const i of items) {
    const sid = i.arDocument.billingStatementId;
    if (sid != null) stmtIds.add(sid);
    if (i.salesOrderId != null && i.arDocument.billingType === "monthly") {
      monthlySalesOrderIds.add(i.salesOrderId);
    }
  }
  for (const sid of stmtIds) {
    await syncOneBillingStatementPaidFields(tx, sid);
  }
  for (const soId of monthlySalesOrderIds) {
    await syncMonthlyOrderReceivedFromAr(tx, soId);
  }
}

/** 依該單月結 AR open items 回填 monthly_received_amount / monthly_period_paid */
async function syncMonthlyOrderReceivedFromAr(tx: Prisma.TransactionClient, salesOrderId: bigint): Promise<void> {
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true,
      totalAmount: true,
      monthlySubtotal: true,
      billingTypeAtOrder: true,
      billingStatementOrder: { select: { monthlyUntaxedAmount: true } },
    },
  });
  if (!order) return;

  const monthlyOpens = await tx.arOpenItem.findMany({
    where: {
      salesOrderId,
      arDocument: { billingType: "monthly", status: { not: "voided" } },
    },
    select: { originalAmount: true, allocatedAmount: true, outstandingAmount: true },
  });
  if (monthlyOpens.length === 0) return;

  let original = new Prisma.Decimal(0);
  let allocated = new Prisma.Decimal(0);
  let outstanding = new Prisma.Decimal(0);
  for (const oi of monthlyOpens) {
    original = original.plus(oi.originalAmount);
    allocated = allocated.plus(oi.allocatedAmount);
    outstanding = outstanding.plus(oi.outstandingAmount);
  }

  const capFromJunction = order.billingStatementOrder?.monthlyUntaxedAmount;
  const cap =
    capFromJunction != null
      ? new Prisma.Decimal(capFromJunction)
      : orderMonthlyCap({
          monthlySubtotal: order.monthlySubtotal,
          totalAmount: order.totalAmount,
          billingTypeAtOrder: order.billingTypeAtOrder,
        });

  /** 已清金額含收款沖帳與折讓（original − outstanding） */
  const cleared = original.minus(outstanding);
  const received = decMin(cleared.greaterThan(0) ? cleared : allocated, cap);
  await tx.salesOrder.update({
    where: { id: salesOrderId },
    data: {
      monthlyReceivedAmount: received,
      monthlyPeriodPaid: outstanding.lessThanOrEqualTo(0) && cap.greaterThan(0),
    },
  });
}

async function applyAllocations(
  tx: Prisma.TransactionClient,
  args: {
    voucherId: bigint;
    openItemAmounts: Array<{ openItemId: bigint; amount: Prisma.Decimal }>;
    /** 沖帳時間；未傳則取收款單 paid_at */
    allocatedAt?: Date;
  },
) {
  let allocatedAt = args.allocatedAt;
  if (!allocatedAt) {
    const voucher = await tx.receiptVoucher.findUnique({
      where: { id: args.voucherId },
      select: { paidAt: true },
    });
    allocatedAt = voucher?.paidAt ?? new Date();
  }
  const cashSalesOrdersToCheck = new Set<bigint>();
  const touchedOpenItemsForStmt: bigint[] = [];
  for (const item of args.openItemAmounts) {
    if (item.amount.lessThanOrEqualTo(0)) continue;
    const open = await tx.arOpenItem.findUnique({
      where: { id: item.openItemId },
      include: { arDocument: true },
    });
    if (!open) continue;
    if (open.salesOrderId && open.arDocument.billingType === "cash") {
      cashSalesOrdersToCheck.add(open.salesOrderId);
    }
    const allocAmount = decMin(item.amount, new Prisma.Decimal(open.outstandingAmount));
    if (allocAmount.lessThanOrEqualTo(0)) continue;
    touchedOpenItemsForStmt.push(open.id);
    const allocatedAmount = new Prisma.Decimal(open.allocatedAmount).plus(allocAmount);
    const outstandingAmount = decMax(new Prisma.Decimal(open.outstandingAmount).minus(allocAmount), new Prisma.Decimal(0));
    await tx.arAllocationMap.create({
      data: {
        receiptVoucherId: args.voucherId,
        arOpenItemId: open.id,
        allocatedAmount: allocAmount,
        allocatedAt,
      },
    });
    const nextStatus = arStatusFromOutstanding(outstandingAmount, open.dueDate ?? undefined);
    await tx.arOpenItem.update({
      where: { id: open.id },
      data: {
        allocatedAmount,
        outstandingAmount,
        status: nextStatus === "unpaid" && allocatedAmount.greaterThan(0) ? "partially_paid" : nextStatus,
      },
    });
    const related = await tx.arOpenItem.count({
      where: { arDocumentId: open.arDocumentId, outstandingAmount: { gt: new Prisma.Decimal(0) } },
    });
    await tx.arDocument.update({
      where: { id: open.arDocumentId },
      data: { status: related === 0 ? "paid" : "open" },
    });
  }
  await syncBillingStatementsAfterAllocations(tx, touchedOpenItemsForStmt);
  for (const soId of cashSalesOrdersToCheck) {
    await tryFulfillPendingPrepaidTopup(tx, soId);
  }
}

function normalizeLineBillingType(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "cash" || s === "monthly" || s === "prepaid") return s;
  return fallback === "cash" || fallback === "monthly" || fallback === "prepaid" ? fallback : "cash";
}

function normalizeLinePurpose(raw: unknown): "delivery" | "prepaid_barrel_topup" {
  return raw === "prepaid_barrel_topup" ? "prepaid_barrel_topup" : "delivery";
}

/** 彙總訂單明細：預付桶儲值（依商品） */
function sumPrepaidTopupByProduct(
  lines: Array<{ productId: bigint; qty: number; linePurpose?: string | null }>,
): Map<bigint, number> {
  const m = new Map<bigint, number>();
  for (const l of lines) {
    if ((l.linePurpose ?? "delivery") !== "prepaid_barrel_topup") continue;
    m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
  }
  return m;
}

async function adjustCustomerPrepaidProductBalance(
  tx: Prisma.TransactionClient,
  customerId: bigint,
  productId: bigint,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  if (delta < 0) {
    const qty = -delta;
    const hit = await tx.customerPrepaidProductBalance.updateMany({
      where: { customerId, productId },
      data: { balanceBarrels: { decrement: qty } },
    });
    if (hit.count === 0) {
      await tx.customerPrepaidProductBalance.create({
        data: { customerId, productId, balanceBarrels: -qty },
      });
    }
    return;
  }
  await tx.customerPrepaidProductBalance.upsert({
    where: { customerId_productId: { customerId, productId } },
    create: { customerId, productId, balanceBarrels: delta },
    update: { balanceBarrels: { increment: delta } },
  });
}

/**
 * 本單「現金」AR 全部沖清後，將 pending_prepaid_topup_barrels 入帳至客戶預付桶餘額（匯款／現金沖帳／預收扣抵皆然）。
 * 若同單有同商品之預付出貨，與儲值一併以淨額入帳（避免先扣後補造成暫時負餘額）。
 */
async function tryFulfillPendingPrepaidTopup(tx: Prisma.TransactionClient, salesOrderId: bigint): Promise<void> {
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      lines: { include: { product: true } },
      customer: true,
    },
  });
  if (!order || order.pendingPrepaidTopupBarrels <= 0) return;

  const cashOpens = await tx.arOpenItem.findMany({
    where: {
      salesOrderId,
      arDocument: { billingType: "cash" },
    },
  });
  if (cashOpens.length === 0) return;

  for (const oi of cashOpens) {
    if (new Prisma.Decimal(oi.outstandingAmount).greaterThan(0)) return;
  }

  const barrels = order.pendingPrepaidTopupBarrels;
  const topupByProduct = new Map<bigint, number>();
  const topupParts: string[] = [];
  for (const l of order.lines) {
    if ((l.linePurpose ?? "delivery") !== "prepaid_barrel_topup") continue;
    topupByProduct.set(l.productId, (topupByProduct.get(l.productId) ?? 0) + l.qtyOrdered);
    topupParts.push(`${l.product?.name ?? "商品"} +${l.qtyOrdered}`);
  }

  const deferredConsumeByProduct = new Map<bigint, number>();
  let deferredConsumeTotal = 0;
  for (const line of order.lines) {
    if ((line.linePurpose ?? "delivery") === "prepaid_barrel_topup") continue;
    const qty = effectiveLineDeliveryQty(line);
    if (qty <= 0) continue;
    if (lineBillingType(line, order, order.customer) !== "prepaid") continue;
    if (line.product?.consumesPrepaidBarrel !== true) continue;
    if ((topupByProduct.get(line.productId) ?? 0) <= 0) continue;
    deferredConsumeByProduct.set(line.productId, (deferredConsumeByProduct.get(line.productId) ?? 0) + qty);
    deferredConsumeTotal += qty;
  }

  const netBarrels = barrels - deferredConsumeTotal;
  const cust = await tx.customer.findUnique({ where: { id: order.customerId } });
  if (!cust) return;

  await tx.customer.update({
    where: { id: order.customerId },
    data: { prepaidBarrelBalance: cust.prepaidBarrelBalance + netBarrels },
  });
  await tx.customerLedgerEntry.create({
    data: {
      customerId: order.customerId,
      entryType: "prepaid_topup",
      amount: new Prisma.Decimal(0),
      barrelDelta: barrels,
      salesOrderId,
      note:
        topupParts.length > 0
          ? `預付桶儲值 ${barrels}（訂單 ${order.orderNo}，現金應收已沖清）：${topupParts.join("；")}`
          : `預付桶儲值 ${barrels}（訂單 ${order.orderNo}，現金應收已沖清）`,
      createdByUserId: DEFAULT_CREATOR_USER_ID,
    },
  });
  if (deferredConsumeTotal > 0) {
    await tx.customerLedgerEntry.create({
      data: {
        customerId: order.customerId,
        entryType: "prepaid_consumption",
        amount: new Prisma.Decimal(0),
        barrelDelta: -deferredConsumeTotal,
        salesOrderId,
        note: `預付扣桶 ${deferredConsumeTotal}（訂單 ${order.orderNo}，與本單儲值一併淨額入帳）`,
        createdByUserId: DEFAULT_CREATOR_USER_ID,
      },
    });
  }
  const productIds = new Set([...topupByProduct.keys(), ...deferredConsumeByProduct.keys()]);
  for (const productId of productIds) {
    const net = (topupByProduct.get(productId) ?? 0) - (deferredConsumeByProduct.get(productId) ?? 0);
    await adjustCustomerPrepaidProductBalance(tx, order.customerId, productId, net);
  }
  await tx.salesOrder.update({
    where: { id: salesOrderId },
    data: { pendingPrepaidTopupBarrels: 0 },
  });
}

/** 現金列發票：依模式由「現金列未稅合計」拆解未稅／稅額／含稅（與 tax_invoices 寫入一致） */
function breakdownCashTaxInvoice(
  cashSubtotal: Prisma.Decimal,
  cashInvoiceMode: "none" | "tax_inclusive" | "tax_exclusive",
  taxRate?: Prisma.Decimal,
): { untaxedAmount: Prisma.Decimal; taxAmount: Prisma.Decimal; totalWithTax: Prisma.Decimal } | null {
  if (cashInvoiceMode === "none" || cashSubtotal.lessThanOrEqualTo(0)) return null;
  const rate = taxRate ?? DEFAULT_VAT_RATE;
  if (cashInvoiceMode === "tax_exclusive") {
    const c = computeTaxFromUntaxed(cashSubtotal, rate);
    return { untaxedAmount: cashSubtotal, taxAmount: c.taxAmount, totalWithTax: c.totalWithTax };
  }
  const denom = new Prisma.Decimal(1).plus(rate);
  const untaxedAmount = cashSubtotal.div(denom).toDecimalPlaces(2);
  const taxAmount = cashSubtotal.minus(untaxedAmount).toDecimalPlaces(2);
  return { untaxedAmount, taxAmount, totalWithTax: cashSubtotal };
}

/** 現金／混單之現金部分：依 cash_invoice_mode 開立 sales_order 發票紀錄（AR 仍為未稅本金） */
type TaxInvoiceBasisType = "sales_order" | "billing_statement" | "prepayment_topup";

async function loadCustomerInvoiceBuyer(tx: Prisma.TransactionClient, customerId: bigint) {
  const cust = await tx.customer.findUnique({
    where: { id: customerId },
    select: { name: true, taxId: true },
  });
  return {
    buyerName: cust?.name ?? null,
    buyerTaxId: cust?.taxId ?? null,
  };
}

async function createTaxInvoicePlanned(
  tx: Prisma.TransactionClient,
  args: {
    customerId: bigint;
    basisType: TaxInvoiceBasisType;
    salesOrderId?: bigint | null;
    billingStatementId?: bigint | null;
    receiptVoucherId?: bigint | null;
    invoiceMode: "tax_inclusive" | "tax_exclusive";
    untaxedAmount: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    taxRate?: Prisma.Decimal;
    note?: string | null;
  },
) {
  const buyer = await loadCustomerInvoiceBuyer(tx, args.customerId);
  return tx.taxInvoice.create({
    data: {
      invoiceNo: generateTaxInvoiceNo(),
      customerId: args.customerId,
      basisType: args.basisType,
      billingStatementId: args.billingStatementId ?? null,
      salesOrderId: args.salesOrderId ?? null,
      receiptVoucherId: args.receiptVoucherId ?? null,
      invoiceMode: args.invoiceMode,
      untaxedAmount: args.untaxedAmount,
      taxAmount: args.taxAmount,
      totalAmount: args.totalAmount,
      taxRate: args.taxRate ?? DEFAULT_VAT_RATE,
      status: "planned",
      buyerName: buyer.buyerName,
      buyerTaxId: buyer.buyerTaxId,
      note: args.note ?? null,
    },
  });
}

async function syncPlannedCashTaxInvoice(
  tx: Prisma.TransactionClient,
  args: {
    customerId: bigint;
    salesOrderId: bigint;
    cashInvoiceMode: "none" | "tax_inclusive" | "tax_exclusive";
    cashSubtotal: Prisma.Decimal;
    taxRate?: Prisma.Decimal;
  },
): Promise<void> {
  const br = breakdownCashTaxInvoice(args.cashSubtotal, args.cashInvoiceMode, args.taxRate);
  if (!br) return;

  const issued = await tx.taxInvoice.findFirst({
    where: { salesOrderId: args.salesOrderId, status: "issued", basisType: "sales_order" },
  });
  if (issued) return;

  const planned = await tx.taxInvoice.findFirst({
    where: { salesOrderId: args.salesOrderId, status: "planned", basisType: "sales_order" },
    orderBy: { id: "desc" },
  });

  if (planned) {
    const unchanged =
      planned.invoiceMode === args.cashInvoiceMode &&
      new Prisma.Decimal(planned.untaxedAmount).equals(br.untaxedAmount) &&
      new Prisma.Decimal(planned.taxAmount).equals(br.taxAmount) &&
      new Prisma.Decimal(planned.totalAmount).equals(br.totalWithTax);
    if (unchanged) return;

    const buyer = await loadCustomerInvoiceBuyer(tx, args.customerId);
    await tx.taxInvoice.update({
      where: { id: planned.id },
      data: {
        invoiceMode: args.cashInvoiceMode,
        untaxedAmount: br.untaxedAmount,
        taxAmount: br.taxAmount,
        totalAmount: br.totalWithTax,
        taxRate: args.taxRate ?? DEFAULT_VAT_RATE,
        buyerName: buyer.buyerName,
        buyerTaxId: buyer.buyerTaxId,
      },
    });
    return;
  }

  await createTaxInvoicePlanned(tx, {
    customerId: args.customerId,
    basisType: "sales_order",
    salesOrderId: args.salesOrderId,
    invoiceMode: args.cashInvoiceMode as "tax_inclusive" | "tax_exclusive",
    untaxedAmount: br.untaxedAmount,
    taxAmount: br.taxAmount,
    totalAmount: br.totalWithTax,
    taxRate: args.taxRate,
  });
}

/** 訂單月結沖銷上限（明細月結合計；舊單僅月結客戶時為 total_amount） */
function orderMonthlyCap(o: {
  monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
}): Prisma.Decimal {
  const ms = new Prisma.Decimal(String(o.monthlySubtotal ?? 0));
  if (ms.greaterThan(0)) return ms;
  if ((o.billingTypeAtOrder ?? "") === "monthly") return new Prisma.Decimal(String(o.totalAmount));
  return new Prisma.Decimal(0);
}

/** 訂單現金應收部分（明細現金合計；舊單僅現金客戶時為 total_amount） */
function orderCashPortion(o: {
  cashSubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
}): Prisma.Decimal {
  const cs = new Prisma.Decimal(String(o.cashSubtotal ?? 0));
  if (cs.greaterThan(0)) return cs;
  if ((o.billingTypeAtOrder ?? "") === "cash") return new Prisma.Decimal(String(o.totalAmount));
  return new Prisma.Decimal(0);
}

/**
 * 訂單「現場應收／現金 AR 本金」：現金列為 **稅外加** 時與發票一致為 **含稅總額**；
 * 含稅開票或未開票時與 {@link orderCashPortion} 相同（明細小計為未稅本位）。
 */
function orderCashReceivablePortion(o: {
  cashSubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
  cashInvoiceMode?: string | null;
}): Prisma.Decimal {
  const base = orderCashPortion(o);
  if (base.lessThanOrEqualTo(0)) return base;
  const mode = normalizeCashInvoiceMode(o.cashInvoiceMode ?? "none");
  const br = breakdownCashTaxInvoice(base, mode);
  return br ? br.totalWithTax : base;
}

function lineBillingType(
  line: { billingTypeAtLine?: string | null },
  order: { billingTypeAtOrder: string | null },
  customer: { billingType: string },
): string {
  return normalizeLineBillingType(
    line.billingTypeAtLine ?? order.billingTypeAtOrder ?? customer.billingType,
    "cash",
  );
}

const orderHasMonthlyPortion = (o: {
  monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
  customer?: { billingType: string };
}): boolean => orderMonthlyCap(o).greaterThan(0);

/** 月結對帳／FIFO：訂單是否有「月結應收」份額（含混用單之月結小計） */
const isMonthlyBillingOrder = (o: {
  monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
  totalAmount: Prisma.Decimal | { toString(): string };
  billingTypeAtOrder: string | null;
  customer: { billingType: string };
}): boolean => orderHasMonthlyPortion(o);

/** 截止日 YYYY-MM-DD：本地該日 00:00（供 DateTime 區間比較）；寫入 @db.Date 請用 parseLocalYmdToDbDate */
function cutoffDateStartLocal(ymd: string): Date | null {
  const r = parseLocalYmdRange(ymd);
  return r?.start ?? null;
}

/** 截止日寫入 billing_statements.cutoff_date（@db.Date） */
function cutoffDateToDbDate(ymd: string): Date | null {
  return parseLocalYmdToDbDate(ymd);
}

/** 截止日「含當日」：實際送貨日須嚴格早於「截止日翌日 00:00（本地）」（與 parseLocalYmdRange 之 end 相同） */
function cutoffInclusiveDeliveryUpperBound(ymd: string): Date | null {
  const r = parseLocalYmdRange(ymd);
  return r?.end ?? null;
}

/** 實際送貨時點：司機回報日 → 排程配送日 → 訂單預定配送日 → 辦公室核銷（服務單無配送） */
function actualDeliveryInstant(so: {
  scheduledDeliveryDate: Date | null;
  officeSettledAt?: Date | null;
  assignments?: Array<{ driverReportedAt: Date | null; assignmentDate: Date | null }> | null;
} | null): Date | null {
  if (!so) return null;
  const a = so.assignments?.[0];
  const d = a?.driverReportedAt ?? a?.assignmentDate ?? so.scheduledDeliveryDate ?? so.officeSettledAt ?? null;
  return d ? new Date(d) : null;
}

/** 核銷／建議收款時，他單 AR 是否可視為「可催收舊欠」 */
function isCollectiblePriorSalesOrderAr(salesOrder: {
  status: string;
  lines?: Array<{ qtyDelivered: number }>;
} | null): boolean {
  if (!salesOrder) return true;
  if (
    salesOrder.status === "pending_settlement" ||
    salesOrder.status === "completed" ||
    salesOrder.status === "not_delivered"
  ) {
    return true;
  }
  return (salesOrder.lines ?? []).some((l) => (l.qtyDelivered ?? 0) > 0);
}

/** 辦公室核銷：依收款方式入帳收款單並沖 AR（本單優先，再 FIFO 沖可催收舊欠） */
async function postSettlementReceiptByMethod(
  tx: Prisma.TransactionClient,
  args: {
    customerId: bigint;
    salesOrderId: bigint;
    amount: number;
    paymentMethod: "cash" | "check";
    paymentNote: string;
    settledAt: Date;
    orderNo: string;
  },
): Promise<void> {
  if (!Number.isFinite(args.amount) || args.amount <= 0) return;
  const receivedDec = new Prisma.Decimal(String(args.amount));

  const voucher = await tx.receiptVoucher.create({
    data: {
      voucherNo: generateReceiptVoucherNo(),
      customerId: args.customerId,
      voucherType: "receipt",
      paymentMethod: args.paymentMethod,
      totalAmount: receivedDec,
      unappliedAmount: receivedDec,
      status: "posted",
      paidAt: args.settledAt,
      note: args.paymentNote,
      createdByUserId: DEFAULT_CREATOR_USER_ID,
      createdAt: args.settledAt,
    },
  });
  await tx.payment.create({
    data: {
      customerId: args.customerId,
      salesOrderId: args.salesOrderId,
      amount: args.amount,
      paymentMethod: args.paymentMethod,
      note: args.paymentNote,
      recordedByUserId: DEFAULT_CREATOR_USER_ID,
      paidAt: args.settledAt,
      createdAt: args.settledAt,
      receiptVoucherId: voucher.id,
    },
  });

  let remain = receivedDec;
  const opens = await tx.arOpenItem.findMany({
    where: activeArOpenItemWhere({ customerId: args.customerId }),
    include: {
      salesOrder: { select: { status: true, lines: { select: { qtyDelivered: true } } } },
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
  const thisOrderOpens = opens.filter((o) => o.salesOrderId === args.salesOrderId);
  const priorOpens = opens.filter(
    (o) =>
      o.salesOrderId !== args.salesOrderId &&
      (o.salesOrderId == null || isCollectiblePriorSalesOrderAr(o.salesOrder)),
  );
  const allocs: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];
  for (const open of [...thisOrderOpens, ...priorOpens]) {
    if (remain.lessThanOrEqualTo(0)) break;
    const take = decMin(remain, new Prisma.Decimal(open.outstandingAmount));
    if (take.lessThanOrEqualTo(0)) continue;
    allocs.push({ openItemId: open.id, amount: take });
    remain = remain.minus(take);
  }
  await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: allocs, allocatedAt: args.settledAt });
  await tx.receiptVoucher.update({
    where: { id: voucher.id },
    data: {
      unappliedAmount: remain.lessThanOrEqualTo(0) ? new Prisma.Decimal(0) : remain,
      status: remain.lessThanOrEqualTo(0) ? "applied" : "partial",
    },
  });
  if (remain.greaterThan(0)) {
    const wallet = await ensurePrepaymentWallet(tx, args.customerId);
    const nextBalance = new Prisma.Decimal(wallet.balanceAmount).plus(remain);
    await tx.customerPrepaymentWallet.update({
      where: { customerId: args.customerId },
      data: { balanceAmount: nextBalance },
    });
    await tx.prepaymentTxn.create({
      data: {
        customerId: args.customerId,
        receiptVoucherId: voucher.id,
        txnType: "overpay_to_wallet",
        amount: remain,
        balanceAfter: nextBalance,
        note: args.paymentMethod === "check" ? "司機支票多收轉預收款" : "司機多收轉預收款",
      },
    });
    await tx.receiptVoucher.update({
      where: { id: voucher.id },
      data: { unappliedAmount: new Prisma.Decimal(0), status: "applied" },
    });
    await autoApplyPrepaymentToLatestOpenAr(tx, {
      customerId: args.customerId,
      note: args.paymentMethod === "check" ? "自動預收抵扣（支票多收轉預收）" : "自動預收抵扣（司機多收轉預收）",
    });
  }
}

/**
 * 司機／現場收款口徑：
 * - **建議收款** = 本單 AR＋「可催收舊欠」（已回報／已結案等，不含尚在途、未配送的他單 AR）− 預收錢包。
 * - **其他未清**：可催收舊欠合計（供 UI 區分本單與舊欠）。
 * 實收沖帳：本單優先，再 FIFO 沖可催收舊欠。
 */
async function calcCashDueByUnifiedRule(
  tx: Pick<PrismaClient, "arOpenItem" | "customerPrepaymentWallet">,
  args: { customerId: bigint; currentSalesOrderId: bigint },
): Promise<{
  totalArOutstanding: Prisma.Decimal;
  thisOrderArOutstanding: Prisma.Decimal;
  priorOtherOutstanding: Prisma.Decimal;
  walletBalance: Prisma.Decimal;
  collectDue: Prisma.Decimal;
  /** 同 priorOtherOutstanding（相容舊語意命名） */
  priorCashOutstanding: Prisma.Decimal;
  priorAfterWallet: Prisma.Decimal;
  cashDue: Prisma.Decimal;
}> {
  const [opens, wallet] = await Promise.all([
    tx.arOpenItem.findMany({
      where: activeArOpenItemWhere({ customerId: args.customerId }),
      select: {
        salesOrderId: true,
        outstandingAmount: true,
        salesOrder: { select: { status: true, lines: { select: { qtyDelivered: true } } } },
      },
    }),
    tx.customerPrepaymentWallet.findUnique({ where: { customerId: args.customerId } }),
  ]);

  let thisOrderArOutstanding = new Prisma.Decimal(0);
  let priorOtherOutstanding = new Prisma.Decimal(0);
  for (const open of opens) {
    const amt = new Prisma.Decimal(open.outstandingAmount);
    if (open.salesOrderId === args.currentSalesOrderId) {
      thisOrderArOutstanding = thisOrderArOutstanding.plus(amt);
      continue;
    }
    if (open.salesOrderId == null || isCollectiblePriorSalesOrderAr(open.salesOrder)) {
      priorOtherOutstanding = priorOtherOutstanding.plus(amt);
    }
  }
  const totalArOutstanding = thisOrderArOutstanding.plus(priorOtherOutstanding);
  const walletBalance = new Prisma.Decimal(wallet?.balanceAmount ?? 0);
  const collectDue = decMax(totalArOutstanding.minus(walletBalance), new Prisma.Decimal(0));
  const priorAfterWallet = decMax(priorOtherOutstanding.minus(walletBalance), new Prisma.Decimal(0));

  return {
    totalArOutstanding,
    thisOrderArOutstanding,
    priorOtherOutstanding,
    walletBalance,
    collectDue,
    priorCashOutstanding: priorOtherOutstanding,
    priorAfterWallet,
    cashDue: collectDue,
  };
}

/** 司機今日任務：附帶本單應收現金、客戶往來、上一筆已結案配送摘要（供司機端顯示） */
const buildDriverBillingHints = async (params: {
  customerId: bigint;
  excludeSalesOrderId: bigint;
  order: {
    totalAmount: Prisma.Decimal | { toString(): string };
    orderCashAdjustment?: Prisma.Decimal | { toString(): string } | null;
    billingTypeAtOrder?: string | null;
    cashSubtotal?: Prisma.Decimal | { toString(): string } | null;
    monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
    cashInvoiceMode?: string | null;
  };
  customer: {
    billingType: string;
    prepaidBarrelBalance: number;
    allowPrepaidOverdraft: boolean;
  };
  balanceCache: Map<string, number>;
}): Promise<{
  billingType: string;
  orderTotal: string;
  cashSubtotal: string;
  monthlySubtotal: string;
  /** 明細為預付（桶）之金額合計（參考用；扣桶於核銷） */
  prepaidLineTotal: string;
  /** 已廢止：固定 0，保留欄位供舊版前端相容 */
  orderCashAdjustment: string;
  /** 本張訂單以外之未清應收（現金／月結等；不含本單已立帳 open item） */
  cashPriorBalance: string;
  cashDue: string;
  accountBalance: number;
  prepaidBarrelBalance: number;
  allowPrepaidOverdraft: boolean;
  lastCompletedDelivery: {
    orderNo: string;
    cashReceived: string;
    expectedAmount: string | null;
    cashVariance: string | null;
    settlementOutcome: string | null;
    officeSettledAt: string | null;
  } | null;
  /** 現金列發票（若開票）：未稅／稅額／含稅；稅外加時本單現金應收＝含稅 */
  cashTaxInvoice: {
    mode: "tax_inclusive" | "tax_exclusive";
    taxRate: string;
    untaxedAmount: string;
    taxAmount: string;
    totalWithTax: string;
  } | null;
}> => {
  const orderSnap = params.order.billingTypeAtOrder ?? params.customer.billingType;
  const billing =
    orderSnap === "mixed"
      ? "mixed"
      : ((params.order.billingTypeAtOrder ?? params.customer.billingType) as string);
  const orderTotal = new Prisma.Decimal(String(params.order.totalAmount));
  const adj = new Prisma.Decimal(String(params.order.orderCashAdjustment ?? 0));
  const cashUntaxedPortion = orderCashPortion({
    cashSubtotal: params.order.cashSubtotal ?? null,
    totalAmount: orderTotal,
    billingTypeAtOrder: params.order.billingTypeAtOrder ?? null,
  });
  const monthlyPortion = orderMonthlyCap({
    monthlySubtotal: params.order.monthlySubtotal ?? null,
    totalAmount: orderTotal,
    billingTypeAtOrder: params.order.billingTypeAtOrder ?? null,
  });
  const prepaidLineTotal = orderTotal.minus(cashUntaxedPortion).minus(monthlyPortion);

  const invoiceModeNorm = normalizeCashInvoiceMode(params.order.cashInvoiceMode);
  const cashTaxBreakdown = breakdownCashTaxInvoice(cashUntaxedPortion, invoiceModeNorm);

  const balKey = params.customerId.toString();
  let accountBalance: number;
  if (params.balanceCache.has(balKey)) {
    accountBalance = params.balanceCache.get(balKey)!;
  } else {
    const [arAgg, wallet] = await Promise.all([
      prisma.arOpenItem.aggregate({
        where: activeArOpenItemWhere({ customerId: params.customerId }),
        _sum: { outstandingAmount: true },
      }),
      prisma.customerPrepaymentWallet.findUnique({ where: { customerId: params.customerId } }),
    ]);
    accountBalance = Number(new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0).minus(new Prisma.Decimal(wallet?.balanceAmount ?? 0)));
    params.balanceCache.set(balKey, accountBalance);
  }

  const collectCalc = await calcCashDueByUnifiedRule(prisma, {
    customerId: params.customerId,
    currentSalesOrderId: params.excludeSalesOrderId,
  });
  const cashPriorDec = collectCalc.priorOtherOutstanding;
  const cashDue = collectCalc.collectDue;

  const lastCompleted = await prisma.deliveryAssignment.findFirst({
    where: {
      status: "completed",
      officeSettledAt: { not: null },
      salesOrder: { customerId: params.customerId },
      NOT: { salesOrderId: params.excludeSalesOrderId },
    },
    orderBy: [{ officeSettledAt: "desc" }, { id: "desc" }],
    include: { salesOrder: { select: { orderNo: true } } },
  });

  return {
    billingType: billing,
    orderTotal: orderTotal.toString(),
    cashSubtotal: cashUntaxedPortion.toString(),
    monthlySubtotal: monthlyPortion.toString(),
    prepaidLineTotal: prepaidLineTotal.toString(),
    orderCashAdjustment: adj.toString(),
    cashPriorBalance: cashPriorDec.toString(),
    cashDue: cashDue.toString(),
    accountBalance,
    prepaidBarrelBalance: params.customer.prepaidBarrelBalance,
    allowPrepaidOverdraft: params.customer.allowPrepaidOverdraft,
    lastCompletedDelivery: lastCompleted
      ? {
          orderNo: lastCompleted.salesOrder.orderNo,
          cashReceived: lastCompleted.cashReceived.toString(),
          expectedAmount: lastCompleted.expectedAmount != null ? lastCompleted.expectedAmount.toString() : null,
          cashVariance: lastCompleted.cashVariance != null ? lastCompleted.cashVariance.toString() : null,
          settlementOutcome: lastCompleted.settlementOutcome,
          officeSettledAt: lastCompleted.officeSettledAt?.toISOString() ?? null,
        }
      : null,
    cashTaxInvoice:
      cashTaxBreakdown && invoiceModeNorm !== "none"
        ? {
            mode: invoiceModeNorm as "tax_inclusive" | "tax_exclusive",
            taxRate: DEFAULT_VAT_RATE.toString(),
            untaxedAmount: cashTaxBreakdown.untaxedAmount.toString(),
            taxAmount: cashTaxBreakdown.taxAmount.toString(),
            totalWithTax: cashTaxBreakdown.totalWithTax.toString(),
          }
        : null,
  };
};

const corsOriginList = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
const corsOrigin = corsOriginList && corsOriginList.length > 0 ? corsOriginList : isProductionRuntime() ? false : true;

app.use(cors({ origin: corsOrigin }));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.url?.startsWith("/api/line/webhook")) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      }
    },
  }),
);
app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

app.use(async (req, res, next) => {
  // LIFF／LINE webhook：會員憑證由 /api/liff/* 路由自行驗證，不走員工 JWT
  if (
    !req.path.startsWith("/api/") ||
    req.method === "OPTIONS" ||
    publicApiPaths.has(req.path) ||
    isLiffApiPath(req.path)
  ) {
    next();
    return;
  }

  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] ?? "" : header);
  if (!match) {
    res.status(401).json({ ok: false, message: "請先登入" });
    return;
  }

  try {
    const payload = jwt.verify(match[1], JWT_SECRET, { algorithms: ["HS256"] }) as AuthPayload;
    if (payload.typ === "member") {
      res.status(401).json({ ok: false, message: "登入已失效，請重新登入" });
      return;
    }
    if (payload.typ && payload.typ !== "employee") {
      res.status(401).json({ ok: false, message: "登入已失效，請重新登入" });
      return;
    }
    const userId = toBigInt(payload.sub);
    if (!userId) {
      res.status(401).json({ ok: false, message: "登入已失效，請重新登入" });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { driver: true } });
    if (!user || !user.isActive) {
      res.status(401).json({ ok: false, message: "帳號已停用或不存在" });
      return;
    }
    const authUser: AuthUser = {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      role: user.role,
      driverId: user.driver?.id ?? null,
    };
    if (
      authUser.role === "driver" &&
      !req.path.startsWith("/api/driver/") &&
      req.path !== "/api/auth/me" &&
      req.path !== "/api/auth/password"
    ) {
      res.status(403).json({ ok: false, message: "司機帳號不可使用後台 API" });
      return;
    }
    (req as express.Request & { authUser?: AuthUser }).authUser = authUser;
    next();
  } catch {
    res.status(401).json({ ok: false, message: "登入已失效，請重新登入" });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      db: "connected",
      deliveryPlanningEnabled: isDeliveryPlanningEnabled(),
    });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false, db: "error", message: "資料庫無法連線" });
  }
});

registerDeliveryPlanningRoutes({
  app,
  prisma,
  getAuthUser,
  requireRole,
  toBigInt,
});

registerLegacyHistoryRoutes({
  app,
  prisma,
  getAuthUser,
  requireRole,
  toBigInt,
});

const customerMasterInclude = {
  addresses: {
    orderBy: { id: "asc" as const },
    include: {
      patrolProduct: { select: { id: true, name: true, productCode: true, isActive: true } },
    },
  },
  addressZone: { select: { id: true, name: true, isActive: true } },
  affiliatedCompany: { select: { id: true, name: true, isActive: true } },
  churnReason: { select: { id: true, code: true, label: true, isActive: true } },
} as const;

function monthRangeFromYearMonth(ym: string): { start: Date; end: Date; yearMonth: string } | { error: string } {
  const trimmed = ym.trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return { error: "yearMonth 須為 YYYY-MM" };
  const startR = parseLocalYmdRange(`${trimmed}-01`);
  if (!startR) return { error: "yearMonth 無效" };
  const [y, mo] = trimmed.split("-").map(Number);
  const nextM = mo === 12 ? 1 : mo + 1;
  const nextY = mo === 12 ? y + 1 : y;
  const endR = parseLocalYmdRange(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
  if (!endR) return { error: "yearMonth 無效" };
  return { start: startR.start, end: endR.start, yearMonth: trimmed };
}

function customerReportScopeWhere(
  addressZoneId: bigint | null,
  affiliatedCompanyId: bigint | null,
): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {};
  if (addressZoneId) where.addressZoneId = addressZoneId;
  if (affiliatedCompanyId) where.affiliatedCompanyId = affiliatedCompanyId;
  return where;
}

async function loadCustomerLifecycleWarnings(
  tx: Pick<PrismaClient, "customer" | "arOpenItem">,
  customerId: bigint,
): Promise<string[]> {
  const warnings: string[] = [];
  const cust = await tx.customer.findUnique({
    where: { id: customerId },
    include: { addresses: { select: { barrelsOnSite: true } } },
  });
  if (!cust) return warnings;
  const barrels = sumCustomerBarrelsOnSiteFromAddresses(cust.addresses);
  if (barrels > 0) warnings.push(`此客戶尚有未收回空桶 ${barrels} 桶`);
  const arAgg = await tx.arOpenItem.aggregate({
    where: activeArOpenItemWhere({ customerId }),
    _sum: { outstandingAmount: true },
  });
  const arOutstanding = new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0);
  if (arOutstanding.greaterThan(0)) {
    warnings.push(`此客戶尚有未清應收 $${arOutstanding.toString()}`);
  }
  return warnings;
}

function sumCustomerBarrelsOnSiteFromAddresses(addresses: Array<{ barrelsOnSite: number }>): number {
  return addresses.reduce((s, a) => s + (a.barrelsOnSite ?? 0), 0);
}

function parseNonNegativeBarrelCount(raw: unknown, fieldLabel: string): number | "INVALID" {
  const n = Math.floor(Number(raw ?? 0));
  if (!Number.isFinite(n) || n < 0) return "INVALID";
  return n;
}

/** 送貨樓層：null=未設定；0 為無效 */
function parseOptionalDeliveryFloor(raw: unknown): number | null | "INVALID" {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n === 0) return "INVALID";
  return n;
}

/** 巡查星期：1=週一 … 7=週日；空＝不參加 */
function parseOptionalPatrolWeekday(raw: unknown): number | null | "INVALID" {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 7) return "INVALID";
  return n;
}

/** 目標水位（桶）；空＝未設定 */
function parseOptionalTargetWaterLevel(raw: unknown): number | null | "INVALID" {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return "INVALID";
  return n;
}

/** 二樓以上或地下樓（B1=-1）計入搬運獎金／客戶搬運費 */
function isFloorBonusEligible(floor: number): boolean {
  return floor >= 2 || floor < 0;
}

function formatFloorLabel(floor: number): string {
  if (floor < 0) return `地下${Math.abs(floor)}樓`;
  return `${floor}樓`;
}

/** 可填寫上樓搬運紀錄的配送商品（押桶或預付扣桶） */
function productEligibleForFloorBonus(product: {
  countsDepositBarrel?: boolean;
  consumesPrepaidBarrel?: boolean;
} | null | undefined): boolean {
  if (!product) return false;
  return product.countsDepositBarrel === true || product.consumesPrepaidBarrel === true;
}

const FLOOR_FEE_LINE_PURPOSE = "floor_handling_fee";
const FLOOR_FEE_PRODUCT_SKU = "SYS-FLOOR-FEE";
/** 飲水機維修／清洗服務費（不扣庫存、不計桶） */
const SERVICE_FEE_LINE_PURPOSE = "service_fee";
const SERVICE_FEE_PRODUCT_SKU = "SYS-SERVICE-FEE";
const SERVICE_ORDER_SOURCE = "svc_ticket";

function isNonInventoryLinePurpose(purpose: string | null | undefined): boolean {
  const p = (purpose ?? "delivery").trim();
  return p === "prepaid_barrel_topup" || p === FLOOR_FEE_LINE_PURPOSE || p === SERVICE_FEE_LINE_PURPOSE;
}

/** 彙總本單出庫需求並檢查庫存是否足夠（略過非庫存用途列） */
async function analyzeOrderStockShortage(
  tx: Prisma.TransactionClient,
  salesOrderId: bigint,
  lines?: Array<{
    id: bigint;
    productId: bigint;
    qtyOrdered: number;
    qtyDelivered: number | null;
    linePurpose: string | null;
    product?: { name?: string | null } | null;
  }>,
): Promise<Array<{ productId: string; productName: string; need: number; onHand: number }>> {
  const orderLines =
    lines ??
    (await tx.salesOrderLine.findMany({
      where: { salesOrderId },
      include: { product: { select: { name: true } } },
    }));
  const needByProduct = new Map<bigint, { name: string; need: number }>();
  for (const line of orderLines) {
    if (isNonInventoryLinePurpose(line.linePurpose)) continue;
    const qty =
      line.qtyDelivered != null && Number(line.qtyDelivered) > 0
        ? Number(line.qtyDelivered)
        : Number(line.qtyOrdered);
    if (qty <= 0) continue;
    const name = line.product?.name ?? "商品";
    const cur = needByProduct.get(line.productId);
    if (cur) cur.need += qty;
    else needByProduct.set(line.productId, { name, need: qty });
  }
  const shortages: Array<{ productId: string; productName: string; need: number; onHand: number }> = [];
  for (const [productId, info] of needByProduct) {
    const inv = await tx.inventoryBalance.findUnique({ where: { productId } });
    const onHand = inv?.qtyOnHand ?? 0;
    if (onHand < info.need) {
      shortages.push({
        productId: productId.toString(),
        productName: info.name,
        need: info.need,
        onHand,
      });
    }
  }
  return shortages;
}

async function ensureServiceFeeProduct(tx: Prisma.TransactionClient): Promise<{ id: bigint; name: string; unit: string }> {
  const existing = await tx.product.findFirst({ where: { sku: SERVICE_FEE_PRODUCT_SKU } });
  if (existing) {
    return { id: existing.id, name: existing.name, unit: existing.unit };
  }
  const created = await tx.product.create({
    data: {
      sku: SERVICE_FEE_PRODUCT_SKU,
      name: "飲水機服務費",
      unit: "式",
      countsDepositBarrel: false,
      consumesPrepaidBarrel: false,
      availableOnLiff: false,
      salePrice: 0,
      costPrice: 0,
      driverDeliveryWage: 0,
      isActive: true,
    },
  });
  return { id: created.id, name: created.name, unit: created.unit };
}

/**
 * 服務費應掛在哪位司機、哪一天的日收款核對：
 * - 現場修好收費 → 評估司機＋評估日
 * - 載回廠維修／清洗後送回收費 → 送回司機＋送回日
 */
function resolveServiceTicketCollectionMeta(
  ticket: {
    status: string;
    assessOutcome?: string | null;
    assessDriverId?: bigint | null;
    assessDate?: Date | null;
    returnDriverId?: bigint | null;
    returnDate?: Date | null;
  },
  settledAt: Date,
): { collectorDriverId: bigint | null; collectionDate: Date | null; collectionDateYmd: string } {
  const onsite =
    ticket.status === "onsite_completed" ||
    ticket.assessOutcome === "onsite_fixed";
  const driverId = onsite
    ? ticket.assessDriverId ?? null
    : ticket.returnDriverId ?? ticket.assessDriverId ?? null;
  const dateYmd =
    (onsite
      ? ymdFromDbDate(ticket.assessDate)
      : ymdFromDbDate(ticket.returnDate)) ?? toLocalYmd(settledAt);
  return {
    collectorDriverId: driverId,
    collectionDate: parseLocalYmdToDbDate(dateYmd),
    collectionDateYmd: dateYmd,
  };
}

function ymdFromDbDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 服務單結案入帳：建立已完成訂單 +（現金）逐單 AR；可選當場收款沖帳。
 * 冪等：若 ticket.salesOrderId 已存在則直接回傳既有訂單，不重複立帳。
 */
async function postServiceTicketBilling(
  tx: Prisma.TransactionClient,
  args: {
    ticket: {
      id: bigint;
      ticketNo: string;
      customerId: bigint;
      deliveryAddressId: bigint;
      salesOrderId: bigint | null;
      serviceType: string;
    };
    billingType: "cash" | "monthly";
    charge: Prisma.Decimal;
    userId: bigint;
    settledAt: Date;
    /** 現金：司機是否當場帶回現金／支票；false＝僅立帳、客戶說下次再收 */
    cashCollectedNow?: boolean;
    collectedCash?: number;
    collectedCheck?: number;
  },
): Promise<{ salesOrderId: bigint; orderNo: string; created: boolean; paymentPosted: boolean }> {
  if (args.ticket.salesOrderId != null) {
    const existingOrder = await tx.salesOrder.findUnique({
      where: { id: args.ticket.salesOrderId },
      select: { id: true, orderNo: true },
    });
    if (existingOrder) {
      let paymentPosted = false;
      if (args.billingType === "cash" && args.cashCollectedNow) {
        const existingPay = await tx.payment.findFirst({
          where: { salesOrderId: existingOrder.id, paymentMethod: { in: ["cash", "check"] } },
        });
        if (!existingPay) {
          const cashAmt = Math.max(0, Number(args.collectedCash ?? args.charge));
          const checkAmt = Math.max(0, Number(args.collectedCheck ?? 0));
          if (cashAmt > 0) {
            await postSettlementReceiptByMethod(tx, {
              customerId: args.ticket.customerId,
              salesOrderId: existingOrder.id,
              amount: cashAmt,
              paymentMethod: "cash",
              paymentNote: `服務單 ${args.ticket.ticketNo} 司機帶回現金`,
              settledAt: args.settledAt,
              orderNo: existingOrder.orderNo,
            });
            paymentPosted = true;
          }
          if (checkAmt > 0) {
            await postSettlementReceiptByMethod(tx, {
              customerId: args.ticket.customerId,
              salesOrderId: existingOrder.id,
              amount: checkAmt,
              paymentMethod: "check",
              paymentNote: `服務單 ${args.ticket.ticketNo} 司機帶回支票`,
              settledAt: args.settledAt,
              orderNo: existingOrder.orderNo,
            });
            paymentPosted = true;
          }
        }
      }
      return {
        salesOrderId: existingOrder.id,
        orderNo: existingOrder.orderNo,
        created: false,
        paymentPosted,
      };
    }
  }

  if (!args.charge.greaterThan(0)) {
    throw new Error("收費金額須大於 0 才能建立帳務訂單");
  }

  const product = await ensureServiceFeeProduct(tx);
  const orderNo = generateOrderNo();
  const scheduledYmd = toLocalYmd(args.settledAt);
  const scheduledDate = parseLocalYmdToDbDate(scheduledYmd)!;
  const cashSubtotal = args.billingType === "cash" ? args.charge : new Prisma.Decimal(0);
  const monthlySubtotal = args.billingType === "monthly" ? args.charge : new Prisma.Decimal(0);
  const serviceTypeLabelText =
    args.ticket.serviceType === "cleaning"
      ? "清洗"
      : args.ticket.serviceType === "repair"
        ? "維修"
        : args.ticket.serviceType === "both"
          ? "清洗／維修"
          : args.ticket.serviceType;

  const so = await tx.salesOrder.create({
    data: {
      orderNo,
      customerId: args.ticket.customerId,
      deliveryAddressId: args.ticket.deliveryAddressId,
      status: "completed",
      scheduledDeliveryDate: scheduledDate,
      subtotal: args.charge,
      totalAmount: args.charge,
      remark: `飲水機服務單 ${args.ticket.ticketNo}（${serviceTypeLabelText}）結案入帳`,
      billingTypeAtOrder: args.billingType,
      cashSubtotal,
      monthlySubtotal,
      cashInvoiceMode: null,
      source: SERVICE_ORDER_SOURCE,
      createdByUserId: args.userId,
      officeSettledAt: args.settledAt,
      billingPeriodKey: args.billingType === "monthly" ? billingPeriodKeyFromDate(args.settledAt) : null,
      monthlyPeriodPaid: false,
      monthlyReceivedAmount: new Prisma.Decimal(0),
      lines: {
        create: [
          {
            productId: product.id,
            qtyOrdered: 1,
            qtyDelivered: 1,
            unitPrice: args.charge,
            lineAmount: args.charge,
            billingTypeAtLine: args.billingType,
            linePurpose: SERVICE_FEE_LINE_PURPOSE,
            invoiceMode: null,
          },
        ],
      },
    },
  });

  await tx.serviceTicket.update({
    where: { id: args.ticket.id },
    data: { salesOrderId: so.id },
  });

  let paymentPosted = false;
  if (args.billingType === "cash") {
    await createArForSalesOrder(tx, {
      salesOrderId: so.id,
      orderNo: so.orderNo,
      customerId: args.ticket.customerId,
      billingTypeAtOrder: "cash",
      totalAmount: args.charge,
      cashSubtotal: args.charge,
      monthlySubtotal: new Prisma.Decimal(0),
      monthlySettlementDay: null,
      createdByUserId: args.userId,
      cashInvoiceMode: "none",
    });
    if (args.cashCollectedNow) {
      const cashAmt = Math.max(0, Number(args.collectedCash ?? args.charge));
      const checkAmt = Math.max(0, Number(args.collectedCheck ?? 0));
      if (cashAmt > 0) {
        await postSettlementReceiptByMethod(tx, {
          customerId: args.ticket.customerId,
          salesOrderId: so.id,
          amount: cashAmt,
          paymentMethod: "cash",
          paymentNote: `服務單 ${args.ticket.ticketNo} 司機帶回現金`,
          settledAt: args.settledAt,
          orderNo: so.orderNo,
        });
        paymentPosted = true;
      }
      if (checkAmt > 0) {
        await postSettlementReceiptByMethod(tx, {
          customerId: args.ticket.customerId,
          salesOrderId: so.id,
          amount: checkAmt,
          paymentMethod: "check",
          paymentNote: `服務單 ${args.ticket.ticketNo} 司機帶回支票`,
          settledAt: args.settledAt,
          orderNo: so.orderNo,
        });
        paymentPosted = true;
      }
    }
  }
  // 月結：不在此立逐單 AR，等月結批次（須 completed + officeSettledAt）

  return { salesOrderId: so.id, orderNo: so.orderNo, created: true, paymentPosted };
}

type ParsedFloorBonusRecord = {
  lineId: bigint;
  floor: number;
  qty: number;
};

function parseFloorBonusRecords(raw: unknown): ParsedFloorBonusRecord[] | "INVALID" {
  const map = new Map<string, ParsedFloorBonusRecord>();
  if (!Array.isArray(raw)) return [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const lineId = toBigInt((item as { lineId?: unknown }).lineId);
    const floor = Math.floor(Number((item as { floor?: unknown }).floor));
    const qty = Math.floor(Number((item as { qty?: unknown }).qty ?? 0));
    if (!lineId) continue;
    if (!Number.isFinite(floor) || floor === 0 || !Number.isFinite(qty) || qty < 0) return "INVALID";
    if (qty <= 0) continue;
    if (!isFloorBonusEligible(floor)) return "INVALID";
    const key = `${lineId.toString()}:${floor}`;
    const existing = map.get(key);
    map.set(key, {
      lineId,
      floor,
      qty: (existing?.qty ?? 0) + qty,
    });
  }
  return [...map.values()];
}

async function ensureFloorFeeProduct(tx: Prisma.TransactionClient): Promise<{ id: bigint; name: string; unit: string }> {
  const existing = await tx.product.findFirst({ where: { sku: FLOOR_FEE_PRODUCT_SKU } });
  if (existing) {
    return { id: existing.id, name: existing.name, unit: existing.unit };
  }
  const created = await tx.product.create({
    data: {
      sku: FLOOR_FEE_PRODUCT_SKU,
      name: "樓層搬運費",
      unit: "桶",
      countsDepositBarrel: false,
      consumesPrepaidBarrel: false,
      availableOnLiff: false,
      salePrice: 0,
      costPrice: 0,
      driverDeliveryWage: 0,
      isActive: true,
    },
  });
  return { id: created.id, name: created.name, unit: created.unit };
}

/** 月結客戶→月結；現金／預付／混合→現金 */
function resolveFloorFeeBillingType(customerBillingType: string, orderBillingType: string | null): "cash" | "monthly" {
  const bt = ((orderBillingType ?? customerBillingType) || "cash").trim();
  if (bt === "monthly") return "monthly";
  return "cash";
}

async function listCustomerFloorFeeRates(tx: Prisma.TransactionClient | PrismaClient = prisma) {
  const rows = await tx.customerFloorFeeRate.findMany();
  return sortFloorBonusRates(rows);
}

async function createFloorBonusRecords(
  tx: Prisma.TransactionClient,
  opts: {
    assignment: { id: bigint; driverId: bigint; assignmentDate: Date };
    order: {
      id: bigint;
      orderNo: string;
      lines: Array<{
        id: bigint;
        productId: bigint;
        linePurpose: string | null;
        product: {
          name: string;
          countsDepositBarrel: boolean;
          consumesPrepaidBarrel: boolean;
        } | null;
      }>;
    };
    records: ParsedFloorBonusRecord[];
  },
): Promise<number> {
  await tx.floorDeliveryBonusRecord.deleteMany({
    where: { deliveryAssignmentId: opts.assignment.id },
  });
  let created = 0;
  const lineMap = new Map(opts.order.lines.map((line) => [line.id, line]));
  for (const record of opts.records) {
    const line = lineMap.get(record.lineId);
    if (!line) continue;
    if (isNonInventoryLinePurpose(line.linePurpose)) continue;
    if (!productEligibleForFloorBonus(line.product)) continue;
    await tx.floorDeliveryBonusRecord.create({
      data: {
        deliveryAssignmentId: opts.assignment.id,
        salesOrderId: opts.order.id,
        salesOrderLineId: line.id,
        orderNo: opts.order.orderNo,
        deliveryDate: opts.assignment.assignmentDate,
        driverId: opts.assignment.driverId,
        productId: line.productId,
        productName: line.product!.name,
        qty: record.qty,
        floor: record.floor,
      },
    });
    created += 1;
  }
  return created;
}

/**
 * 依司機回報上樓桶數，將客戶搬運費寫入訂單明細並重算 AR。
 * 僅能在核銷前呼叫；已沖帳 AR 會拋 AR_ALREADY_ALLOCATED。
 */
async function applyCustomerFloorFeesFromRecords(
  tx: Prisma.TransactionClient,
  opts: {
    order: {
      id: bigint;
      orderNo: string;
      customerId: bigint;
      billingTypeAtOrder: string | null;
      cashInvoiceMode: string | null;
      customer: { billingType: string; monthlySettlementDay: number | null };
      lines: Array<{
        id: bigint;
        linePurpose: string | null;
        product: {
          countsDepositBarrel: boolean;
          consumesPrepaidBarrel: boolean;
        } | null;
      }>;
    };
    records: ParsedFloorBonusRecord[];
  },
): Promise<{ feeAmount: Prisma.Decimal; billingType: "cash" | "monthly"; lineCount: number }> {
  const feeProduct = await ensureFloorFeeProduct(tx);
  const billingType = resolveFloorFeeBillingType(opts.order.customer.billingType, opts.order.billingTypeAtOrder);

  await tx.salesOrderLine.deleteMany({
    where: { salesOrderId: opts.order.id, linePurpose: FLOOR_FEE_LINE_PURPOSE },
  });

  const eligibleLineIds = new Set(
    opts.order.lines
      .filter((line) => {
        const purpose = line.linePurpose ?? "delivery";
        if (isNonInventoryLinePurpose(purpose)) return false;
        return productEligibleForFloorBonus(line.product);
      })
      .map((line) => line.id.toString()),
  );

  const qtyByFloor = new Map<number, number>();
  for (const record of opts.records) {
    if (!eligibleLineIds.has(record.lineId.toString())) continue;
    qtyByFloor.set(record.floor, (qtyByFloor.get(record.floor) ?? 0) + record.qty);
  }

  const rates = await listCustomerFloorFeeRates(tx);
  const rateMap = new Map(rates.map((r) => [r.floor, new Prisma.Decimal(r.unitPrice.toString())]));

  let feeAmount = new Prisma.Decimal(0);
  let lineCount = 0;
  for (const [floor, qty] of [...qtyByFloor.entries()].sort((a, b) => a[0] - b[0])) {
    if (qty <= 0) continue;
    const unitPrice = rateMap.get(floor) ?? new Prisma.Decimal(0);
    if (unitPrice.lessThanOrEqualTo(0)) continue;
    const lineAmount = unitPrice.mul(qty);
    feeAmount = feeAmount.add(lineAmount);
    await tx.salesOrderLine.create({
      data: {
        salesOrderId: opts.order.id,
        productId: feeProduct.id,
        qtyOrdered: qty,
        qtyDelivered: qty,
        unitPrice,
        lineAmount,
        billingTypeAtLine: billingType,
        linePurpose: FLOOR_FEE_LINE_PURPOSE,
        promotionNote: `${formatFloorLabel(floor)}搬運費`,
      },
    });
    lineCount += 1;
  }

  const dbLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: opts.order.id } });
  const totals = computeOrderTotalsFromLineAmounts(
    dbLines.map((line) => ({
      lineAmount: new Prisma.Decimal(line.lineAmount.toString()),
      billingTypeAtLine: line.billingTypeAtLine,
      linePurpose: line.linePurpose,
      productId: line.productId,
    })),
  );
  await tx.salesOrder.update({
    where: { id: opts.order.id },
    data: {
      subtotal: totals.subtotal,
      totalAmount: totals.totalAmount,
      cashSubtotal: totals.cashSubtotal,
      monthlySubtotal: totals.monthlySubtotal,
      lockVersion: { increment: 1 },
    },
  });

  await refreshOpenArForSalesOrder(tx, {
    salesOrderId: opts.order.id,
    orderNo: opts.order.orderNo,
    customerId: opts.order.customerId,
    billingTypeAtOrder: opts.order.billingTypeAtOrder,
    totalAmount: totals.totalAmount,
    cashSubtotal: totals.cashSubtotal,
    monthlySubtotal: totals.monthlySubtotal,
    monthlySettlementDay: opts.order.customer.monthlySettlementDay ?? null,
    createdByUserId: DEFAULT_CREATOR_USER_ID,
    cashInvoiceMode: opts.order.cashInvoiceMode,
  });

  return { feeAmount, billingType, lineCount };
}

async function clearCustomerFloorFeeLines(
  tx: Prisma.TransactionClient,
  opts: {
    order: {
      id: bigint;
      orderNo: string;
      customerId: bigint;
      billingTypeAtOrder: string | null;
      cashInvoiceMode: string | null;
      customer: { monthlySettlementDay: number | null };
    };
  },
): Promise<void> {
  const deleted = await tx.salesOrderLine.deleteMany({
    where: { salesOrderId: opts.order.id, linePurpose: FLOOR_FEE_LINE_PURPOSE },
  });
  if (deleted.count <= 0) return;

  const dbLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: opts.order.id } });
  const totals = computeOrderTotalsFromLineAmounts(
    dbLines.map((line) => ({
      lineAmount: new Prisma.Decimal(line.lineAmount.toString()),
      billingTypeAtLine: line.billingTypeAtLine,
      linePurpose: line.linePurpose,
      productId: line.productId,
    })),
  );
  await tx.salesOrder.update({
    where: { id: opts.order.id },
    data: {
      subtotal: totals.subtotal,
      totalAmount: totals.totalAmount,
      cashSubtotal: totals.cashSubtotal,
      monthlySubtotal: totals.monthlySubtotal,
      lockVersion: { increment: 1 },
    },
  });
  await refreshOpenArForSalesOrder(tx, {
    salesOrderId: opts.order.id,
    orderNo: opts.order.orderNo,
    customerId: opts.order.customerId,
    billingTypeAtOrder: opts.order.billingTypeAtOrder,
    totalAmount: totals.totalAmount,
    cashSubtotal: totals.cashSubtotal,
    monthlySubtotal: totals.monthlySubtotal,
    monthlySettlementDay: opts.order.customer.monthlySettlementDay ?? null,
    createdByUserId: DEFAULT_CREATOR_USER_ID,
    cashInvoiceMode: opts.order.cashInvoiceMode,
  });
}

function sumAddressBarrelsOnSite(addresses: Array<{ barrelsOnSite?: number }> | undefined): number {
  return (addresses ?? []).reduce((sum, a) => sum + (a.barrelsOnSite ?? 0), 0);
}

/** 客戶 barrelsOnSite 改為各送貨地址加總（相容舊前端欄位） */
function enrichCustomerBarrels<T extends { barrelsOnSite: number; addresses?: Array<{ barrelsOnSite: number }> }>(row: T): T {
  const addresses = (row.addresses ?? []).map((a) => ({ ...a, barrelsOnSite: a.barrelsOnSite ?? 0 }));
  return {
    ...row,
    addresses,
    barrelsOnSite: sumAddressBarrelsOnSite(addresses),
  };
}

/** 解析客戶外鍵：空值清除；undefined 表示 PATCH 不變 */
function parseOptionalFkId(raw: unknown): bigint | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const id = toBigInt(raw);
  return id ?? null;
}

async function assertAddressZoneId(id: bigint): Promise<boolean> {
  const row = await prisma.addressZone.findFirst({ where: { id, isActive: true } });
  return row != null;
}

async function assertAffiliatedCompanyId(id: bigint): Promise<boolean> {
  const row = await prisma.affiliatedCompany.findFirst({ where: { id, isActive: true } });
  return row != null;
}

app.get("/api/address-zones", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.addressZone.findMany({
      where: all ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/address-zones", async (req, res) => {
  try {
    const body = req.body as { name?: unknown; sortOrder?: unknown };
    const name = trimOptionalString(body.name);
    if (!name) {
      res.status(400).json({ ok: false, message: "分區名稱為必填" });
      return;
    }
    if (name.length > 50) {
      res.status(400).json({ ok: false, message: "分區名稱不可超過 50 字" });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.addressZone.create({
      data: { name, sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0 },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此分區名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/address-zones/:zoneId", async (req, res) => {
  try {
    const zoneId = toBigInt(req.params.zoneId);
    if (!zoneId) {
      res.status(400).json({ ok: false, message: "參數錯誤：zoneId" });
      return;
    }
    const body = req.body as { name?: unknown; sortOrder?: unknown; isActive?: unknown };
    const data: { name?: string; sortOrder?: number; isActive?: boolean } = {};
    if (body.name !== undefined) {
      const name = trimOptionalString(body.name);
      if (!name) {
        res.status(400).json({ ok: false, message: "分區名稱不可為空" });
        return;
      }
      if (name.length > 50) {
        res.status(400).json({ ok: false, message: "分區名稱不可超過 50 字" });
        return;
      }
      data.name = name;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }
    const row = await prisma.addressZone.update({ where: { id: zoneId }, data });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到分區" });
      return;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此分區名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/address-zones/:zoneId", async (req, res) => {
  try {
    const zoneId = toBigInt(req.params.zoneId);
    if (!zoneId) {
      res.status(400).json({ ok: false, message: "參數錯誤：zoneId" });
      return;
    }
    const used = await prisma.customer.count({ where: { addressZoneId: zoneId } });
    if (used > 0) {
      res.status(400).json({ ok: false, message: `仍有 ${used} 筆客戶使用此分區，請改為停用或先變更客戶分區` });
      return;
    }
    await prisma.addressZone.delete({ where: { id: zoneId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到分區" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/affiliated-companies", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.affiliatedCompany.findMany({
      where: all ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/affiliated-companies", async (req, res) => {
  try {
    const body = req.body as { name?: unknown; sortOrder?: unknown };
    const name = trimOptionalString(body.name);
    if (!name) {
      res.status(400).json({ ok: false, message: "公司名稱為必填" });
      return;
    }
    if (name.length > 200) {
      res.status(400).json({ ok: false, message: "公司名稱不可超過 200 字" });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.affiliatedCompany.create({
      data: { name, sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0 },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此公司名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/affiliated-companies/:companyId", async (req, res) => {
  try {
    const companyId = toBigInt(req.params.companyId);
    if (!companyId) {
      res.status(400).json({ ok: false, message: "參數錯誤：companyId" });
      return;
    }
    const body = req.body as { name?: unknown; sortOrder?: unknown; isActive?: unknown };
    const data: { name?: string; sortOrder?: number; isActive?: boolean } = {};
    if (body.name !== undefined) {
      const name = trimOptionalString(body.name);
      if (!name) {
        res.status(400).json({ ok: false, message: "公司名稱不可為空" });
        return;
      }
      if (name.length > 200) {
        res.status(400).json({ ok: false, message: "公司名稱不可超過 200 字" });
        return;
      }
      data.name = name;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }
    const row = await prisma.affiliatedCompany.update({ where: { id: companyId }, data });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到公司" });
      return;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此公司名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/affiliated-companies/:companyId", async (req, res) => {
  try {
    const companyId = toBigInt(req.params.companyId);
    if (!companyId) {
      res.status(400).json({ ok: false, message: "參數錯誤：companyId" });
      return;
    }
    const used = await prisma.customer.count({ where: { affiliatedCompanyId: companyId } });
    if (used > 0) {
      res.status(400).json({ ok: false, message: `仍有 ${used} 筆客戶隸屬此公司，請改為停用或先變更客戶公司` });
      return;
    }
    await prisma.affiliatedCompany.delete({ where: { id: companyId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到公司" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/print-slogans", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.printSlogan.findMany({
      where: all ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/print-slogans", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const body = req.body as { title?: unknown; body?: unknown; sortOrder?: unknown };
    const title = trimOptionalString(body.title);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!title) {
      res.status(400).json({ ok: false, message: "標語名稱為必填" });
      return;
    }
    if (!text) {
      res.status(400).json({ ok: false, message: "標語內容為必填" });
      return;
    }
    if (title.length > 80) {
      res.status(400).json({ ok: false, message: "標語名稱不可超過 80 字" });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.printSlogan.create({
      data: {
        title,
        body: text,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此標語名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/print-slogans/:sloganId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const sloganId = toBigInt(req.params.sloganId);
    if (!sloganId) {
      res.status(400).json({ ok: false, message: "參數錯誤：sloganId" });
      return;
    }
    const body = req.body as { title?: unknown; body?: unknown; sortOrder?: unknown; isActive?: unknown };
    const data: { title?: string; body?: string; sortOrder?: number; isActive?: boolean } = {};
    if (body.title !== undefined) {
      const title = trimOptionalString(body.title);
      if (!title) {
        res.status(400).json({ ok: false, message: "標語名稱不可為空" });
        return;
      }
      if (title.length > 80) {
        res.status(400).json({ ok: false, message: "標語名稱不可超過 80 字" });
        return;
      }
      data.title = title;
    }
    if (body.body !== undefined) {
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) {
        res.status(400).json({ ok: false, message: "標語內容不可為空" });
        return;
      }
      data.body = text;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }
    const row = await prisma.printSlogan.update({ where: { id: sloganId }, data });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到標語" });
      return;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此標語名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/print-slogans/:sloganId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const sloganId = toBigInt(req.params.sloganId);
    if (!sloganId) {
      res.status(400).json({ ok: false, message: "參數錯誤：sloganId" });
      return;
    }
    await prisma.printSlogan.delete({ where: { id: sloganId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到標語" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

async function resolveOrderAnnouncementText(referenceYmd: string): Promise<string | null> {
  const parsed = parseLocalYmdRange(referenceYmd);
  if (!parsed) return null;
  const refDate = parsed.start;

  const period = await prisma.orderAnnouncement.findMany({
    where: {
      isActive: true,
      kind: "period",
      startsOn: { lte: refDate },
      endsOn: { gte: refDate },
    },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  const standing = await prisma.orderAnnouncement.findMany({
    where: { isActive: true, kind: "standing" },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  const parts = [...period, ...standing].map((r) => r.body.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function parseAnnouncementKind(raw: unknown): "standing" | "period" | null {
  const k = typeof raw === "string" ? raw.trim() : "";
  if (k === "standing" || k === "period") return k;
  return null;
}

function parseAnnouncementDates(
  kind: "standing" | "period",
  startsOnYmd: unknown,
  endsOnYmd: unknown,
): { startsOn: Date | null; endsOn: Date | null } | { error: string } {
  if (kind === "standing") {
    const hasStart = typeof startsOnYmd === "string" && startsOnYmd.trim();
    const hasEnd = typeof endsOnYmd === "string" && endsOnYmd.trim();
    if (hasStart || hasEnd) {
      return { error: "全站公告不可設定起迄日" };
    }
    return { startsOn: null, endsOn: null };
  }
  const startStr = typeof startsOnYmd === "string" ? startsOnYmd.trim() : "";
  const endStr = typeof endsOnYmd === "string" ? endsOnYmd.trim() : "";
  if (!startStr || !endStr) {
    return { error: "特定期間公告須填寫起日與迄日" };
  }
  const startParsed = parseLocalYmdRange(startStr);
  const endParsed = parseLocalYmdRange(endStr);
  if (!startParsed || !endParsed) {
    return { error: "起迄日格式須為 YYYY-MM-DD" };
  }
  if (startParsed.start.getTime() > endParsed.start.getTime()) {
    return { error: "起日不可晚於迄日" };
  }
  return { startsOn: startParsed.start, endsOn: endParsed.start };
}

/** 依參考日（通常為訂單配送日）合併生效中的套印公告 */
app.get("/api/order-announcements/resolved", async (req, res) => {
  try {
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    let ymd = dateParam;
    if (!ymd) {
      const d = new Date();
      ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    const text = await resolveOrderAnnouncementText(ymd);
    res.json({ ok: true, date: ymd, text });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/order-announcements", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.orderAnnouncement.findMany({
      where: all ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { kind: "asc" }, { id: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/order-announcements", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const body = req.body as {
      title?: unknown;
      body?: unknown;
      kind?: unknown;
      startsOnYmd?: unknown;
      endsOnYmd?: unknown;
      sortOrder?: unknown;
    };
    const title = trimOptionalString(body.title);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const kind = parseAnnouncementKind(body.kind) ?? "standing";
    if (!title) {
      res.status(400).json({ ok: false, message: "公告名稱為必填" });
      return;
    }
    if (!text) {
      res.status(400).json({ ok: false, message: "公告內容為必填" });
      return;
    }
    if (title.length > 80) {
      res.status(400).json({ ok: false, message: "公告名稱不可超過 80 字" });
      return;
    }
    const dates = parseAnnouncementDates(kind, body.startsOnYmd, body.endsOnYmd);
    if ("error" in dates) {
      res.status(400).json({ ok: false, message: dates.error });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.orderAnnouncement.create({
      data: {
        title,
        body: text,
        kind,
        startsOn: dates.startsOn,
        endsOn: dates.endsOn,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/order-announcements/:announcementId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const announcementId = toBigInt(req.params.announcementId);
    if (!announcementId) {
      res.status(400).json({ ok: false, message: "參數錯誤：announcementId" });
      return;
    }
    const existing = await prisma.orderAnnouncement.findUnique({ where: { id: announcementId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到公告" });
      return;
    }
    const body = req.body as {
      title?: unknown;
      body?: unknown;
      kind?: unknown;
      startsOnYmd?: unknown;
      endsOnYmd?: unknown;
      sortOrder?: unknown;
      isActive?: unknown;
    };
    const data: Prisma.OrderAnnouncementUpdateInput = {};
    if (body.title !== undefined) {
      const title = trimOptionalString(body.title);
      if (!title) {
        res.status(400).json({ ok: false, message: "公告名稱不可為空" });
        return;
      }
      if (title.length > 80) {
        res.status(400).json({ ok: false, message: "公告名稱不可超過 80 字" });
        return;
      }
      data.title = title;
    }
    if (body.body !== undefined) {
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) {
        res.status(400).json({ ok: false, message: "公告內容不可為空" });
        return;
      }
      data.body = text;
    }
    const nextKind = body.kind !== undefined ? parseAnnouncementKind(body.kind) : existing.kind;
    if (body.kind !== undefined && !nextKind) {
      res.status(400).json({ ok: false, message: "kind 須為 standing 或 period" });
      return;
    }
    if (nextKind) {
      data.kind = nextKind;
      const startsInput = body.startsOnYmd !== undefined ? body.startsOnYmd : existing.startsOn ? toLocalYmd(existing.startsOn) : undefined;
      const endsInput = body.endsOnYmd !== undefined ? body.endsOnYmd : existing.endsOn ? toLocalYmd(existing.endsOn) : undefined;
      const dates = parseAnnouncementDates(nextKind as "standing" | "period", startsInput, endsInput);
      if ("error" in dates) {
        res.status(400).json({ ok: false, message: dates.error });
        return;
      }
      data.startsOn = dates.startsOn;
      data.endsOn = dates.endsOn;
    } else if (body.startsOnYmd !== undefined || body.endsOnYmd !== undefined) {
      const dates = parseAnnouncementDates(existing.kind as "standing" | "period", body.startsOnYmd, body.endsOnYmd);
      if ("error" in dates) {
        res.status(400).json({ ok: false, message: dates.error });
        return;
      }
      data.startsOn = dates.startsOn;
      data.endsOn = dates.endsOn;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }
    const row = await prisma.orderAnnouncement.update({ where: { id: announcementId }, data });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到公告" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/order-announcements/:announcementId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const announcementId = toBigInt(req.params.announcementId);
    if (!announcementId) {
      res.status(400).json({ ok: false, message: "參數錯誤：announcementId" });
      return;
    }
    await prisma.orderAnnouncement.delete({ where: { id: announcementId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到公告" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/promotion-rules", async (_req, res) => {
  try {
    const rows = await prisma.promotionRule.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
    res.json(rows.map(serializePromotionRule));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/promotion-rules/:ruleKey", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const ruleKey = typeof req.params.ruleKey === "string" ? req.params.ruleKey.trim() : "";
    if (!ruleKey) {
      res.status(400).json({ ok: false, message: "參數錯誤：ruleKey" });
      return;
    }
    const existing = await prisma.promotionRule.findUnique({ where: { ruleKey } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到優惠規則" });
      return;
    }
    const body = req.body as { isEnabled?: unknown; config?: unknown };
    const data: Prisma.PromotionRuleUpdateInput = {};
    if (body.isEnabled !== undefined) {
      data.isEnabled = Boolean(body.isEnabled);
    }
    if (body.config !== undefined) {
      if (ruleKey === "prepaid_topup_bonus") {
        const v = validatePrepaidTopupBonusConfig(body.config);
        if (!v.ok) {
          res.status(400).json({ ok: false, message: v.message });
          return;
        }
        data.config = v.data;
      } else {
        data.config = body.config && typeof body.config === "object" ? body.config : {};
      }
    }
    const row = await prisma.promotionRule.update({ where: { ruleKey }, data });
    res.json({ ok: true, data: serializePromotionRule(row) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/promotion-dispenser-gift-rules", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.promotionDispenserGiftRule.findMany({
      where: all ? undefined : { isActive: true },
      include: { triggerProduct: true, giftProduct: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    res.json(rows.map(serializeDispenserGiftRule));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/promotion-dispenser-gift-rules", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const body = req.body as {
      triggerProductId?: unknown;
      giftProductId?: unknown;
      giftQtyPerUnit?: unknown;
      sortOrder?: unknown;
    };
    const triggerProductId = toBigInt(body.triggerProductId);
    const giftProductId = toBigInt(body.giftProductId);
    const giftQtyPerUnit = Math.floor(Number(body.giftQtyPerUnit ?? 0));
    if (!triggerProductId || !giftProductId) {
      res.status(400).json({ ok: false, message: "請選擇飲水機商品與贈送商品" });
      return;
    }
    if (!Number.isFinite(giftQtyPerUnit) || giftQtyPerUnit <= 0) {
      res.status(400).json({ ok: false, message: "每台贈送桶數須為正整數" });
      return;
    }
    if (triggerProductId === giftProductId) {
      res.status(400).json({ ok: false, message: "贈送商品不可與飲水機商品相同" });
      return;
    }
    const [triggerProduct, giftProduct] = await Promise.all([
      prisma.product.findUnique({ where: { id: triggerProductId } }),
      prisma.product.findUnique({ where: { id: giftProductId } }),
    ]);
    if (!triggerProduct || !triggerProduct.isActive) {
      res.status(400).json({ ok: false, message: "飲水機商品不存在或已停用" });
      return;
    }
    if (!giftProduct || !giftProduct.isActive) {
      res.status(400).json({ ok: false, message: "贈送商品不存在或已停用" });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.promotionDispenserGiftRule.create({
      data: {
        triggerProductId,
        giftProductId,
        giftQtyPerUnit,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      },
      include: { triggerProduct: true, giftProduct: true },
    });
    res.status(201).json({ ok: true, data: serializeDispenserGiftRule(row) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(400).json({ ok: false, message: "此飲水機商品已有贈品規則" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/promotion-dispenser-gift-rules/:ruleId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const ruleId = toBigInt(req.params.ruleId);
    if (!ruleId) {
      res.status(400).json({ ok: false, message: "參數錯誤：ruleId" });
      return;
    }
    const existing = await prisma.promotionDispenserGiftRule.findUnique({ where: { id: ruleId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到規則" });
      return;
    }
    const body = req.body as {
      triggerProductId?: unknown;
      giftProductId?: unknown;
      giftQtyPerUnit?: unknown;
      sortOrder?: unknown;
      isActive?: unknown;
    };
    const data: Prisma.PromotionDispenserGiftRuleUpdateInput = {};
    if (body.triggerProductId !== undefined) {
      const triggerProductId = toBigInt(body.triggerProductId);
      if (!triggerProductId) {
        res.status(400).json({ ok: false, message: "飲水機商品無效" });
        return;
      }
      const triggerProduct = await prisma.product.findUnique({ where: { id: triggerProductId } });
      if (!triggerProduct || !triggerProduct.isActive) {
        res.status(400).json({ ok: false, message: "飲水機商品不存在或已停用" });
        return;
      }
      data.triggerProduct = { connect: { id: triggerProductId } };
    }
    if (body.giftProductId !== undefined) {
      const giftProductId = toBigInt(body.giftProductId);
      if (!giftProductId) {
        res.status(400).json({ ok: false, message: "贈送商品無效" });
        return;
      }
      const giftProduct = await prisma.product.findUnique({ where: { id: giftProductId } });
      if (!giftProduct || !giftProduct.isActive) {
        res.status(400).json({ ok: false, message: "贈送商品不存在或已停用" });
        return;
      }
      data.giftProduct = { connect: { id: giftProductId } };
    }
    if (body.giftQtyPerUnit !== undefined) {
      const giftQtyPerUnit = Math.floor(Number(body.giftQtyPerUnit));
      if (!Number.isFinite(giftQtyPerUnit) || giftQtyPerUnit <= 0) {
        res.status(400).json({ ok: false, message: "每台贈送桶數須為正整數" });
        return;
      }
      data.giftQtyPerUnit = giftQtyPerUnit;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }
    const nextTriggerId =
      body.triggerProductId !== undefined ? toBigInt(body.triggerProductId) : existing.triggerProductId;
    const nextGiftId = body.giftProductId !== undefined ? toBigInt(body.giftProductId) : existing.giftProductId;
    if (nextTriggerId && nextGiftId && nextTriggerId === nextGiftId) {
      res.status(400).json({ ok: false, message: "贈送商品不可與飲水機商品相同" });
      return;
    }
    const row = await prisma.promotionDispenserGiftRule.update({
      where: { id: ruleId },
      data,
      include: { triggerProduct: true, giftProduct: true },
    });
    res.json({ ok: true, data: serializeDispenserGiftRule(row) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(400).json({ ok: false, message: "此飲水機商品已有贈品規則" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/promotion-dispenser-gift-rules/:ruleId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const ruleId = toBigInt(req.params.ruleId);
    if (!ruleId) {
      res.status(400).json({ ok: false, message: "參數錯誤：ruleId" });
      return;
    }
    await prisma.promotionDispenserGiftRule.delete({ where: { id: ruleId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到規則" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/promotion-rules/preview", async (req, res) => {
  try {
    const body = req.body as { lines?: unknown };
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.json({ ok: true, data: { messages: [], giftLines: [] } });
      return;
    }
    const draftLines: DraftOrderLine[] = [];
    for (const row of body.lines) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as {
        productId?: unknown;
        qty?: unknown;
        billingType?: unknown;
        linePurpose?: unknown;
        invoiceMode?: unknown;
        isReplenishment?: unknown;
      };
      const pid = toBigInt(r.productId);
      const q = Number(r.qty);
      if (!pid || !Number.isInteger(q) || q < 0) continue;
      const isReplenishment = Boolean(r.isReplenishment);
      draftLines.push({
        productId: pid,
        qty: q,
        unitPrice: null,
        billingType: isReplenishment ? "cash" : normalizeLineBillingType(r.billingType, "cash"),
        linePurpose: isReplenishment ? "delivery" : normalizeLinePurpose(r.linePurpose),
        invoiceMode: normalizeLineInvoiceMode(r.invoiceMode),
        isReplenishment,
      });
    }
    const { lines, messages } = await applyPromotions(prisma, draftLines);
    const giftLines = lines
      .filter((l) => l.isPromotionGift)
      .map((l) => ({
        productId: l.productId.toString(),
        qty: l.qty,
        linePurpose: l.linePurpose,
        promotionRuleKey: l.promotionRuleKey ?? null,
        promotionNote: l.promotionNote ?? null,
      }));
    res.json({ ok: true, data: { messages, giftLines } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/customer-churn-reasons", async (_req, res) => {
  try {
    const rows = await prisma.customerChurnReason.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        label: r.label,
        sortOrder: r.sortOrder,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/customers/:customerId/lifecycle-events", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const rows = await prisma.customerLifecycleEvent.findMany({
      where: { customerId },
      include: {
        churnReason: { select: { id: true, code: true, label: true } },
        recordedBy: { select: { id: true, name: true, employeeCode: true } },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    });
    res.json({
      ok: true,
      data: rows.map((e) => ({
        id: e.id.toString(),
        eventType: e.eventType,
        effectiveAt: e.effectiveAt ? fmtDbDateYmd(e.effectiveAt) : null,
        churnReason: e.churnReason
          ? { id: e.churnReason.id.toString(), code: e.churnReason.code, label: e.churnReason.label }
          : null,
        note: e.note,
        recordedBy: e.recordedBy
          ? { id: e.recordedBy.id.toString(), name: e.recordedBy.name, employeeCode: e.recordedBy.employeeCode }
          : null,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/customers/:customerId/churn", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const body = (req.body ?? {}) as {
      churnReasonId?: unknown;
      churnReasonNote?: unknown;
      churnedAtYmd?: unknown;
      churnedAt?: unknown;
    };
    const churnReasonId = toBigInt(body.churnReasonId);
    if (!churnReasonId) {
      res.status(400).json({ ok: false, message: "請選擇流失原因" });
      return;
    }
    const reason = await prisma.customerChurnReason.findFirst({
      where: { id: churnReasonId, isActive: true },
    });
    if (!reason) {
      res.status(400).json({ ok: false, message: "流失原因不存在或已停用" });
      return;
    }
    const note = typeof body.churnReasonNote === "string" ? body.churnReasonNote.trim() : "";
    if (reason.code === "other" && !note) {
      res.status(400).json({ ok: false, message: "原因為「其他」時請填寫說明" });
      return;
    }
    const effectiveResolved = resolvePaidAtFromBody({
      paidAtYmd: body.churnedAtYmd,
      paidAt: body.churnedAt,
    });
    if ("error" in effectiveResolved) {
      res.status(400).json({ ok: false, message: effectiveResolved.error });
      return;
    }
    const effectiveDb = parseLocalYmdToDbDate(toLocalYmd(effectiveResolved));
    if (!effectiveDb) {
      res.status(400).json({ ok: false, message: "流失生效日無效" });
      return;
    }

    const warnings = await loadCustomerLifecycleWarnings(prisma, customerId);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id: customerId } });
      if (!existing) throw new Error("CUSTOMER_NOT_FOUND");
      if (existing.lifecycleStatus === "churned") throw new Error("ALREADY_CHURNED");

      await tx.customer.update({
        where: { id: customerId },
        data: {
          lifecycleStatus: "churned",
          churnedAt: effectiveDb,
          churnReasonId,
          churnReasonNote: note || null,
        },
      });
      await tx.customerLifecycleEvent.create({
        data: {
          customerId,
          eventType: "churned",
          effectiveAt: effectiveDb,
          churnReasonId,
          note: note || null,
          recordedByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      return tx.customer.findUnique({
        where: { id: customerId },
        include: customerMasterInclude,
      });
    });

    res.json({ ok: true, data: enrichCustomerBarrels(result!), warnings });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("CUSTOMER_NOT_FOUND")) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    if (msg.includes("ALREADY_CHURNED")) {
      res.status(400).json({ ok: false, message: "此客戶已是流失狀態" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.post("/api/customers/:customerId/reactivate", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const body = (req.body ?? {}) as { note?: unknown; reactivatedAtYmd?: unknown; reactivatedAt?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const effectiveResolved = resolvePaidAtFromBody({
      paidAtYmd: body.reactivatedAtYmd,
      paidAt: body.reactivatedAt,
    });
    if ("error" in effectiveResolved) {
      res.status(400).json({ ok: false, message: effectiveResolved.error });
      return;
    }
    const effectiveDb = parseLocalYmdToDbDate(toLocalYmd(effectiveResolved));
    if (!effectiveDb) {
      res.status(400).json({ ok: false, message: "回流生效日無效" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id: customerId } });
      if (!existing) throw new Error("CUSTOMER_NOT_FOUND");
      if (existing.lifecycleStatus !== "churned") throw new Error("NOT_CHURNED");

      await tx.customer.update({
        where: { id: customerId },
        data: {
          lifecycleStatus: "active",
          churnedAt: null,
          churnReasonId: null,
          churnReasonNote: null,
        },
      });
      await tx.customerLifecycleEvent.create({
        data: {
          customerId,
          eventType: "reactivated",
          effectiveAt: effectiveDb,
          note: note || null,
          recordedByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      return tx.customer.findUnique({
        where: { id: customerId },
        include: customerMasterInclude,
      });
    });

    res.json({ ok: true, data: enrichCustomerBarrels(result!) });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("CUSTOMER_NOT_FOUND")) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    if (msg.includes("NOT_CHURNED")) {
      res.status(400).json({ ok: false, message: "此客戶目前不是流失狀態" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.get("/api/reports/customer-lifecycle", async (req, res) => {
  try {
    const yearMonth =
      typeof req.query.yearMonth === "string" && req.query.yearMonth.trim()
        ? req.query.yearMonth.trim()
        : billingPeriodKeyFromDate(new Date());
    const range = monthRangeFromYearMonth(yearMonth);
    if ("error" in range) {
      res.status(400).json({ ok: false, message: range.error });
      return;
    }
    const addressZoneId = req.query.addressZoneId ? toBigInt(req.query.addressZoneId) : null;
    const affiliatedCompanyId = req.query.affiliatedCompanyId ? toBigInt(req.query.affiliatedCompanyId) : null;
    const scope = customerReportScopeWhere(addressZoneId, affiliatedCompanyId);
    const monthStartDb = parseLocalYmdToDbDate(toLocalYmd(range.start))!;
    const monthEndExclusiveDb = parseLocalYmdToDbDate(toLocalYmd(range.end))!;
    const effectiveInMonth = { gte: monthStartDb, lt: monthEndExclusiveDb };

    const [newCustomers, churnEvents, reactivateEvents, reasonRows] = await Promise.all([
      prisma.customer.findMany({
        where: {
          ...scope,
          createdAt: { gte: range.start, lt: range.end },
        },
        include: {
          addressZone: { select: { id: true, name: true } },
          affiliatedCompany: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.customerLifecycleEvent.findMany({
        where: {
          eventType: "churned",
          effectiveAt: effectiveInMonth,
          customer: scope,
        },
        include: {
          customer: {
            include: {
              addressZone: { select: { id: true, name: true } },
              affiliatedCompany: { select: { id: true, name: true } },
              churnReason: { select: { id: true, code: true, label: true } },
            },
          },
          churnReason: { select: { id: true, code: true, label: true } },
        },
        orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
      }),
      prisma.customerLifecycleEvent.findMany({
        where: {
          eventType: "reactivated",
          effectiveAt: effectiveInMonth,
          customer: scope,
        },
        include: {
          customer: {
            include: {
              addressZone: { select: { id: true, name: true } },
              affiliatedCompany: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
      }),
      prisma.customerLifecycleEvent.groupBy({
        by: ["churnReasonId"],
        where: {
          eventType: "churned",
          effectiveAt: effectiveInMonth,
          customer: scope,
          churnReasonId: { not: null },
        },
        _count: { id: true },
      }),
    ]);

    const churnCustomerIds = [...new Set(churnEvents.map((e) => e.customerId))];
    const eventCountRows =
      churnCustomerIds.length > 0
        ? await prisma.customerLifecycleEvent.groupBy({
            by: ["customerId", "eventType"],
            where: { customerId: { in: churnCustomerIds } },
            _count: { id: true },
          })
        : [];
    const eventCountMap = new Map<string, { churned: number; reactivated: number }>();
    for (const row of eventCountRows) {
      const key = row.customerId.toString();
      const cur = eventCountMap.get(key) ?? { churned: 0, reactivated: 0 };
      if (row.eventType === "churned") cur.churned = row._count.id;
      if (row.eventType === "reactivated") cur.reactivated = row._count.id;
      eventCountMap.set(key, cur);
    }

    const lastDeliveryRows =
      churnCustomerIds.length > 0
        ? await prisma.salesOrder.findMany({
            where: {
              customerId: { in: churnCustomerIds },
              status: "completed",
              officeSettledAt: { not: null },
            },
            select: { customerId: true, officeSettledAt: true, orderNo: true },
            orderBy: [{ officeSettledAt: "desc" }, { id: "desc" }],
          })
        : [];
    const lastDeliveryByCustomer = new Map<string, { date: string; orderNo: string }>();
    for (const o of lastDeliveryRows) {
      const cid = o.customerId.toString();
      if (lastDeliveryByCustomer.has(cid)) continue;
      lastDeliveryByCustomer.set(cid, {
        date: o.officeSettledAt ? fmtDbDateYmd(o.officeSettledAt) : "",
        orderNo: o.orderNo,
      });
    }

    const reasonLabels = await prisma.customerChurnReason.findMany({
      where: { id: { in: reasonRows.map((r) => r.churnReasonId!).filter(Boolean) } },
    });
    const reasonLabelMap = new Map(reasonLabels.map((r) => [r.id.toString(), r.label]));

    const byReason = reasonRows
      .map((r) => ({
        reasonId: r.churnReasonId?.toString() ?? "",
        reasonLabel: r.churnReasonId ? (reasonLabelMap.get(r.churnReasonId.toString()) ?? "—") : "—",
        count: r._count.id,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      ok: true,
      data: {
        yearMonth: range.yearMonth,
        filters: {
          addressZoneId: addressZoneId?.toString() ?? null,
          affiliatedCompanyId: affiliatedCompanyId?.toString() ?? null,
        },
        summary: {
          newCount: newCustomers.length,
          churnedCount: churnEvents.length,
          churnedCustomerCount: churnCustomerIds.length,
          reactivatedCount: reactivateEvents.length,
          netNewMinusChurn: newCustomers.length - churnEvents.length,
        },
        newCustomers: newCustomers.map((c) => ({
          id: c.id.toString(),
          customerCode: c.customerCode,
          name: c.name,
          billingType: c.billingType,
          createdAt: c.createdAt.toISOString(),
          addressZone: c.addressZone,
          affiliatedCompany: c.affiliatedCompany,
        })),
        churnedCustomers: churnEvents.map((e) => {
          const c = e.customer;
          const counts = eventCountMap.get(c.id.toString()) ?? { churned: 0, reactivated: 0 };
          const last = lastDeliveryByCustomer.get(c.id.toString());
          return {
            eventId: e.id.toString(),
            id: c.id.toString(),
            customerCode: c.customerCode,
            name: c.name,
            billingType: c.billingType,
            lifecycleStatus: c.lifecycleStatus,
            churnedAt: fmtDbDateYmd(e.effectiveAt),
            reasonLabel: e.churnReason?.label ?? c.churnReason?.label ?? "—",
            reasonNote: e.note ?? c.churnReasonNote,
            addressZone: c.addressZone,
            affiliatedCompany: c.affiliatedCompany,
            lastDeliveryDate: last?.date ?? null,
            lastOrderNo: last?.orderNo ?? null,
            totalChurnCount: counts.churned,
            totalReactivatedCount: counts.reactivated,
          };
        }),
        reactivatedCustomers: reactivateEvents.map((e) => ({
          eventId: e.id.toString(),
          id: e.customer.id.toString(),
          customerCode: e.customer.customerCode,
          name: e.customer.name,
          reactivatedAt: fmtDbDateYmd(e.effectiveAt),
          note: e.note,
          addressZone: e.customer.addressZone,
          affiliatedCompany: e.customer.affiliatedCompany,
        })),
        byReason,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/customers", async (_req, res) => {
  try {
    const rows = await prisma.customer.findMany({
      include: customerMasterInclude,
      orderBy: [{ customerCode: "asc" }, { id: "desc" }],
    });
    res.json(rows.map(enrichCustomerBarrels));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/customers/:customerId", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const row = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        ...customerMasterInclude,
        salesOrders: {
          orderBy: { id: "desc" },
          take: 100,
          include: {
            deliveryAddress: true,
            lines: { include: { product: true } },
            assignments: {
              where: { status: { in: ["completed", "not_delivered", "pending_settlement"] } },
              orderBy: { id: "desc" },
              take: 1,
            },
            billingStatementOrder: true,
          },
        },
      },
    });
    if (!row) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    // 月結已付：applyAllocations 會回填 monthlyPeriodPaid／monthlyReceivedAmount；
    // 此處仍以 AR outstanding 做防禦性覆蓋，避免舊資料或未同步狀態顯示錯誤。
    const salesOrders = row.salesOrders ?? [];
    const idsWithMonthlyPortion = salesOrders.filter((o) => orderHasMonthlyPortion(o)).map((o) => o.id);

    const unpaidLegacyMonthlySet = new Set<string>();
    if (idsWithMonthlyPortion.length > 0) {
      const unpaid = await prisma.arOpenItem.groupBy({
        by: ["salesOrderId"],
        where: {
          customerId,
          salesOrderId: { in: idsWithMonthlyPortion },
          outstandingAmount: { gt: new Prisma.Decimal(0) },
          arDocument: { billingType: "monthly" },
        },
        _sum: { outstandingAmount: true },
      });
      for (const r of unpaid) {
        if (r.salesOrderId == null) continue;
        const sum = r._sum.outstandingAmount ?? new Prisma.Decimal(0);
        if (sum.greaterThan(0)) unpaidLegacyMonthlySet.add(String(r.salesOrderId));
      }
    }

    row.salesOrders = salesOrders.map((o) => {
      const withBillable = {
        ...o,
        orderBillableAmount: orderBillableAmount(o).toString(),
      };
      if (!orderHasMonthlyPortion(o)) return withBillable;
      if (unpaidLegacyMonthlySet.has(String(o.id))) {
        return { ...withBillable, monthlyPeriodPaid: false };
      }
      const cap = orderMonthlyCap(o);
      const inStatementBatch = (o as { billingStatementOrder?: { id: bigint } | null }).billingStatementOrder != null;
      const awaitingStatementPost = o.status === "completed" && !inStatementBatch && cap.greaterThan(0);
      if (awaitingStatementPost) {
        return { ...withBillable, monthlyPeriodPaid: false };
      }
      return withBillable;
    });

    res.json(enrichCustomerBarrels(row));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 客戶帳務摘要：往來餘額（正＝客戶欠公司）、預付桶餘額 */
app.get("/api/customers/:customerId/billing-summary", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    const [wallet, arAgg, prepaidByProduct] = await Promise.all([
      prisma.customerPrepaymentWallet.findUnique({ where: { customerId } }),
      prisma.arOpenItem.aggregate({
        where: activeArOpenItemWhere({ customerId }),
        _sum: { outstandingAmount: true },
      }),
      prisma.customerPrepaidProductBalance.findMany({
        where: { customerId, balanceBarrels: { gt: 0 } },
        include: { product: { select: { id: true, name: true } } },
        orderBy: [{ productId: "asc" }],
      }),
    ]);
    const arOutstandingDec = new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0);
    const walletDec = new Prisma.Decimal(wallet?.balanceAmount ?? 0);
    const accountBalance = Number(arOutstandingDec.minus(walletDec));
    res.json({
      ok: true,
      data: {
        billingType: cust.billingType,
        monthlySettlementDay: cust.monthlySettlementDay,
        prepaidBarrelBalance: cust.prepaidBarrelBalance,
        prepaidBarrelByProduct: prepaidByProduct.map((r) => ({
          productId: r.productId.toString(),
          productName: r.product.name,
          barrels: r.balanceBarrels,
        })),
        allowPrepaidOverdraft: cust.allowPrepaidOverdraft,
        prepaymentMoneyBalance: walletDec.toString(),
        arOutstandingAmount: arOutstandingDec.toString(),
        /** 新口徑：正＝客戶欠公司；負＝客戶預收高於未清應收 */
        accountBalance,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 客戶商品上次成交價：供開單頁快速參考（同客戶、同商品） */
app.get("/api/customers/:customerId/last-product-prices", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const rows = await prisma.salesOrderLine.findMany({
      where: {
        salesOrder: {
          customerId,
          status: { not: "cancelled" },
        },
      },
      include: {
        product: { select: { id: true, name: true } },
        salesOrder: { select: { orderNo: true, createdAt: true, scheduledDeliveryDate: true } },
      },
      orderBy: [{ id: "desc" }],
      take: 1000,
    });
    const seen = new Set<string>();
    const list: Array<{
      productId: string;
      productName: string;
      unitPrice: string;
      orderNo: string;
      orderedAt: string;
    }> = [];
    for (const r of rows) {
      const key = r.productId.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const orderDate = r.salesOrder.scheduledDeliveryDate ?? r.salesOrder.createdAt;
      list.push({
        productId: key,
        productName: r.product.name,
        unitPrice: r.unitPrice.toString(),
        orderNo: r.salesOrder.orderNo,
        orderedAt: orderDate.toISOString(),
      });
    }
    res.json({ ok: true, data: list });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/**
 * 客戶帳務明細（流水）：分錄列表，並依時間序計算「本筆後往來餘額」。
 * 預設取最近 limit 筆（由新到舊排列）；餘額計算仍與全帳連續。
 */
app.get("/api/customers/:customerId/billing-ledger", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200));

    const [arDocs, allocs, prepayTxns, creditNotes, wallet, arAgg] = await Promise.all([
      prisma.arDocument.findMany({
        where: activeArDocumentWhere({ customerId }),
        include: { salesOrder: { select: { id: true, orderNo: true } } },
      }),
      prisma.arAllocationMap.findMany({
        where: { arOpenItem: { customerId } },
        include: {
          arOpenItem: { select: { salesOrderId: true, salesOrder: { select: { orderNo: true } } } },
          receiptVoucher: { select: { id: true, paymentMethod: true, paidAt: true, totalAmount: true } },
        },
      }),
      prisma.prepaymentTxn.findMany({
        where: { customerId },
        include: { receiptVoucher: { select: { id: true, paymentMethod: true, paidAt: true, totalAmount: true } } },
      }),
      prisma.creditNote.findMany({
        where: { customerId },
        include: { salesOrder: { select: { id: true, orderNo: true } } },
      }),
      prisma.customerPrepaymentWallet.findUnique({ where: { customerId } }),
      prisma.arOpenItem.aggregate({
        where: activeArOpenItemWhere({ customerId }),
        _sum: { outstandingAmount: true },
      }),
    ]);

    const rawEntries: Array<{
      id: string;
      entryType: string;
      amount: Prisma.Decimal;
      barrelDelta: number;
      salesOrderId: string | null;
      orderNo: string | null;
      paymentId: string | null;
      payment: { id: string; amount: string; paidAt: string; paymentMethod: string } | null;
      note: string | null;
      createdAt: Date;
    }> = [];

    for (const d of arDocs) {
      rawEntries.push({
        id: `ar_doc_${d.id.toString()}`,
        entryType: "ar_accrual",
        amount: new Prisma.Decimal(d.documentAmount),
        barrelDelta: 0,
        salesOrderId: d.salesOrderId ? d.salesOrderId.toString() : null,
        orderNo: d.salesOrder?.orderNo ?? null,
        paymentId: null,
        payment: null,
        note: `AR立帳 ${d.arNo}`,
        createdAt: d.postedAt,
      });
    }
    for (const a of allocs) {
      rawEntries.push({
        id: `ar_alloc_${a.id.toString()}`,
        entryType: "ar_receipt_alloc",
        amount: new Prisma.Decimal(a.allocatedAmount).negated(),
        barrelDelta: 0,
        salesOrderId: a.arOpenItem.salesOrderId ? a.arOpenItem.salesOrderId.toString() : null,
        orderNo: a.arOpenItem.salesOrder?.orderNo ?? null,
        paymentId: a.receiptVoucher.id.toString(),
        payment: {
          id: a.receiptVoucher.id.toString(),
          amount: a.receiptVoucher.totalAmount.toString(),
          paidAt: a.receiptVoucher.paidAt.toISOString(),
          paymentMethod: a.receiptVoucher.paymentMethod,
        },
        note: `收款沖帳 ${a.receiptVoucher.id.toString()}`,
        createdAt: a.allocatedAt,
      });
    }
    for (const t of prepayTxns) {
      rawEntries.push({
        id: `prepay_${t.id.toString()}`,
        entryType: "prepayment_wallet_txn",
        amount: new Prisma.Decimal(t.amount).negated(),
        barrelDelta: 0,
        salesOrderId: null,
        orderNo: null,
        paymentId: t.receiptVoucherId ? t.receiptVoucherId.toString() : null,
        payment: t.receiptVoucher
          ? {
              id: t.receiptVoucher.id.toString(),
              amount: t.receiptVoucher.totalAmount.toString(),
              paidAt: t.receiptVoucher.paidAt.toISOString(),
              paymentMethod: t.receiptVoucher.paymentMethod,
            }
          : null,
        note: t.note ?? t.txnType,
        createdAt: t.createdAt,
      });
    }
    for (const cnote of creditNotes) {
      rawEntries.push({
        id: `credit_${cnote.id.toString()}`,
        entryType: "credit_note_alloc",
        amount: new Prisma.Decimal(cnote.amount).negated(),
        barrelDelta: 0,
        salesOrderId: cnote.salesOrderId ? cnote.salesOrderId.toString() : null,
        orderNo: cnote.salesOrder?.orderNo ?? null,
        paymentId: null,
        payment: null,
        note: cnote.reason ?? `折讓 ${cnote.creditNo}`,
        createdAt: cnote.createdAt,
      });
    }

    rawEntries.sort((a, b) => {
      const d = a.createdAt.getTime() - b.createdAt.getTime();
      if (d !== 0) return d;
      return a.id.localeCompare(b.id);
    });

    const totalCount = rawEntries.length;
    const accountBalance = Number(new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0).minus(new Prisma.Decimal(wallet?.balanceAmount ?? 0)));

    if (rawEntries.length === 0) {
      res.json({
        ok: true,
        data: {
          customerId: customerId.toString(),
          totalCount,
          limit,
          accountBalance,
          entries: [] as unknown[],
        },
      });
      return;
    }

    let running = 0;
    const entriesAll = rawEntries.map((r) => {
      running += Number(r.amount);
      return {
        id: r.id,
        entryType: r.entryType,
        amount: r.amount.toString(),
        barrelDelta: r.barrelDelta,
        salesOrderId: r.salesOrderId,
        orderNo: r.orderNo,
        paymentId: r.paymentId,
        payment: r.payment,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        createdBy: null,
        balanceAfter: running,
      };
    });
    const entries = entriesAll.slice(Math.max(0, entriesAll.length - limit)).reverse();

    res.json({
      ok: true,
      data: {
        customerId: customerId.toString(),
        totalCount,
        limit,
        accountBalance,
        entries,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 客戶現金／銷單收款紀錄（payments 表，與流水互補） */
app.get("/api/customers/:customerId/payments", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Math.min(300, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));

    const rows = await prisma.payment.findMany({
      where: { customerId },
      orderBy: { id: "desc" },
      take: limit,
      include: {
        salesOrder: { select: { orderNo: true } },
      },
    });

    res.json({
      ok: true,
      data: {
        customerId: customerId.toString(),
        limit,
        payments: rows.map((p) => ({
          id: p.id.toString(),
          amount: p.amount.toString(),
          paymentMethod: p.paymentMethod,
          paidAt: p.paidAt.toISOString(),
          note: p.note,
          salesOrderId: p.salesOrderId?.toString() ?? null,
          orderNo: p.salesOrder?.orderNo ?? null,
        })),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/customers/:customerId/prepaid-topup", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }
    const body = req.body as { barrels?: unknown; note?: unknown };
    const barrels = Math.floor(Number(body.barrels ?? 0));
    if (!Number.isFinite(barrels) || barrels <= 0) {
      res.status(400).json({ ok: false, message: "儲值桶數須為正整數" });
      return;
    }
    const note = typeof body.note === "string" ? body.note.trim() || null : null;

    const result = await prisma.$transaction(async (tx) => {
      const cust = await tx.customer.findUnique({ where: { id: customerId } });
      if (!cust) {
        return null;
      }
      if (cust.billingType !== "prepaid") {
        throw new Error("NOT_PREPAID");
      }
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: { prepaidBarrelBalance: cust.prepaidBarrelBalance + barrels },
      });
      await tx.customerLedgerEntry.create({
        data: {
          customerId,
          entryType: "prepaid_topup",
          amount: new Prisma.Decimal(0),
          barrelDelta: barrels,
          note: note ?? `預付儲值 +${barrels} 桶`,
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      return updated;
    });

    if (result === null) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    res.status(201).json({ ok: true, data: result });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("NOT_PREPAID")) {
      res.status(400).json({ ok: false, message: "僅預付客戶可儲值桶數" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

type AddressInput = {
  label?: unknown;
  addressLine?: unknown;
  deliveryFloor?: unknown;
  contactName?: unknown;
  contactPhone?: unknown;
  contactMobile?: unknown;
  isDefault?: unknown;
  barrelsOnSite?: unknown;
  patrolWeekday?: unknown;
  targetWaterLevel?: unknown;
  patrolProductId?: unknown;
};

type AddressCreateRow = {
  label: string | null;
  addressLine: string;
  deliveryFloor: number | null;
  contactName: string | null;
  contactPhone: string | null;
  contactMobile: string | null;
  isDefault: boolean;
  barrelsOnSite: number;
  patrolWeekday: number | null;
  targetWaterLevel: number | null;
  patrolProductId: bigint | null;
};

const normalizeAddressCreates = (
  raw: unknown,
): AddressCreateRow[] | "INVALID_BARRELS" | "INVALID_FLOOR" | "INVALID_PATROL" => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: AddressCreateRow[] = [];
  let defaultSeen = false;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as AddressInput;
    const addressLine = typeof o.addressLine === "string" ? o.addressLine.trim() : "";
    if (!addressLine) continue;
    const barrelsParsed = parseNonNegativeBarrelCount(o.barrelsOnSite, "barrelsOnSite");
    if (barrelsParsed === "INVALID") return "INVALID_BARRELS";
    const floorParsed = parseOptionalDeliveryFloor(o.deliveryFloor);
    if (floorParsed === "INVALID") return "INVALID_FLOOR";
    const weekdayParsed = parseOptionalPatrolWeekday(o.patrolWeekday);
    if (weekdayParsed === "INVALID") return "INVALID_PATROL";
    const levelParsed = parseOptionalTargetWaterLevel(o.targetWaterLevel);
    if (levelParsed === "INVALID") return "INVALID_PATROL";
    const patrolProductId =
      o.patrolProductId === null || o.patrolProductId === undefined || o.patrolProductId === ""
        ? null
        : toBigInt(o.patrolProductId);
    if (weekdayParsed != null && !patrolProductId) return "INVALID_PATROL";
    const label = trimOptionalString(o.label);
    const contactName = trimOptionalString(o.contactName);
    const contactPhone = trimOptionalString(o.contactPhone);
    const contactMobile = trimOptionalString(o.contactMobile);
    let isDefault = Boolean(o.isDefault);
    if (isDefault) {
      if (defaultSeen) isDefault = false;
      else defaultSeen = true;
    }
    out.push({
      label,
      addressLine,
      deliveryFloor: floorParsed,
      contactName,
      contactPhone,
      contactMobile,
      isDefault,
      barrelsOnSite: barrelsParsed,
      patrolWeekday: weekdayParsed,
      targetWaterLevel: levelParsed,
      patrolProductId,
    });
  }
  if (out.length > 0 && !out.some((a) => a.isDefault)) {
    out[0].isDefault = true;
  }
  return out;
};

app.post("/api/customers", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const body = req.body as {
      customerCode?: unknown;
      name?: unknown;
      contactName?: unknown;
      phone?: unknown;
      mobile?: unknown;
      taxId?: unknown;
      billingType?: unknown;
      defaultCashInvoiceMode?: unknown;
      addressZoneId?: unknown;
      affiliatedCompanyId?: unknown;
      creditLimit?: unknown;
      notes?: unknown;
      standingRemark?: unknown;
      addresses?: unknown;
      monthlySettlementDay?: unknown;
      allowPrepaidOverdraft?: unknown;
    };

    const customerCode = normalizeCustomerCode(body.customerCode);
    if (!customerCode) {
      res.status(400).json({ ok: false, message: "客戶編號須為 6 碼數字" });
      return;
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ ok: false, message: "客戶名稱為必填" });
      return;
    }

    const contactName = trimOptionalString(body.contactName);
    const phone = trimOptionalString(body.phone);
    const mobile = trimOptionalString(body.mobile);
    if (mobile) {
      const normalizedMobile = normalizeMobile(mobile);
      if (normalizedMobile) {
        const dup = await prisma.customer.findFirst({
          where: { OR: [{ mobile: normalizedMobile }, { phone: normalizedMobile }] },
          select: { id: true },
        });
        if (dup) {
          res.status(409).json({ ok: false, message: "此手機已有客戶資料，請使用既有客戶或聯繫客服" });
          return;
        }
      }
    }
    const taxIdNorm = normalizeTaxId(body.taxId);
    if (taxIdNorm === "INVALID") {
      res.status(400).json({ ok: false, message: "統一編號須為 8 碼數字" });
      return;
    }
    const billingType =
      typeof body.billingType === "string" && ["cash", "monthly", "prepaid"].includes(body.billingType)
        ? body.billingType
        : "cash";
    const defaultCashInvoiceMode = normalizeCashInvoiceMode(body.defaultCashInvoiceMode ?? "none");
    const addressZoneId = parseOptionalFkId(body.addressZoneId);
    if (addressZoneId) {
      const ok = await assertAddressZoneId(addressZoneId);
      if (!ok) {
        res.status(400).json({ ok: false, message: "地址分區不存在或已停用" });
        return;
      }
    }
    const affiliatedCompanyId = parseOptionalFkId(body.affiliatedCompanyId);
    if (affiliatedCompanyId) {
      const ok = await assertAffiliatedCompanyId(affiliatedCompanyId);
      if (!ok) {
        res.status(400).json({ ok: false, message: "隸屬公司不存在或已停用" });
        return;
      }
    }
    let monthlySettlementDay: number | null = null;
    if (body.monthlySettlementDay !== undefined && body.monthlySettlementDay !== null) {
      const d = Math.floor(Number(body.monthlySettlementDay));
      if (!Number.isFinite(d) || d < 1 || d > 31) {
        res.status(400).json({ ok: false, message: "月結日須為 1–31" });
        return;
      }
      monthlySettlementDay = d;
    }
    const allowPrepaidOverdraft =
      typeof body.allowPrepaidOverdraft === "boolean" ? body.allowPrepaidOverdraft : false;
    const creditLimit = new Prisma.Decimal(Number(body.creditLimit ?? 0));
    if (creditLimit.lessThan(0)) {
      res.status(400).json({ ok: false, message: "信用額度不可為負" });
      return;
    }
    const notes = trimOptionalString(body.notes);
    const standingRemark = trimOptionalString(body.standingRemark);

    const addressCreates = normalizeAddressCreates(body.addresses);
    if (addressCreates === "INVALID_BARRELS") {
      res.status(400).json({ ok: false, message: "各送貨點未收回空桶須為非負整數" });
      return;
    }
    if (addressCreates === "INVALID_FLOOR") {
      res.status(400).json({ ok: false, message: "送貨樓層須為非零整數（地下樓可填 -1、-2）或留空" });
      return;
    }
    if (addressCreates === "INVALID_PATROL") {
      res.status(400).json({
        ok: false,
        message: "巡查設定無效：星期須為 1–7；啟用巡查時須指定預設商品；目標水位須為非負整數或留空",
      });
      return;
    }
    if (addressCreates.length === 0) {
      res.status(400).json({ ok: false, message: "請至少新增一筆送貨地址（地址內容必填）" });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customer.create({
        data: {
          customerCode,
          name,
          contactName,
          phone,
          mobile,
          taxId: taxIdNorm,
          billingType,
          defaultCashInvoiceMode,
          addressZoneId: addressZoneId ?? undefined,
          affiliatedCompanyId: affiliatedCompanyId ?? undefined,
          creditLimit,
          notes,
          standingRemark,
          monthlySettlementDay: monthlySettlementDay ?? undefined,
          allowPrepaidOverdraft,
          addresses: {
            create: addressCreates,
          },
        } as Prisma.CustomerCreateInput,
        include: customerMasterInclude,
      });
      const effectiveDb = parseLocalYmdToDbDate(toLocalYmd(row.createdAt));
      if (effectiveDb) {
        await tx.customerLifecycleEvent.create({
          data: {
            customerId: row.id,
            eventType: "created",
            effectiveAt: effectiveDb,
            recordedByUserId: DEFAULT_CREATOR_USER_ID,
          },
        });
      }
      return row;
    });

    res.status(201).json({ ok: true, data: enrichCustomerBarrels(created) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "客戶編號已存在，請改用其他 6 碼編號" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/customers/:customerId", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }

    const body = req.body as {
      customerCode?: unknown;
      name?: unknown;
      contactName?: unknown;
      phone?: unknown;
      mobile?: unknown;
      taxId?: unknown;
      billingType?: unknown;
      defaultCashInvoiceMode?: unknown;
      addressZoneId?: unknown;
      affiliatedCompanyId?: unknown;
      creditLimit?: unknown;
      notes?: unknown;
      standingRemark?: unknown;
      monthlySettlementDay?: unknown;
      allowPrepaidOverdraft?: unknown;
    };

    const existing = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    const data: {
      customerCode?: string;
      name?: string;
      contactName?: string | null;
      phone?: string | null;
      mobile?: string | null;
      taxId?: string | null;
      billingType?: string;
      defaultCashInvoiceMode?: string;
      addressZoneId?: bigint | null;
      affiliatedCompanyId?: bigint | null;
      creditLimit?: Prisma.Decimal;
      notes?: string | null;
      standingRemark?: string | null;
      monthlySettlementDay?: number | null;
      allowPrepaidOverdraft?: boolean;
    } = {};

    if (body.customerCode !== undefined) {
      const code = normalizeCustomerCode(body.customerCode);
      if (!code) {
        res.status(400).json({ ok: false, message: "客戶編號須為 6 碼數字" });
        return;
      }
      data.customerCode = code;
    }

    if (typeof body.name === "string") {
      const n = body.name.trim();
      if (!n) {
        res.status(400).json({ ok: false, message: "名稱不可為空" });
        return;
      }
      data.name = n;
    }
    if (body.contactName !== undefined) {
      data.contactName = trimOptionalString(body.contactName);
    }
    if (body.phone !== undefined) {
      data.phone = trimOptionalString(body.phone);
    }
    if (body.mobile !== undefined) {
      data.mobile = trimOptionalString(body.mobile);
    }
    if (body.taxId !== undefined) {
      const taxIdNorm = normalizeTaxId(body.taxId);
      if (taxIdNorm === "INVALID") {
        res.status(400).json({ ok: false, message: "統一編號須為 8 碼數字" });
        return;
      }
      data.taxId = taxIdNorm;
    }
    if (typeof body.billingType === "string" && ["cash", "monthly", "prepaid"].includes(body.billingType)) {
      data.billingType = body.billingType;
    }
    if (body.defaultCashInvoiceMode !== undefined) {
      data.defaultCashInvoiceMode = normalizeCashInvoiceMode(body.defaultCashInvoiceMode);
    }
    if (body.addressZoneId !== undefined) {
      const zoneId = parseOptionalFkId(body.addressZoneId);
      if (zoneId) {
        const ok = await assertAddressZoneId(zoneId);
        if (!ok) {
          res.status(400).json({ ok: false, message: "地址分區不存在或已停用" });
          return;
        }
      }
      data.addressZoneId = zoneId ?? null;
    }
    if (body.affiliatedCompanyId !== undefined) {
      const companyId = parseOptionalFkId(body.affiliatedCompanyId);
      if (companyId) {
        const ok = await assertAffiliatedCompanyId(companyId);
        if (!ok) {
          res.status(400).json({ ok: false, message: "隸屬公司不存在或已停用" });
          return;
        }
      }
      data.affiliatedCompanyId = companyId ?? null;
    }
    if (body.monthlySettlementDay !== undefined) {
      if (body.monthlySettlementDay === null) {
        data.monthlySettlementDay = null;
      } else {
        const d = Math.floor(Number(body.monthlySettlementDay));
        if (!Number.isFinite(d) || d < 1 || d > 31) {
          res.status(400).json({ ok: false, message: "月結日須為 1–31 或 null" });
          return;
        }
        data.monthlySettlementDay = d;
      }
    }
    if (typeof body.allowPrepaidOverdraft === "boolean") {
      data.allowPrepaidOverdraft = body.allowPrepaidOverdraft;
    }
    if (body.creditLimit !== undefined) {
      const c = new Prisma.Decimal(Number(body.creditLimit));
      if (c.lessThan(0)) {
        res.status(400).json({ ok: false, message: "信用額度不可為負" });
        return;
      }
      data.creditLimit = c;
    }
    if (body.notes !== undefined) {
      data.notes = trimOptionalString(body.notes);
    }
    if (body.standingRemark !== undefined) {
      data.standingRemark = trimOptionalString(body.standingRemark);
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }

    const updated = await prisma.customer.update({
      where: { id: customerId },
      data: data as Prisma.CustomerUpdateInput,
      include: customerMasterInclude,
    });

    res.json({ ok: true, data: enrichCustomerBarrels(updated) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "客戶編號已存在，請改用其他 6 碼編號" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/customers/:customerId/addresses", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId" });
      return;
    }

    const body = req.body as AddressInput;
    const addressLine = typeof body.addressLine === "string" ? body.addressLine.trim() : "";
    if (!addressLine) {
      res.status(400).json({ ok: false, message: "地址內容為必填" });
      return;
    }

    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    const label = trimOptionalString(body.label);
    const contactName = trimOptionalString(body.contactName);
    const contactPhone = trimOptionalString(body.contactPhone);
    const contactMobile = trimOptionalString(body.contactMobile);
    const setDefault = Boolean(body.isDefault);
    const barrelsParsed = parseNonNegativeBarrelCount(body.barrelsOnSite, "barrelsOnSite");
    if (barrelsParsed === "INVALID") {
      res.status(400).json({ ok: false, message: "未收回空桶須為非負整數" });
      return;
    }
    const deliveryFloorParsed = parseOptionalDeliveryFloor(body.deliveryFloor);
    if (deliveryFloorParsed === "INVALID") {
      res.status(400).json({ ok: false, message: "送貨樓層須為非零整數（地下樓可填 -1、-2）或留空" });
      return;
    }
    const weekdayParsed = parseOptionalPatrolWeekday(body.patrolWeekday);
    if (weekdayParsed === "INVALID") {
      res.status(400).json({ ok: false, message: "巡查星期須為 1–7（週一～週日）或留空" });
      return;
    }
    const levelParsed = parseOptionalTargetWaterLevel(body.targetWaterLevel);
    if (levelParsed === "INVALID") {
      res.status(400).json({ ok: false, message: "目標水位須為非負整數或留空" });
      return;
    }
    const patrolProductId =
      body.patrolProductId === null || body.patrolProductId === undefined || body.patrolProductId === ""
        ? null
        : toBigInt(body.patrolProductId);
    if (weekdayParsed != null && !patrolProductId) {
      res.status(400).json({ ok: false, message: "啟用巡查時請指定預設商品" });
      return;
    }
    if (patrolProductId) {
      const p = await prisma.product.findUnique({ where: { id: patrolProductId } });
      if (!p || !p.isActive) {
        res.status(400).json({ ok: false, message: "巡查預設商品不存在或已停用" });
        return;
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      if (setDefault) {
        await tx.deliveryAddress.updateMany({
          where: { customerId },
          data: { isDefault: false },
        });
      }
      return tx.deliveryAddress.create({
        data: {
          customerId,
          label,
          addressLine,
          deliveryFloor: deliveryFloorParsed,
          contactName,
          contactPhone,
          contactMobile,
          isDefault: setDefault,
          barrelsOnSite: barrelsParsed,
          patrolWeekday: weekdayParsed,
          targetWaterLevel: levelParsed,
          patrolProductId,
        },
        include: {
          patrolProduct: { select: { id: true, name: true, productCode: true, isActive: true } },
        },
      });
    });

    res.status(201).json({ ok: true, data: created });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/customers/:customerId/addresses/:addressId", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    const addressId = toBigInt(req.params.addressId);
    if (!customerId || !addressId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId / addressId" });
      return;
    }

    const existing = await prisma.deliveryAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到地址或與客戶不符" });
      return;
    }

    const body = req.body as AddressInput;

    const data: {
      label?: string | null;
      addressLine?: string;
      deliveryFloor?: number | null;
      contactName?: string | null;
      contactPhone?: string | null;
      contactMobile?: string | null;
      isDefault?: boolean;
      barrelsOnSite?: number;
      patrolWeekday?: number | null;
      targetWaterLevel?: number | null;
      patrolProductId?: bigint | null;
      latitude?: null;
      longitude?: null;
      geocodeStatus?: string;
      geocodedAddress?: null;
      geocodedAt?: null;
      locationAccuracy?: null;
      manualLocationConfirmed?: boolean;
    } = {};

    if (body.label !== undefined) {
      data.label = trimOptionalString(body.label);
    }
    if (body.addressLine !== undefined) {
      const line = typeof body.addressLine === "string" ? body.addressLine.trim() : "";
      if (!line) {
        res.status(400).json({ ok: false, message: "地址內容不可為空" });
        return;
      }
      data.addressLine = line;
    }
    if (body.deliveryFloor !== undefined) {
      const floorParsed = parseOptionalDeliveryFloor(body.deliveryFloor);
      if (floorParsed === "INVALID") {
        res.status(400).json({ ok: false, message: "送貨樓層須為非零整數（地下樓可填 -1、-2）或留空" });
        return;
      }
      data.deliveryFloor = floorParsed;
    }
    if (body.contactName !== undefined) {
      data.contactName = trimOptionalString(body.contactName);
    }
    if (body.contactPhone !== undefined) {
      data.contactPhone = trimOptionalString(body.contactPhone);
    }
    if (body.contactMobile !== undefined) {
      data.contactMobile = trimOptionalString(body.contactMobile);
    }
    if (body.isDefault !== undefined) {
      data.isDefault = Boolean(body.isDefault);
    }
    if (body.barrelsOnSite !== undefined) {
      const barrelsParsed = parseNonNegativeBarrelCount(body.barrelsOnSite, "barrelsOnSite");
      if (barrelsParsed === "INVALID") {
        res.status(400).json({ ok: false, message: "未收回空桶須為非負整數" });
        return;
      }
      data.barrelsOnSite = barrelsParsed;
    }
    if (body.patrolWeekday !== undefined) {
      const weekdayParsed = parseOptionalPatrolWeekday(body.patrolWeekday);
      if (weekdayParsed === "INVALID") {
        res.status(400).json({ ok: false, message: "巡查星期須為 1–7（週一～週日）或留空" });
        return;
      }
      data.patrolWeekday = weekdayParsed;
    }
    if (body.targetWaterLevel !== undefined) {
      const levelParsed = parseOptionalTargetWaterLevel(body.targetWaterLevel);
      if (levelParsed === "INVALID") {
        res.status(400).json({ ok: false, message: "目標水位須為非負整數或留空" });
        return;
      }
      data.targetWaterLevel = levelParsed;
    }
    if (body.patrolProductId !== undefined) {
      if (body.patrolProductId === null || body.patrolProductId === "") {
        data.patrolProductId = null;
      } else {
        const pid = toBigInt(body.patrolProductId);
        if (!pid) {
          res.status(400).json({ ok: false, message: "巡查預設商品無效" });
          return;
        }
        const p = await prisma.product.findUnique({ where: { id: pid } });
        if (!p || !p.isActive) {
          res.status(400).json({ ok: false, message: "巡查預設商品不存在或已停用" });
          return;
        }
        data.patrolProductId = pid;
      }
    }

    const nextWeekday = data.patrolWeekday !== undefined ? data.patrolWeekday : existing.patrolWeekday;
    const nextProductId = data.patrolProductId !== undefined ? data.patrolProductId : existing.patrolProductId;
    if (nextWeekday != null && nextProductId == null) {
      res.status(400).json({ ok: false, message: "啟用巡查時請指定預設商品" });
      return;
    }

    if (data.addressLine != null && data.addressLine !== existing.addressLine) {
      data.latitude = null;
      data.longitude = null;
      data.geocodeStatus = "pending";
      data.geocodedAddress = null;
      data.geocodedAt = null;
      data.locationAccuracy = null;
      data.manualLocationConfirmed = false;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.deliveryAddress.updateMany({
          where: { customerId },
          data: { isDefault: false },
        });
      }
      const row = await tx.deliveryAddress.update({
        where: { id: addressId },
        data,
        include: {
          patrolProduct: { select: { id: true, name: true, productCode: true, isActive: true } },
        },
      });
      const defCount = await tx.deliveryAddress.count({ where: { customerId, isDefault: true } });
      if (defCount === 0) {
        const first = await tx.deliveryAddress.findFirst({
          where: { customerId },
          orderBy: { id: "asc" },
        });
        if (first) {
          await tx.deliveryAddress.update({
            where: { id: first.id },
            data: { isDefault: true },
          });
        }
      }
      return row;
    });

    const fullCustomer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: customerMasterInclude,
    });

    res.json({
      ok: true,
      data: updated,
      customer: fullCustomer ? enrichCustomerBarrels(fullCustomer) : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/customers/:customerId/addresses/:addressId", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher", "warehouse"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    const addressId = toBigInt(req.params.addressId);
    if (!customerId || !addressId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId / addressId" });
      return;
    }

    const addr = await prisma.deliveryAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!addr) {
      res.status(404).json({ ok: false, message: "找不到地址或與客戶不符" });
      return;
    }

    const addressCount = await prisma.deliveryAddress.count({ where: { customerId } });
    if (addressCount <= 1) {
      res.status(400).json({ ok: false, message: "至少須保留一筆送貨地址" });
      return;
    }

    const orderCount = await prisma.salesOrder.count({ where: { deliveryAddressId: addressId } });
    if (orderCount > 0) {
      res.status(409).json({
        ok: false,
        message: `此地址已有 ${orderCount} 筆訂單引用，無法刪除。訂單與報表需保留送貨點紀錄；請改為「編輯地址」更新內容，或新增地址後將新訂單改綁新地址。`,
        orderCount,
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      const wasDefault = addr.isDefault;
      await tx.deliveryAddress.delete({ where: { id: addressId } });
      if (wasDefault) {
        const first = await tx.deliveryAddress.findFirst({
          where: { customerId },
          orderBy: { id: "asc" },
        });
        if (first) {
          await tx.deliveryAddress.update({
            where: { id: first.id },
            data: { isDefault: true },
          });
        }
      }
    });

    const fullCustomer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: customerMasterInclude,
    });

    res.json({ ok: true, customer: fullCustomer ? enrichCustomerBarrels(fullCustomer) : null });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("Foreign key constraint") || msg.includes("P2003")) {
      res.status(409).json({
        ok: false,
        message: "此地址仍被訂單或其他資料引用，無法刪除。建議改為編輯地址內容。",
      });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    const rows = await prisma.product.findMany({
      include: { inventory: true },
      orderBy: [{ productCode: "asc" }, { id: "desc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const body = req.body as {
      productCode?: unknown;
      name?: unknown;
      sku?: unknown;
      unit?: unknown;
      countsDepositBarrel?: unknown;
      consumesPrepaidBarrel?: unknown;
      availableOnLiff?: unknown;
      salePrice?: unknown;
      costPrice?: unknown;
      driverDeliveryWage?: unknown;
      initialQty?: unknown;
    };

    const productCode = normalizeProductCode(body.productCode);
    if (!productCode) {
      res.status(400).json({ ok: false, message: "商品編號須為 3 碼數字" });
      return;
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const skuRaw = typeof body.sku === "string" ? body.sku.trim() : "";
    const sku = skuRaw === "" ? null : skuRaw;
    const unit = typeof body.unit === "string" && body.unit.trim() !== "" ? body.unit.trim() : "桶";
    const countsDepositBarrel = Boolean(body.countsDepositBarrel);
    const consumesPrepaidBarrel =
      body.consumesPrepaidBarrel !== undefined ? Boolean(body.consumesPrepaidBarrel) : countsDepositBarrel;
    const availableOnLiff = Boolean(body.availableOnLiff);
    const salePrice = Number(body.salePrice ?? 0);
    const costPrice = Number(body.costPrice ?? 0);
    const driverDeliveryWage = Number(body.driverDeliveryWage ?? 0);
    const initialQty = Math.floor(Number(body.initialQty ?? 0));

    if (!name) {
      res.status(400).json({ ok: false, message: "商品名稱為必填" });
      return;
    }
    if (!Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(costPrice) || costPrice < 0) {
      res.status(400).json({ ok: false, message: "售價與成本須為非負數字" });
      return;
    }
    if (!Number.isFinite(driverDeliveryWage) || driverDeliveryWage < 0) {
      res.status(400).json({ ok: false, message: "配送薪資須為非負數字" });
      return;
    }
    if (!Number.isInteger(initialQty) || initialQty < 0) {
      res.status(400).json({ ok: false, message: "初始庫存須為非負整數" });
      return;
    }

    const full = await prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          productCode,
          name,
          sku,
          unit,
          countsDepositBarrel,
          consumesPrepaidBarrel,
          availableOnLiff,
          salePrice,
          costPrice,
          driverDeliveryWage,
        } as Parameters<typeof tx.product.create>[0]["data"],
      });
      await tx.inventoryBalance.create({
        data: {
          productId: p.id,
          qtyOnHand: initialQty,
        },
      });
      if (initialQty > 0) {
        await tx.stockMovement.create({
          data: {
            productId: p.id,
            movementType: "adjust",
            qtyDelta: initialQty,
            refType: "manual",
            refId: p.id,
            note: "建立商品初始庫存",
            createdByUserId: DEFAULT_CREATOR_USER_ID,
          },
        });
      }
      return tx.product.findUnique({
        where: { id: p.id },
        include: { inventory: true },
      });
    });

    res.status(201).json({ ok: true, data: full });
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "商品編號或 SKU 已存在，請改用其他值" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/products/:productId", async (req, res) => {
  try {
    const productId = toBigInt(req.params.productId);
    if (!productId) {
      res.status(400).json({ ok: false, message: "參數錯誤：productId" });
      return;
    }

    const body = req.body as {
      productCode?: unknown;
      countsDepositBarrel?: unknown;
      consumesPrepaidBarrel?: unknown;
      availableOnLiff?: unknown;
      name?: unknown;
      unit?: unknown;
      salePrice?: unknown;
      costPrice?: unknown;
      driverDeliveryWage?: unknown;
      isActive?: unknown;
    };

    const existing = await prisma.product.findUnique({ where: { id: productId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到商品" });
      return;
    }

    const data: {
      productCode?: string | null;
      countsDepositBarrel?: boolean;
      consumesPrepaidBarrel?: boolean;
      availableOnLiff?: boolean;
      name?: string;
      unit?: string;
      salePrice?: Prisma.Decimal;
      costPrice?: Prisma.Decimal;
      driverDeliveryWage?: Prisma.Decimal;
      isActive?: boolean;
    } = {};

    if (body.productCode !== undefined) {
      if (body.productCode === null || body.productCode === "") {
        data.productCode = null;
      } else {
        const pc = normalizeProductCode(body.productCode);
        if (!pc) {
          res.status(400).json({ ok: false, message: "商品編號須為 3 碼數字或留空" });
          return;
        }
        data.productCode = pc;
      }
    }
    if (body.countsDepositBarrel !== undefined) {
      data.countsDepositBarrel = Boolean(body.countsDepositBarrel);
    }
    if (body.consumesPrepaidBarrel !== undefined) {
      data.consumesPrepaidBarrel = Boolean(body.consumesPrepaidBarrel);
    }
    if (body.availableOnLiff !== undefined) {
      data.availableOnLiff = Boolean(body.availableOnLiff);
    }
    if (typeof body.name === "string") {
      const n = body.name.trim();
      if (!n) {
        res.status(400).json({ ok: false, message: "名稱不可為空" });
        return;
      }
      data.name = n;
    }
    if (typeof body.unit === "string" && body.unit.trim() !== "") {
      data.unit = body.unit.trim();
    }
    if (body.salePrice !== undefined) {
      const sp = Number(body.salePrice);
      if (!Number.isFinite(sp) || sp < 0) {
        res.status(400).json({ ok: false, message: "售價須為非負數字" });
        return;
      }
      data.salePrice = new Prisma.Decimal(sp);
    }
    if (body.costPrice !== undefined) {
      const cp = Number(body.costPrice);
      if (!Number.isFinite(cp) || cp < 0) {
        res.status(400).json({ ok: false, message: "成本須為非負數字" });
        return;
      }
      data.costPrice = new Prisma.Decimal(cp);
    }
    if (body.driverDeliveryWage !== undefined) {
      const w = Number(body.driverDeliveryWage);
      if (!Number.isFinite(w) || w < 0) {
        res.status(400).json({ ok: false, message: "配送薪資須為非負數字" });
        return;
      }
      data.driverDeliveryWage = new Prisma.Decimal(w);
    }
    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: data as Prisma.ProductUpdateInput,
      include: { inventory: true },
    });

    res.json({ ok: true, data: updated });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "商品編號已存在，請改用其他 3 碼編號" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/products/:productId/inventory-adjust", async (req, res) => {
  try {
    const productId = toBigInt(req.params.productId);
    if (!productId) {
      res.status(400).json({ ok: false, message: "參數錯誤：productId" });
      return;
    }
    const { qtyDelta, note } = req.body as { qtyDelta?: unknown; note?: unknown };
    const delta = Number(qtyDelta);
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
      res.status(400).json({ ok: false, message: "數量須為非零整數" });
      return;
    }
    const existing = await prisma.product.findUnique({ where: { id: productId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到商品" });
      return;
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.inventoryBalance.upsert({
        where: { productId },
        create: { productId, qtyOnHand: delta },
        update: { qtyOnHand: { increment: delta } },
      });
      await tx.stockMovement.create({
        data: {
          productId,
          movementType: delta > 0 ? "inbound" : "adjust",
          qtyDelta: delta,
          refType: "manual",
          refId: productId,
          note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : (delta > 0 ? "手動入庫" : "手動調整"),
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      return tx.inventoryBalance.findUnique({ where: { productId } });
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/vehicles", async (_req, res) => {
  try {
    const rows = await prisma.vehicle.findMany({
      where: { isActive: true },
      orderBy: { plateNo: "asc" },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/vehicles", async (req, res) => {
  try {
    const body = req.body as { plateNo?: unknown; description?: unknown };
    const plateNo = typeof body.plateNo === "string" ? body.plateNo.trim().toUpperCase() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!plateNo) {
      res.status(400).json({ ok: false, message: "車牌為必填" });
      return;
    }
    const row = await prisma.vehicle.create({
      data: {
        plateNo,
        description: description === "" ? null : description,
      },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("Unique constraint") || msg.includes("P2002")) {
      res.status(409).json({ ok: false, message: "此車牌已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.get("/api/drivers", async (req, res) => {
  try {
    const includeInactive =
      req.query.includeInactive === "1" || req.query.includeInactive === "true";
    if (includeInactive && !requireRole(req, res, ["admin"])) return;

    const rows = await prisma.driver.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: {
        user: true,
        vehicle: true,
      },
      orderBy: [{ isActive: "desc" }, { id: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 登入：帳號為 users.employee_code（員編） */
app.post("/api/auth/login", async (req, res) => {
  try {
    const employeeCode = typeof req.body?.employeeCode === "string" ? req.body.employeeCode.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!employeeCode || !password) {
      res.status(400).json({ ok: false, message: "請提供員編與密碼" });
      return;
    }

    const throttleKey = loginThrottleKey(req, employeeCode);
    const throttled = inspectLoginThrottle(throttleKey);
    if (!throttled.ok) {
      res.status(429).json({ ok: false, message: throttled.message });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { employeeCode },
      include: { driver: true },
    });

    if (!user || !user.isActive) {
      noteLoginFailure(throttleKey);
      res.status(401).json({ ok: false, message: "帳號或密碼錯誤" });
      return;
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      noteLoginFailure(throttleKey);
      res.status(401).json({ ok: false, message: "帳號或密碼錯誤" });
      return;
    }

    noteLoginSuccess(throttleKey);
    const token = jwt.sign(
      {
        typ: "employee",
        sub: user.id.toString(),
        role: user.role,
        employeeCode: user.employeeCode,
      },
      JWT_SECRET,
      JWT_SIGN_OPTIONS,
    );

    res.json({
      ok: true,
      token,
      user: toPublicUser(user),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/auth/bootstrap", async (req, res) => {
  try {
    const users = await prisma.user.count();
    if (users > 0) {
      res.status(409).json({ ok: false, message: "系統已有使用者，請由管理員新增帳號" });
      return;
    }
    if (isProductionRuntime()) {
      const setup = process.env.BOOTSTRAP_SETUP_TOKEN?.trim() ?? "";
      const given =
        (typeof req.body?.setupToken === "string" ? req.body.setupToken.trim() : "") ||
        (typeof req.headers["x-bootstrap-token"] === "string" ? req.headers["x-bootstrap-token"].trim() : "");
      if (!setup || given !== setup) {
        res.status(403).json({ ok: false, message: "正式環境已關閉公開初始化，請設定 BOOTSTRAP_SETUP_TOKEN" });
        return;
      }
    }
    const body = req.body as { name?: unknown; employeeCode?: unknown; phone?: unknown; password?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const employeeCode = typeof body.employeeCode === "string" ? body.employeeCode.trim().toUpperCase() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !employeeCode || !password) {
      res.status(400).json({ ok: false, message: "姓名、帳號、密碼為必填" });
      return;
    }
    const passwordErr = passwordPolicyError(password);
    if (passwordErr) {
      res.status(400).json({ ok: false, message: passwordErr });
      return;
    }
    const user = await prisma.user.create({
      data: {
        name,
        employeeCode,
        phone: phoneRaw || null,
        passwordHash: await hashPassword(password),
        role: "admin",
      },
      include: { driver: true },
    });
    const token = jwt.sign(
      { typ: "employee", sub: user.id.toString(), role: user.role, employeeCode: user.employeeCode },
      JWT_SECRET,
      JWT_SIGN_OPTIONS,
    );
    res.status(201).json({ ok: true, token, user: toPublicUser(user) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/auth/me", async (req, res) => {
  const auth = getAuthUser(req);
  if (!auth) {
    res.status(401).json({ ok: false, message: "請先登入" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: auth.id }, include: { driver: true } });
  if (!user) {
    res.status(401).json({ ok: false, message: "帳號不存在" });
    return;
  }
  res.json({ ok: true, user: toPublicUser(user) });
});

app.get("/api/users", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const rows = await prisma.user.findMany({
      where: { role: { not: "driver" } },
      include: { driver: true },
      orderBy: [{ isActive: "desc" }, { id: "asc" }],
    });
    res.json({ ok: true, data: rows.map(toPublicUser) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/users", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const body = req.body as { name?: unknown; employeeCode?: unknown; phone?: unknown; password?: unknown; role?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const employeeCode = typeof body.employeeCode === "string" ? body.employeeCode.trim().toUpperCase() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const roleRaw = typeof body.role === "string" ? body.role.trim() : "dispatcher";
    const role = ["admin", "dispatcher", "warehouse", "accounting"].includes(roleRaw) ? roleRaw : "dispatcher";
    if (!name || !employeeCode || !password) {
      res.status(400).json({ ok: false, message: "姓名、帳號、密碼為必填" });
      return;
    }
    const passwordErr = passwordPolicyError(password);
    if (passwordErr) {
      res.status(400).json({ ok: false, message: passwordErr });
      return;
    }
    const row = await prisma.user.create({
      data: {
        name,
        employeeCode,
        phone: phoneRaw || null,
        passwordHash: await hashPassword(password),
        role,
      },
      include: { driver: true },
    });
    res.status(201).json({ ok: true, data: toPublicUser(row) });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("Unique constraint") || msg.includes("P2002")) {
      res.status(409).json({ ok: false, message: "此帳號已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.patch("/api/users/:userId", async (req, res) => {
  const auth = requireRole(req, res, ["admin"]);
  if (!auth) return;
  try {
    const userId = toBigInt(req.params.userId);
    if (!userId) {
      res.status(400).json({ ok: false, message: "userId 無效" });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "使用者不存在" });
      return;
    }
    if (existing.role === "driver") {
      res.status(400).json({ ok: false, message: "司機帳號請至「司機資料」頁面維護" });
      return;
    }
    const body = req.body as { name?: unknown; phone?: unknown; role?: unknown; isActive?: unknown; password?: unknown };
    const data: Prisma.UserUpdateInput = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (body.phone !== undefined) data.phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    if (typeof body.role === "string" && ["admin", "dispatcher", "warehouse", "accounting"].includes(body.role)) data.role = body.role;
    if (typeof body.isActive === "boolean") {
      if (userId === auth.id && body.isActive === false) {
        res.status(400).json({ ok: false, message: "不可停用目前登入中的自己" });
        return;
      }
      data.isActive = body.isActive;
    }
    if (typeof body.password === "string" && body.password !== "") {
      const passwordErr = passwordPolicyError(body.password);
      if (passwordErr) {
        res.status(400).json({ ok: false, message: passwordErr });
        return;
      }
      data.passwordHash = await hashPassword(body.password);
    }
    const row = await prisma.user.update({ where: { id: userId }, data, include: { driver: true } });
    res.json({ ok: true, data: toPublicUser(row) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/auth/password", async (req, res) => {
  const auth = getAuthUser(req);
  if (!auth) {
    res.status(401).json({ ok: false, message: "請先登入" });
    return;
  }
  try {
    const body = req.body as { oldPassword?: unknown; newPassword?: unknown };
    const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!oldPassword || !newPassword) {
      res.status(400).json({ ok: false, message: "請輸入原密碼與新密碼" });
      return;
    }
    const passwordErr = passwordPolicyError(newPassword);
    if (passwordErr) {
      res.status(400).json({ ok: false, message: passwordErr });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: auth.id } });
    if (!user || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
      res.status(401).json({ ok: false, message: "原密碼錯誤" });
      return;
    }
    await prisma.user.update({ where: { id: auth.id }, data: { passwordHash: await hashPassword(newPassword) } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 新增司機：建立 User（員編登入 + 聯絡手機）+ Driver（employee_code 與 users 同步） */
app.post("/api/drivers", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = req.body as {
      name?: unknown;
      employeeCode?: unknown;
      phone?: unknown;
      password?: unknown;
      vehicleId?: unknown;
      maxOrderCount?: unknown;
      maxBarrelQty?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const employeeCode = typeof body.employeeCode === "string" ? body.employeeCode.trim().toUpperCase() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    const phone = phoneRaw === "" ? null : phoneRaw;
    const password = typeof body.password === "string" ? body.password : "";
    const vehicleId = body.vehicleId != null && String(body.vehicleId).trim() !== "" ? toBigInt(body.vehicleId) : null;
    const maxOrderCount = parsePositiveInt(body.maxOrderCount, 20);
    const maxBarrelQty = parsePositiveInt(body.maxBarrelQty, 150);

    if (!name || !employeeCode || !password) {
      res.status(400).json({ ok: false, message: "姓名、員編、密碼為必填" });
      return;
    }
    const passwordErr = passwordPolicyError(password);
    if (passwordErr) {
      res.status(400).json({ ok: false, message: passwordErr });
      return;
    }

    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle || !vehicle.isActive) {
        res.status(400).json({ ok: false, message: "車輛不存在或未啟用" });
        return;
      }
    }

    const existingUser = await prisma.user.findUnique({ where: { employeeCode } });
    if (existingUser) {
      res.status(409).json({ ok: false, message: "此員編已存在" });
      return;
    }

    const passwordHash = await hashPassword(password);

    const driver = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          employeeCode,
          phone,
          passwordHash,
          name,
          role: "driver",
        },
      });

      return tx.driver.create({
        data: {
          userId: user.id,
          employeeCode,
          vehicleId,
          maxOrderCount,
          maxBarrelQty,
        },
        include: {
          user: true,
          vehicle: true,
        },
      });
    });

    res.status(201).json({ ok: true, data: driver });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/drivers/:driverId", async (req, res) => {
  const auth = getAuthUser(req);
  if (!auth) {
    res.status(401).json({ ok: false, message: "請先登入" });
    return;
  }
  const isAdmin = auth.role === "admin";
  const canPayroll = auth.role === "admin" || auth.role === "accounting" || auth.role === "dispatcher";
  if (!isAdmin && !canPayroll) {
    res.status(403).json({ ok: false, message: "權限不足" });
    return;
  }
  try {
    const driverId = toBigInt(req.params.driverId);
    if (!driverId) {
      res.status(400).json({ ok: false, message: "driverId 無效" });
      return;
    }
    const existing = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { user: true },
    });
    if (!existing) {
      res.status(404).json({ ok: false, message: "司機不存在" });
      return;
    }

    const body = req.body as {
      maxOrderCount?: unknown;
      maxBarrelQty?: unknown;
      baseSalary?: unknown;
      vehicleId?: unknown;
      isActive?: unknown;
      password?: unknown;
    };

    if (!isAdmin) {
      const extraKeys = Object.keys(body).filter((k) => k !== "baseSalary");
      if (extraKeys.length > 0) {
        res.status(403).json({ ok: false, message: "僅管理員可修改容量／車輛／啟停／密碼" });
        return;
      }
      if (body.baseSalary === undefined) {
        res.status(400).json({ ok: false, message: "未提供可更新欄位" });
        return;
      }
    }

    const driverData: {
      maxOrderCount?: number;
      maxBarrelQty?: number;
      baseSalary?: Prisma.Decimal;
      vehicleId?: bigint | null;
      isActive?: boolean;
    } = {};
    let passwordHash: string | undefined;

    if (body.baseSalary !== undefined) {
      if (!canPayroll) {
        res.status(403).json({ ok: false, message: "權限不足" });
        return;
      }
      const n = Number(body.baseSalary);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "底薪須為非負數字" });
        return;
      }
      driverData.baseSalary = new Prisma.Decimal(n);
    }
    if (body.maxOrderCount !== undefined) {
      const n = parsePositiveInt(body.maxOrderCount, -1);
      if (n < 0) {
        res.status(400).json({ ok: false, message: "最高訂單數須為非負整數" });
        return;
      }
      driverData.maxOrderCount = n;
    }
    if (body.maxBarrelQty !== undefined) {
      const n = parsePositiveInt(body.maxBarrelQty, -1);
      if (n < 0) {
        res.status(400).json({ ok: false, message: "最大運送桶數須為非負整數" });
        return;
      }
      driverData.maxBarrelQty = n;
    }
    if (body.vehicleId !== undefined) {
      const raw = body.vehicleId;
      if (raw == null || String(raw).trim() === "") {
        driverData.vehicleId = null;
      } else {
        const vehicleId = toBigInt(raw);
        if (!vehicleId) {
          res.status(400).json({ ok: false, message: "vehicleId 無效" });
          return;
        }
        const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || !vehicle.isActive) {
          res.status(400).json({ ok: false, message: "車輛不存在或未啟用" });
          return;
        }
        driverData.vehicleId = vehicleId;
      }
    }
    if (body.isActive !== undefined) {
      driverData.isActive = Boolean(body.isActive);
    }
    if (body.password !== undefined) {
      const password = typeof body.password === "string" ? body.password : "";
      if (password === "") {
        res.status(400).json({ ok: false, message: "密碼不可為空" });
        return;
      }
      const passwordErr = passwordPolicyError(password);
      if (passwordErr) {
        res.status(400).json({ ok: false, message: passwordErr });
        return;
      }
      passwordHash = await hashPassword(password);
    }

    const driver = await prisma.$transaction(async (tx) => {
      const userPatch: Prisma.UserUpdateInput = {};
      if (driverData.isActive !== undefined) userPatch.isActive = driverData.isActive;
      if (passwordHash) userPatch.passwordHash = passwordHash;
      if (Object.keys(userPatch).length > 0) {
        await tx.user.update({
          where: { id: existing.userId },
          data: userPatch,
        });
      }
      return tx.driver.update({
        where: { id: driverId },
        data: driverData,
        include: { user: true, vehicle: true },
      });
    });

    res.json({ ok: true, data: driver });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/sales-orders", async (req, res) => {
  try {
    const sourceRaw = typeof req.query.source === "string" ? req.query.source.trim() : "";
    const where =
      sourceRaw === "liff" || sourceRaw === "admin"
        ? { source: sourceRaw }
        : undefined;
    const rows = await prisma.salesOrder.findMany({
      where,
      include: salesOrderDetailInclude,
      orderBy: { id: "desc" },
      take: 100,
    });
    res.json(
      rows.map((o) => ({
        ...o,
        orderBillableAmount: orderBillableAmount(o).toString(),
      })),
    );
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台分配：指定客戶之未完成訂單（已分派／未分派），不含已完成與已取消 */
app.get("/api/sales-orders/incomplete-by-customer", async (req, res) => {
  try {
    const customerId = req.query.customerId ? toBigInt(req.query.customerId) : null;
    if (!customerId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 必填" });
      return;
    }
    const rows = await prisma.salesOrder.findMany({
      where: {
        customerId,
        status: { notIn: ["completed", "cancelled", "pending_review"] },
      },
      include: {
        customer: true,
        deliveryAddress: true,
        lines: { include: { product: true } },
        assignments: {
          include: {
            driver: { include: { user: true } },
            vehicle: true,
          },
          orderBy: { id: "desc" },
        },
      },
      orderBy: [{ scheduledDeliveryDate: "asc" }, { id: "desc" }],
      take: 120,
    });
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 進行中配送任務（尚未結案） */
const ACTIVE_DELIVERY_ASSIGNMENT_STATUSES = ["assigned", "delivering", "pending_settlement"] as const;

/**
 * 分派狀態佇列：未分派／已分派（須在 :salesOrderId 之前）
 * scope=unassigned：未完成且無進行中 DeliveryAssignment
 * scope=assigned：有進行中 DeliveryAssignment
 */
app.get("/api/sales-orders/assignment-queue", async (req, res) => {
  try {
    const scopeRaw = typeof req.query.scope === "string" ? req.query.scope.trim() : "unassigned";
    const scope = scopeRaw === "assigned" ? "assigned" : "unassigned";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 200;

    const activeAssignmentFilter = {
      status: { in: [...ACTIVE_DELIVERY_ASSIGNMENT_STATUSES] },
    };

    const where: Prisma.SalesOrderWhereInput = {
      status: { notIn: ["completed", "cancelled", "pending_review"] },
      ...(scope === "unassigned"
        ? { assignments: { none: activeAssignmentFilter } }
        : { assignments: { some: activeAssignmentFilter } }),
    };

    if (q) {
      where.AND = [
        {
          OR: [
            { orderNo: { contains: q } },
            { customer: { name: { contains: q } } },
            { customer: { customerCode: { contains: q } } },
            { customer: { phone: { contains: q } } },
            { customer: { mobile: { contains: q } } },
          ],
        },
      ];
    }

    const rows = await prisma.salesOrder.findMany({
      where,
      include: salesOrderDetailInclude,
      orderBy:
        scope === "unassigned"
          ? [{ scheduledDeliveryDate: "asc" }, { id: "asc" }]
          : [{ id: "desc" }],
      take: limit,
    });

    res.json({
      ok: true,
      data: {
        scope,
        total: rows.length,
        orders: rows.map((o) => {
          const activeAssignments = (o.assignments ?? []).filter((a) =>
            (ACTIVE_DELIVERY_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
          );
          return {
            ...o,
            orderBillableAmount: orderBillableAmount(o).toString(),
            activeAssignments,
          };
        }),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** LINE／待確認訂單列表（須在 :salesOrderId 之前） */
app.get("/api/sales-orders/pending-review", async (_req, res) => {
  try {
    const rows = await prisma.salesOrder.findMany({
      where: { status: "pending_review" },
      include: salesOrderDetailInclude,
      orderBy: { id: "desc" },
      take: 200,
    });
    res.json({
      ok: true,
      data: rows.map((o) => ({
        ...o,
        orderBillableAmount: orderBillableAmount(o).toString(),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 預覽本週巡查單（須在 :salesOrderId 之前，否則會被當成 orderId） */
app.get("/api/sales-orders/patrol-preview", async (req, res) => {
  try {
    const weekAnchor =
      typeof req.query.weekStart === "string" && req.query.weekStart.trim()
        ? req.query.weekStart.trim()
        : toLocalYmd(new Date());
    const result = await listPatrolCandidatesForWeek(weekAnchor);
    if (!result.ok) {
      res.status(400).json({ ok: false, message: result.message });
      return;
    }
    const creatable = result.candidates.filter((c) => !c.skipReason);
    res.json({
      ok: true,
      data: {
        weekStart: result.weekStart,
        weekEnd: result.weekEnd,
        total: result.candidates.length,
        creatable: creatable.length,
        skipped: result.candidates.length - creatable.length,
        candidates: result.candidates,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/sales-orders/:salesOrderId", async (req, res) => {
  try {
    const salesOrderId = toBigInt(req.params.salesOrderId);
    if (!salesOrderId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const row = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: salesOrderDetailInclude,
    });
    if (!row) {
      res.status(404).json({ ok: false, message: "找不到訂單" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 訂單套印補強：司機／預付剩餘桶／空桶／同地址上次配送摘要／稅額 */
app.get("/api/sales-orders/:salesOrderId/print-enrichment", async (req, res) => {
  try {
    const salesOrderId = toBigInt(req.params.salesOrderId);
    if (!salesOrderId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        customer: { select: { id: true, mobile: true, phone: true, prepaidBarrelBalance: true } },
        deliveryAddress: { select: { id: true, barrelsOnSite: true } },
        assignments: {
          where: { status: { not: "cancelled" } },
          orderBy: { id: "desc" },
          take: 5,
          include: { driver: { include: { user: { select: { name: true } } } } },
        },
      },
    });
    if (!order) {
      res.status(404).json({ ok: false, message: "找不到訂單" });
      return;
    }

    /** 已派單才印司機；優先進行中派單，否則最近一筆非取消派單 */
    const activeAssignment =
      order.assignments.find((a) =>
        (ACTIVE_DELIVERY_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
      ) ?? order.assignments[0] ?? null;
    const driverName =
      activeAssignment?.driver?.user?.name?.trim() ||
      activeAssignment?.driver?.employeeCode?.trim() ||
      null;

    const invoiceMode = normalizeCashInvoiceMode(order.cashInvoiceMode);
    const cashSub = new Prisma.Decimal(order.cashSubtotal ?? 0);
    const taxBr = breakdownCashTaxInvoice(cashSub, invoiceMode);
    const taxAmount = taxBr ? taxBr.taxAmount.toString() : null;

    const candidates = await prisma.salesOrder.findMany({
      where: {
        deliveryAddressId: order.deliveryAddressId,
        id: { not: order.id },
        status: { notIn: ["cancelled", "draft"] },
      },
      select: {
        id: true,
        officeSettledAt: true,
        scheduledDeliveryDate: true,
        lines: {
          select: {
            qtyDelivered: true,
            qtyOrdered: true,
            linePurpose: true,
          },
        },
        assignments: {
          where: { status: { in: ["completed", "not_delivered", "pending_settlement"] } },
          orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { driverReportedAt: true, assignmentDate: true },
        },
      },
      orderBy: { id: "desc" },
      take: 40,
    });

    let lastOrderDate: string | null = null;
    let lastBottleQty: number | null = null;
    let bestTs = -1;
    for (const cand of candidates) {
      const a = cand.assignments[0];
      /** 需有實際配送／核銷痕跡，勿僅用排程日 */
      const instantRaw = a?.driverReportedAt ?? a?.assignmentDate ?? cand.officeSettledAt ?? null;
      if (!instantRaw) continue;
      const instant = new Date(instantRaw);
      const ts = instant.getTime();
      if (!Number.isFinite(ts) || ts <= bestTs) continue;
      bestTs = ts;
      lastOrderDate = toLocalYmd(instant);
      lastBottleQty = cand.lines
        .filter((l) => (l.linePurpose ?? "delivery") !== "prepaid_barrel_topup")
        .reduce((sum, l) => {
          const delivered = l.qtyDelivered > 0 ? l.qtyDelivered : l.qtyOrdered > 0 && a ? l.qtyOrdered : 0;
          return sum + Math.max(0, delivered);
        }, 0);
    }

    res.json({
      ok: true,
      data: {
        customerMobile: order.customer.mobile?.trim() || null,
        taxAmount,
        cashInvoiceMode: invoiceMode === "none" ? null : invoiceMode,
        driverName,
        /** 預付剩餘桶（扣桶在核銷；開單當下即為不含本張配送扣桶） */
        prepaidBarrelBalance: order.customer.prepaidBarrelBalance,
        /** 本送貨點未回收空桶 */
        barrelsOnSite: order.deliveryAddress?.barrelsOnSite ?? 0,
        lastOrderDate,
        lastBottleQty,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/completed-deliveries", async (_req, res) => {
  try {
    const rows = await prisma.deliveryAssignment.findMany({
      where: { status: "completed" },
      include: {
        salesOrder: {
          include: {
            customer: true,
          },
        },
        driver: {
          include: { user: true },
        },
        vehicle: true,
      },
      orderBy: { completedAt: "desc" },
      take: 100,
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 核銷：待辦公室確認（pending_settlement）＋已核銷結案（completed / not_delivered） */
app.get("/api/settlements", async (_req, res) => {
  try {
    const rows = await prisma.deliveryAssignment.findMany({
      where: { status: { in: ["pending_settlement", "completed", "not_delivered"] } },
      include: {
        salesOrder: {
          include: {
            customer: true,
            deliveryAddress: true,
            lines: { include: { product: true } },
          },
        },
        driver: { include: { user: true } },
        vehicle: true,
        floorBonusRecords: {
          orderBy: [{ floor: "asc" }, { id: "asc" }],
        },
        events: { orderBy: { id: "desc" }, take: 5 },
      },
      orderBy: { updatedAt: "desc" },
      take: 400,
    });
    const hydrated = await Promise.all(
      rows.map(async (row) => {
        const order = row.salesOrder;
        const calc = await calcCashDueByUnifiedRule(prisma, {
          customerId: order.customerId,
          currentSalesOrderId: order.id,
        });
        const collected = assignmentFieldCollectedTotal(row);
        const expectedDec =
          row.expectedAmount != null ? new Prisma.Decimal(row.expectedAmount) : calc.cashDue;
        const variance = collected.minus(expectedDec);
        return {
          ...row,
          expectedAmount: expectedDec,
          cashVariance: variance,
          orderBillableAmount: orderBillableAmount(order),
        };
      }),
    );
    const rank = (r: { status: string; driverReportedAt: Date | null; officeSettledAt: Date | null; completedAt: Date | null; updatedAt: Date }) => {
      const t = r.officeSettledAt ?? r.driverReportedAt ?? r.completedAt ?? r.updatedAt;
      return t.getTime();
    };
    hydrated.sort((a, b) => rank(b) - rank(a));
    res.json(hydrated.slice(0, 300));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 辦公室確認核銷核心（單筆／批次共用） */
type OfficeSettlementApproveResult =
  | {
      ok: true;
      data: Awaited<ReturnType<typeof prisma.deliveryAssignment.findUnique>>;
      notify: {
        kind: "not_delivered" | "delivered";
        customerId: bigint;
        salesOrderId: bigint;
        assignmentId: bigint;
        orderNo: string;
        settlementOutcome?: string;
        failureReason?: string | null;
      };
    }
  | { ok: false; httpStatus: number; message: string };

async function runOfficeSettlementApprove(
  assignmentId: bigint,
  settledAt: Date,
  actorUserId: bigint = DEFAULT_CREATOR_USER_ID,
): Promise<OfficeSettlementApproveResult> {
  try {
    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        salesOrder: {
          include: {
            lines: { include: { product: true } },
            customer: true,
            deliveryAddress: true,
          },
        },
      },
    });
    if (!assignment) {
      return { ok: false as const, httpStatus: 404, message: "找不到配送任務" };
    }
    if (assignment.status !== "pending_settlement") {
      return { ok: false as const, httpStatus: 400, message: "此任務不在「待辦公室核銷」狀態" };
    }

    const outcome = assignment.settlementOutcome;
    const order = assignment.salesOrder;
    const customerRow = order.customer;
    const monthlyPortion = orderMonthlyCap(order);

    if (outcome === "not_delivered") {
      const result = await prisma.$transaction(async (tx) => {
        await tx.deliveryAssignment.update({
          where: { id: assignmentId },
          data: {
            status: "not_delivered",
            completedAt: settledAt,
            officeSettledAt: settledAt,
          } as Prisma.DeliveryAssignmentUpdateInput,
        });

        await tx.salesOrder.update({
          where: { id: assignment.salesOrderId },
          data: {
            status: "confirmed",
            lockVersion: { increment: 1 },
          },
        });
        await tx.floorDeliveryBonusRecord.deleteMany({
          where: { deliveryAssignmentId: assignmentId },
        });
        await clearCustomerFloorFeeLines(tx, {
          order: {
            id: order.id,
            orderNo: order.orderNo,
            customerId: order.customerId,
            billingTypeAtOrder: order.billingTypeAtOrder,
            cashInvoiceMode: order.cashInvoiceMode,
            customer: { monthlySettlementDay: customerRow.monthlySettlementDay ?? null },
          },
        });

        await tx.deliveryEvent.create({
          data: {
            deliveryAssignmentId: assignmentId,
            eventType: "settlement",
            createdAt: settledAt,
            payloadJson: {
              source: "office_approve",
              outcome: "not_delivered",
              failureReason: assignment.failureReason,
              note: assignment.settlementNote ?? undefined,
              orderNo: assignment.salesOrder.orderNo,
              officeSettledAt: settledAt.toISOString(),
            },
          },
        });

        await writeOperationAuditLog(tx, {
          actorUserId,
          action: "office_settlement",
          entityType: "delivery_assignment",
          entityId: assignmentId.toString(),
          before: {
            assignmentStatus: assignment.status,
            settlementOutcome: assignment.settlementOutcome,
            salesOrderStatus: order.status,
          },
          after: {
            outcome: "not_delivered",
            assignmentStatus: "not_delivered",
            salesOrderStatus: "confirmed",
            orderNo: order.orderNo,
            salesOrderId: order.id.toString(),
            officeSettledAt: settledAt.toISOString(),
          },
        });

        return tx.deliveryAssignment.findUnique({
          where: { id: assignmentId },
          include: {
            salesOrder: true,
            driver: { include: { user: true } },
            vehicle: true,
            floorBonusRecords: { orderBy: [{ floor: "asc" }, { id: "asc" }] },
            events: { orderBy: { id: "asc" } },
          },
        });
      });

      return {
        ok: true as const,
        data: result,
        notify: {
          kind: "not_delivered" as const,
          customerId: assignment.salesOrder.customerId,
          salesOrderId: assignment.salesOrderId,
          assignmentId,
          orderNo: assignment.salesOrder.orderNo,
          failureReason: assignment.failureReason,
        },
      };
    }

    if (
      outcome !== "delivered_no_cash" &&
      outcome !== "delivered_cash_exact" &&
      outcome !== "delivered_cash_short" &&
      outcome !== "delivered_cash_over"
    ) {
      return { ok: false as const, httpStatus: 400, message: "無效的核銷結果，無法確認" };
    }

    const cashReceived = Number(assignment.cashReceived);
    const checkReceived = Number(assignment.checkReceived ?? 0);
    const receivedDec = assignmentFieldCollectedTotal(assignment);

    let barrelsDeliveredAll = 0;
    let barrelsTopupCredit = 0;
    const prepaidConsumeByProduct = new Map<bigint, number>();
    const prepaidTopupByProduct = new Map<bigint, number>();
    for (const line of order.lines) {
      const purpose = line.linePurpose ?? "delivery";
      const qty = effectiveLineDeliveryQty(line);
      const p = line.product as {
        countsDepositBarrel?: boolean;
        consumesPrepaidBarrel?: boolean;
        name?: string;
      } | null;
      if (purpose === "prepaid_barrel_topup") {
        barrelsTopupCredit += line.qtyOrdered;
        prepaidTopupByProduct.set(line.productId, (prepaidTopupByProduct.get(line.productId) ?? 0) + line.qtyOrdered);
        continue;
      }
      if (p?.countsDepositBarrel === true) {
        barrelsDeliveredAll += qty;
      }
      if (lineBillingType(line, order, customerRow) === "prepaid" && p?.consumesPrepaidBarrel === true) {
        prepaidConsumeByProduct.set(line.productId, (prepaidConsumeByProduct.get(line.productId) ?? 0) + qty);
      }
    }
    const immediatePrepaidConsumeByProduct = new Map<bigint, number>();
    for (const [productId, qty] of prepaidConsumeByProduct) {
      if ((prepaidTopupByProduct.get(productId) ?? 0) > 0) continue;
      immediatePrepaidConsumeByProduct.set(productId, qty);
    }
    const barrelsPrepaidImmediate = [...immediatePrepaidConsumeByProduct.values()].reduce((a, b) => a + b, 0);

    const effective = (order.billingTypeAtOrder ?? customerRow.billingType) as string;
    const expected = order.totalAmount;

    const result = await prisma.$transaction(async (tx) => {
      await tx.deliveryAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "completed",
          completedAt: settledAt,
          officeSettledAt: settledAt,
        } as Prisma.DeliveryAssignmentUpdateInput,
      });

      const topupAlreadyPosted = await tx.customerLedgerEntry.findFirst({
        where: { salesOrderId: assignment.salesOrderId, entryType: "prepaid_topup" },
        select: { id: true },
      });
      const nextPendingTopup =
        order.pendingPrepaidTopupBarrels > 0
          ? order.pendingPrepaidTopupBarrels
          : barrelsTopupCredit > 0 && !topupAlreadyPosted
            ? barrelsTopupCredit
            : order.pendingPrepaidTopupBarrels;

      await tx.salesOrder.update({
        where: { id: assignment.salesOrderId },
        data: {
          status: "completed",
          lockVersion: { increment: 1 },
          pendingPrepaidTopupBarrels: nextPendingTopup,
          ...(monthlyPortion.greaterThan(0)
            ? {
                billingPeriodKey: billingPeriodKeyFromDate(settledAt),
                officeSettledAt: settledAt,
                monthlyPeriodPaid: false,
                monthlyReceivedAmount: new Prisma.Decimal(0),
              }
            : {}),
        },
      });

      const stockShortages = await analyzeOrderStockShortage(tx, assignment.salesOrderId, assignment.salesOrder.lines);
      if (stockShortages.length > 0) {
        const s = stockShortages[0]!;
        throw new Error(`INSUFFICIENT_STOCK:${s.productName}:${s.need}:${s.onHand}`);
      }

      for (const line of assignment.salesOrder.lines) {
        if (isNonInventoryLinePurpose(line.linePurpose)) {
          continue;
        }
        const qty = effectiveLineDeliveryQty(line);
        if (qty <= 0) continue;
        let inv = await tx.inventoryBalance.findUnique({ where: { productId: line.productId } });
        if (!inv) {
          await tx.inventoryBalance.create({
            data: { productId: line.productId, qtyOnHand: 0 },
          });
          inv = await tx.inventoryBalance.findUnique({ where: { productId: line.productId } });
        }
        const onHand = inv?.qtyOnHand ?? 0;
        if (onHand < qty) {
          const pName = (line.product as { name?: string } | null)?.name ?? "商品";
          throw new Error(`INSUFFICIENT_STOCK:${pName}:${qty}:${onHand}`);
        }
        await tx.stockMovement.create({
          data: {
            productId: line.productId,
            movementType: "out_sale",
            qtyDelta: -qty,
            refType: "sales_order",
            refId: assignment.salesOrderId,
            note: `銷單出庫 ${assignment.salesOrder.orderNo}`,
            createdByUserId: DEFAULT_CREATOR_USER_ID,
            createdAt: settledAt,
          },
        });
        if (inv) {
          await tx.inventoryBalance.update({
            where: { productId: line.productId },
            data: { qtyOnHand: onHand - qty },
          });
        }
      }

      const customerId = assignment.salesOrder.customerId;
      const deliveryAddressId = assignment.salesOrder.deliveryAddressId;
      const emptyReturned = Math.max(0, Math.floor(Number(assignment.emptyBarrelsReturned)));
      const barrelNet = barrelsDeliveredAll - emptyReturned;
      const cust = await tx.customer.findUnique({ where: { id: customerId } });
      if (cust) {
        if (!cust.allowPrepaidOverdraft && immediatePrepaidConsumeByProduct.size > 0) {
          const pids = [...immediatePrepaidConsumeByProduct.keys()];
          const balRows = await tx.customerPrepaidProductBalance.findMany({
            where: { customerId, productId: { in: pids } },
          });
          const balMap = new Map(balRows.map((r) => [r.productId, r.balanceBarrels]));
          for (const [pid, need] of immediatePrepaidConsumeByProduct) {
            const avail = balMap.get(pid) ?? 0;
            if (need > avail) {
              const hitLine = order.lines.find((l) => l.productId === pid);
              const pName = (hitLine?.product as { name?: string } | null)?.name ?? "商品";
              throw new Error(`PREPAID_INSUFFICIENT:${pName}:${need}:${avail}`);
            }
          }
        }
        const prepaidBarrelBalance =
          barrelsPrepaidImmediate > 0
            ? cust.prepaidBarrelBalance - barrelsPrepaidImmediate
            : cust.prepaidBarrelBalance;
        if (emptyReturned > 0 || barrelsDeliveredAll > 0) {
          const addr = await tx.deliveryAddress.findFirst({
            where: { id: deliveryAddressId, customerId },
          });
          if (addr) {
            const barrelsOnSiteBefore = addr.barrelsOnSite;
            const barrelsOnSiteAfter = Math.max(0, barrelsOnSiteBefore + barrelNet);
            if (barrelNet !== 0) {
              await tx.deliveryAddress.update({
                where: { id: deliveryAddressId },
                data: { barrelsOnSite: barrelsOnSiteAfter },
              });
            }
            await recordBarrelMovement(tx, {
              sourceType: "delivery",
              sourceRefId: assignmentId,
              refNo: order.orderNo,
              movementDate: settledAt,
              occurredAt: settledAt,
              customerId,
              deliveryAddressId,
              barrelsReturned: emptyReturned,
              barrelsDelivered: barrelsDeliveredAll,
              barrelDelta: barrelNet,
              barrelsOnSiteBefore,
              barrelsOnSiteAfter,
              driverId: assignment.driverId,
              vehicleId: assignment.vehicleId,
              salesOrderId: assignment.salesOrderId,
              deliveryAssignmentId: assignmentId,
              note: assignment.settlementNote,
              createdByUserId: DEFAULT_CREATOR_USER_ID,
            });
          }
        }
        if (barrelsPrepaidImmediate > 0) {
          await tx.customer.update({
            where: { id: customerId },
            data: { prepaidBarrelBalance },
          });
        }
      }
      for (const [productId, qty] of immediatePrepaidConsumeByProduct) {
        await adjustCustomerPrepaidProductBalance(tx, customerId, productId, -qty);
      }

      const collectCalc = await calcCashDueByUnifiedRule(tx, {
        customerId,
        currentSalesOrderId: assignment.salesOrderId,
      });
      const cashDueResolved = collectCalc.collectDue;
      const varianceDisplayResolved = receivedDec.minus(cashDueResolved);

      let paymentNoteBase = "司機銷單收款";
      if (outcome === "delivered_cash_exact") {
        paymentNoteBase = "司機收款（足額）";
      } else if (outcome === "delivered_cash_short") {
        paymentNoteBase = `司機收款（少收，差額 ${varianceDisplayResolved.toString()}，應收現金 ${cashDueResolved.toString()}）`;
      } else if (outcome === "delivered_cash_over") {
        paymentNoteBase = `司機收款（多收，差額 +${varianceDisplayResolved.toString()}，應收現金 ${cashDueResolved.toString()}）`;
      }
      const cashPaymentNote = cashReceived > 0 ? paymentNoteBase.replace("司機收款", "司機現金收款") : "";
      const checkPaymentNote = checkReceived > 0 ? paymentNoteBase.replace("司機收款", "司機支票收款") : "";

      /** 現金應收以 AR 為唯一來源：開單／回報已立 AR；此處只入收款單並沖帳（本單優先，再舊欠） */
      if (cashReceived > 0) {
        await postSettlementReceiptByMethod(tx, {
          customerId,
          salesOrderId: assignment.salesOrderId,
          amount: cashReceived,
          paymentMethod: "cash",
          paymentNote: cashPaymentNote || "司機現金收款",
          settledAt,
          orderNo: order.orderNo,
        });
      }
      if (checkReceived > 0) {
        await postSettlementReceiptByMethod(tx, {
          customerId,
          salesOrderId: assignment.salesOrderId,
          amount: checkReceived,
          paymentMethod: "check",
          paymentNote: checkPaymentNote || "司機支票收款",
          settledAt,
          orderNo: order.orderNo,
        });
      }

      /** 月結應收改於「結帳批次」立帳（R2），此處不再逐單寫 monthly_accrual */

      if (barrelsPrepaidImmediate > 0) {
        await tx.customerLedgerEntry.create({
          data: {
            customerId,
            entryType: "prepaid_consumption",
            amount: new Prisma.Decimal(0),
            barrelDelta: -barrelsPrepaidImmediate,
            salesOrderId: assignment.salesOrderId,
            note: `預付扣桶 ${barrelsPrepaidImmediate}（訂單 ${order.orderNo}）`,
            createdByUserId: DEFAULT_CREATOR_USER_ID,
            createdAt: settledAt,
          },
        });
      }

      await tx.deliveryEvent.create({
        data: {
          deliveryAssignmentId: assignmentId,
          eventType: "settlement",
          createdAt: settledAt,
          payloadJson: {
            source: "office_approve",
            outcome,
            note: assignment.settlementNote ?? "辦公室確認核銷",
            billingTypeEffective: effective,
            emptyBarrelsReturned: assignment.emptyBarrelsReturned,
            barrelsDeliveredCount: barrelsDeliveredAll,
            prepaidBarrelTopupPendingQty: barrelsTopupCredit,
            barrelNetCustomer: barrelNet,
            cashReceived,
            checkReceived,
            collectedTotal: cashReceived + checkReceived,
            orderTotal: expected.toString(),
            orderCashAdjustment: String(order.orderCashAdjustment ?? 0),
            cashSettlementMode: cashReceived + checkReceived > 0 ? "ar_receipt_fifo" : undefined,
            cashDue: cashDueResolved.toString(),
            expectedAmount: cashDueResolved.toString(),
            cashVariance: varianceDisplayResolved.toString(),
            orderNo: assignment.salesOrder.orderNo,
            officeSettledAt: settledAt.toISOString(),
          },
        },
      });

      await writeOperationAuditLog(tx, {
        actorUserId,
        action: "office_settlement",
        entityType: "delivery_assignment",
        entityId: assignmentId.toString(),
        before: {
          assignmentStatus: assignment.status,
          settlementOutcome: assignment.settlementOutcome,
          salesOrderStatus: order.status,
          cashReceived: assignment.cashReceived.toString(),
          checkReceived: String(assignment.checkReceived ?? 0),
        },
        after: {
          outcome: assignment.settlementOutcome,
          assignmentStatus: "completed",
          salesOrderStatus: "completed",
          orderNo: order.orderNo,
          salesOrderId: order.id.toString(),
          officeSettledAt: settledAt.toISOString(),
          cashReceived,
          checkReceived,
        },
      });

      return tx.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        include: {
          salesOrder: true,
          driver: { include: { user: true } },
          vehicle: true,
          floorBonusRecords: { orderBy: [{ floor: "asc" }, { id: "asc" }] },
          events: { orderBy: { id: "asc" } },
        },
      });
    });

    return {
      ok: true as const,
      data: result,
      notify: {
        kind: "delivered" as const,
        customerId: assignment.salesOrder.customerId,
        salesOrderId: assignment.salesOrderId,
        assignmentId,
        orderNo: assignment.salesOrder.orderNo,
        settlementOutcome: String(assignment.settlementOutcome ?? outcome ?? ""),
        failureReason: assignment.failureReason,
      },
    };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("PREPAID_INSUFFICIENT:")) {
      const [, pName, need, avail] = msg.split(":");
      return {
        ok: false,
        httpStatus: 400,
        message: `預付桶商品額度不足：${pName} 需 ${need} 桶、可用 ${avail} 桶。請先儲值同商品桶數後再核銷。`,
      };
    }
    if (msg.includes("INSUFFICIENT_STOCK:")) {
      const [, pName, need, avail] = msg.split(":");
      return {
        ok: false,
        httpStatus: 400,
        message: `庫存不足，無法核銷出庫：${pName} 需 ${need}、庫存 ${avail}。請先入庫或調整庫存後再核銷。`,
      };
    }
    return { ok: false, httpStatus: 500, message: msg };
  }
}

function fireSettlementApproveNotify(result: Extract<OfficeSettlementApproveResult, { ok: true }>) {
  const n = result.notify;
  if (n.kind === "not_delivered" || n.settlementOutcome === "not_delivered") {
    void notifyCustomerViaLine(prisma, {
      customerId: n.customerId,
      eventType: "order_not_delivered",
      salesOrderId: n.salesOrderId,
      deliveryAssignmentId: n.assignmentId,
      text: formatNotDeliveredMessage({
        orderNo: n.orderNo,
        reason: n.failureReason,
      }),
    }).catch((err) => console.error("[line-notify] order_not_delivered", err));
  } else {
    void notifyCustomerViaLine(prisma, {
      customerId: n.customerId,
      eventType: "order_delivered",
      salesOrderId: n.salesOrderId,
      deliveryAssignmentId: n.assignmentId,
      text: formatDeliveredMessage({ orderNo: n.orderNo }),
    }).catch((err) => console.error("[line-notify] order_delivered", err));
  }
}

async function assertDayNotClosedForSettlement(settledAt: Date): Promise<string | null> {
  try {
    const ymd = toLocalYmd(settledAt);
    const businessDate = parseLocalYmdToDbDate(ymd);
    if (!businessDate) return null;
    const lock = await prisma.dayCloseLock.findUnique({ where: { businessDate } });
    if (lock && lock.unlockedAt == null) {
      return `營業日 ${ymd} 已關帳，無法核銷（請管理員先解鎖）`;
    }
  } catch {
    /* table may not exist yet before migration */
  }
  return null;
}

/** 辦公室確認核銷：執行訂單結案、出庫、收款入帳（或未送達退回） */
app.post("/api/settlements/approve", async (req, res) => {
  try {
    const body = req.body as {
      assignmentId?: unknown;
      /** YYYY-MM-DD：本地該日 00:00（未傳 officeSettledAt 時使用） */
      officeSettledAtYmd?: unknown;
      /** ISO 8601：辦公室核銷完成時間（優先於 officeSettledAtYmd） */
      officeSettledAt?: unknown;
    };
    const assignmentId = toBigInt(body.assignmentId);
    if (!assignmentId) {
      res.status(400).json({ ok: false, message: "參數錯誤：assignmentId 必填" });
      return;
    }
    let settledAt = new Date();
    const officeIso = typeof body.officeSettledAt === "string" ? body.officeSettledAt.trim() : "";
    if (officeIso) {
      const parsedIso = new Date(officeIso);
      if (Number.isNaN(parsedIso.getTime())) {
        res.status(400).json({ ok: false, message: "officeSettledAt 須為有效 ISO 日期時間" });
        return;
      }
      settledAt = parsedIso;
    } else {
      const ymd = typeof body.officeSettledAtYmd === "string" ? body.officeSettledAtYmd.trim() : "";
      if (ymd) {
        const parsed = parseLocalYmdRange(ymd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "officeSettledAtYmd 須為 YYYY-MM-DD" });
          return;
        }
        settledAt = parsed.start;
      }
    }

    const dayLockMsg = await assertDayNotClosedForSettlement(settledAt);
    if (dayLockMsg) {
      res.status(423).json({ ok: false, message: dayLockMsg });
      return;
    }

    const actorUserId = getAuthUser(req)?.id ?? DEFAULT_CREATOR_USER_ID;
    const result = await runOfficeSettlementApprove(assignmentId, settledAt, actorUserId);
    if (!result.ok) {
      res.status(result.httpStatus).json({ ok: false, message: result.message });
      return;
    }
    res.json({ ok: true, data: result.data });
    fireSettlementApproveNotify(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 批次核銷：僅 pending_settlement 且 delivered_cash_exact（含零應收足額） */
app.post("/api/settlements/batch-complete", async (req, res) => {
  try {
    const body = req.body as { assignmentIds?: unknown; officeSettledAt?: unknown };
    if (!Array.isArray(body.assignmentIds) || body.assignmentIds.length === 0) {
      res.status(400).json({ ok: false, message: "參數錯誤：assignmentIds 必填" });
      return;
    }
    const ids = body.assignmentIds
      .map((x) => toBigInt(x))
      .filter((x): x is bigint => x != null);
    if (ids.length === 0) {
      res.status(400).json({ ok: false, message: "assignmentIds 無效" });
      return;
    }
    let settledAt = new Date();
    const officeIso = typeof body.officeSettledAt === "string" ? body.officeSettledAt.trim() : "";
    if (officeIso) {
      const parsedIso = new Date(officeIso);
      if (Number.isNaN(parsedIso.getTime())) {
        res.status(400).json({ ok: false, message: "officeSettledAt 須為有效 ISO 日期時間" });
        return;
      }
      settledAt = parsedIso;
    }

    const dayLockMsg = await assertDayNotClosedForSettlement(settledAt);
    if (dayLockMsg) {
      res.status(423).json({ ok: false, message: dayLockMsg });
      return;
    }

    const actorUserId = getAuthUser(req)?.id ?? DEFAULT_CREATOR_USER_ID;
    const succeeded: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const assignmentId of ids) {
      const idStr = assignmentId.toString();
      const row = await prisma.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, status: true, settlementOutcome: true },
      });
      if (!row) {
        skipped.push({ id: idStr, reason: "找不到配送任務" });
        continue;
      }
      if (row.status !== "pending_settlement") {
        skipped.push({ id: idStr, reason: "非待辦公室核銷狀態" });
        continue;
      }
      if (row.settlementOutcome !== "delivered_cash_exact") {
        skipped.push({
          id: idStr,
          reason: `異常或需人工核銷（${row.settlementOutcome ?? "無結果"}）`,
        });
        continue;
      }
      const result = await runOfficeSettlementApprove(assignmentId, settledAt, actorUserId);
      if (!result.ok) {
        skipped.push({ id: idStr, reason: result.message });
        continue;
      }
      succeeded.push(idStr);
      fireSettlementApproveNotify(result);
    }

    res.json({ ok: true, data: { succeeded, skipped } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});


/** 二樓以上搬運獎金紀錄查詢 */
app.get("/api/floor-delivery-bonuses", async (req, res) => {
  try {
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const driverId = toBigInt(req.query.driverId);
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

    const where: Prisma.FloorDeliveryBonusRecordWhereInput = {
      deliveryAssignment: { is: { status: "completed" } },
    };
    if (driverId) {
      where.driverId = driverId;
    }
    if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.deliveryDate = range;
    }

    const rows = await prisma.floorDeliveryBonusRecord.findMany({
      where,
      include: {
        driver: { include: { user: true } },
        product: { select: { id: true, name: true, unit: true } },
      },
      orderBy: [{ deliveryDate: "desc" }, { id: "desc" }],
      take: 500,
    });

    const filtered = q
      ? rows.filter((row) => {
          const no = row.orderNo.toLowerCase();
          const product = row.productName.toLowerCase();
          const driverCode = String(row.driver?.user?.employeeCode ?? "").toLowerCase();
          const driverName = String(row.driver?.user?.name ?? "").toLowerCase();
          return no.includes(q) || product.includes(q) || driverCode.includes(q) || driverName.includes(q);
        })
      : rows;

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

function parseYearMonthDbRange(yearMonth: string): { start: Date; end: Date; label: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const label = `${y}-${String(mo).padStart(2, "0")}`;
  const start = parseLocalYmdToDbDate(`${label}-01`);
  const nextM = mo === 12 ? 1 : mo + 1;
  const nextY = mo === 12 ? y + 1 : y;
  const end = parseLocalYmdToDbDate(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
  if (!start || !end) return null;
  return { start, end, label };
}

async function ensurePayrollSettings() {
  const existing = await prisma.payrollSetting.findUnique({ where: { id: 1n } });
  if (existing) return existing;
  return prisma.payrollSetting.create({
    data: { id: 1n, emptyBarrelWage: 0 },
  });
}

function sortFloorBonusRates<T extends { floor: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    // 地上樓層升冪，地下樓層（負數）排在後面且絕對值升冪
    const aAbove = a.floor > 0;
    const bAbove = b.floor > 0;
    if (aAbove !== bAbove) return aAbove ? -1 : 1;
    if (aAbove) return a.floor - b.floor;
    return Math.abs(a.floor) - Math.abs(b.floor);
  });
}

async function listFloorBonusRates() {
  const rows = await prisma.payrollFloorBonusRate.findMany();
  return sortFloorBonusRates(rows);
}

app.get("/api/payroll-settings", async (_req, res) => {
  try {
    const [row, floorRates, customerFloorFeeRates] = await Promise.all([
      ensurePayrollSettings(),
      listFloorBonusRates(),
      listCustomerFloorFeeRates(),
    ]);
    res.json({
      ok: true,
      data: {
        emptyBarrelWage: row.emptyBarrelWage.toString(),
        floorBonusRates: floorRates.map((r) => ({
          floor: r.floor,
          wage: r.wage.toString(),
        })),
        customerFloorFeeRates: customerFloorFeeRates.map((r) => ({
          floor: r.floor,
          unitPrice: r.unitPrice.toString(),
        })),
        updatedAt: row.updatedAt,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/payroll-settings", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = req.body as {
      emptyBarrelWage?: unknown;
      floorBonusRates?: unknown;
      customerFloorFeeRates?: unknown;
    };
    const data: { emptyBarrelWage?: Prisma.Decimal } = {};
    if (body.emptyBarrelWage !== undefined) {
      const n = Number(body.emptyBarrelWage);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "空桶單價須為非負數字" });
        return;
      }
      data.emptyBarrelWage = new Prisma.Decimal(n);
    }

    let parsedRates: Array<{ floor: number; wage: Prisma.Decimal }> | null = null;
    if (body.floorBonusRates !== undefined) {
      if (!Array.isArray(body.floorBonusRates)) {
        res.status(400).json({ ok: false, message: "floorBonusRates 須為陣列" });
        return;
      }
      const seen = new Set<number>();
      parsedRates = [];
      for (const item of body.floorBonusRates) {
        const floor = Math.trunc(Number((item as { floor?: unknown })?.floor));
        const wageN = Number((item as { wage?: unknown })?.wage);
        if (!Number.isFinite(floor) || floor === 0 || floor === 1) {
          res.status(400).json({ ok: false, message: "樓層須為整數，且不可為 0 或 1（一樓不計搬運）" });
          return;
        }
        if (!Number.isFinite(wageN) || wageN < 0) {
          res.status(400).json({ ok: false, message: "搬運單價須為非負數字" });
          return;
        }
        if (seen.has(floor)) {
          res.status(400).json({ ok: false, message: `樓層 ${floor} 重複` });
          return;
        }
        seen.add(floor);
        parsedRates.push({ floor, wage: new Prisma.Decimal(wageN) });
      }
    }

    let parsedCustomerFees: Array<{ floor: number; unitPrice: Prisma.Decimal }> | null = null;
    if (body.customerFloorFeeRates !== undefined) {
      if (!Array.isArray(body.customerFloorFeeRates)) {
        res.status(400).json({ ok: false, message: "customerFloorFeeRates 須為陣列" });
        return;
      }
      const seen = new Set<number>();
      parsedCustomerFees = [];
      for (const item of body.customerFloorFeeRates) {
        const floor = Math.trunc(Number((item as { floor?: unknown })?.floor));
        const priceN = Number((item as { unitPrice?: unknown })?.unitPrice);
        if (!Number.isFinite(floor) || floor === 0 || floor === 1) {
          res.status(400).json({ ok: false, message: "客戶搬運費樓層須為整數，且不可為 0 或 1" });
          return;
        }
        if (!Number.isFinite(priceN) || priceN < 0) {
          res.status(400).json({ ok: false, message: "客戶搬運費單價須為非負數字" });
          return;
        }
        if (seen.has(floor)) {
          res.status(400).json({ ok: false, message: `客戶搬運費樓層 ${floor} 重複` });
          return;
        }
        seen.add(floor);
        parsedCustomerFees.push({ floor, unitPrice: new Prisma.Decimal(priceN) });
      }
    }

    await ensurePayrollSettings();
    const row = await prisma.$transaction(async (tx) => {
      const updated =
        Object.keys(data).length > 0
          ? await tx.payrollSetting.update({ where: { id: 1n }, data })
          : await tx.payrollSetting.findUniqueOrThrow({ where: { id: 1n } });
      if (parsedRates) {
        await tx.payrollFloorBonusRate.deleteMany({});
        if (parsedRates.length > 0) {
          await tx.payrollFloorBonusRate.createMany({
            data: parsedRates.map((r) => ({ floor: r.floor, wage: r.wage })),
          });
        }
      }
      if (parsedCustomerFees) {
        await tx.customerFloorFeeRate.deleteMany({});
        if (parsedCustomerFees.length > 0) {
          await tx.customerFloorFeeRate.createMany({
            data: parsedCustomerFees.map((r) => ({ floor: r.floor, unitPrice: r.unitPrice })),
          });
        }
      }
      return updated;
    });

    const [floorRates, customerFloorFeeRates] = await Promise.all([
      listFloorBonusRates(),
      listCustomerFloorFeeRates(),
    ]);
    res.json({
      ok: true,
      data: {
        emptyBarrelWage: row.emptyBarrelWage.toString(),
        floorBonusRates: floorRates.map((r) => ({
          floor: r.floor,
          wage: r.wage.toString(),
        })),
        customerFloorFeeRates: customerFloorFeeRates.map((r) => ({
          floor: r.floor,
          unitPrice: r.unitPrice.toString(),
        })),
        updatedAt: row.updatedAt,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/**
 * 司機月薪資統計
 * 薪資 = 底薪 + Σ(商品配送量×單價) + 回收空桶×固定單價 + Σ(上樓桶數×該樓層單價)
 * yearMonth=YYYY-MM；僅統計已核銷完成（completed）之配送／收空桶／搬運紀錄
 */
app.get("/api/reports/driver-payroll", async (req, res) => {
  try {
    const ymRaw =
      typeof req.query.yearMonth === "string" && req.query.yearMonth.trim()
        ? req.query.yearMonth.trim()
        : toLocalYmd(new Date()).slice(0, 7);
    const range = parseYearMonthDbRange(ymRaw);
    if (!range) {
      res.status(400).json({ ok: false, message: "yearMonth 格式須為 YYYY-MM" });
      return;
    }
    const { start, end, label } = range;
    const dateFilter = { gte: start, lt: end };

    const [settings, floorRates, drivers, products, assignments, pickups, floorRows] = await Promise.all([
      ensurePayrollSettings(),
      listFloorBonusRates(),
      prisma.driver.findMany({
        where: { isActive: true },
        include: { user: true },
        orderBy: { id: "asc" },
      }),
      prisma.product.findMany({
        select: { id: true, name: true, unit: true, driverDeliveryWage: true, productCode: true },
        orderBy: [{ productCode: "asc" }, { id: "asc" }],
      }),
      prisma.deliveryAssignment.findMany({
        where: { status: "completed", assignmentDate: dateFilter },
        include: {
          salesOrder: {
            include: {
              lines: { include: { product: { select: { id: true, name: true, unit: true, driverDeliveryWage: true } } } },
            },
          },
        },
      }),
      prisma.barrelPickup.findMany({
        where: { status: "completed", pickupDate: dateFilter },
        select: { driverId: true, barrelsReturned: true },
      }),
      prisma.floorDeliveryBonusRecord.findMany({
        where: {
          deliveryDate: dateFilter,
          deliveryAssignment: { is: { status: "completed" } },
        },
        select: { driverId: true, qty: true, floor: true },
      }),
    ]);

    const emptyWage = Number(settings.emptyBarrelWage);
    const floorWageByFloor = new Map<number, number>(floorRates.map((r) => [r.floor, Number(r.wage)]));

    type ProductAgg = { productId: string; productName: string; unit: string; qty: number; wagePerUnit: number; amount: number };
    type FloorAgg = { floor: number; qty: number; wagePerUnit: number; amount: number };
    type DriverAgg = {
      driverId: string;
      employeeCode: string;
      name: string;
      baseSalary: number;
      deliveryByProduct: Map<string, ProductAgg>;
      deliveryQty: number;
      deliveryAmount: number;
      emptyBarrelQty: number;
      floorBonusQty: number;
      floorBonusAmount: number;
      floorByLevel: Map<number, FloorAgg>;
    };

    const byDriver = new Map<string, DriverAgg>();
    for (const d of drivers) {
      byDriver.set(String(d.id), {
        driverId: String(d.id),
        employeeCode: String(d.user?.employeeCode ?? d.employeeCode ?? ""),
        name: String(d.user?.name ?? ""),
        baseSalary: Number(d.baseSalary),
        deliveryByProduct: new Map(),
        deliveryQty: 0,
        deliveryAmount: 0,
        emptyBarrelQty: 0,
        floorBonusQty: 0,
        floorBonusAmount: 0,
        floorByLevel: new Map(),
      });
    }

    const ensureDriver = (driverId: bigint) => {
      const key = String(driverId);
      let row = byDriver.get(key);
      if (!row) {
        row = {
          driverId: key,
          employeeCode: "",
          name: `司機#${key}`,
          baseSalary: 0,
          deliveryByProduct: new Map(),
          deliveryQty: 0,
          deliveryAmount: 0,
          emptyBarrelQty: 0,
          floorBonusQty: 0,
          floorBonusAmount: 0,
          floorByLevel: new Map(),
        };
        byDriver.set(key, row);
      }
      return row;
    };

    for (const a of assignments) {
      const row = ensureDriver(a.driverId);
      row.emptyBarrelQty += Math.max(0, Number(a.emptyBarrelsReturned ?? 0));
      for (const line of a.salesOrder?.lines ?? []) {
        const purpose = line.linePurpose ?? "delivery";
        if (isNonInventoryLinePurpose(purpose)) continue;
        const qty = effectiveLineDeliveryQty(line);
        if (qty <= 0) continue;
        const productId = String(line.productId);
        const wage = Number(line.product?.driverDeliveryWage ?? 0);
        const hit = row.deliveryByProduct.get(productId) ?? {
          productId,
          productName: line.product?.name ?? "商品",
          unit: line.product?.unit ?? "",
          qty: 0,
          wagePerUnit: wage,
          amount: 0,
        };
        hit.qty += qty;
        hit.wagePerUnit = wage;
        hit.amount = hit.qty * hit.wagePerUnit;
        row.deliveryByProduct.set(productId, hit);
      }
    }

    for (const p of pickups) {
      const row = ensureDriver(p.driverId);
      row.emptyBarrelQty += Math.max(0, Number(p.barrelsReturned ?? 0));
    }

    for (const f of floorRows) {
      const row = ensureDriver(f.driverId);
      const qty = Math.max(0, Number(f.qty ?? 0));
      const floor = Number(f.floor);
      const wage = floorWageByFloor.get(floor) ?? 0;
      const amount = qty * wage;
      row.floorBonusQty += qty;
      row.floorBonusAmount += amount;
      const hit = row.floorByLevel.get(floor) ?? { floor, qty: 0, wagePerUnit: wage, amount: 0 };
      hit.qty += qty;
      hit.wagePerUnit = wage;
      hit.amount = hit.qty * hit.wagePerUnit;
      row.floorByLevel.set(floor, hit);
    }

    const driversOut = [...byDriver.values()]
      .map((row) => {
        const deliveryProducts = [...row.deliveryByProduct.values()].sort((a, b) => b.qty - a.qty);
        const deliveryQty = deliveryProducts.reduce((s, p) => s + p.qty, 0);
        const deliveryAmount = deliveryProducts.reduce((s, p) => s + p.amount, 0);
        const emptyBarrelAmount = row.emptyBarrelQty * emptyWage;
        const floorByLevel = sortFloorBonusRates([...row.floorByLevel.values()]);
        const totalPay = row.baseSalary + deliveryAmount + emptyBarrelAmount + row.floorBonusAmount;
        return {
          driverId: row.driverId,
          employeeCode: row.employeeCode,
          name: row.name,
          baseSalary: row.baseSalary.toFixed(2),
          deliveryQty,
          deliveryAmount: deliveryAmount.toFixed(2),
          deliveryProducts: deliveryProducts.map((p) => ({
            ...p,
            wagePerUnit: p.wagePerUnit.toFixed(2),
            amount: p.amount.toFixed(2),
          })),
          emptyBarrelQty: row.emptyBarrelQty,
          emptyBarrelWage: emptyWage.toFixed(2),
          emptyBarrelAmount: emptyBarrelAmount.toFixed(2),
          floorBonusQty: row.floorBonusQty,
          floorBonusAmount: row.floorBonusAmount.toFixed(2),
          floorByLevel: floorByLevel.map((f) => ({
            floor: f.floor,
            qty: f.qty,
            wagePerUnit: f.wagePerUnit.toFixed(2),
            amount: f.amount.toFixed(2),
          })),
          totalPay: totalPay.toFixed(2),
        };
      })
      .sort((a, b) => Number(b.totalPay) - Number(a.totalPay) || a.employeeCode.localeCompare(b.employeeCode));

    const totals = driversOut.reduce(
      (acc, d) => {
        acc.baseSalary += Number(d.baseSalary);
        acc.deliveryQty += d.deliveryQty;
        acc.deliveryAmount += Number(d.deliveryAmount);
        acc.emptyBarrelQty += d.emptyBarrelQty;
        acc.emptyBarrelAmount += Number(d.emptyBarrelAmount);
        acc.floorBonusQty += d.floorBonusQty;
        acc.floorBonusAmount += Number(d.floorBonusAmount);
        acc.totalPay += Number(d.totalPay);
        return acc;
      },
      {
        baseSalary: 0,
        deliveryQty: 0,
        deliveryAmount: 0,
        emptyBarrelQty: 0,
        emptyBarrelAmount: 0,
        floorBonusQty: 0,
        floorBonusAmount: 0,
        totalPay: 0,
      },
    );

    res.json({
      ok: true,
      data: {
        yearMonth: label,
        settings: {
          emptyBarrelWage: settings.emptyBarrelWage.toString(),
          floorBonusRates: floorRates.map((r) => ({
            floor: r.floor,
            wage: r.wage.toString(),
          })),
          customerFloorFeeRates: (await listCustomerFloorFeeRates()).map((r) => ({
            floor: r.floor,
            unitPrice: r.unitPrice.toString(),
          })),
        },
        products: products.map((p) => ({
          id: String(p.id),
          productCode: p.productCode,
          name: p.name,
          unit: p.unit,
          driverDeliveryWage: p.driverDeliveryWage.toString(),
        })),
        drivers: driversOut,
        totals: {
          baseSalary: totals.baseSalary.toFixed(2),
          deliveryQty: totals.deliveryQty,
          deliveryAmount: totals.deliveryAmount.toFixed(2),
          emptyBarrelQty: totals.emptyBarrelQty,
          emptyBarrelAmount: totals.emptyBarrelAmount.toFixed(2),
          floorBonusQty: totals.floorBonusQty,
          floorBonusAmount: totals.floorBonusAmount.toFixed(2),
          totalPay: totals.totalPay.toFixed(2),
        },
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 截止日前已完成配送、含月結份額、且尚未納入任何結帳批次之訂單 */
async function fetchMonthlyOrdersEligibleForStatement(customerId: bigint, cutoffDateYmd: string, explicitOrderIds?: bigint[]) {
  const deliveryUpper = cutoffInclusiveDeliveryUpperBound(cutoffDateYmd);
  if (!deliveryUpper) return [];

  const orders = await prisma.salesOrder.findMany({
    where: {
      customerId,
      status: "completed",
      officeSettledAt: { not: null },
      billingStatementOrder: { is: null },
      ...(explicitOrderIds && explicitOrderIds.length > 0 ? { id: { in: explicitOrderIds } } : {}),
    },
    include: {
      lines: { include: { product: true } },
      assignments: {
        where: { status: { in: ["completed", "not_delivered"] } },
        orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
        take: 1,
      },
      billingStatementOrder: true,
    },
    orderBy: [{ id: "asc" }],
  });

  return orders
    .filter((o) => orderHasMonthlyPortion(o))
    .filter((o) => {
      const t = actualDeliveryInstant(o);
      return t != null && t.getTime() < deliveryUpper.getTime();
    });
}

function normalizeStatementInvoiceMode(raw: unknown): "none" | "tax_inclusive" | "tax_exclusive" {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "tax_inclusive" || s === "tax_exclusive" || s === "none") return s;
  return "tax_exclusive";
}

/** 月結待結：尚未開立批次的已完成月結訂單（不限截止日） */
app.get("/api/billing/monthly-unsettled", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    if (!customerId) {
      res.status(400).json({ ok: false, message: "請指定 customerId" });
      return;
    }
    const orders = await prisma.salesOrder.findMany({
      where: {
        customerId,
        status: "completed",
        officeSettledAt: { not: null },
        billingStatementOrder: { is: null },
      },
      include: {
        lines: { include: { product: true } },
        assignments: {
          where: { status: { in: ["completed", "not_delivered"] } },
          orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ id: "asc" }],
    });
    const pending = orders
      .filter((o) => orderHasMonthlyPortion(o))
      .map((o) => {
        const cap = orderMonthlyCap(o);
        const received = new Prisma.Decimal(String(o.monthlyReceivedAmount ?? 0));
        const outstanding = cap.minus(received);
        const a = o.assignments?.[0];
        const deliveryRaw = a?.driverReportedAt ?? a?.assignmentDate ?? o.scheduledDeliveryDate ?? null;
        return {
          id: o.id.toString(),
          orderNo: o.orderNo,
          deliveryDate: deliveryRaw ? toLocalYmd(new Date(deliveryRaw)) : null,
          monthlyAmount: cap.toString(),
          monthlyReceivedAmount: received.toString(),
          outstandingAmount: outstanding.toString(),
          monthlyPeriodPaid: o.monthlyPeriodPaid,
        };
      })
      .filter((r) => new Prisma.Decimal(r.outstandingAmount).greaterThan(0));
    const totalPending = pending.reduce(
      (s, r) => s.add(new Prisma.Decimal(r.outstandingAmount)),
      new Prisma.Decimal(0),
    );
    res.json({
      ok: true,
      data: {
        orderCount: pending.length,
        totalPending: totalPending.toString(),
        orders: pending,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 月結收款：FIFO 沖銷訂單、寫入 monthly_receipt_alloc；短收不會將未沖完訂單標為已付（已廢止） */
app.post("/api/billing/monthly-receive", async (_req, res) => {
  res.status(410).json({ ok: false, message: "已移除：請不要再使用 /api/billing/monthly-receive（改由一般請款單/收款沖帳流程自行處理）" });
});

/** @deprecated 已廢止 */
app.post("/api/billing/monthly-mark-paid", async (_req, res) => {
  res.status(410).json({ ok: false, message: "已移除：請不要再使用 /api/billing/monthly-mark-paid（改由一般請款單/收款沖帳流程自行處理）" });
});

app.get("/api/payments", async (_req, res) => {
  try {
    const rows = await prisma.payment.findMany({
      include: {
        customer: true,
        salesOrder: true,
      },
      orderBy: { paidAt: "desc" },
      take: 100,
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 解析營運指標／報表用的本地日期區間 */
function resolveAccountingPeriodRange(
  range: string,
  startDate: string,
  endDate: string,
  now = new Date(),
  opts?: { date?: string; ym?: string },
): { start: Date; end: Date } | { error: string } {
  if (range === "month") {
    const ymRaw = (opts?.ym ?? "").trim() || (startDate.trim().length >= 7 ? startDate.trim().slice(0, 7) : "");
    let y: number;
    let m: number;
    if (/^\d{4}-\d{2}$/.test(ymRaw)) {
      y = Number(ymRaw.slice(0, 4));
      m = Number(ymRaw.slice(5, 7));
    } else {
      y = now.getFullYear();
      m = now.getMonth() + 1;
    }
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return { error: "月份無效（須 YYYY-MM）" };
    const monthStart = parseLocalYmdRange(`${y}-${String(m).padStart(2, "0")}-01`);
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const monthEnd = parseLocalYmdRange(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
    if (!monthStart || !monthEnd) return { error: "月份區間解析失敗" };
    return { start: monthStart.start, end: monthEnd.start };
  }
  if (range === "custom") {
    const customStart = parseLocalYmdRange(startDate);
    const customEnd = parseLocalYmdRange(endDate);
    if (!customStart || !customEnd) return { error: "custom 區間需要有效的 startDate / endDate (YYYY-MM-DD)" };
    if (customStart.start >= customEnd.end) return { error: "日期區間錯誤：startDate 必須小於等於 endDate" };
    return { start: customStart.start, end: customEnd.end };
  }
  // today / day：單日（可指定 date 或 startDate）
  const dayYmd = (opts?.date ?? "").trim() || startDate.trim() || toLocalYmd(now);
  const todayRange = parseLocalYmdRange(dayYmd);
  if (!todayRange) return { error: "日期須為 YYYY-MM-DD" };
  return { start: todayRange.start, end: todayRange.end };
}

/** 區間完成訂單中，尚未開立月結批次的月結應收合計／筆數 */
function sumPendingMonthlyStatementAmount(
  orders: Array<{
    monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
    totalAmount: Prisma.Decimal | { toString(): string };
    billingTypeAtOrder: string | null;
    billingStatementOrder?: { id: bigint } | null;
  }>,
): { amount: number; count: number } {
  let amount = 0;
  let count = 0;
  for (const o of orders) {
    if (o.billingStatementOrder != null) continue;
    const cap = orderMonthlyCap(o);
    if (cap.greaterThan(0)) {
      amount += Number(cap);
      count += 1;
    }
  }
  return { amount, count };
}

type AccountingPeriodFilters = {
  customerId?: bigint | null;
  driverId?: bigint | null;
  billingType?: string | null;
  /** 預設 true：排除 is_test 訂單；傳 excludeTest=0 可包含 */
  excludeTest?: boolean;
};

function salesOrderWhereFromAccountingFilters(filters: AccountingPeriodFilters): Prisma.SalesOrderWhereInput {
  const where: Prisma.SalesOrderWhereInput = {};
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.excludeTest !== false) where.isTest = false;
  return where;
}

function orderMatchesBillingTypeFilter(
  o: {
    billingTypeAtOrder: string | null;
    totalAmount?: Prisma.Decimal | { toString(): string } | null;
    cashSubtotal?: Prisma.Decimal | { toString(): string } | null;
    monthlySubtotal?: Prisma.Decimal | { toString(): string } | null;
    cashInvoiceMode?: string | null;
    lines?: Array<{ billingTypeAtLine?: string | null; linePurpose?: string | null }>;
  },
  billingType: string | null | undefined,
): boolean {
  if (!billingType) return true;
  const withTotal = {
    ...o,
    totalAmount: o.totalAmount ?? new Prisma.Decimal(0),
  };
  if (billingType === "cash") {
    return orderCashReceivablePortion(withTotal).greaterThan(0) || (o.billingTypeAtOrder ?? "") === "cash";
  }
  if (billingType === "monthly") {
    return orderMonthlyCap(withTotal).greaterThan(0) || (o.billingTypeAtOrder ?? "") === "monthly";
  }
  if (billingType === "prepaid") {
    if ((o.billingTypeAtOrder ?? "") === "prepaid") return true;
    return (o.lines ?? []).some(
      (l) =>
        (l.billingTypeAtLine ?? "") === "prepaid" ||
        (l.linePurpose ?? "delivery") === "prepaid_barrel_topup",
    );
  }
  return true;
}

function sumPrepaidTopupAndConsume(
  orders: Array<{
    lines?: Array<{
      billingTypeAtLine?: string | null;
      linePurpose?: string | null;
      lineAmount: Prisma.Decimal | { toString(): string };
      qtyOrdered: number;
      qtyDelivered: number;
    }>;
  }>,
): { topupAmount: number; consumeAmount: number; consumeBarrels: number } {
  let topupAmount = 0;
  let consumeAmount = 0;
  let consumeBarrels = 0;
  for (const o of orders) {
    for (const l of o.lines ?? []) {
      const purpose = l.linePurpose ?? "delivery";
      if (purpose === "prepaid_barrel_topup") {
        topupAmount += Number(l.lineAmount);
        continue;
      }
      if ((l.billingTypeAtLine ?? "") === "prepaid") {
        consumeAmount += Number(l.lineAmount);
        const qty = l.qtyDelivered > 0 ? l.qtyDelivered : l.qtyOrdered;
        consumeBarrels += Math.max(0, qty);
      }
    }
  }
  return { topupAmount, consumeAmount, consumeBarrels };
}

async function buildAccountingPeriodSummary(start: Date, end: Date, filters: AccountingPeriodFilters = {}) {
  const customerId = filters.customerId ?? null;
  const driverId = filters.driverId ?? null;
  const billingType = filters.billingType?.trim() || null;
  const salesOrderWhere = salesOrderWhereFromAccountingFilters(filters);
  const hasSalesOrderFilter = Object.keys(salesOrderWhere).length > 0;

  const assignmentWhere: Prisma.DeliveryAssignmentWhereInput = {
    status: "completed",
    completedAt: { gte: start, lt: end },
    ...(driverId ? { driverId } : {}),
    ...(hasSalesOrderFilter ? { salesOrder: salesOrderWhere } : {}),
  };

  const lineSelect = {
    billingTypeAtLine: true,
    linePurpose: true,
    lineAmount: true,
    qtyOrdered: true,
    qtyDelivered: true,
  } as const;

  const orderWithLinesInclude = {
    billingStatementOrder: { select: { id: true } },
    lines: { select: lineSelect },
  } as const;

  type PeriodSalesOrder = Awaited<
    ReturnType<
      typeof prisma.salesOrder.findFirst<{
        include: typeof orderWithLinesInclude;
      }>
    >
  >;

  const [todayCompleted, periodPaymentsRaw, serviceTicketsClosed] = await Promise.all([
    prisma.deliveryAssignment.findMany({
      where: assignmentWhere,
      include: {
        salesOrder: {
          include: orderWithLinesInclude,
        },
      },
    }),
    prisma.payment.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        paymentMethod: { not: "prepayment" },
        ...(customerId ? { customerId } : {}),
        ...(filters.excludeTest !== false
          ? { OR: [{ salesOrderId: null }, { salesOrder: { isTest: false } }] }
          : {}),
      },
      include: {
        salesOrder: {
          include: {
            lines: { select: lineSelect },
            billingStatementOrder: { select: { id: true } },
          },
        },
      },
    }),
    driverId
      ? Promise.resolve(
          [] as Array<{
            id: bigint;
            ticketNo: string;
            closedAt: Date | null;
            billingType: string | null;
            chargeAmount: Prisma.Decimal | null;
            customer: { id: bigint; name: string; customerCode: string | null } | null;
            salesOrder: NonNullable<PeriodSalesOrder>;
          }>,
        )
      : prisma.serviceTicket.findMany({
          where: {
            status: "closed",
            closedAt: { gte: start, lt: end },
            salesOrderId: { not: null },
            ...(customerId ? { customerId } : {}),
            ...(hasSalesOrderFilter ? { salesOrder: salesOrderWhere } : {}),
          },
          include: {
            salesOrder: {
              include: orderWithLinesInclude,
            },
            customer: { select: { id: true, name: true, customerCode: true } },
          },
          orderBy: { closedAt: "desc" },
        }),
  ]);

  const serviceOrdersRaw = serviceTicketsClosed
    .map((t) => t.salesOrder)
    .filter((o): o is NonNullable<PeriodSalesOrder> => !!o && o.status !== "cancelled");

  let deliveryRows = todayCompleted;
  let serviceOrders = serviceOrdersRaw;
  if (billingType) {
    deliveryRows = deliveryRows.filter((row) => orderMatchesBillingTypeFilter(row.salesOrder, billingType));
    serviceOrders = serviceOrders.filter((o) => orderMatchesBillingTypeFilter(o, billingType));
  }

  const periodOrders = [...deliveryRows.map((row) => row.salesOrder), ...serviceOrders];
  const orderIds = [...new Set(periodOrders.map((o) => o.id))];
  const orderIdSet = new Set(orderIds.map((id) => id.toString()));

  /**
   * 有司機／結帳篩選時：實收僅計「本區間篩選後完成單」關聯之收款，與營收口徑對齊。
   * 無此類篩選時：維持區間內全部收款（仍套用客戶／excludeTest）。
   */
  let periodPayments = periodPaymentsRaw;
  if (driverId || billingType) {
    periodPayments = periodPaymentsRaw.filter(
      (p) => p.salesOrderId != null && orderIdSet.has(p.salesOrderId.toString()),
    );
  }

  const periodOrderOutstandingAgg =
    orderIds.length > 0
      ? await prisma.arOpenItem.aggregate({
          where: activeArOpenItemWhere({ salesOrderId: { in: orderIds } }),
          _sum: { outstandingAmount: true },
        })
      : { _sum: { outstandingAmount: null } };

  const deliveryRevenue = deliveryRows.reduce((sum, row) => sum + Number(orderBillableAmount(row.salesOrder)), 0);
  const serviceRevenue = serviceOrders.reduce((sum, o) => sum + Number(orderBillableAmount(o)), 0);
  const periodRevenue = deliveryRevenue + serviceRevenue;

  let revenueCash = 0;
  let revenueMonthly = 0;
  for (const o of periodOrders) {
    revenueCash += Number(orderCashReceivablePortion(o));
    revenueMonthly += Number(orderMonthlyCap(o));
  }
  const prepaid = sumPrepaidTopupAndConsume(periodOrders);

  const periodCollectedCash = periodPayments
    .filter((row) => row.paymentMethod === "cash")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const periodCollectedTransfer = periodPayments
    .filter((row) => row.paymentMethod === "transfer")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const periodCollectedOther = periodPayments
    .filter((row) => row.paymentMethod !== "cash" && row.paymentMethod !== "transfer")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const periodCollected = periodCollectedCash + periodCollectedTransfer + periodCollectedOther;
  const todayCompletedCount = deliveryRows.length + serviceOrders.length;
  const periodOrderOutstanding = Number(periodOrderOutstandingAgg._sum.outstandingAmount ?? 0);
  const pendingMonthly = sumPendingMonthlyStatementAmount(periodOrders);
  const periodPendingMonthly = pendingMonthly.amount;
  const periodPendingMonthlyCount = pendingMonthly.count;
  const periodReceivableTotal = periodOrderOutstanding + periodPendingMonthly;
  const driverCashCollected = deliveryRows.reduce((sum, row) => sum + Number(row.cashReceived ?? 0), 0);

  const arCustomerFilter = customerId ? { customerId } : {};
  const [arClosingAgg, arAccrualAgg, arAllocAgg] = await Promise.all([
    prisma.arOpenItem.aggregate({
      where: activeArOpenItemWhere(arCustomerFilter),
      _sum: { outstandingAmount: true },
    }),
    prisma.arDocument.aggregate({
      where: {
        status: { not: "voided" },
        postedAt: { gte: start, lt: end },
        ...(customerId ? { customerId } : {}),
      },
      _sum: { documentAmount: true },
    }),
    prisma.arAllocationMap.aggregate({
      where: {
        allocatedAt: { gte: start, lt: end },
        ...(customerId ? { arOpenItem: { customerId } } : {}),
      },
      _sum: { allocatedAmount: true },
    }),
  ]);

  const arClosing = Number(arClosingAgg._sum.outstandingAmount ?? 0);
  const arPeriodAccrual = Number(arAccrualAgg._sum.documentAmount ?? 0);
  const arPeriodCollected = Number(arAllocAgg._sum.allocatedAmount ?? 0);
  /** 前期欠款＝期末 − 本期立帳 ＋ 本期沖帳（含折讓外之收款沖帳） */
  const arOpening = arClosing - arPeriodAccrual + arPeriodCollected;
  /** 司機／結帳篩選時 AR 滾動仍僅套用客戶條件（AR 為客戶維度） */
  const arRollScope: "all" | "customer" | "customer_only_ignore_driver_billing" =
    driverId || billingType ? "customer_only_ignore_driver_billing" : customerId ? "customer" : "all";

  return {
    periodRevenue,
    periodCollected,
    periodCollectedCash,
    periodCollectedTransfer,
    periodCollectedOther,
    todayCompletedCount,
    periodOrderOutstanding,
    periodPendingMonthly,
    periodPendingMonthlyCount,
    periodReceivableTotal,
    revenueCash,
    revenueMonthly,
    revenuePrepaidTopup: prepaid.topupAmount,
    revenuePrepaidConsume: prepaid.consumeAmount,
    prepaidConsumeBarrels: prepaid.consumeBarrels,
    arOpening,
    arPeriodAccrual,
    arPeriodCollected,
    arClosing,
    arRollScope,
    driverCashCollected,
    todayCompleted: deliveryRows,
    periodPayments,
    serviceTicketsClosed: driverId ? [] : serviceTicketsClosed,
    deliveryRevenue,
    serviceRevenue,
  };
}

function parseExcludeTestFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "no") return false;
  if (s === "1" || s === "true" || s === "yes") return true;
  return true;
}

function parseAccountingFiltersFromQuery(query: Record<string, unknown>): AccountingPeriodFilters {
  const customerId = toBigInt(query.customerId);
  const driverId = toBigInt(query.driverId);
  const billingTypeRaw = typeof query.billingType === "string" ? query.billingType.trim() : "";
  const billingType =
    billingTypeRaw === "cash" || billingTypeRaw === "monthly" || billingTypeRaw === "prepaid"
      ? billingTypeRaw
      : null;
  const excludeTest = parseExcludeTestFlag(query.excludeTest);
  return { customerId, driverId, billingType, excludeTest };
}

function accountingSummaryJson(
  range: string,
  start: Date,
  end: Date,
  summary: Awaited<ReturnType<typeof buildAccountingPeriodSummary>>,
) {
  return {
    range,
    startDate: toLocalYmd(start),
    endDate: toLocalYmd(new Date(end.getTime() - 1)),
    periodRevenue: summary.periodRevenue,
    periodCollected: summary.periodCollected,
    periodCollectedCash: summary.periodCollectedCash,
    periodCollectedTransfer: summary.periodCollectedTransfer,
    periodCollectedOther: summary.periodCollectedOther,
    todayCompletedCount: summary.todayCompletedCount,
    periodOrderOutstanding: summary.periodOrderOutstanding,
    periodPendingMonthly: summary.periodPendingMonthly,
    periodPendingMonthlyCount: summary.periodPendingMonthlyCount,
    periodReceivableTotal: summary.periodReceivableTotal,
    revenueCash: summary.revenueCash,
    revenueMonthly: summary.revenueMonthly,
    revenuePrepaidTopup: summary.revenuePrepaidTopup,
    revenuePrepaidConsume: summary.revenuePrepaidConsume,
    prepaidConsumeBarrels: summary.prepaidConsumeBarrels,
    arOpening: summary.arOpening,
    arPeriodAccrual: summary.arPeriodAccrual,
    arPeriodCollected: summary.arPeriodCollected,
    arClosing: summary.arClosing,
    arRollScope: summary.arRollScope,
    driverCashCollected: summary.driverCashCollected,
    deliveryRevenue: summary.deliveryRevenue,
    serviceRevenue: summary.serviceRevenue,
    todayRevenue: summary.periodRevenue,
    todayCashReceived: summary.periodCollectedCash,
    unpaidAmount: summary.periodReceivableTotal,
  };
}

app.get("/api/accounting/summary", async (req, res) => {
  try {
    const now = new Date();
    const range = String(req.query.range ?? "today");
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";
    const date = typeof req.query.date === "string" ? req.query.date : "";
    const ym = typeof req.query.ym === "string" ? req.query.ym : "";
    const filters = parseAccountingFiltersFromQuery(req.query as Record<string, unknown>);

    const resolved = resolveAccountingPeriodRange(range, startDate, endDate, now, { date, ym });
    if ("error" in resolved) {
      res.status(400).json({ ok: false, message: resolved.error });
      return;
    }
    const { start, end } = resolved;
    const summary = await buildAccountingPeriodSummary(start, end, filters);
    res.json(accountingSummaryJson(range, start, end, summary));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 日報／月報明細：區間內配送、收款與彙總（伺服器端篩選，不受列表筆數上限影響） */
app.get("/api/reports/period-detail", async (req, res) => {
  try {
    const range = String(req.query.range ?? "today");
    if (range !== "today" && range !== "day" && range !== "month" && range !== "custom") {
      res.status(400).json({ ok: false, message: "range 須為 today、day、month 或 custom" });
      return;
    }
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";
    const date = typeof req.query.date === "string" ? req.query.date : "";
    const ym = typeof req.query.ym === "string" ? req.query.ym : "";
    const filters = parseAccountingFiltersFromQuery(req.query as Record<string, unknown>);
    const resolved = resolveAccountingPeriodRange(range === "day" ? "today" : range, startDate, endDate, new Date(), {
      date,
      ym,
    });
    if ("error" in resolved) {
      res.status(400).json({ ok: false, message: resolved.error });
      return;
    }
    const { start, end } = resolved;
    const summary = await buildAccountingPeriodSummary(start, end, filters);

    const salesOrderWhere = salesOrderWhereFromAccountingFilters(filters);
    const hasSalesOrderFilter = Object.keys(salesOrderWhere).length > 0;
    const deliveryWhere: Prisma.DeliveryAssignmentWhereInput = {
      status: "completed",
      completedAt: { gte: start, lt: end },
      ...(filters.driverId ? { driverId: filters.driverId } : {}),
      ...(hasSalesOrderFilter ? { salesOrder: salesOrderWhere } : {}),
    };

    const deliveriesRaw = await prisma.deliveryAssignment.findMany({
      where: deliveryWhere,
      include: {
        salesOrder: {
          include: {
            customer: true,
            lines: true,
            billingStatementOrder: { select: { id: true } },
          },
        },
        driver: { include: { user: true } },
        vehicle: true,
      },
      orderBy: { completedAt: "desc" },
    });
    const deliveries = filters.billingType
      ? deliveriesRaw.filter((row) => orderMatchesBillingTypeFilter(row.salesOrder, filters.billingType))
      : deliveriesRaw;

    const periodOrderIdSet = new Set(deliveries.map((d) => d.salesOrderId.toString()));
    for (const t of summary.serviceTicketsClosed) {
      if (t.salesOrder?.id) periodOrderIdSet.add(t.salesOrder.id.toString());
    }

    const paymentsRaw = await prisma.payment.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        paymentMethod: { not: "prepayment" },
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.excludeTest !== false
          ? { OR: [{ salesOrderId: null }, { salesOrder: { isTest: false } }] }
          : {}),
      },
      include: {
        customer: true,
        salesOrder: { include: { lines: true } },
      },
      orderBy: { paidAt: "desc" },
    });
    const payments =
      filters.driverId || filters.billingType
        ? paymentsRaw.filter((p) => p.salesOrderId != null && periodOrderIdSet.has(p.salesOrderId.toString()))
        : paymentsRaw;

    const enrichedDeliveries = deliveries.map((row) => ({
      ...row,
      salesOrder: row.salesOrder
        ? {
            ...row.salesOrder,
            orderBillableAmount: orderBillableAmount(row.salesOrder).toString(),
          }
        : null,
    }));

    const serviceTickets = summary.serviceTicketsClosed
      .filter((t) => {
        if (!t.salesOrder || t.salesOrder.status === "cancelled") return false;
        if (filters.billingType && !orderMatchesBillingTypeFilter(t.salesOrder, filters.billingType)) return false;
        return true;
      })
      .map((t) => ({
        id: t.id.toString(),
        ticketNo: t.ticketNo,
        closedAt: t.closedAt?.toISOString() ?? null,
        billingType: t.billingType,
        chargeAmount: t.chargeAmount?.toString() ?? null,
        customer: t.customer
          ? { id: t.customer.id.toString(), name: t.customer.name, customerCode: t.customer.customerCode }
          : null,
        salesOrder: t.salesOrder
          ? {
              id: t.salesOrder.id.toString(),
              orderNo: t.salesOrder.orderNo,
              totalAmount: t.salesOrder.totalAmount.toString(),
              billingTypeAtOrder: t.salesOrder.billingTypeAtOrder,
              orderBillableAmount: orderBillableAmount(t.salesOrder).toString(),
            }
          : null,
      }));

    const breakdownRaw = typeof req.query.breakdown === "string" ? req.query.breakdown.trim() : "";
    if (breakdownRaw) {
      if (!["revenue", "ar", "pendingMonthly", "payments"].includes(breakdownRaw)) {
        res.status(400).json({
          ok: false,
          message: "breakdown 須為 revenue、ar、pendingMonthly 或 payments",
        });
        return;
      }
      const summaryJson = accountingSummaryJson(range, start, end, summary);
      if (breakdownRaw === "payments") {
        res.json({
          ok: true,
          data: {
            ...summaryJson,
            summary: summaryJson,
            breakdown: "payments",
            rows: payments.map((p) => ({
              id: p.id.toString(),
              paidAt: p.paidAt?.toISOString() ?? null,
              amount: p.amount.toString(),
              paymentMethod: p.paymentMethod,
              note: p.note,
              customerName: p.customer?.name ?? null,
              orderNo: p.salesOrder?.orderNo ?? null,
            })),
            deliveries: [],
            serviceTickets: [],
            payments: [],
          },
        });
        return;
      }
      if (breakdownRaw === "revenue") {
        const rows = [
          ...enrichedDeliveries.map((row) => ({
            kind: "delivery" as const,
            id: row.id.toString(),
            at: row.completedAt?.toISOString?.() ?? (row.completedAt ? String(row.completedAt) : null),
            orderNo: row.salesOrder?.orderNo ?? null,
            customerName: row.salesOrder?.customer?.name ?? null,
            amount: row.salesOrder?.orderBillableAmount ?? "0",
            driverName: row.driver?.user?.name ?? row.driver?.employeeCode ?? null,
          })),
          ...serviceTickets.map((t) => ({
            kind: "service" as const,
            id: t.id,
            at: t.closedAt,
            orderNo: t.salesOrder?.orderNo ?? t.ticketNo,
            customerName: t.customer?.name ?? null,
            amount: t.salesOrder?.orderBillableAmount ?? t.chargeAmount ?? "0",
            driverName: null as string | null,
          })),
        ];
        res.json({
          ok: true,
          data: {
            ...summaryJson,
            summary: summaryJson,
            breakdown: "revenue",
            rows,
            deliveries: [],
            serviceTickets: [],
            payments: [],
          },
        });
        return;
      }
      if (breakdownRaw === "pendingMonthly") {
        const periodOrders = [
          ...deliveries.map((d) => d.salesOrder).filter(Boolean),
          ...summary.serviceTicketsClosed.map((t) => t.salesOrder).filter(Boolean),
        ] as Array<{
          id: bigint;
          orderNo: string;
          customerId: bigint;
          monthlySubtotal?: Prisma.Decimal | null;
          totalAmount: Prisma.Decimal;
          billingTypeAtOrder: string | null;
          billingStatementOrder?: { id: bigint } | null;
          customer?: { name: string } | null;
        }>;
        const rows = periodOrders
          .filter((o) => o && o.billingStatementOrder == null && orderMonthlyCap(o).greaterThan(0))
          .map((o) => ({
            id: o.id.toString(),
            orderNo: o.orderNo,
            customerId: o.customerId.toString(),
            customerName: o.customer?.name ?? null,
            amount: orderMonthlyCap(o).toString(),
          }));
        res.json({
          ok: true,
          data: {
            ...summaryJson,
            summary: summaryJson,
            breakdown: "pendingMonthly",
            rows,
            deliveries: [],
            serviceTickets: [],
            payments: [],
          },
        });
        return;
      }
      // breakdown === "ar"
      const orderIds = [
        ...new Set([
          ...deliveries.map((d) => d.salesOrderId),
          ...summary.serviceTicketsClosed
            .map((t) => t.salesOrder?.id)
            .filter((id): id is bigint => id != null),
        ]),
      ];
      const arItems =
        orderIds.length > 0
          ? await prisma.arOpenItem.findMany({
              where: activeArOpenItemWhere({ salesOrderId: { in: orderIds } }),
              include: { customer: true, salesOrder: true, arDocument: true },
              orderBy: { id: "asc" },
            })
          : [];
      res.json({
        ok: true,
        data: {
          ...summaryJson,
          summary: summaryJson,
          breakdown: "ar",
          rows: arItems.map((i) => ({
            id: i.id.toString(),
            arNo: i.arDocument.arNo,
            orderNo: i.salesOrder?.orderNo ?? null,
            customerId: i.customerId.toString(),
            customerName: i.customer.name,
            outstandingAmount: i.outstandingAmount.toString(),
            dueDate: i.dueDate ? toLocalYmd(new Date(i.dueDate)) : null,
            status: i.status,
          })),
          deliveries: [],
          serviceTickets: [],
          payments: [],
        },
      });
      return;
    }

    res.json({
      ok: true,
      data: {
        ...accountingSummaryJson(range, start, end, summary),
        summary: accountingSummaryJson(range, start, end, summary),
        deliveries: enrichedDeliveries,
        serviceTickets,
        payments,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機日收款核對：指定司機、配送日之訂單明細與現金／支票回報 */
app.get("/api/reports/driver-daily-collection", async (req, res) => {
  try {
    const driverId = toBigInt(req.query.driverId);
    const dateRaw =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : toLocalYmd(new Date());
    const range = parseLocalYmdRange(dateRaw);
    if (!driverId || !range) {
      res.status(400).json({ ok: false, message: "參數錯誤：driverId、date（YYYY-MM-DD）必填" });
      return;
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { user: true, vehicle: true },
    });
    if (!driver) {
      res.status(404).json({ ok: false, message: "找不到司機" });
      return;
    }

    const assignments = await prisma.deliveryAssignment.findMany({
      where: {
        driverId,
        assignmentDate: { gte: range.start, lt: range.end },
        status: { not: "cancelled" },
      },
      include: {
        salesOrder: {
          include: {
            customer: true,
            deliveryAddress: true,
            lines: { include: { product: true }, orderBy: { id: "asc" } },
          },
        },
        floorBonusRecords: { orderBy: [{ floor: "asc" }, { id: "asc" }] },
      },
      orderBy: [{ driverReportedAt: "asc" }, { id: "asc" }],
    });

    const orders = await Promise.all(
      assignments.map(async (asn) => {
        const order = asn.salesOrder;
        const calc = await calcCashDueByUnifiedRule(prisma, {
          customerId: order.customerId,
          currentSalesOrderId: order.id,
        });
        const expectedAmount = Number(asn.expectedAmount ?? calc.cashDue);
        const cashReceived = Number(asn.cashReceived ?? 0);
        const checkReceived = Number(asn.checkReceived ?? 0);
        const collectedTotal = cashReceived + checkReceived;
        const lines = order.lines
          .filter((ln) => (ln.linePurpose ?? "delivery") !== "prepaid_barrel_topup" || ln.qtyOrdered > 0)
          .map((ln) => {
            const purpose = ln.linePurpose ?? "delivery";
            const qty =
              purpose === "delivery"
                ? ln.qtyDelivered > 0
                  ? ln.qtyDelivered
                  : ln.qtyOrdered
                : ln.qtyOrdered;
            const productName = ln.product?.name?.trim() || "商品";
            const unit = ln.product?.unit?.trim() || "桶";
            const billing = ln.billingTypeAtLine ?? order.billingTypeAtOrder ?? order.customer.billingType;
        const label =
                purpose === "prepaid_barrel_topup"
                  ? `${productName} 儲值 ${qty} ${unit}`
                  : purpose === "floor_handling_fee"
                    ? `${productName} ${qty} ${unit}`
                    : `${productName} × ${qty} ${unit}`;
            return {
              id: ln.id.toString(),
              productName,
              unit,
              qty,
              unitPrice: ln.unitPrice.toString(),
              lineAmount: ln.lineAmount.toString(),
              billingType: billing,
              linePurpose: purpose,
              label,
            };
          });

        return {
          assignmentId: asn.id.toString(),
          orderNo: order.orderNo,
          assignmentStatus: asn.status,
          customerCode: order.customer.customerCode ?? "",
          customerName: order.customer.name,
          deliveryAddress: order.deliveryAddress?.addressLine ?? "",
          lines,
          lineSummary: lines.map((l) => l.label).join("；") || "—",
          expectedAmount,
          cashReceived,
          checkReceived,
          collectedTotal,
          collectionVariance: collectedTotal - expectedAmount,
          collectionStatus: driverCollectionStatusLabel({
            status: asn.status,
            settlementOutcome: asn.settlementOutcome,
            failureReason: asn.failureReason,
            expectedAmount,
            collectedTotal,
          }),
          settlementOutcome: asn.settlementOutcome,
          billableAmount: orderBillableAmount(order).toString(),
          floorBonusRecords: asn.floorBonusRecords.map((r) => ({
            id: r.id.toString(),
            productName: r.productName,
            qty: r.qty,
            floor: r.floor,
            floorLabel: r.floor < 0 ? `地下${Math.abs(r.floor)}樓` : `${r.floor}樓`,
          })),
          driverReportedAt: asn.driverReportedAt?.toISOString() ?? null,
          officeSettledAt: asn.officeSettledAt?.toISOString() ?? null,
        };
      }),
    );

    const summary = orders.reduce(
      (acc, row) => {
        acc.orderCount += 1;
        acc.totalExpected += row.expectedAmount;
        acc.totalCash += row.cashReceived;
        acc.totalCheck += row.checkReceived;
        acc.totalCollected += row.collectedTotal;
        if (row.collectionVariance !== 0 && row.expectedAmount > 0) acc.varianceOrderCount += 1;
        return acc;
      },
      {
        orderCount: 0,
        totalExpected: 0,
        totalCash: 0,
        totalCheck: 0,
        totalCollected: 0,
        varianceOrderCount: 0,
      },
    );

    // 飲水機服務費：掛在負責收款司機的歸屬日（現場＝評估司機／日；載回＝送回司機／日）
    const serviceTickets = await prisma.serviceTicket.findMany({
      where: {
        collectorDriverId: driverId,
        collectionDate: { gte: range.start, lt: range.end },
        status: "closed",
        chargeAmount: { gt: 0 },
      },
      include: {
        customer: true,
        deliveryAddress: true,
        salesOrder: true,
      },
      orderBy: [{ collectionDate: "asc" }, { id: "asc" }],
    });

    const serviceOrders = serviceTickets.map((t) => {
      const charge = Number(t.chargeAmount ?? 0);
      const isCash = t.billingType === "cash";
      const expectedAmount = isCash ? charge : 0;
      const cashReceived = Number(t.driverCashReceived ?? 0);
      const checkReceived = Number(t.driverCheckReceived ?? 0);
      const collectedTotal = cashReceived + checkReceived;
      const serviceTypeLabel =
        t.serviceType === "cleaning"
          ? "清洗"
          : t.serviceType === "repair"
            ? "維修"
            : t.serviceType === "both"
              ? "清洗／維修"
              : t.serviceType;
      const onsite = t.assessOutcome === "onsite_fixed";
      const label = `飲水機服務費（${serviceTypeLabel}${onsite ? "·現場" : "·送回"}）`;
      let collectionStatus: string;
      if (!isCash) {
        collectionStatus = "月結·無現金應收";
      } else if (expectedAmount <= 0) {
        collectionStatus = "無現金應收";
      } else if (collectedTotal <= 0) {
        collectionStatus = "下次再收／待沖帳";
      } else if (collectedTotal === expectedAmount) {
        collectionStatus = "服務費·足額";
      } else if (collectedTotal < expectedAmount) {
        collectionStatus = `服務費·少收 ${(expectedAmount - collectedTotal).toFixed(0)}`;
      } else {
        collectionStatus = `服務費·多收 ${(collectedTotal - expectedAmount).toFixed(0)}`;
      }

      return {
        assignmentId: `svc-${t.id.toString()}`,
        sourceType: "service_ticket" as const,
        ticketNo: t.ticketNo,
        orderNo: t.salesOrder?.orderNo ?? t.ticketNo,
        assignmentStatus: "completed",
        customerCode: t.customer.customerCode ?? "",
        customerName: t.customer.name,
        deliveryAddress: t.deliveryAddress?.addressLine ?? "",
        lines: [
          {
            id: `svc-line-${t.id.toString()}`,
            productName: "飲水機服務費",
            unit: "式",
            qty: 1,
            unitPrice: String(charge),
            lineAmount: String(charge),
            billingType: t.billingType ?? "cash",
            linePurpose: SERVICE_FEE_LINE_PURPOSE,
            label,
          },
        ],
        lineSummary: label,
        expectedAmount,
        cashReceived,
        checkReceived,
        collectedTotal,
        collectionVariance: collectedTotal - expectedAmount,
        collectionStatus,
        settlementOutcome: isCash
          ? collectedTotal <= 0
            ? "delivered_no_cash"
            : collectedTotal === expectedAmount
              ? "delivered_cash_exact"
              : collectedTotal < expectedAmount
                ? "delivered_cash_short"
                : "delivered_cash_over"
          : null,
        billableAmount: String(charge),
        floorBonusRecords: [] as Array<{
          id: string;
          productName: string;
          qty: number;
          floor: number;
          floorLabel: string;
        }>,
        driverReportedAt: t.closedAt?.toISOString() ?? null,
        officeSettledAt: t.salesOrder?.officeSettledAt?.toISOString() ?? t.closedAt?.toISOString() ?? null,
      };
    });

    for (const row of serviceOrders) {
      summary.orderCount += 1;
      summary.totalExpected += row.expectedAmount;
      summary.totalCash += row.cashReceived;
      summary.totalCheck += row.checkReceived;
      summary.totalCollected += row.collectedTotal;
      if (row.collectionVariance !== 0 && row.expectedAmount > 0) summary.varianceOrderCount += 1;
    }

    const allOrders = [
      ...orders.map((o) => ({ ...o, sourceType: "delivery" as const, ticketNo: null as string | null })),
      ...serviceOrders,
    ];

    res.json({
      ok: true,
      data: {
        date: dateRaw,
        driver: {
          id: driver.id.toString(),
          employeeCode: driver.user?.employeeCode ?? driver.employeeCode,
          name: driver.user?.name ?? "",
          vehiclePlate: driver.vehicle?.plateNo ?? null,
        },
        summary: {
          ...summary,
          totalVariance: summary.totalCollected - summary.totalExpected,
          deliveryOrderCount: orders.length,
          serviceTicketCount: serviceOrders.length,
        },
        orders: allOrders,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台分配：指定司機於某日期的配送任務與商品數量彙總（不含已取消任務） */
app.get("/api/delivery-assignments/by-driver-date", async (req, res) => {
  try {
    const driverId = req.query.driverId ? toBigInt(req.query.driverId) : null;
    const assignmentDateRaw = typeof req.query.assignmentDate === "string" ? req.query.assignmentDate.trim() : "";
    const range = parseLocalYmdRange(assignmentDateRaw);
    if (!driverId || !range) {
      res.status(400).json({ ok: false, message: "參數錯誤：driverId、assignmentDate（YYYY-MM-DD）必填" });
      return;
    }

    const rows = await prisma.deliveryAssignment.findMany({
      where: {
        driverId,
        assignmentDate: { gte: range.start, lt: range.end },
        status: { not: "cancelled" },
      },
      include: {
        salesOrder: {
          include: {
            customer: true,
            deliveryAddress: true,
            lines: { include: { product: true } },
          },
        },
        vehicle: true,
        driver: { include: { user: true } },
        floorBonusRecords: {
          orderBy: [{ floor: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ id: "asc" }],
    });

    type TotRow = { productId: string; label: string; unit: string; qtyTotal: number };
    const totalsMap = new Map<string, TotRow>();

    for (const asn of rows) {
      const lines = asn.salesOrder?.lines ?? [];
      for (const ln of lines) {
        const qty = Number(ln.qtyOrdered);
        if (!Number.isFinite(qty)) continue;
        const pid = String(ln.productId);
        const lp = String(ln.linePurpose ?? "delivery");
        const key = `${pid}__${lp}`;
        const p = ln.product;
        const baseName = (p?.name ?? "").trim() || "（商品）";
        const unit = (p?.unit ?? "").trim();
        const label = lp === "prepaid_barrel_topup" ? `${baseName}（預付桶儲值）` : baseName;
        const prev = totalsMap.get(key);
        if (prev) prev.qtyTotal += qty;
        else totalsMap.set(key, { productId: pid, label, unit, qtyTotal: qty });
      }
    }

    const productTotals = [...totalsMap.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "zh-Hant", { numeric: true }),
    );

    res.json({ ok: true, data: { assignments: rows, productTotals } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/delivery-assignments", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = req.body as {
      salesOrderId?: unknown;
      driverId?: unknown;
      vehicleId?: unknown;
      assignmentDate?: unknown;
      estimatedDeliverySlot?: unknown;
      estimatedDeliveryAt?: unknown;
    };

    const salesOrderId = toBigInt(body.salesOrderId);
    const driverId = toBigInt(body.driverId);
    const vehicleId =
      body.vehicleId != null && String(body.vehicleId).trim() !== "" ? toBigInt(body.vehicleId) : null;
    const assignmentDate = body.assignmentDate ? new Date(String(body.assignmentDate)) : new Date();
    const estimatedDeliverySlot =
      typeof body.estimatedDeliverySlot === "string" ? body.estimatedDeliverySlot.trim() || null : null;
    let estimatedDeliveryAt: Date | null = null;
    if (body.estimatedDeliveryAt != null && String(body.estimatedDeliveryAt).trim() !== "") {
      const parsed = new Date(String(body.estimatedDeliveryAt));
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ ok: false, message: "estimatedDeliveryAt 格式錯誤" });
        return;
      }
      estimatedDeliveryAt = parsed;
    }
    if (!salesOrderId || !driverId || Number.isNaN(assignmentDate.getTime())) {
      res.status(400).json({ ok: false, message: "參數錯誤：salesOrderId / driverId / assignmentDate 必填" });
      return;
    }

    const assignmentDateLabel =
      typeof body.assignmentDate === "string" && body.assignmentDate.trim()
        ? body.assignmentDate.trim().slice(0, 10)
        : assignmentDate.toISOString().slice(0, 10);

    // 行為等價：仍使用 DEFAULT_CREATOR_USER_ID（與重構前相同）
    const result = await createDeliveryAssignment(prisma, {
      salesOrderId,
      driverId,
      vehicleId,
      assignmentDate,
      assignmentDateLabel,
      assignedByUserId: DEFAULT_CREATOR_USER_ID,
      estimatedDeliverySlot,
      estimatedDeliveryAt,
      checkStock: true,
    });

    if (!result.ok) {
      res.status(result.httpStatus ?? 400).json({ ok: false, message: result.reason });
      return;
    }

    const created = await prisma.deliveryAssignment.findUnique({
      where: { id: result.assignmentId },
      include: {
        salesOrder: true,
        driver: { include: { user: true } },
        vehicle: true,
      },
    });

    res.status(201).json({
      ok: true,
      data: created,
      warnings: result.warnings,
      stockShortages: result.stockShortages,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 批次分派：失敗單略過並回報原因 */
app.post("/api/orders/batch-assign", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = req.body as {
      salesOrderIds?: unknown;
      driverId?: unknown;
      vehicleId?: unknown;
      assignmentDate?: unknown;
    };
    if (!Array.isArray(body.salesOrderIds) || body.salesOrderIds.length === 0) {
      res.status(400).json({ ok: false, message: "參數錯誤：salesOrderIds 必填" });
      return;
    }
    const salesOrderIds = body.salesOrderIds
      .map((x) => toBigInt(x))
      .filter((x): x is bigint => x != null);
    const driverId = toBigInt(body.driverId);
    const vehicleId =
      body.vehicleId != null && String(body.vehicleId).trim() !== "" ? toBigInt(body.vehicleId) : null;
    const assignmentDate = body.assignmentDate ? new Date(String(body.assignmentDate)) : new Date();
    if (!driverId || Number.isNaN(assignmentDate.getTime()) || salesOrderIds.length === 0) {
      res.status(400).json({ ok: false, message: "參數錯誤：salesOrderIds / driverId 必填" });
      return;
    }

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.isActive) {
      res.status(400).json({ ok: false, message: "司機不存在或未啟用" });
      return;
    }
    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle || !vehicle.isActive) {
        res.status(400).json({ ok: false, message: "車輛不存在或未啟用" });
        return;
      }
    }

    const actorUserId = getAuthUser(req)?.id ?? DEFAULT_CREATOR_USER_ID;
    const assignmentDateLabel =
      typeof body.assignmentDate === "string" && body.assignmentDate.trim()
        ? body.assignmentDate.trim().slice(0, 10)
        : assignmentDate.toISOString().slice(0, 10);

    const succeeded: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const salesOrderId of salesOrderIds) {
      const idStr = salesOrderId.toString();
      try {
        // 與重構前相同：batch 不做庫存檢查；規則集中於 createDeliveryAssignment
        const result = await createDeliveryAssignment(prisma, {
          salesOrderId,
          driverId,
          vehicleId,
          assignmentDate,
          assignmentDateLabel,
          assignedByUserId: actorUserId,
          estimatedDeliverySlot: null,
          checkStock: false,
        });
        if (!result.ok) {
          skipped.push({ id: idStr, reason: result.reason });
          continue;
        }
        succeeded.push(idStr);
      } catch (e) {
        skipped.push({ id: idStr, reason: String(e) });
      }
    }

    res.json({ ok: true, data: { succeeded, skipped } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

type CreateSalesOrderResult = { status: number; payload: Record<string, unknown> };

async function createConfirmedSalesOrder(
  body: {
    customerId?: unknown;
    deliveryAddressId?: unknown;
    productId?: unknown;
    qty?: unknown;
    lines?: unknown;
    scheduledDeliveryDate?: unknown;
    remark?: unknown;
    orderCashAdjustment?: unknown;
    cashInvoiceMode?: unknown;
    isTest?: unknown;
    testBatchId?: unknown;
    orderKind?: unknown;
    dispatchPriority?: unknown;
    earliestDate?: unknown;
    earliestShift?: unknown;
    latestDate?: unknown;
    latestShift?: unknown;
    preferredShift?: unknown;
    dispatchLocked?: unknown;
  },
  opts: {
    source?: string;
    createdByUserId?: bigint | null;
    initialStatus?: string;
    /** admin 來源才接受 isTest／testBatchId */
    allowTestFlags?: boolean;
    actorUserId?: bigint | null;
  } = {},
): Promise<CreateSalesOrderResult> {
  try {
    const orderSource = opts.source === "liff" ? "liff" : "admin";
    const creatorUserId = opts.createdByUserId === null ? null : (opts.createdByUserId ?? DEFAULT_CREATOR_USER_ID);
    const arCreatorUserId = creatorUserId ?? DEFAULT_CREATOR_USER_ID;
    const initialStatus = opts.initialStatus === "pending_review" ? "pending_review" : "confirmed";
    const allowTestFlags = opts.allowTestFlags === true && orderSource === "admin";
    const isTest = allowTestFlags && (body.isTest === true || body.isTest === 1 || body.isTest === "1" || body.isTest === "true");
    const testBatchRaw = allowTestFlags && typeof body.testBatchId === "string" ? body.testBatchId.trim() : "";
    const testBatchId = testBatchRaw ? testBatchRaw.slice(0, 64) : null;
    if (isTest === false && testBatchId) {
      return { status: 400, payload: { ok: false, message: "testBatchId 僅能搭配 isTest=true" } };
    }

    const customerId = toBigInt(body.customerId);
    const deliveryAddressId = toBigInt(body.deliveryAddressId);

    if (!customerId || !deliveryAddressId) {
      return { status: 400, payload: { ok: false, message: "參數錯誤：customerId / deliveryAddressId 必填" } };
    }

    type LineIn = {
      productId: bigint;
      qty: number;
      unitPrice: Prisma.Decimal | null;
      billingType: string;
      linePurpose: "delivery" | "prepaid_barrel_topup";
      invoiceMode: string | null;
      isPromotionGift?: boolean;
      promotionRuleKey?: string | null;
      promotionNote?: string | null;
      isReplenishment?: boolean;
    };
    const linesIn: LineIn[] = [];

    if (Array.isArray(body.lines) && body.lines.length > 0) {
      for (const row of body.lines) {
        if (typeof row !== "object" || row === null) continue;
        const r = row as {
          productId?: unknown;
          qty?: unknown;
          unitPrice?: unknown;
          billingType?: unknown;
          linePurpose?: unknown;
          invoiceMode?: unknown;
          isReplenishment?: unknown;
        };
        const pid = toBigInt(r.productId);
        const q = Number(r.qty);
        if (!pid || !Number.isInteger(q) || q < 0) {
          return { status: 400, payload: { ok: false, message: "明細錯誤：每列需有效 productId 與 qty（非負整數，0 表示數量待定）" } };
        }
        const isReplenishment = orderSource === "liff" ? false : Boolean(r.isReplenishment);
        let unitPrice: Prisma.Decimal | null = null;
        if (orderSource !== "liff" && r.unitPrice !== undefined && r.unitPrice !== null && r.unitPrice !== "") {
          const up = Number(r.unitPrice);
          if (!Number.isFinite(up) || up < 0) {
            return { status: 400, payload: { ok: false, message: "明細錯誤：unitPrice 須為非負數字" } };
          }
          unitPrice = new Prisma.Decimal(up);
        } else if (isReplenishment) {
          unitPrice = new Prisma.Decimal(0);
        }
        const linePurpose = isReplenishment ? "delivery" : normalizeLinePurpose(r.linePurpose);
        if (isReplenishment && normalizeLinePurpose(r.linePurpose) === "prepaid_barrel_topup") {
          return { status: 400, payload: { ok: false, message: "補送不可同時為預付桶儲值" } };
        }
        linesIn.push({
          productId: pid,
          qty: q,
          unitPrice,
          billingType: isReplenishment ? "cash" : normalizeLineBillingType(r.billingType, "cash"),
          linePurpose,
          invoiceMode: normalizeLineInvoiceMode(r.invoiceMode),
          isReplenishment,
        });
      }
    } else {
      const productId = toBigInt(body.productId);
      const qty = Number(body.qty);
      if (!productId || !Number.isInteger(qty) || qty < 0) {
        return { status: 400, payload: { ok: false, message: "參數錯誤：請傳入 lines[] 或單筆 productId + qty（非負整數）" } };
      }
      linesIn.push({ productId, qty, unitPrice: null, billingType: "cash", linePurpose: "delivery", invoiceMode: null, isReplenishment: false });
    }

    if (linesIn.length === 0) {
      return { status: 400, payload: { ok: false, message: "至少需要一筆商品明細" } };
    }

    if (orderSource === "liff" && linesIn.some((l) => l.isReplenishment)) {
      return { status: 400, payload: { ok: false, message: "LINE 訂水不可勾選補送" } };
    }

    const address = await prisma.deliveryAddress.findUnique({ where: { id: deliveryAddressId } });
    if (!address || address.customerId !== customerId) {
      return { status: 400, payload: { ok: false, message: "送貨地址不存在，或不屬於該客戶" } };
    }

    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      return { status: 400, payload: { ok: false, message: "客戶不存在" } };
    }
    if (cust.lifecycleStatus === "churned") {
      return { status: 400, payload: { ok: false, message: "此客戶已標記流失，無法開新訂單" } };
    }

    if (orderSource === "liff") {
      const openAtAddress = await prisma.salesOrder.findFirst({
        where: {
          deliveryAddressId,
          status: { notIn: ["completed", "cancelled", "not_delivered"] },
        },
        orderBy: { id: "desc" },
        select: { orderNo: true },
      });
      if (openAtAddress) {
        return {
          status: 409,
          payload: {
            ok: false,
            message: `此地址已有未完成訂單 ${openAtAddress.orderNo}，完成後才能再從 LINE 下單`,
          },
        };
      }
    }

    const linesInResolved: LineIn[] = linesIn
      .filter((l) => !l.isPromotionGift)
      .map((l) => {
      const isReplenishment = Boolean(l.isReplenishment);
      // LINE 訂水一律依客戶主檔結帳方式，不接受前端自行指定（避免誤成現金）
      const billingType = isReplenishment
        ? "cash"
        : l.linePurpose === "prepaid_barrel_topup"
          ? "cash"
          : orderSource === "liff"
            ? normalizeLineBillingType(null, cust.billingType)
            : normalizeLineBillingType(l.billingType, cust.billingType);
      const invoiceMode = billingType === "cash" ? l.invoiceMode : null;
      return {
        ...l,
        billingType,
        invoiceMode,
        isReplenishment,
        linePurpose: isReplenishment ? "delivery" : l.linePurpose,
        unitPrice: isReplenishment && l.unitPrice == null ? new Prisma.Decimal(0) : l.unitPrice,
      };
    });

    const promotionApplied = await applyPromotions(prisma, linesInResolved);
    const linesAfterPromotions = promotionApplied.lines as LineIn[];

    for (const l of linesAfterPromotions) {
      if (l.linePurpose === "prepaid_barrel_topup") {
        if (l.billingType !== "cash") {
          return { status: 400, payload: { ok: false, message: "預付桶儲值明細須為現金列（司機收款／匯款）" } };
        }
        if (l.isReplenishment) {
          return { status: 400, payload: { ok: false, message: "補送不可同時為預付桶儲值" } };
        }
      }
    }

    const distinctLineBillings = new Set(linesAfterPromotions.map((l) => l.billingType));
    const billingTypeAtOrder =
      distinctLineBillings.size === 1 ? [...distinctLineBillings][0]! : "mixed";
    let orderCashAdjustment = new Prisma.Decimal(0);
    if (
      orderSource !== "liff" &&
      body.orderCashAdjustment !== undefined &&
      body.orderCashAdjustment !== null &&
      body.orderCashAdjustment !== ""
    ) {
      const adj = new Prisma.Decimal(Number(body.orderCashAdjustment));
      if (adj.lessThan(0)) {
        return { status: 400, payload: { ok: false, message: "本單往來補額不可為負" } };
      }
      orderCashAdjustment = adj;
    }

    const uniqueIds = [...new Set(linesAfterPromotions.map((l) => l.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: uniqueIds } } });
    const productById = new Map(products.map((p) => [p.id, p]));
    const liffLastPriceByProduct = new Map<bigint, Prisma.Decimal>();
    if (orderSource === "liff") {
      const history = await prisma.salesOrderLine.findMany({
        where: {
          productId: { in: uniqueIds },
          salesOrder: { customerId, status: { not: "cancelled" } },
        },
        orderBy: { id: "desc" },
        select: { productId: true, unitPrice: true },
      });
      for (const line of history) {
        if (!liffLastPriceByProduct.has(line.productId)) {
          liffLastPriceByProduct.set(line.productId, line.unitPrice);
        }
      }
    }

    for (const l of linesAfterPromotions) {
      const p = productById.get(l.productId);
      if (!p || !p.isActive) {
        return { status: 400, payload: { ok: false, message: "商品不存在或已停用" } };
      }
      if (orderSource === "liff" && !l.isPromotionGift && !p.availableOnLiff) {
        return { status: 400, payload: { ok: false, message: `商品「${p.name}」未開放 LINE 訂購` } };
      }
    }
    const prepaidTopupByProduct = sumPrepaidTopupByProduct(
      linesAfterPromotions.map((l) => ({ productId: l.productId, qty: l.qty, linePurpose: l.linePurpose })),
    );
    const prepaidNeedByProduct = new Map<bigint, number>();
    for (const l of linesAfterPromotions) {
      if (l.linePurpose !== "delivery" || l.billingType !== "prepaid") continue;
      const p = productById.get(l.productId);
      if (p?.consumesPrepaidBarrel === true) {
        prepaidNeedByProduct.set(l.productId, (prepaidNeedByProduct.get(l.productId) ?? 0) + l.qty);
      }
    }
    if (!cust.allowPrepaidOverdraft && prepaidNeedByProduct.size > 0) {
      const productIds = [...prepaidNeedByProduct.keys()];
      const rows = await prisma.customerPrepaidProductBalance.findMany({
        where: { customerId, productId: { in: productIds } },
      });
      const balMap = new Map(rows.map((r) => [r.productId, r.balanceBarrels]));
      for (const [pid, need] of prepaidNeedByProduct) {
        const avail = balMap.get(pid) ?? 0;
        const sameOrderTopup = prepaidTopupByProduct.get(pid) ?? 0;
        if (need > avail + sameOrderTopup) {
          const p = productById.get(pid);
          const shortfall = need - avail - sameOrderTopup;
          const message =
            sameOrderTopup > 0
              ? `預付桶商品額度不足：${p?.name ?? "商品"} 需 ${need} 桶、目前 ${avail} 桶、本單儲值 ${sameOrderTopup} 桶後仍不足 ${shortfall} 桶。`
              : `預付桶商品額度不足：${p?.name ?? "商品"} 需 ${need} 桶、可用 ${avail} 桶。請先儲值同商品桶數後再開單。`;
          return { status: 400, payload: { ok: false, message } };
        }
      }
    }

    let safeScheduled: Date | null = null;
    if (body.scheduledDeliveryDate !== undefined && body.scheduledDeliveryDate !== null && String(body.scheduledDeliveryDate).trim() !== "") {
      const raw = String(body.scheduledDeliveryDate).trim();
      // DATE 欄位用 UTC 日曆日寫入，避免本地午夜被 Prisma 存成「前一天」
      const ymdDb = parseLocalYmdToDbDate(raw);
      if (ymdDb) {
        safeScheduled = ymdDb;
      } else {
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          return { status: 400, payload: { ok: false, message: "scheduledDeliveryDate 格式錯誤（需 YYYY-MM-DD 或有效日期時間）" } };
        }
        safeScheduled = parsed;
      }
    }

    const cashInvoiceMode = normalizeCashInvoiceMode(body.cashInvoiceMode);

    const lineCreates = linesAfterPromotions.map((l) => {
      const product = productById.get(l.productId)!;
      const isReplenishment = Boolean(l.isReplenishment) && !l.isPromotionGift;
      const unitPrice =
        l.isPromotionGift || isReplenishment
          ? l.unitPrice ?? new Prisma.Decimal(0)
          : orderSource === "liff"
            ? (liffLastPriceByProduct.get(l.productId) ?? product.salePrice)
            : (l.unitPrice ?? product.salePrice);
      const lineAmount = unitPrice.mul(l.qty);
      return {
        productId: l.productId,
        qtyOrdered: l.qty,
        qtyDelivered: 0,
        unitPrice,
        lineAmount,
        billingTypeAtLine: l.billingType,
        linePurpose: l.linePurpose,
        invoiceMode: l.invoiceMode,
        isPromotionGift: Boolean(l.isPromotionGift),
        promotionRuleKey: l.promotionRuleKey ?? null,
        promotionNote: l.promotionNote ?? null,
        isReplenishment,
      };
    });

    const totals = computeOrderTotalsFromLineAmounts(
      lineCreates.map((l) => ({
        lineAmount: l.lineAmount,
        billingTypeAtLine: l.billingTypeAtLine,
        linePurpose: l.linePurpose,
        productId: l.productId,
      })),
    );
    const { subtotal, cashSubtotal, monthlySubtotal } = totals;
    const pendingPrepaidTopupBarrels = lineCreates
      .filter((l) => l.linePurpose === "prepaid_barrel_topup")
      .reduce((s, l) => s + l.qtyOrdered, 0);

    const remarkText = typeof body.remark === "string" ? body.remark.trim() || null : null;
    const anyReplenishment = lineCreates.some((l) => l.isReplenishment);
    let orderKind =
      typeof body.orderKind === "string" && body.orderKind.trim()
        ? body.orderKind.trim()
        : remarkText?.startsWith("【週期巡查】")
          ? "patrol"
          : anyReplenishment
            ? "replenishment"
            : "general";
    const dispatchPriority =
      typeof body.dispatchPriority === "string" && body.dispatchPriority.trim()
        ? body.dispatchPriority.trim()
        : anyReplenishment
          ? "urgent"
          : orderKind === "patrol"
            ? "normal"
            : "normal";
    const preferredShift =
      typeof body.preferredShift === "string" && body.preferredShift.trim()
        ? body.preferredShift.trim()
        : orderKind === "patrol"
          ? "any"
          : null;

    let earliestDate: Date | null = parseLocalYmdToDbDate(String(body.earliestDate ?? "").trim());
    let earliestShift = typeof body.earliestShift === "string" ? body.earliestShift.trim() || null : null;
    let latestDate: Date | null = parseLocalYmdToDbDate(String(body.latestDate ?? "").trim());
    let latestShift = typeof body.latestShift === "string" ? body.latestShift.trim() || null : null;

    const slaCfg = slaConfigFromSettings(await loadPlanningSettings(prisma));
    if (orderKind === "patrol" && safeScheduled && (!earliestDate || !latestDate)) {
      const dueYmd = safeScheduled.toISOString().slice(0, 10);
      const win = patrolWindow(dueYmd, slaCfg.patrolEarlyShifts, slaCfg.patrolLateShifts);
      earliestDate = earliestDate ?? parseLocalYmdToDbDate(win.earliest.date);
      earliestShift = earliestShift ?? win.earliest.shift;
      latestDate = latestDate ?? parseLocalYmdToDbDate(win.latest.date);
      latestShift = latestShift ?? win.latest.shift;
    } else if (orderKind === "general" && !latestDate) {
      const schedYmd = safeScheduled ? safeScheduled.toISOString().slice(0, 10) : null;
      const sla = generalEffectiveLatest(
        new Date(),
        schedYmd,
        null,
        slaCfg.generalShifts,
        slaCfg.afterScheduledShifts,
      );
      latestDate = parseLocalYmdToDbDate(sla.date);
      latestShift = sla.shift;
    }

    const created = await prisma.$transaction(async (tx) => {
      if (orderSource === "liff") {
        const openAtAddress = await tx.salesOrder.findFirst({
          where: {
            deliveryAddressId,
            status: { notIn: ["completed", "cancelled", "not_delivered"] },
          },
          select: { orderNo: true },
        });
        if (openAtAddress) {
          const err = new Error(`此地址已有未完成訂單 ${openAtAddress.orderNo}，完成後才能再從 LINE 下單`);
          (err as Error & { statusCode?: number }).statusCode = 409;
          throw err;
        }
      }
      const so = await tx.salesOrder.create({
        data: {
          orderNo: generateOrderNo(),
          customerId,
          deliveryAddressId,
          status: initialStatus,
          scheduledDeliveryDate: safeScheduled,
          subtotal,
          totalAmount: subtotal,
          remark: remarkText,
          billingTypeAtOrder,
          cashSubtotal,
          monthlySubtotal,
          orderCashAdjustment,
          cashInvoiceMode: cashInvoiceMode === "none" ? null : cashInvoiceMode,
          pendingPrepaidTopupBarrels,
          source: orderSource,
          isTest,
          testBatchId: isTest ? testBatchId : null,
          createdByUserId: creatorUserId,
          orderKind,
          dispatchPriority,
          earliestDate,
          earliestShift,
          latestDate,
          latestShift,
          preferredShift,
          dispatchLocked: body.dispatchLocked === true,
          lines: {
            create: lineCreates,
          },
        },
      });

      await createArForSalesOrder(tx, {
        salesOrderId: so.id,
        orderNo: so.orderNo,
        customerId,
        billingTypeAtOrder,
        totalAmount: subtotal,
        cashSubtotal,
        monthlySubtotal,
        monthlySettlementDay: cust.monthlySettlementDay ?? null,
        createdByUserId: arCreatorUserId,
        cashInvoiceMode,
      });
      await syncPlannedCashTaxInvoice(tx, {
        customerId,
        salesOrderId: so.id,
        cashInvoiceMode,
        cashSubtotal,
      });
      await autoApplyPrepaymentToLatestOpenAr(tx, {
        customerId,
        note: `自動預收抵扣（立帳 ${so.orderNo}）`,
      });

      const full = await tx.salesOrder.findUnique({
        where: { id: so.id },
        include: {
          customer: true,
          deliveryAddress: true,
          lines: { include: { product: true } },
        },
      });

      await writeOperationAuditLog(tx, {
        actorUserId: opts.actorUserId ?? creatorUserId,
        action: "order_create",
        entityType: "sales_order",
        entityId: so.id.toString(),
        before: null,
        after: {
          id: so.id.toString(),
          orderNo: so.orderNo,
          customerId: customerId.toString(),
          deliveryAddressId: deliveryAddressId.toString(),
          status: so.status,
          totalAmount: so.totalAmount.toString(),
          isTest: so.isTest,
          testBatchId: so.testBatchId,
          source: so.source,
          lines: (full?.lines ?? []).map((l) => ({
            id: l.id.toString(),
            productId: l.productId.toString(),
            qtyOrdered: l.qtyOrdered,
            unitPrice: l.unitPrice.toString(),
            lineAmount: l.lineAmount.toString(),
            billingTypeAtLine: l.billingTypeAtLine,
            linePurpose: l.linePurpose,
          })),
        },
      });

      return full;
    });

    return { status: 201, payload: { ok: true, data: created } };
  } catch (e) {
    const statusCode =
      e && typeof e === "object" && "statusCode" in e ? Number((e as { statusCode?: unknown }).statusCode) : 0;
    if (statusCode === 409) {
      return {
        status: 409,
        payload: { ok: false, message: e instanceof Error ? e.message : "此地址已有未完成訂單" },
      };
    }
    return { status: 500, payload: { ok: false, message: publicErrorMessage(e) } };
  }
}

app.post("/api/sales-orders", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  const auth = getAuthUser(req);
  const result = await createConfirmedSalesOrder(req.body ?? {}, {
    source: "admin",
    createdByUserId: auth?.id ?? DEFAULT_CREATOR_USER_ID,
    allowTestFlags: !auth || auth.role === "admin",
    actorUserId: auth?.id ?? DEFAULT_CREATOR_USER_ID,
  });
  res.status(result.status).json(result.payload);
});

const PATROL_WEEKDAY_LABELS = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"] as const;

function isoWeekdayFromLocalDate(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

function mondayOfWeekContainingYmd(ymd: string): Date | null {
  const r = parseLocalYmdRange(ymd);
  if (!r) return null;
  const d = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate());
  const iso = isoWeekdayFromLocalDate(d);
  d.setDate(d.getDate() - (iso - 1));
  return d;
}

function weekYmdByWeekday(monday: Date): Map<number, string> {
  const m = new Map<number, string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    m.set(i + 1, toLocalYmd(d));
  }
  return m;
}

const PATROL_BLOCKING_ORDER_STATUSES = ["completed", "cancelled", "pending_review"] as const;

function formatPatrolBlockingOrderReason(orderNo: string, scheduledDeliveryDate: string | null): string {
  const dateNote = scheduledDeliveryDate ? `配送日 ${scheduledDeliveryDate}` : "配送日未設定";
  return `尚有未完成訂單 ${orderNo}（${dateNote}）`;
}

type PatrolCandidate = {
  addressId: string;
  customerId: string;
  customerCode: string | null;
  customerName: string;
  billingType: string;
  addressLabel: string | null;
  addressLine: string;
  patrolWeekday: number;
  patrolWeekdayLabel: string;
  scheduledDeliveryDate: string;
  targetWaterLevel: number | null;
  productId: string;
  productName: string;
  skipReason: string | null;
  blockingOrderNo: string | null;
  blockingOrderDate: string | null;
};

async function listPatrolCandidatesForWeek(weekAnchorYmd: string): Promise<
  | { ok: true; weekStart: string; weekEnd: string; candidates: PatrolCandidate[] }
  | { ok: false; message: string }
> {
  const monday = mondayOfWeekContainingYmd(weekAnchorYmd);
  if (!monday) return { ok: false, message: "weekStart 須為 YYYY-MM-DD" };
  const weekMap = weekYmdByWeekday(monday);
  const weekStart = weekMap.get(1)!;
  const weekEnd = weekMap.get(7)!;

  const addresses = await prisma.deliveryAddress.findMany({
    where: {
      patrolWeekday: { not: null },
      patrolProductId: { not: null },
      customer: { lifecycleStatus: { not: "churned" } },
    },
    include: {
      customer: { select: { id: true, customerCode: true, name: true, billingType: true } },
      patrolProduct: { select: { id: true, name: true, isActive: true } },
    },
    orderBy: [{ patrolWeekday: "asc" }, { id: "asc" }],
  });

  const addressIds = addresses.map((a) => a.id);

  const existing =
    addressIds.length === 0
      ? []
      : await prisma.salesOrder.findMany({
          where: {
            deliveryAddressId: { in: addressIds },
            scheduledDeliveryDate: {
              gte: parseLocalYmdToDbDate(weekStart)!,
              lte: parseLocalYmdToDbDate(weekEnd)!,
            },
            status: { not: "cancelled" },
          },
          select: { deliveryAddressId: true, scheduledDeliveryDate: true, orderNo: true },
        });
  const existingKey = new Set(
    existing.map((o) => {
      const ymd = o.scheduledDeliveryDate ? fmtDbDateYmd(o.scheduledDeliveryDate) : "";
      return `${o.deliveryAddressId.toString()}|${ymd}`;
    }),
  );

  const incompleteOrders =
    addressIds.length === 0
      ? []
      : await prisma.salesOrder.findMany({
          where: {
            deliveryAddressId: { in: addressIds },
            status: { notIn: [...PATROL_BLOCKING_ORDER_STATUSES] },
          },
          select: { deliveryAddressId: true, orderNo: true, scheduledDeliveryDate: true },
          orderBy: [{ scheduledDeliveryDate: "asc" }, { id: "asc" }],
        });
  const blockingByAddress = new Map<string, { orderNo: string; scheduledDeliveryDate: string | null }>();
  for (const o of incompleteOrders) {
    const addrId = o.deliveryAddressId.toString();
    if (blockingByAddress.has(addrId)) continue;
    blockingByAddress.set(addrId, {
      orderNo: o.orderNo,
      scheduledDeliveryDate: o.scheduledDeliveryDate ? fmtDbDateYmd(o.scheduledDeliveryDate) : null,
    });
  }

  const candidates: PatrolCandidate[] = [];
  for (const addr of addresses) {
    const weekday = addr.patrolWeekday!;
    const scheduledDeliveryDate = weekMap.get(weekday);
    if (!scheduledDeliveryDate) continue;
    const product = addr.patrolProduct;
    let skipReason: string | null = null;
    let blockingOrderNo: string | null = null;
    let blockingOrderDate: string | null = null;
    if (!product || !product.isActive) skipReason = "預設商品停用或不存在";
    const blocking = blockingByAddress.get(addr.id.toString());
    if (!skipReason && blocking) {
      skipReason = formatPatrolBlockingOrderReason(blocking.orderNo, blocking.scheduledDeliveryDate);
      blockingOrderNo = blocking.orderNo;
      blockingOrderDate = blocking.scheduledDeliveryDate;
    }
    const key = `${addr.id.toString()}|${scheduledDeliveryDate}`;
    if (!skipReason && existingKey.has(key)) skipReason = "本週同日已有訂單";

    candidates.push({
      addressId: addr.id.toString(),
      customerId: addr.customer.id.toString(),
      customerCode: addr.customer.customerCode,
      customerName: addr.customer.name,
      billingType: addr.customer.billingType,
      addressLabel: addr.label,
      addressLine: addr.addressLine,
      patrolWeekday: weekday,
      patrolWeekdayLabel: PATROL_WEEKDAY_LABELS[weekday] ?? String(weekday),
      scheduledDeliveryDate,
      targetWaterLevel: addr.targetWaterLevel,
      productId: product?.id.toString() ?? "",
      productName: product?.name ?? "—",
      skipReason,
      blockingOrderNo,
      blockingOrderDate,
    });
  }

  return { ok: true, weekStart, weekEnd, candidates };
}

/** 一鍵產生本週巡查單：數量 0（待定）、結帳依客戶 billingType */
app.post("/api/sales-orders/generate-patrol", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = (req.body ?? {}) as { weekStart?: unknown };
    const weekAnchor =
      typeof body.weekStart === "string" && body.weekStart.trim()
        ? body.weekStart.trim()
        : toLocalYmd(new Date());
    const preview = await listPatrolCandidatesForWeek(weekAnchor);
    if (!preview.ok) {
      res.status(400).json({ ok: false, message: preview.message });
      return;
    }

    const created: Array<{ orderNo: string; addressId: string; customerName: string; scheduledDeliveryDate: string }> = [];
    const errors: Array<{ addressId: string; customerName: string; message: string }> = [];
    const skipped = preview.candidates.filter((c) => c.skipReason);

    for (const c of preview.candidates) {
      if (c.skipReason) continue;
      const levelNote =
        c.targetWaterLevel != null ? `目標水位 ${c.targetWaterLevel} 桶` : "目標水位未設定";
      const billingNote =
        c.billingType === "prepaid" ? "預付扣桶" : c.billingType === "monthly" ? "月結" : "現金";
      const remark = `【週期巡查】${c.patrolWeekdayLabel}；${levelNote}；結帳 ${billingNote}；數量於現場回報`;
      const result = await createConfirmedSalesOrder(
        {
          customerId: c.customerId,
          deliveryAddressId: c.addressId,
          scheduledDeliveryDate: c.scheduledDeliveryDate,
          remark,
          orderKind: "patrol",
          preferredShift: "any",
          lines: [
            {
              productId: c.productId,
              qty: 0,
              billingType: c.billingType === "monthly" || c.billingType === "prepaid" ? c.billingType : "cash",
              linePurpose: "delivery",
            },
          ],
        },
        { source: "admin", createdByUserId: DEFAULT_CREATOR_USER_ID },
      );
      if (result.status >= 400 || !result.payload.ok) {
        errors.push({
          addressId: c.addressId,
          customerName: c.customerName,
          message: String((result.payload as { message?: string }).message ?? "開單失敗"),
        });
        continue;
      }
      const orderNo = String((result.payload as { data?: { orderNo?: string } }).data?.orderNo ?? "");
      created.push({
        orderNo,
        addressId: c.addressId,
        customerName: c.customerName,
        scheduledDeliveryDate: c.scheduledDeliveryDate,
      });
    }

    res.json({
      ok: true,
      data: {
        weekStart: preview.weekStart,
        weekEnd: preview.weekEnd,
        createdCount: created.length,
        skippedCount: skipped.length,
        errorCount: errors.length,
        created,
        skipped,
        errors,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 辦公室確認 LINE／待審訂單 → confirmed（之後才可派車） */
app.post("/api/sales-orders/:salesOrderId/confirm-review", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const salesOrderId = toBigInt(req.params.salesOrderId);
    if (!salesOrderId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        customer: true,
        deliveryAddress: true,
        lines: { include: { product: true } },
      },
    });
    if (!order) {
      res.status(404).json({ ok: false, message: "找不到訂單" });
      return;
    }
    if (order.status !== "pending_review") {
      res.status(400).json({ ok: false, message: "此訂單不在待確認狀態" });
      return;
    }
    const updated = await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: "confirmed", lockVersion: { increment: 1 } },
      include: {
        customer: true,
        deliveryAddress: true,
        lines: { include: { product: true } },
      },
    });

    void notifyCustomerViaLine(prisma, {
      customerId: order.customerId,
      eventType: "order_confirmed",
      salesOrderId,
      text: [
        "【訂單已確認】",
        `訂單編號：${order.orderNo}`,
        "辦公室已確認您的訂購，接著會為您安排配送。",
      ].join("\n"),
    }).catch((err) => console.error("[line-notify] order_confirmed", err));

    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/driver/confirm-line-deliveries", async (req, res) => {
  try {
    const body = req.body as { assignmentId?: unknown; lines?: unknown };
    const assignmentId = toBigInt(body.assignmentId);
    if (!assignmentId) {
      res.status(400).json({ ok: false, message: "參數錯誤：assignmentId 必填" });
      return;
    }
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.status(400).json({ ok: false, message: "請傳入 lines（各品項實際配送桶數）" });
      return;
    }

    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        salesOrder: {
          include: { lines: true, customer: true },
        },
      },
    });
    if (!assignment) {
      res.status(404).json({ ok: false, message: "找不到配送任務" });
      return;
    }
    const auth = getAuthUser(req);
    if (auth?.role === "driver" && assignment.driverId !== auth.driverId) {
      res.status(403).json({ ok: false, message: "不可修改其他司機的任務" });
      return;
    }
    if (assignment.status === "completed" || assignment.status === "not_delivered" || assignment.status === "cancelled") {
      res.status(400).json({ ok: false, message: "此任務已結案，無法修改配送數量" });
      return;
    }
    if (!["assigned", "delivering", "pending_settlement"].includes(assignment.status)) {
      res.status(400).json({ ok: false, message: "此任務狀態不可確認配送數量" });
      return;
    }

    const order = assignment.salesOrder;
    const parsed = parseLineDeliveriesFromBody(body.lines, order.lines);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, message: parsed.message });
      return;
    }
    const hasTbdQty = order.lines.some(
      (l) => (l.linePurpose ?? "delivery") === "delivery" && l.qtyOrdered === 0,
    );
    if (hasTbdQty && parsed.lines.some((l) => l.qtyDelivered <= 0)) {
      res.status(400).json({ ok: false, message: "開單數量為 0（待定）的品項，須填寫實際配送桶數" });
      return;
    }

    const reportSourcePayload =
      auth?.role === "driver"
        ? { source: "driver_app" as const }
        : auth
          ? {
              source: "office_proxy" as const,
              reportedByUserId: auth.id.toString(),
              reportedByEmployeeCode: auth.employeeCode,
              reportedByName: auth.name,
            }
          : { source: "unknown" as const };

    const result = await prisma.$transaction(async (tx) => {
      const beforeLines = order.lines.map((l) => ({
        lineId: l.id.toString(),
        qtyOrdered: l.qtyOrdered,
        qtyDelivered: l.qtyDelivered,
        lineAmount: l.lineAmount.toString(),
      }));

      await applyLineDeliveriesAtReport(tx, order, parsed.lines);

      const orderAfter = await tx.salesOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { lines: { include: { product: true } }, customer: true },
      });
      const collectCalc = await calcCashDueByUnifiedRule(tx, {
        customerId: orderAfter.customerId,
        currentSalesOrderId: orderAfter.id,
      });
      const cashDue = collectCalc.collectDue;

      let assignmentPatch: Prisma.DeliveryAssignmentUpdateInput = {};
      if (assignment.status === "pending_settlement") {
        const receivedDec = assignmentFieldCollectedTotal(assignment);
        const variance = receivedDec.minus(cashDue);
        let settlementOutcome: string;
        if (receivedDec.isZero() && !cashDue.isZero()) {
          settlementOutcome = "delivered_no_cash";
        } else if (variance.isZero()) {
          settlementOutcome = "delivered_cash_exact";
        } else if (variance.lessThan(0)) {
          settlementOutcome = "delivered_cash_short";
        } else {
          settlementOutcome = "delivered_cash_over";
        }
        assignmentPatch = {
          expectedAmount: cashDue,
          cashVariance: variance,
          settlementOutcome,
        };
      }

      await tx.deliveryAssignment.update({
        where: { id: assignmentId },
        data: assignmentPatch,
      });

      await tx.deliveryEvent.create({
        data: {
          deliveryAssignmentId: assignmentId,
          eventType: "line_delivery_confirm",
          payloadJson: {
            orderNo: order.orderNo,
            lineDeliveries: parsed.lines.map((l) => ({
              lineId: l.lineId.toString(),
              qtyDelivered: l.qtyDelivered,
            })),
            orderTotal: orderAfter.totalAmount.toString(),
            cashSubtotal: String(orderAfter.cashSubtotal ?? 0),
            cashDue: cashDue.toString(),
            ...reportSourcePayload,
          },
        },
      });

      await writeOperationAuditLog(tx, {
        actorUserId: auth?.id ?? null,
        action: "line_qty_change",
        entityType: "sales_order",
        entityId: order.id.toString(),
        before: {
          assignmentId: assignmentId.toString(),
          orderNo: order.orderNo,
          totalAmount: order.totalAmount.toString(),
          lines: beforeLines,
        },
        after: {
          assignmentId: assignmentId.toString(),
          orderNo: orderAfter.orderNo,
          totalAmount: orderAfter.totalAmount.toString(),
          cashDue: cashDue.toString(),
          lines: orderAfter.lines.map((l) => ({
            lineId: l.id.toString(),
            qtyOrdered: l.qtyOrdered,
            qtyDelivered: l.qtyDelivered,
            lineAmount: l.lineAmount.toString(),
          })),
          ...reportSourcePayload,
        },
      });

      return tx.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        include: {
          salesOrder: { include: { lines: { include: { product: true } }, customer: true } },
        },
      });
    });

    if (!result?.salesOrder) {
      res.status(500).json({ ok: false, message: "確認後讀取任務失敗" });
      return;
    }

    const orderAfter = result.salesOrder;
    const balanceCache = new Map<string, number>();
    const hints = await buildDriverBillingHints({
      customerId: orderAfter.customerId,
      excludeSalesOrderId: orderAfter.id,
      order: orderAfter,
      customer: {
        billingType: orderAfter.customer.billingType,
        prepaidBarrelBalance: orderAfter.customer.prepaidBarrelBalance,
        allowPrepaidOverdraft: orderAfter.customer.allowPrepaidOverdraft,
      },
      balanceCache,
    });
    const taxInvoice = await prisma.taxInvoice.findFirst({
      where: { salesOrderId: orderAfter.id, status: "issued" },
      orderBy: { id: "desc" },
    });

    res.json({
      ok: true,
      data: {
        assignment: result,
        driverBillingHints: hints,
        cashTaxInvoice: taxInvoice
          ? {
              mode: taxInvoice.invoiceMode,
              untaxedAmount: taxInvoice.untaxedAmount.toString(),
              taxAmount: taxInvoice.taxAmount.toString(),
              totalWithTax: taxInvoice.totalAmount.toString(),
            }
          : null,
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === "AR_ALREADY_ALLOCATED") {
      res.status(400).json({ ok: false, message: "訂單應收已沖帳，無法變更配送數量" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/driver/complete", async (req, res) => {
  try {
    const body = req.body as {
      assignmentId?: unknown;
      delivered?: unknown;
      failureReason?: unknown;
      emptyBarrelsReturned?: unknown;
      cashReceived?: unknown;
      checkReceived?: unknown;
      note?: unknown;
      /** 各明細實際配送桶數 */
      lines?: unknown;
      /** YYYY-MM-DD：司機回報時間用此本地日期的 00:00:00（測試或補登） */
      reportedAtYmd?: unknown;
      /** ISO 8601：若需指定時分秒可傳此欄（優先於 reportedAtYmd） */
      reportedAt?: unknown;
      /** 二樓以上/地下樓搬運紀錄：可多筆（同商品不同樓層） */
      floorBonusRecords?: unknown;
    };

    const assignmentId = toBigInt(body.assignmentId);
    const delivered = body.delivered !== false;
    const failureReason = typeof body.failureReason === "string" ? body.failureReason.trim() : "";
    const emptyBarrelsReturned = Number(body.emptyBarrelsReturned ?? 0);
    const cashReceived = Number(body.cashReceived ?? 0);
    const checkReceived = Number(body.checkReceived ?? 0);
    const note = typeof body.note === "string" ? body.note.trim() : "";

    if (!assignmentId) {
      res.status(400).json({ ok: false, message: "參數錯誤：assignmentId 必填" });
      return;
    }

    if (!delivered) {
      if (!failureReason) {
        res.status(400).json({ ok: false, message: "未送達時請填寫原因" });
        return;
      }
    } else {
      if (!Number.isFinite(emptyBarrelsReturned) || !Number.isFinite(cashReceived) || !Number.isFinite(checkReceived)) {
        res.status(400).json({ ok: false, message: "參數錯誤：emptyBarrelsReturned / cashReceived / checkReceived" });
        return;
      }
      if (emptyBarrelsReturned < 0 || cashReceived < 0 || checkReceived < 0) {
        res.status(400).json({ ok: false, message: "空桶回收與收款金額不可為負數" });
        return;
      }
    }

    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        salesOrder: {
          include: {
            lines: { include: { product: true } },
            customer: true,
          },
        },
        floorBonusRecords: true,
      },
    });
    if (!assignment) {
      res.status(404).json({ ok: false, message: "找不到配送任務" });
      return;
    }
    const auth = getAuthUser(req);
    if (auth?.role === "driver" && assignment.driverId !== auth.driverId) {
      res.status(403).json({ ok: false, message: "不可回報其他司機的任務" });
      return;
    }
    const reportSourcePayload =
      auth?.role === "driver"
        ? { source: "driver_app" as const }
        : auth
          ? {
              source: "office_proxy" as const,
              reportedByUserId: auth.id.toString(),
              reportedByEmployeeCode: auth.employeeCode,
              reportedByName: auth.name,
            }
          : { source: "unknown" as const };
    const isAmendPending = assignment.status === "pending_settlement";
    if (assignment.status === "completed" || assignment.status === "not_delivered") {
      res.status(400).json({ ok: false, message: "此任務已結案" });
      return;
    }
    if (assignment.status === "cancelled") {
      res.status(400).json({ ok: false, message: "此任務已取消" });
      return;
    }
    if (!isAmendPending && assignment.status !== "assigned" && assignment.status !== "delivering") {
      res.status(400).json({ ok: false, message: "此任務狀態不可提交司機回報" });
      return;
    }

    let driverReportedAt = new Date();
    const reportedAtIso = typeof body.reportedAt === "string" ? body.reportedAt.trim() : "";
    if (reportedAtIso) {
      const parsedIso = new Date(reportedAtIso);
      if (Number.isNaN(parsedIso.getTime())) {
        res.status(400).json({ ok: false, message: "reportedAt 須為有效 ISO 日期時間" });
        return;
      }
      driverReportedAt = parsedIso;
    } else {
      const reportedYmd = typeof body.reportedAtYmd === "string" ? body.reportedAtYmd.trim() : "";
      if (reportedYmd) {
        const parsed = parseLocalYmdRange(reportedYmd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "reportedAtYmd 須為 YYYY-MM-DD" });
          return;
        }
        driverReportedAt = parsed.start;
      }
    }

    const now = driverReportedAt;
    const order = assignment.salesOrder;

    let parsedLineDeliveries: ParsedLineDelivery[] | null = null;
    if (delivered) {
      if (Array.isArray(body.lines) && body.lines.length > 0) {
        const parsed = parseLineDeliveriesFromBody(body.lines, order.lines);
        if (!parsed.ok) {
          res.status(400).json({ ok: false, message: parsed.message });
          return;
        }
        parsedLineDeliveries = parsed.lines;
      } else {
        if (!deliveryLinesQtyConfirmed(order.lines)) {
          res.status(400).json({
            ok: false,
            message: "請先按「確認配送數量」，系統才會重算訂單金額與應收現金",
          });
          return;
        }
        parsedLineDeliveries = lineDeliveriesFromDb(order.lines);
      }
    }
    const parsedFloorBonusRecords = delivered ? parseFloorBonusRecords(body.floorBonusRecords) : [];
    if (parsedFloorBonusRecords === "INVALID") {
      res.status(400).json({ ok: false, message: "搬運紀錄須包含有效樓層（2樓以上或地下樓）與非負整數桶數" });
      return;
    }

    const amendPrev =
      isAmendPending
        ? {
            emptyBarrelsReturned: assignment.emptyBarrelsReturned,
            cashReceived: assignment.cashReceived.toString(),
            checkReceived: assignment.checkReceived.toString(),
            settlementOutcome: assignment.settlementOutcome,
            failureReason: assignment.failureReason,
            settlementNote: assignment.settlementNote,
            driverReportedAt: assignment.driverReportedAt?.toISOString() ?? null,
            floorBonusRecords: assignment.floorBonusRecords.map((r) => ({
              lineId: r.salesOrderLineId.toString(),
              floor: r.floor,
              qty: r.qty,
            })),
          }
        : null;

    const result = await prisma.$transaction(async (tx) => {
      let cashDue = new Prisma.Decimal(0);
      if (!delivered) {
        await clearCustomerFloorFeeLines(tx, {
          order: {
            id: order.id,
            orderNo: order.orderNo,
            customerId: order.customerId,
            billingTypeAtOrder: order.billingTypeAtOrder,
            cashInvoiceMode: order.cashInvoiceMode,
            customer: { monthlySettlementDay: order.customer.monthlySettlementDay ?? null },
          },
        });
        const collectCalc = await calcCashDueByUnifiedRule(tx, {
          customerId: order.customerId,
          currentSalesOrderId: order.id,
        });
        cashDue = collectCalc.collectDue;
      }

      if (!delivered) {
        await tx.deliveryAssignment.update({
          where: { id: assignmentId },
          data: {
            status: "pending_settlement",
            ...(!isAmendPending ? { driverReportedAt: now } : {}),
            completedAt: null,
            officeSettledAt: null,
            emptyBarrelsReturned: 0,
            cashReceived: 0,
            checkReceived: 0,
            settlementOutcome: "not_delivered",
            failureReason,
            expectedAmount: cashDue,
            cashVariance: null,
            settlementNote: note || null,
          } as Prisma.DeliveryAssignmentUpdateInput,
        });
        await tx.floorDeliveryBonusRecord.deleteMany({
          where: { deliveryAssignmentId: assignmentId },
        });

        await tx.deliveryEvent.create({
          data: {
            deliveryAssignmentId: assignmentId,
            eventType: isAmendPending ? "driver_report_amend" : "driver_report",
            payloadJson: {
              outcome: "not_delivered",
              failureReason,
              note: note || undefined,
              driverId: assignment.driverId.toString(),
              orderNo: order.orderNo,
              driverReportedAt: now.toISOString(),
              ...reportSourcePayload,
              ...(isAmendPending && amendPrev
                ? {
                    amendment: true,
                    previous: amendPrev,
                  }
                : {}),
            },
          },
        });

        await writeOperationAuditLog(tx, {
          actorUserId: auth?.id ?? null,
          action: "driver_report",
          entityType: "delivery_assignment",
          entityId: assignmentId.toString(),
          before: {
            assignmentStatus: assignment.status,
            settlementOutcome: assignment.settlementOutcome,
            ...(amendPrev ?? {}),
          },
          after: {
            outcome: "not_delivered",
            failureReason,
            note: note || null,
            orderNo: order.orderNo,
            salesOrderId: order.id.toString(),
            amendment: isAmendPending,
            ...reportSourcePayload,
          },
        });

        return tx.deliveryAssignment.findUnique({
          where: { id: assignmentId },
          include: {
            salesOrder: true,
            driver: { include: { user: true } },
            vehicle: true,
            events: { orderBy: { id: "asc" } },
          },
        });
      }

      if (parsedLineDeliveries) {
        await applyLineDeliveriesAtReport(tx, order, parsedLineDeliveries);
      }

      const orderForFloor = await tx.salesOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          customer: true,
          lines: { include: { product: true } },
        },
      });
      const floorBonusCreated = await createFloorBonusRecords(tx, {
        assignment,
        order: orderForFloor,
        records: parsedFloorBonusRecords,
      });
      const floorFeeApplied = await applyCustomerFloorFeesFromRecords(tx, {
        order: orderForFloor,
        records: parsedFloorBonusRecords,
      });

      const orderAfter = await tx.salesOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { customer: true },
      });
      const orderTotal = new Prisma.Decimal(orderAfter.totalAmount.toString());
      const collectCalc = await calcCashDueByUnifiedRule(tx, {
        customerId: orderAfter.customerId,
        currentSalesOrderId: orderAfter.id,
      });
      cashDue = collectCalc.collectDue;

      const receivedDec = assignmentFieldCollectedTotal({ cashReceived, checkReceived });
      const variance = receivedDec.minus(cashDue);
      let settlementOutcome: string;
      if (receivedDec.isZero() && !cashDue.isZero()) {
        settlementOutcome = "delivered_no_cash";
      } else if (variance.isZero()) {
        settlementOutcome = "delivered_cash_exact";
      } else if (variance.lessThan(0)) {
        settlementOutcome = "delivered_cash_short";
      } else {
        settlementOutcome = "delivered_cash_over";
      }

      await tx.deliveryAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "pending_settlement",
          ...(!isAmendPending ? { driverReportedAt: now } : {}),
          completedAt: null,
          officeSettledAt: null,
          emptyBarrelsReturned: Math.floor(emptyBarrelsReturned),
          cashReceived,
          checkReceived,
          settlementOutcome,
          failureReason: null,
          expectedAmount: cashDue,
          cashVariance: variance,
          settlementNote: note || null,
        } as Prisma.DeliveryAssignmentUpdateInput,
      });

      await tx.deliveryEvent.create({
        data: {
          deliveryAssignmentId: assignmentId,
          eventType: isAmendPending ? "driver_report_amend" : "driver_report",
          payloadJson: {
            outcome: settlementOutcome,
            note: note || "司機回報送達",
            emptyBarrelsReturned: Math.floor(emptyBarrelsReturned),
            cashReceived,
            checkReceived,
            orderTotal: orderTotal.toString(),
            orderCashAdjustment: String(orderAfter.orderCashAdjustment ?? 0),
            cashDue: cashDue.toString(),
            expectedAmount: cashDue.toString(),
            cashVariance: variance.toString(),
            orderNo: order.orderNo,
            driverId: assignment.driverId.toString(),
            driverReportedAt: now.toISOString(),
            lineDeliveries: parsedLineDeliveries?.map((l) => ({
              lineId: l.lineId.toString(),
              qtyDelivered: l.qtyDelivered,
            })),
            floorBonusRecords: parsedFloorBonusRecords.map((r) => ({
              lineId: r.lineId.toString(),
              floor: r.floor,
              qty: r.qty,
            })),
            floorBonusCreated,
            customerFloorFeeAmount: floorFeeApplied.feeAmount.toString(),
            customerFloorFeeBillingType: floorFeeApplied.billingType,
            customerFloorFeeLineCount: floorFeeApplied.lineCount,
            ...reportSourcePayload,
            ...(isAmendPending && amendPrev
              ? {
                  amendment: true,
                  previous: amendPrev,
                }
              : {}),
          },
        },
      });

      await writeOperationAuditLog(tx, {
        actorUserId: auth?.id ?? null,
        action: "driver_report",
        entityType: "delivery_assignment",
        entityId: assignmentId.toString(),
        before: {
          assignmentStatus: assignment.status,
          settlementOutcome: assignment.settlementOutcome,
          ...(amendPrev ?? {}),
        },
        after: {
          outcome: settlementOutcome,
          cashReceived,
          checkReceived,
          emptyBarrelsReturned: Math.floor(emptyBarrelsReturned),
          cashDue: cashDue.toString(),
          orderNo: order.orderNo,
          salesOrderId: order.id.toString(),
          lineDeliveries: parsedLineDeliveries?.map((l) => ({
            lineId: l.lineId.toString(),
            qtyDelivered: l.qtyDelivered,
          })),
          amendment: isAmendPending,
          ...reportSourcePayload,
        },
      });

      return tx.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        include: {
          salesOrder: true,
          driver: { include: { user: true } },
          vehicle: true,
          events: { orderBy: { id: "asc" } },
        },
      });
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    if (e instanceof Error && e.message === "AR_ALREADY_ALLOCATED") {
      res.status(400).json({
        ok: false,
        message: "訂單應收已沖帳，無法變更配送數量或搬運費",
      });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/driver/today", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const employeeCode =
      auth?.role === "driver"
        ? auth.employeeCode
        : String(req.query.employeeCode ?? "").trim();
    if (!employeeCode) {
      res.status(400).json({ ok: false, message: "employeeCode 必填" });
      return;
    }

    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    let start: Date;
    let end: Date;
    if (dateParam) {
      const parsed = parseLocalYmdRange(dateParam);
      if (!parsed) {
        res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
        return;
      }
      start = parsed.start;
      end = parsed.end;
    } else {
      const today = new Date();
      start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    }

    const rows = await prisma.deliveryAssignment.findMany({
      where: {
        status: { in: ["assigned", "delivering", "pending_settlement", "completed", "not_delivered"] },
        driver: {
          user: {
            employeeCode,
          },
        },
        assignmentDate: {
          gte: start,
          lt: end,
        },
      },
      include: {
        salesOrder: {
          include: {
            customer: true,
            deliveryAddress: true,
            lines: {
              include: { product: true },
            },
          },
        },
        vehicle: true,
        floorBonusRecords: {
          orderBy: [{ floor: "asc" }, { id: "asc" }],
        },
        events: {
          orderBy: { id: "asc" },
        },
      },
      orderBy: { id: "desc" },
    });

    const customerFloorFeeRates = await listCustomerFloorFeeRates();
    const feeRatesPayload = customerFloorFeeRates.map((r) => ({
      floor: r.floor,
      unitPrice: r.unitPrice.toString(),
    }));
    const balanceCache = new Map<string, number>();
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const order = row.salesOrder;
        const customer = order.customer;
        const hints = await buildDriverBillingHints({
          customerId: customer.id,
          excludeSalesOrderId: order.id,
          order,
          customer: {
            billingType: customer.billingType,
            prepaidBarrelBalance: customer.prepaidBarrelBalance,
            allowPrepaidOverdraft: customer.allowPrepaidOverdraft,
          },
          balanceCache,
        });
        return { ...row, driverBillingHints: hints, customerFloorFeeRates: feeRatesPayload };
      }),
    );

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/sales-orders/:salesOrderId/cancel", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const salesOrderId = toBigInt(req.params.salesOrderId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!salesOrderId) {
      res.status(400).json({ ok: false, message: "參數錯誤：salesOrderId 必填" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({
        where: { id: salesOrderId },
        include: {
          payments: true,
          assignments: true,
        },
      });

      if (!order) {
        res.status(404).json({ ok: false, message: "找不到訂單" });
        return null;
      }

      if (order.status === "cancelled") {
        return {
          order: await tx.salesOrder.findUnique({
            where: { id: salesOrderId },
            include: { customer: true, deliveryAddress: true, lines: { include: { product: true } } },
          }),
          wasPendingReview: false,
          previousOrderNo: order.orderNo,
          customerId: order.customerId,
          rejectReason: "",
        };
      }

      if (
        order.status === "completed" ||
        (NON_CANCELLABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
      ) {
        res.status(400).json({ ok: false, message: "此訂單已分派司機或已完成核銷，不可取消" });
        return null;
      }
      if (order.officeSettledAt != null) {
        res.status(400).json({ ok: false, message: "此訂單已完成核銷，不可取消" });
        return null;
      }
      if (
        order.assignments.some((a) =>
          (NON_CANCELLABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
        )
      ) {
        res.status(400).json({ ok: false, message: "此訂單已分派司機或已完成核銷，不可取消" });
        return null;
      }

      if (order.payments.length > 0) {
        res.status(400).json({ ok: false, message: "此訂單已產生收款紀錄，不可取消" });
        return null;
      }

      const arItems = await tx.arOpenItem.findMany({
        where: { salesOrderId },
        include: { allocations: true },
      });
      const hasAllocatedAr = arItems.some(
        (oi) => oi.allocations.length > 0 || new Prisma.Decimal(oi.allocatedAmount).greaterThan(0),
      );
      if (hasAllocatedAr) {
        res.status(400).json({ ok: false, message: "此訂單已有沖帳紀錄，不可取消" });
        return null;
      }

      await voidArForCancelledSalesOrder(tx, salesOrderId);

      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { status: "cancelled", lockVersion: { increment: 1 }, remark: reason || order.remark },
      });

      return {
        order: await tx.salesOrder.findUnique({
          where: { id: salesOrderId },
          include: { customer: true, deliveryAddress: true, lines: { include: { product: true } } },
        }),
        wasPendingReview: order.status === "pending_review",
        previousOrderNo: order.orderNo,
        customerId: order.customerId,
        rejectReason: reason,
      };
    });

    if (!result) return;
    if (result.wasPendingReview && result.order) {
      void notifyCustomerViaLine(prisma, {
        customerId: result.customerId,
        eventType: "order_rejected",
        salesOrderId: result.order.id,
        text: [
          "【訂單未通過確認】",
          `訂單編號：${result.previousOrderNo}`,
          result.rejectReason ? `說明：${result.rejectReason}` : "辦公室未能確認此訂購，請於官方帳號聯絡我們。",
        ].join("\n"),
      }).catch((err) => console.error("[line-notify] order_rejected", err));
    }
    res.json({ ok: true, data: result.order });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/ar/open-items", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const billingType = typeof req.query.billingType === "string" ? req.query.billingType.trim() : "";
    const cutoffDate = typeof req.query.cutoffDate === "string" ? req.query.cutoffDate.trim() : "";
    const cutoffStart = cutoffDate ? cutoffDateStartLocal(cutoffDate) : null;
    if (cutoffDate && !cutoffStart) {
      res.status(400).json({ ok: false, message: "cutoffDate 須為 YYYY-MM-DD" });
      return;
    }
    const extra: Prisma.ArOpenItemWhereInput = {};
    if (customerId) extra.customerId = customerId;
    if (status) extra.status = status;
    if (cutoffStart) extra.createdAt = { lt: cutoffStart };
    if (billingType) {
      extra.arDocument = { billingType };
    }
    const rows = await prisma.arOpenItem.findMany({
      where: activeArOpenItemWhere(extra),
      include: {
        arDocument: true,
        salesOrder: { select: { id: true, orderNo: true } },
        allocations: { include: { receiptVoucher: { select: { id: true, voucherNo: true, paidAt: true } } } },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/ar/receipt-vouchers", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const body = req.body as {
      customerId?: unknown;
      paymentMethod?: unknown;
      amount?: unknown;
      note?: unknown;
      allocations?: unknown;
      toPrepayment?: unknown;
      paidAt?: unknown;
      paidAtYmd?: unknown;
    };
    const customerId = toBigInt(body.customerId);
    const amount = new Prisma.Decimal(Number(body.amount ?? 0));
    if (!customerId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 與 amount(>0) 必填" });
      return;
    }

    const toPrepayment = body.toPrepayment === true;
    const paidAtResolved = resolvePaidAtFromBody(body);
    if ("error" in paidAtResolved) {
      res.status(400).json({ ok: false, message: paidAtResolved.error });
      return;
    }
    const paidAt = paidAtResolved;

    const result = await prisma.$transaction(async (tx) => {
      const voucher = await tx.receiptVoucher.create({
        data: {
          voucherNo: generateReceiptVoucherNo(),
          customerId,
          voucherType: "receipt",
          paymentMethod: typeof body.paymentMethod === "string" ? body.paymentMethod.trim() || "cash" : "cash",
          totalAmount: amount,
          unappliedAmount: amount,
          status: "posted",
          paidAt,
          note: typeof body.note === "string" ? body.note.trim() || null : null,
          createdByUserId: DEFAULT_CREATOR_USER_ID,
          createdAt: paidAt,
        },
      });

      await tx.payment.create({
        data: {
          customerId,
          salesOrderId: null,
          amount,
          paymentMethod: voucher.paymentMethod,
          note: voucher.note,
          recordedByUserId: DEFAULT_CREATOR_USER_ID,
          paidAt,
          createdAt: paidAt,
          receiptVoucherId: voucher.id,
        },
      });

      if (toPrepayment) {
        const wallet = await ensurePrepaymentWallet(tx, customerId);
        const nextBalance = new Prisma.Decimal(wallet.balanceAmount).plus(amount);
        await tx.customerPrepaymentWallet.update({
          where: { customerId },
          data: { balanceAmount: nextBalance },
        });
        await tx.prepaymentTxn.create({
          data: {
            customerId,
            receiptVoucherId: voucher.id,
            txnType: "topup",
            amount,
            balanceAfter: nextBalance,
            note: "預收款儲值",
          },
        });
        await tx.receiptVoucher.update({
          where: { id: voucher.id },
          data: { unappliedAmount: new Prisma.Decimal(0), status: "applied" },
        });
        await autoApplyPrepaymentToLatestOpenAr(tx, {
          customerId,
          note: "自動預收抵扣（收款轉預收）",
        });
      } else {
        let allocRows: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];
        if (Array.isArray(body.allocations)) {
          allocRows = body.allocations
            .map((r) => {
              if (typeof r !== "object" || r === null) return null;
              const rr = r as { openItemId?: unknown; amount?: unknown };
              const openItemId = toBigInt(rr.openItemId);
              const a = new Prisma.Decimal(Number(rr.amount ?? 0));
              if (!openItemId || a.lessThanOrEqualTo(0)) return null;
              return { openItemId, amount: a };
            })
            .filter((x): x is { openItemId: bigint; amount: Prisma.Decimal } => Boolean(x));
        } else {
          let remain = amount;
          const opens = await tx.arOpenItem.findMany({
            where: { customerId, outstandingAmount: { gt: new Prisma.Decimal(0) } },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          });
          for (const open of opens) {
            if (remain.lessThanOrEqualTo(0)) break;
            const take = decMin(remain, new Prisma.Decimal(open.outstandingAmount));
            if (take.lessThanOrEqualTo(0)) continue;
            allocRows.push({ openItemId: open.id, amount: take });
            remain = remain.minus(take);
          }
        }
        await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: allocRows, allocatedAt: paidAt });
        const sumAlloc = allocRows.reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0));
        const unapplied = decMax(amount.minus(sumAlloc), new Prisma.Decimal(0));
        await tx.receiptVoucher.update({
          where: { id: voucher.id },
          data: {
            unappliedAmount: unapplied,
            status: unapplied.greaterThan(0) ? "partial" : "applied",
          },
        });

        if (unapplied.greaterThan(0)) {
          const wallet = await ensurePrepaymentWallet(tx, customerId);
          const nextBalance = new Prisma.Decimal(wallet.balanceAmount).plus(unapplied);
          await tx.customerPrepaymentWallet.update({
            where: { customerId },
            data: { balanceAmount: nextBalance },
          });
          await tx.prepaymentTxn.create({
            data: {
              customerId,
              receiptVoucherId: voucher.id,
              txnType: "overpay_to_wallet",
              amount: unapplied,
              balanceAfter: nextBalance,
              note: "溢收轉預收款",
            },
          });
          await tx.receiptVoucher.update({
            where: { id: voucher.id },
            data: { unappliedAmount: new Prisma.Decimal(0), status: "applied" },
          });
          await autoApplyPrepaymentToLatestOpenAr(tx, {
            customerId,
            note: "自動預收抵扣（溢收轉預收）",
          });
        }
      }

      return tx.receiptVoucher.findUnique({
        where: { id: voucher.id },
        include: {
          allocations: { include: { arOpenItem: { include: { salesOrder: true, arDocument: true } } } },
          prepaymentTxns: true,
        },
      });
    });

    res.status(201).json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/ar/receipt-vouchers", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    const rows = await prisma.receiptVoucher.findMany({
      where: customerId ? { customerId } : undefined,
      include: { allocations: true, prepaymentTxns: true },
      orderBy: { id: "desc" },
    });
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/customers/:customerId/prepayment-topup-money", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting"])) return;
  try {
    const customerId = toBigInt(req.params.customerId);
    const amount = new Prisma.Decimal(Number(req.body?.amount ?? 0));
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const invoiceModeRaw = req.body?.invoiceMode;
    if (!customerId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 與 amount(>0) 必填" });
      return;
    }

    const paidAtResolved = resolvePaidAtFromBody(req.body ?? {});
    if ("error" in paidAtResolved) {
      res.status(400).json({ ok: false, message: paidAtResolved.error });
      return;
    }
    const paidAt = paidAtResolved;

    const result = await prisma.$transaction(async (tx) => {
      const cust = await tx.customer.findUnique({ where: { id: customerId } });
      if (!cust) throw new Error("CUSTOMER_NOT_FOUND");
      const invoiceMode = normalizeCashInvoiceMode(
        typeof invoiceModeRaw === "string" ? invoiceModeRaw : (cust.defaultCashInvoiceMode ?? "none"),
      );
      const wallet = await ensurePrepaymentWallet(tx, customerId);
      const voucher = await tx.receiptVoucher.create({
        data: {
          voucherNo: generateReceiptVoucherNo(),
          customerId,
          voucherType: "prepayment",
          paymentMethod: "transfer",
          totalAmount: amount,
          unappliedAmount: new Prisma.Decimal(0),
          status: "applied",
          paidAt,
          note: note || "預收款儲值",
          createdByUserId: DEFAULT_CREATOR_USER_ID,
          createdAt: paidAt,
        },
      });
      await tx.payment.create({
        data: {
          customerId,
          salesOrderId: null,
          amount,
          paymentMethod: "transfer",
          note: note || "預收款儲值",
          recordedByUserId: DEFAULT_CREATOR_USER_ID,
          paidAt,
          createdAt: paidAt,
          receiptVoucherId: voucher.id,
        },
      });
      const nextBalance = new Prisma.Decimal(wallet.balanceAmount).plus(amount);
      await tx.customerPrepaymentWallet.update({
        where: { customerId },
        data: { balanceAmount: nextBalance },
      });
      await tx.prepaymentTxn.create({
        data: {
          customerId,
          receiptVoucherId: voucher.id,
          txnType: "topup",
          amount,
          balanceAfter: nextBalance,
          note: note || "預收款儲值",
        },
      });
      let taxInvoice = null;
      if (invoiceMode !== "none") {
        const br = breakdownCashTaxInvoice(amount, invoiceMode);
        if (br) {
          taxInvoice = await createTaxInvoicePlanned(tx, {
            customerId,
            basisType: "prepayment_topup",
            receiptVoucherId: voucher.id,
            invoiceMode,
            untaxedAmount: br.untaxedAmount,
            taxAmount: br.taxAmount,
            totalAmount: br.totalWithTax,
            note: note || "預收款儲值",
          });
        }
      }
      await autoApplyPrepaymentToLatestOpenAr(tx, {
        customerId,
        note: "自動預收抵扣（儲值後）",
      });
      const walletAfter = await tx.customerPrepaymentWallet.findUnique({ where: { customerId } });
      return { wallet: walletAfter, taxInvoice };
    });
    res.status(201).json({
      ok: true,
      data: {
        wallet: result.wallet,
        taxInvoice: result.taxInvoice
          ? {
              id: result.taxInvoice.id.toString(),
              invoiceNo: result.taxInvoice.invoiceNo,
              status: result.taxInvoice.status,
            }
          : null,
      },
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("CUSTOMER_NOT_FOUND")) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.post("/api/ar/prepayment-apply", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting", "dispatcher"])) return;
  try {
    const customerId = toBigInt(req.body?.customerId);
    const openItemId = toBigInt(req.body?.openItemId);
    const amount = new Prisma.Decimal(Number(req.body?.amount ?? 0));
    if (!customerId || !openItemId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId/openItemId/amount 必填" });
      return;
    }
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await ensurePrepaymentWallet(tx, customerId);
      if (new Prisma.Decimal(wallet.balanceAmount).lessThan(amount)) {
        throw new Error("PREPAYMENT_INSUFFICIENT");
      }
      const open = await tx.arOpenItem.findUnique({ where: { id: openItemId } });
      if (!open || open.customerId !== customerId) throw new Error("OPEN_ITEM_NOT_FOUND");
      const take = decMin(amount, new Prisma.Decimal(open.outstandingAmount));
      const voucher = await tx.receiptVoucher.create({
        data: {
          voucherNo: generateReceiptVoucherNo(),
          customerId,
          voucherType: "prepayment_apply",
          paymentMethod: "prepayment",
          totalAmount: take,
          unappliedAmount: new Prisma.Decimal(0),
          status: "applied",
          note: "預收款扣抵應收",
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: [{ openItemId, amount: take }] });
      const nextBalance = new Prisma.Decimal(wallet.balanceAmount).minus(take);
      await tx.customerPrepaymentWallet.update({ where: { customerId }, data: { balanceAmount: nextBalance } });
      await tx.prepaymentTxn.create({
        data: {
          customerId,
          receiptVoucherId: voucher.id,
          txnType: "apply",
          amount: take.negated(),
          balanceAfter: nextBalance,
          note: "預收款扣抵",
        },
      });
      return { voucherId: voucher.id.toString(), appliedAmount: take.toString(), balanceAfter: nextBalance.toString() };
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("PREPAYMENT_INSUFFICIENT")) {
      res.status(400).json({ ok: false, message: "預收款餘額不足" });
      return;
    }
    if (msg.includes("OPEN_ITEM_NOT_FOUND")) {
      res.status(404).json({ ok: false, message: "找不到可扣抵應收" });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

app.post("/api/ar/credit-notes", async (req, res) => {
  if (!requireRole(req, res, ["admin", "accounting"])) return;
  try {
    const customerId = toBigInt(req.body?.customerId);
    const salesOrderId = toBigInt(req.body?.salesOrderId);
    const amount = new Prisma.Decimal(Number(req.body?.amount ?? 0));
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!customerId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 與 amount(>0) 必填" });
      return;
    }
    const result = await prisma.$transaction(async (tx) => {
      const cn = await tx.creditNote.create({
        data: {
          creditNo: generateCreditNo(),
          customerId,
          salesOrderId: salesOrderId ?? null,
          amount,
          reason: reason || null,
          status: "approved",
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      let remain = amount;
      const opens = await tx.arOpenItem.findMany({
        where: {
          customerId,
          outstandingAmount: { gt: new Prisma.Decimal(0) },
          ...(salesOrderId ? { salesOrderId } : {}),
        },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        include: { arDocument: true },
      });
      const creditNoteCashOrderIds = new Set<bigint>();
      const touchedOpenItemIds: bigint[] = [];
      for (const open of opens) {
        if (remain.lessThanOrEqualTo(0)) break;
        const take = decMin(remain, new Prisma.Decimal(open.outstandingAmount));
        if (take.lessThanOrEqualTo(0)) continue;
        await tx.creditNoteAllocation.create({
          data: {
            creditNoteId: cn.id,
            arOpenItemId: open.id,
            amount: take,
          },
        });
        const allocatedAmount = new Prisma.Decimal(open.allocatedAmount).plus(take);
        const outstandingAmount = decMax(new Prisma.Decimal(open.outstandingAmount).minus(take), new Prisma.Decimal(0));
        await tx.arOpenItem.update({
          where: { id: open.id },
          data: {
            allocatedAmount,
            outstandingAmount,
            status: outstandingAmount.lessThanOrEqualTo(0) ? "paid" : "partially_paid",
          },
        });
        touchedOpenItemIds.push(open.id);
        const related = await tx.arOpenItem.count({
          where: { arDocumentId: open.arDocumentId, outstandingAmount: { gt: new Prisma.Decimal(0) } },
        });
        await tx.arDocument.update({
          where: { id: open.arDocumentId },
          data: { status: related === 0 ? "paid" : "open" },
        });
        if (open.salesOrderId && open.arDocument.billingType === "cash") {
          creditNoteCashOrderIds.add(open.salesOrderId);
        }
        remain = remain.minus(take);
      }
      await syncBillingStatementsAfterAllocations(tx, touchedOpenItemIds);
      for (const oid of creditNoteCashOrderIds) {
        await tryFulfillPendingPrepaidTopup(tx, oid);
      }
      await tx.customerLedgerEntry.create({
        data: {
          customerId,
          entryType: "ar_credit_note",
          amount: amount.negated(),
          salesOrderId: salesOrderId ?? null,
          note: reason || "折讓沖銷",
          createdByUserId: DEFAULT_CREATOR_USER_ID,
          sourceType: "credit_note",
          sourceId: cn.id,
        },
      });
      return tx.creditNote.findUnique({ where: { id: cn.id }, include: { allocations: true } });
    });
    res.status(201).json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/reports/ar-aging", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    const items = await prisma.arOpenItem.findMany({
      where: activeArOpenItemWhere(customerId ? { customerId } : {}),
      include: { customer: true, salesOrder: true, arDocument: true },
    });
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const bucket = { current: 0, d30: 0, d60: 0, d90: 0 };
    const rows = items.map((i) => {
      const outstanding = Number(i.outstandingAmount);
      const due = i.dueDate ? new Date(i.dueDate) : null;
      const days = due ? Math.max(0, Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24))) : 0;
      if (days >= 90) bucket.d90 += outstanding;
      else if (days >= 60) bucket.d60 += outstanding;
      else if (days >= 30) bucket.d30 += outstanding;
      else bucket.current += outstanding;
      return {
        openItemId: i.id.toString(),
        arNo: i.arDocument.arNo,
        customerId: i.customerId.toString(),
        customerName: i.customer.name,
        salesOrderId: i.salesOrderId?.toString() ?? null,
        orderNo: i.salesOrder?.orderNo ?? null,
        dueDate: i.dueDate,
        outstandingAmount: i.outstandingAmount.toString(),
        overdueDays: days,
        status: i.status,
      };
    });
    res.json({ ok: true, data: { summary: bucket, rows } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/reports/ar-exceptions", async (_req, res) => {
  try {
    const overdue = await prisma.arOpenItem.findMany({
      where: activeArOpenItemWhere({ status: "overdue" }),
      include: { customer: true, salesOrder: true, arDocument: true },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });
    const cashMissing = await prisma.deliveryAssignment.findMany({
      where: {
        status: "pending_settlement",
        settlementOutcome: { in: ["delivered_no_cash", "delivered_cash_short"] },
      },
      include: { salesOrder: { include: { customer: true } }, driver: { include: { user: true } } },
      orderBy: { id: "desc" },
      take: 200,
    });
    const creditHoldCustomers = await prisma.customer.findMany({
      where: {
        creditLimit: { gt: new Prisma.Decimal(0) },
        arOpenItems: { some: { outstandingAmount: { gt: new Prisma.Decimal(0) } } },
      },
      include: {
        arOpenItems: true,
      },
    });
    const creditHold = creditHoldCustomers
      .map((c) => {
        const outstanding = c.arOpenItems.reduce((s, i) => s + Number(i.outstandingAmount), 0);
        return { customerId: c.id.toString(), customerName: c.name, creditLimit: c.creditLimit.toString(), outstanding };
      })
      .filter((r) => r.outstanding > Number(r.creditLimit));
    res.json({ ok: true, data: { overdue, cashMissing, creditHold } });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 負庫存／庫存異常清單 */
app.get("/api/reports/inventory-exceptions", async (_req, res) => {
  try {
    const rows = await prisma.inventoryBalance.findMany({
      where: { qtyOnHand: { lt: 0 } },
      include: {
        product: {
          select: { id: true, productCode: true, name: true, sku: true, unit: true, isActive: true },
        },
      },
      orderBy: { qtyOnHand: "asc" },
    });
    const data = rows.map((r) => ({
      productId: r.productId.toString(),
      productCode: r.product.productCode,
      name: r.product.name,
      sku: r.product.sku,
      unit: r.product.unit,
      isActive: r.product.isActive,
      qtyOnHand: r.qtyOnHand,
    }));
    res.json({ ok: true, data, totalCount: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

type ExceptionCenterType =
  | "ar_past_due"
  | "cash_short"
  | "cash_over"
  | "delivered_unpaid"
  | "pending_settlement_stale"
  | "assigned_unreported"
  | "monthly_delivered_unbilled"
  | "prepaid_low"
  | "inventory_negative"
  | "deposit_barrels_stale"
  | "credit_over_limit";

type ExceptionCenterItem = {
  type: ExceptionCenterType;
  severity: "info" | "warn" | "critical";
  title: string;
  customerId?: string;
  customerName?: string;
  salesOrderId?: string;
  orderNo?: string;
  assignmentId?: string;
  productId?: string;
  productName?: string;
  driverId?: string;
  driverName?: string;
  amount?: string;
  expectedAmount?: string;
  collectedAmount?: string;
  variance?: string;
  qty?: number;
  qtyOnHand?: number;
  threshold?: number;
  dueDate?: string | null;
  overdueDays?: number;
  reportedAt?: string | null;
  assignmentDate?: string | null;
  deepLink?: string;
};

/** 異常中心：聚合 AR／庫存／配送／月結／預付／押桶等異常 */
app.get("/api/reports/exception-center", async (req, res) => {
  try {
    const prepaidLowThreshold = Math.max(
      0,
      Number(typeof req.query.prepaidLowThreshold === "string" ? req.query.prepaidLowThreshold : 2) || 2,
    );
    const depositStaleDays = Math.max(
      1,
      Number(typeof req.query.depositStaleDays === "string" ? req.query.depositStaleDays : 90) || 90,
    );
    const summaryOnly =
      req.query.summaryOnly === "1" ||
      req.query.summaryOnly === "true" ||
      req.query.summaryOnly === "yes";
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const staleSettlementBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const depositStaleBefore = new Date(dayStart.getTime() - depositStaleDays * 24 * 60 * 60 * 1000);

    if (summaryOnly) {
      const [
        arPastDue,
        cashShort,
        cashOver,
        deliveredUnpaid,
        pendingSettlementStale,
        assignedUnreported,
        monthlyUnbilled,
        prepaidLowCust,
        prepaidLowProd,
        inventoryNegative,
        creditCustomers,
      ] = await Promise.all([
        prisma.arOpenItem.count({
          where: activeArOpenItemWhere({ dueDate: { lt: dayStart } }),
        }),
        prisma.deliveryAssignment.count({
          where: {
            OR: [
              { status: "pending_settlement", settlementOutcome: "delivered_cash_short" },
              {
                status: "completed",
                settlementOutcome: "delivered_cash_short",
                officeSettledAt: { gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
              },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            OR: [
              { status: "pending_settlement", settlementOutcome: "delivered_cash_over" },
              {
                status: "completed",
                settlementOutcome: "delivered_cash_over",
                officeSettledAt: { gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
              },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            OR: [
              { status: "pending_settlement", settlementOutcome: "delivered_no_cash" },
              {
                status: "completed",
                settlementOutcome: "delivered_no_cash",
                officeSettledAt: { gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
              },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            status: "pending_settlement",
            driverReportedAt: { lt: staleSettlementBefore },
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            status: { in: ["assigned", "delivering"] },
            driverReportedAt: null,
            assignmentDate: { lt: dayStart },
          },
        }),
        prisma.salesOrder.count({
          where: {
            status: "completed",
            officeSettledAt: { not: null },
            billingStatementOrder: { is: null },
            OR: [
              { monthlySubtotal: { gt: 0 } },
              { billingTypeAtOrder: "monthly" },
              { lines: { some: { billingTypeAtLine: "monthly" } } },
            ],
          },
        }),
        prisma.customer.count({
          where: {
            billingType: "prepaid",
            prepaidBarrelBalance: { lte: prepaidLowThreshold },
            lifecycleStatus: "active",
          },
        }),
        prisma.customerPrepaidProductBalance.count({
          where: {
            balanceBarrels: { lte: prepaidLowThreshold },
            customer: { lifecycleStatus: "active" },
          },
        }),
        prisma.inventoryBalance.count({ where: { qtyOnHand: { lt: 0 } } }),
        prisma.customer.findMany({
          where: {
            creditLimit: { gt: new Prisma.Decimal(0) },
            arOpenItems: { some: { outstandingAmount: { gt: new Prisma.Decimal(0) } } },
          },
          include: {
            arOpenItems: {
              where: {
                outstandingAmount: { gt: new Prisma.Decimal(0) },
                arDocument: { status: { not: "voided" } },
                OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }],
              },
              select: { outstandingAmount: true },
            },
          },
          take: 500,
        }),
      ]);

      const creditOverLimit = creditCustomers.filter((c) => {
        const outstanding = c.arOpenItems.reduce((s, i) => s + Number(i.outstandingAmount), 0);
        return outstanding > Number(c.creditLimit);
      }).length;

      // 押桶「長期未收」需逐址對最後配送日，summaryOnly 不估算（避免上界膨脹）；詳見完整清單
      const summary = {
        ar_past_due: arPastDue,
        cash_short: cashShort,
        cash_over: cashOver,
        delivered_unpaid: deliveredUnpaid,
        pending_settlement_stale: pendingSettlementStale,
        assigned_unreported: assignedUnreported,
        monthly_delivered_unbilled: monthlyUnbilled,
        prepaid_low: prepaidLowCust + prepaidLowProd,
        inventory_negative: inventoryNegative,
        deposit_barrels_stale: 0,
        credit_over_limit: creditOverLimit,
      } as Record<ExceptionCenterType, number>;
      const totalCount = Object.values(summary).reduce((a, b) => a + b, 0);
      res.json({
        ok: true,
        data: {
          generatedAt: now.toISOString(),
          prepaidLowThreshold,
          depositStaleDays,
          totalCount,
          summary,
          items: [],
          summaryOnly: true,
        },
      });
      return;
    }

    const items: ExceptionCenterItem[] = [];

    const [
      pastDueAr,
      cashVarianceAssignments,
      stalePending,
      assignedUnreported,
      monthlyUnbilled,
      prepaidCustomers,
      prepaidProductBalances,
      negativeInventory,
      depositAddresses,
      creditCustomers,
    ] = await Promise.all([
      prisma.arOpenItem.findMany({
        where: activeArOpenItemWhere({
          dueDate: { lt: dayStart },
        }),
        include: { customer: true, salesOrder: true, arDocument: true },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        take: 300,
      }),
      prisma.deliveryAssignment.findMany({
        where: {
          OR: [
            {
              status: "pending_settlement",
              settlementOutcome: { in: ["delivered_no_cash", "delivered_cash_short", "delivered_cash_over"] },
            },
            {
              status: "completed",
              settlementOutcome: { in: ["delivered_cash_short", "delivered_cash_over", "delivered_no_cash"] },
              officeSettledAt: { gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
            },
          ],
        },
        include: {
          salesOrder: { include: { customer: true } },
          driver: { include: { user: true } },
        },
        orderBy: { id: "desc" },
        take: 300,
      }),
      prisma.deliveryAssignment.findMany({
        where: {
          status: "pending_settlement",
          driverReportedAt: { lt: staleSettlementBefore },
        },
        include: {
          salesOrder: { include: { customer: true } },
          driver: { include: { user: true } },
        },
        orderBy: { driverReportedAt: "asc" },
        take: 200,
      }),
      prisma.deliveryAssignment.findMany({
        where: {
          status: { in: ["assigned", "delivering"] },
          driverReportedAt: null,
          assignmentDate: { lt: dayStart },
        },
        include: {
          salesOrder: { include: { customer: true } },
          driver: { include: { user: true } },
        },
        orderBy: { assignmentDate: "asc" },
        take: 200,
      }),
      prisma.salesOrder.findMany({
        where: {
          status: "completed",
          officeSettledAt: { not: null },
          billingStatementOrder: { is: null },
          OR: [
            { monthlySubtotal: { gt: 0 } },
            { billingTypeAtOrder: "monthly" },
            { lines: { some: { billingTypeAtLine: "monthly" } } },
          ],
        },
        include: {
          customer: true,
          lines: { select: { billingTypeAtLine: true, lineAmount: true, linePurpose: true } },
          assignments: {
            where: { status: { in: ["completed", "not_delivered"] } },
            orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
            take: 1,
          },
        },
        orderBy: { officeSettledAt: "asc" },
        take: 300,
      }),
      prisma.customer.findMany({
        where: {
          billingType: "prepaid",
          prepaidBarrelBalance: { lte: prepaidLowThreshold },
          lifecycleStatus: "active",
        },
        select: {
          id: true,
          name: true,
          prepaidBarrelBalance: true,
          allowPrepaidOverdraft: true,
        },
        take: 200,
      }),
      prisma.customerPrepaidProductBalance.findMany({
        where: { balanceBarrels: { lte: prepaidLowThreshold } },
        include: {
          customer: { select: { id: true, name: true, lifecycleStatus: true, billingType: true } },
          product: { select: { id: true, name: true, productCode: true } },
        },
        take: 200,
      }),
      prisma.inventoryBalance.findMany({
        where: { qtyOnHand: { lt: 0 } },
        include: {
          product: { select: { id: true, name: true, productCode: true } },
        },
        orderBy: { qtyOnHand: "asc" },
        take: 100,
      }),
      prisma.deliveryAddress.findMany({
        where: { barrelsOnSite: { gt: 0 } },
        include: {
          customer: { select: { id: true, name: true, lifecycleStatus: true } },
        },
        take: 400,
      }),
      prisma.customer.findMany({
        where: {
          creditLimit: { gt: new Prisma.Decimal(0) },
          arOpenItems: { some: { outstandingAmount: { gt: new Prisma.Decimal(0) } } },
        },
        include: {
          arOpenItems: {
            where: {
              outstandingAmount: { gt: new Prisma.Decimal(0) },
              arDocument: { status: { not: "voided" } },
              OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }],
            },
            select: { outstandingAmount: true },
          },
        },
        take: 300,
      }),
    ]);

    for (const i of pastDueAr) {
      const due = i.dueDate ? new Date(i.dueDate) : null;
      const overdueDays = due
        ? Math.max(0, Math.floor((dayStart.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)))
        : 0;
      items.push({
        type: "ar_past_due",
        severity: overdueDays >= 60 ? "critical" : "warn",
        title: `AR 逾期 ${overdueDays} 天`,
        customerId: i.customerId.toString(),
        customerName: i.customer.name,
        salesOrderId: i.salesOrderId?.toString(),
        orderNo: i.salesOrder?.orderNo ?? i.arDocument.arNo,
        amount: i.outstandingAmount.toString(),
        dueDate: i.dueDate ? toLocalYmd(new Date(i.dueDate)) : null,
        overdueDays,
        deepLink: `/reports/billing-ar?customerId=${i.customerId.toString()}`,
      });
    }

    for (const a of cashVarianceAssignments) {
      const outcome = a.settlementOutcome ?? "";
      const expected = Number(a.expectedAmount ?? 0);
      const collected = Number(a.cashReceived ?? 0) + Number(a.checkReceived ?? 0);
      const variance = collected - expected;
      const driverName = a.driver.user?.name ?? a.driver.employeeCode ?? undefined;
      const base = {
        customerId: a.salesOrder.customerId.toString(),
        customerName: a.salesOrder.customer.name,
        salesOrderId: a.salesOrderId.toString(),
        orderNo: a.salesOrder.orderNo,
        assignmentId: a.id.toString(),
        driverId: a.driverId.toString(),
        driverName,
        expectedAmount: String(a.expectedAmount ?? 0),
        collectedAmount: String(collected),
        variance: String(variance),
        reportedAt: a.driverReportedAt?.toISOString() ?? null,
        assignmentDate: a.assignmentDate ? toLocalYmd(new Date(a.assignmentDate)) : null,
        deepLink: a.status === "pending_settlement"
          ? `/orders/complete?orderNo=${encodeURIComponent(a.salesOrder.orderNo)}`
          : `/orders/query?orderNo=${encodeURIComponent(a.salesOrder.orderNo)}`,
      };
      if (outcome === "delivered_cash_short") {
        items.push({ ...base, type: "cash_short", severity: "warn", title: "配送短收" });
      } else if (outcome === "delivered_cash_over") {
        items.push({ ...base, type: "cash_over", severity: "info", title: "配送溢收" });
      } else if (outcome === "delivered_no_cash" && expected > 0) {
        items.push({ ...base, type: "delivered_unpaid", severity: "critical", title: "已送達未收款" });
      }
    }

    for (const a of stalePending) {
      items.push({
        type: "pending_settlement_stale",
        severity: "warn",
        title: "待核銷超過 1 天",
        customerId: a.salesOrder.customerId.toString(),
        customerName: a.salesOrder.customer.name,
        salesOrderId: a.salesOrderId.toString(),
        orderNo: a.salesOrder.orderNo,
        assignmentId: a.id.toString(),
        driverId: a.driverId.toString(),
        driverName: a.driver.user?.name ?? a.driver.employeeCode ?? undefined,
        reportedAt: a.driverReportedAt?.toISOString() ?? null,
        assignmentDate: a.assignmentDate ? toLocalYmd(new Date(a.assignmentDate)) : null,
        deepLink: `/orders/complete?orderNo=${encodeURIComponent(a.salesOrder.orderNo)}`,
      });
    }

    for (const a of assignedUnreported) {
      items.push({
        type: "assigned_unreported",
        severity: "warn",
        title: "已分派未回報（逾配送日）",
        customerId: a.salesOrder.customerId.toString(),
        customerName: a.salesOrder.customer.name,
        salesOrderId: a.salesOrderId.toString(),
        orderNo: a.salesOrder.orderNo,
        assignmentId: a.id.toString(),
        driverId: a.driverId.toString(),
        driverName: a.driver.user?.name ?? a.driver.employeeCode ?? undefined,
        assignmentDate: a.assignmentDate ? toLocalYmd(new Date(a.assignmentDate)) : null,
        deepLink: `/orders/assign?orderNo=${encodeURIComponent(a.salesOrder.orderNo)}`,
      });
    }

    for (const o of monthlyUnbilled) {
      if (!orderHasMonthlyPortion(o)) continue;
      const cap = orderMonthlyCap(o);
      const received = new Prisma.Decimal(String(o.monthlyReceivedAmount ?? 0));
      const outstanding = cap.minus(received);
      if (outstanding.lessThanOrEqualTo(0)) continue;
      const a = o.assignments?.[0];
      items.push({
        type: "monthly_delivered_unbilled",
        severity: "info",
        title: "月結已送達尚未開帳單",
        customerId: o.customerId.toString(),
        customerName: o.customer.name,
        salesOrderId: o.id.toString(),
        orderNo: o.orderNo,
        amount: outstanding.toString(),
        assignmentDate: a?.driverReportedAt
          ? toLocalYmd(new Date(a.driverReportedAt))
          : a?.assignmentDate
            ? toLocalYmd(new Date(a.assignmentDate))
            : null,
        deepLink: `/reports/billing-ar?customerId=${o.customerId.toString()}`,
      });
    }

    for (const c of prepaidCustomers) {
      items.push({
        type: "prepaid_low",
        severity: c.prepaidBarrelBalance <= 0 && !c.allowPrepaidOverdraft ? "critical" : "warn",
        title: "預付桶低水位（客戶總餘額）",
        customerId: c.id.toString(),
        customerName: c.name,
        qty: c.prepaidBarrelBalance,
        threshold: prepaidLowThreshold,
        deepLink: `/data/customers?customerId=${c.id.toString()}`,
      });
    }
    for (const row of prepaidProductBalances) {
      if (row.customer.lifecycleStatus !== "active") continue;
      items.push({
        type: "prepaid_low",
        severity: row.balanceBarrels <= 0 ? "critical" : "warn",
        title: `預付桶低水位（${row.product.name}）`,
        customerId: row.customer.id.toString(),
        customerName: row.customer.name,
        productId: row.product.id.toString(),
        productName: row.product.name,
        qty: row.balanceBarrels,
        threshold: prepaidLowThreshold,
        deepLink: `/data/customers?customerId=${row.customer.id.toString()}`,
      });
    }

    for (const r of negativeInventory) {
      items.push({
        type: "inventory_negative",
        severity: "critical",
        title: "負庫存",
        productId: r.productId.toString(),
        productName: r.product.name,
        qtyOnHand: r.qtyOnHand,
        deepLink: "/data/products",
      });
    }

    const depositAddressIds = depositAddresses.map((a) => a.id);
    const lastDeliveries =
      depositAddressIds.length > 0
        ? await prisma.deliveryAssignment.findMany({
            where: {
              status: "completed",
              salesOrder: { deliveryAddressId: { in: depositAddressIds } },
            },
            include: { salesOrder: { select: { deliveryAddressId: true } } },
            orderBy: { completedAt: "desc" },
            take: 2000,
          })
        : [];
    const lastDeliveryByAddress = new Map<string, Date>();
    for (const d of lastDeliveries) {
      const addrId = d.salesOrder.deliveryAddressId.toString();
      if (lastDeliveryByAddress.has(addrId)) continue;
      if (d.completedAt) lastDeliveryByAddress.set(addrId, d.completedAt);
    }
    for (const addr of depositAddresses) {
      if (addr.customer.lifecycleStatus !== "active") continue;
      const last = lastDeliveryByAddress.get(addr.id.toString());
      if (last && last.getTime() >= depositStaleBefore.getTime()) continue;
      items.push({
        type: "deposit_barrels_stale",
        severity: "info",
        title: `押桶長期未收（在場 ${addr.barrelsOnSite} 桶）`,
        customerId: addr.customer.id.toString(),
        customerName: addr.customer.name,
        qty: addr.barrelsOnSite,
        threshold: depositStaleDays,
        assignmentDate: last ? toLocalYmd(last) : null,
        deepLink: "/orders/barrel-pickup/new",
      });
    }

    for (const c of creditCustomers) {
      const outstanding = c.arOpenItems.reduce((s, i) => s + Number(i.outstandingAmount), 0);
      const limit = Number(c.creditLimit);
      if (outstanding <= limit) continue;
      items.push({
        type: "credit_over_limit",
        severity: "critical",
        title: "超過信用額度",
        customerId: c.id.toString(),
        customerName: c.name,
        amount: String(outstanding),
        expectedAmount: c.creditLimit.toString(),
        variance: String(outstanding - limit),
        deepLink: `/reports/billing-ar?customerId=${c.id.toString()}`,
      });
    }

    const summary = {} as Record<ExceptionCenterType, number>;
    const allTypes: ExceptionCenterType[] = [
      "ar_past_due",
      "cash_short",
      "cash_over",
      "delivered_unpaid",
      "pending_settlement_stale",
      "assigned_unreported",
      "monthly_delivered_unbilled",
      "prepaid_low",
      "inventory_negative",
      "deposit_barrels_stale",
      "credit_over_limit",
    ];
    for (const t of allTypes) summary[t] = 0;
    for (const it of items) summary[it.type] += 1;

    res.json({
      ok: true,
      data: {
        generatedAt: now.toISOString(),
        prepaidLowThreshold,
        depositStaleDays,
        totalCount: items.length,
        summary,
        items,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/reports/driver-cash-close", async (req, res) => {
  try {
    const ymd = typeof req.query.date === "string" ? req.query.date.trim() : toLocalYmd(new Date());
    const parsed = parseLocalYmdRange(ymd);
    if (!parsed) {
      res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
      return;
    }
    const [assignments, vouchers] = await Promise.all([
      prisma.deliveryAssignment.findMany({
        where: {
          assignmentDate: { gte: parsed.start, lt: parsed.end },
          settlementOutcome: { in: ["delivered_cash_exact", "delivered_cash_short", "delivered_cash_over", "delivered_no_cash"] },
        },
        include: {
          salesOrder: { include: { customer: true } },
          driver: { include: { user: true } },
        },
      }),
      prisma.receiptVoucher.findMany({
        where: { paymentMethod: "cash", paidAt: { gte: parsed.start, lt: parsed.end } },
      }),
    ]);
    const expected = assignments.reduce((s, a) => s + Number(a.expectedAmount ?? 0), 0);
    const collected = assignments.reduce((s, a) => s + Number(a.cashReceived ?? 0), 0);
    const recordedCash = vouchers.reduce((s, v) => s + Number(v.totalAmount), 0);
    res.json({
      ok: true,
      data: {
        date: ymd,
        expectedCash: expected,
        driverCollectedCash: collected,
        cashierRecordedCash: recordedCash,
        varianceDriverVsExpected: collected - expected,
        varianceCashierVsDriver: recordedCash - collected,
        rows: assignments.map((a) => ({
          assignmentId: a.id.toString(),
          driver: a.driver.user?.name ?? a.driver.employeeCode,
          orderNo: a.salesOrder.orderNo,
          customer: a.salesOrder.customer.name,
          expectedAmount: String(a.expectedAmount ?? 0),
          cashReceived: String(a.cashReceived ?? 0),
          settlementOutcome: a.settlementOutcome,
        })),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 開立月結結帳批次：彙總未稅月結應收（AR）、並產生整期發票資料（策略 A：稅額於本期加總後計） */
app.post("/api/billing/statements/post", async (req, res) => {
  try {
    const body = req.body as {
      customerId?: unknown;
      cutoffDate?: unknown;
      salesOrderIds?: unknown;
      taxRate?: unknown;
      invoiceMode?: unknown;
    };
    const customerId = toBigInt(body.customerId);
    const cutoffDate = typeof body.cutoffDate === "string" ? body.cutoffDate.trim() : "";
    if (!customerId || !cutoffDate) {
      res.status(400).json({ ok: false, message: "customerId 與 cutoffDate 必填" });
      return;
    }
    const cutoffDayStart = cutoffDateStartLocal(cutoffDate);
    const deliveryUpper = cutoffInclusiveDeliveryUpperBound(cutoffDate);
    if (!cutoffDayStart || !deliveryUpper) {
      res.status(400).json({ ok: false, message: "cutoffDate 須為 YYYY-MM-DD" });
      return;
    }

    let explicitIds: bigint[] | undefined;
    if (Array.isArray(body.salesOrderIds) && body.salesOrderIds.length > 0) {
      const parsed = body.salesOrderIds.map((x) => toBigInt(x)).filter((x): x is bigint => x != null);
      explicitIds = [...new Set(parsed.map((x) => x.toString()))].map((s) => BigInt(s));
      if (explicitIds.length === 0) {
        res.status(400).json({ ok: false, message: "salesOrderIds 無有效訂單 ID" });
        return;
      }
    }

    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    const baseEligible = await fetchMonthlyOrdersEligibleForStatement(customerId, cutoffDate);
    let eligible = baseEligible;
    if (explicitIds && explicitIds.length > 0) {
      const pick = new Set(explicitIds);
      eligible = baseEligible.filter((o) => pick.has(o.id));
      if (eligible.length !== explicitIds.length) {
        res.status(400).json({
          ok: false,
          message: "部分訂單無法納入（可能未配送完成、已立批次、截止日不符或不含月結份額）",
        });
        return;
      }
    }

    if (eligible.length === 0) {
      res.status(400).json({ ok: false, message: "沒有可納入本期結帳的月結訂單" });
      return;
    }

    const invoiceMode = normalizeStatementInvoiceMode(body.invoiceMode);
    const taxRateRaw = Number(body.taxRate ?? NaN);
    const taxRate =
      Number.isFinite(taxRateRaw) && taxRateRaw >= 0 ? new Prisma.Decimal(String(taxRateRaw)) : DEFAULT_VAT_RATE;

    let untaxedTotal = new Prisma.Decimal(0);
    const linesPayload = eligible.map((o) => {
      const cap = orderMonthlyCap(o);
      untaxedTotal = untaxedTotal.add(cap);
      return { salesOrderId: o.id, monthlyUntaxedAmount: cap };
    });

    /**
     * 發票與 AR 應收口徑：
     * - tax_exclusive：訂單月結為未稅，稅外加 → AR／發票總額 = 未稅＋稅
     * - tax_inclusive：訂單月結為含稅售價總額 → AR = 含稅總額；發票拆未稅／稅
     * - none：不開發票 → AR = 訂單月結金額
     */
    let taxAmount = new Prisma.Decimal(0);
    let invoiceUntaxed = untaxedTotal;
    let totalWithTax = untaxedTotal;
    let arAmount = untaxedTotal;
    if (invoiceMode === "tax_exclusive") {
      const c = computeTaxFromUntaxed(untaxedTotal, taxRate);
      taxAmount = c.taxAmount;
      totalWithTax = c.totalWithTax;
      arAmount = c.totalWithTax;
      invoiceUntaxed = untaxedTotal;
    } else if (invoiceMode === "tax_inclusive") {
      const br = breakdownCashTaxInvoice(untaxedTotal, "tax_inclusive", taxRate);
      if (br) {
        taxAmount = br.taxAmount;
        invoiceUntaxed = br.untaxedAmount;
        totalWithTax = br.totalWithTax;
        arAmount = br.totalWithTax;
      }
    }

    const dueDate = computeMonthlyDueDate(cust.monthlySettlementDay, new Date());
    const cutoffDbDate = cutoffDateToDbDate(cutoffDate);
    if (!cutoffDbDate) {
      res.status(400).json({ ok: false, message: "cutoffDate 須為 YYYY-MM-DD" });
      return;
    }

    const postedBundle = await prisma.$transaction(async (tx) => {
      const stmt = await tx.billingStatement.create({
        data: {
          statementNo: generateStatementNo(),
          customerId,
          status: "posted",
          cutoffDate: cutoffDbDate,
          untaxedTotal: invoiceUntaxed,
          taxAmount,
          totalWithTax,
          taxRate,
          invoiceMode,
          postedAt: new Date(),
        },
      });

      await tx.billingStatementOrder.createMany({
        data: linesPayload.map((x) => ({
          billingStatementId: stmt.id,
          salesOrderId: x.salesOrderId,
          monthlyUntaxedAmount: x.monthlyUntaxedAmount,
        })),
      });

      const ar = await tx.arDocument.create({
        data: {
          arNo: generateArNo(),
          customerId,
          salesOrderId: null,
          billingStatementId: stmt.id,
          documentType: "delivery",
          billingType: "monthly",
          documentAmount: arAmount,
          dueDate,
          status: "open",
          postedAt: new Date(),
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });
      await tx.arOpenItem.create({
        data: {
          arDocumentId: ar.id,
          customerId,
          salesOrderId: null,
          originalAmount: arAmount,
          allocatedAmount: new Prisma.Decimal(0),
          outstandingAmount: arAmount,
          dueDate,
          expectedCollectDate: dueDate,
          status: arStatusFromOutstanding(arAmount, dueDate),
        },
      });

      const orderNos = eligible.map((o) => o.orderNo).join("、");
      await tx.customerLedgerEntry.create({
        data: {
          customerId,
          entryType: "statement_monthly_ar",
          amount: arAmount,
          salesOrderId: null,
          sourceType: "billing_statement",
          sourceId: stmt.id,
          note: `月結批次立帳 ${stmt.statementNo}（應收 ${arAmount.toString()}／未稅合計 ${invoiceUntaxed.toString()}）：${orderNos}`,
          createdByUserId: DEFAULT_CREATOR_USER_ID,
        },
      });

      const taxInvoice =
        invoiceMode !== "none"
          ? await createTaxInvoicePlanned(tx, {
              customerId,
              basisType: "billing_statement",
              billingStatementId: stmt.id,
              invoiceMode,
              untaxedAmount: invoiceUntaxed,
              taxAmount,
              totalAmount: totalWithTax,
              taxRate,
            })
          : null;

      const full = await tx.billingStatement.findUnique({
        where: { id: stmt.id },
        include: {
          orders: { include: { salesOrder: { select: { id: true, orderNo: true } } } },
          taxInvoices: true,
          arDocuments: { include: { openItems: true } },
        },
      });
      return { billingStatement: full, taxInvoice };
    });

    res.status(201).json({ ok: true, data: postedBundle });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

const taxInvoiceInclude = {
  customer: { select: { id: true, name: true, taxId: true } },
  salesOrder: { select: { id: true, orderNo: true } },
  billingStatement: { select: { id: true, statementNo: true } },
  receiptVoucher: { select: { id: true, voucherNo: true } },
} satisfies Prisma.TaxInvoiceInclude;

function serializeTaxInvoice(
  ti: Prisma.TaxInvoiceGetPayload<{ include: typeof taxInvoiceInclude }>,
) {
  return {
    id: ti.id.toString(),
    invoiceNo: ti.invoiceNo,
    externalInvoiceNo: ti.externalInvoiceNo,
    customerId: ti.customerId.toString(),
    customerName: ti.customer?.name ?? null,
    basisType: ti.basisType,
    salesOrderId: ti.salesOrderId?.toString() ?? null,
    salesOrderNo: ti.salesOrder?.orderNo ?? null,
    billingStatementId: ti.billingStatementId?.toString() ?? null,
    billingStatementNo: ti.billingStatement?.statementNo ?? null,
    receiptVoucherId: ti.receiptVoucherId?.toString() ?? null,
    receiptVoucherNo: ti.receiptVoucher?.voucherNo ?? null,
    invoiceMode: ti.invoiceMode,
    untaxedAmount: ti.untaxedAmount.toString(),
    taxAmount: ti.taxAmount.toString(),
    totalAmount: ti.totalAmount.toString(),
    taxRate: ti.taxRate.toString(),
    status: ti.status,
    buyerTaxId: ti.buyerTaxId,
    buyerName: ti.buyerName,
    note: ti.note,
    issuedAt: ti.issuedAt.toISOString(),
    createdAt: ti.createdAt.toISOString(),
  };
}

/** 發票查詢：依日期、客戶、狀態、來源類型篩選 */
app.get("/api/tax-invoices", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const basisTypeParam = typeof req.query.basisType === "string" ? req.query.basisType.trim() : "";
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const salesOrderId = toBigInt(req.query.salesOrderId);
    const billingStatementId = toBigInt(req.query.billingStatementId);

    const where: Prisma.TaxInvoiceWhereInput = {};
    if (customerId) where.customerId = customerId;
    if (statusParam === "planned" || statusParam === "issued" || statusParam === "voided") {
      where.status = statusParam;
    }
    if (basisTypeParam === "sales_order" || basisTypeParam === "billing_statement" || basisTypeParam === "prepayment_topup") {
      where.basisType = basisTypeParam;
    }
    if (salesOrderId) where.salesOrderId = salesOrderId;
    if (billingStatementId) where.billingStatementId = billingStatementId;
    if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.createdAt = range;
    }
    if (q) {
      where.OR = [
        { invoiceNo: { contains: q } },
        { externalInvoiceNo: { contains: q } },
        { buyerName: { contains: q } },
        { buyerTaxId: { contains: q } },
        { customer: { name: { contains: q } } },
        { salesOrder: { orderNo: { contains: q } } },
        { billingStatement: { statementNo: { contains: q } } },
        { receiptVoucher: { voucherNo: { contains: q } } },
      ];
    }

    const rows = await prisma.taxInvoice.findMany({
      where,
      include: taxInvoiceInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 500,
    });
    res.json({ ok: true, data: rows.map(serializeTaxInvoice) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 補登實際發票號碼／更新發票紀錄 */
app.patch("/api/tax-invoices/:id", async (req, res) => {
  try {
    const id = toBigInt(req.params.id);
    if (!id) {
      res.status(400).json({ ok: false, message: "參數錯誤：id" });
      return;
    }
    const body = req.body as {
      externalInvoiceNo?: unknown;
      note?: unknown;
      buyerTaxId?: unknown;
      buyerName?: unknown;
      status?: unknown;
    };
    const existing = await prisma.taxInvoice.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到發票紀錄" });
      return;
    }
    if (existing.status === "voided") {
      res.status(400).json({ ok: false, message: "已作廢的發票不可修改" });
      return;
    }

    const patch: Prisma.TaxInvoiceUpdateInput = {};
    if (typeof body.externalInvoiceNo === "string") {
      const ext = body.externalInvoiceNo.trim();
      patch.externalInvoiceNo = ext || null;
      if (ext) {
        patch.status = "issued";
        patch.issuedAt = new Date();
      }
    }
    if (typeof body.note === "string") patch.note = body.note.trim() || null;
    if (typeof body.buyerTaxId === "string") patch.buyerTaxId = body.buyerTaxId.trim() || null;
    if (typeof body.buyerName === "string") patch.buyerName = body.buyerName.trim() || null;
    if (body.status === "voided") {
      patch.status = "voided";
    } else if (body.status === "planned" && existing.status !== "issued") {
      patch.status = "planned";
      patch.externalInvoiceNo = null;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ ok: false, message: "無有效更新欄位" });
      return;
    }

    if (patch.externalInvoiceNo && typeof patch.externalInvoiceNo === "string") {
      const dup = await prisma.taxInvoice.findFirst({
        where: {
          externalInvoiceNo: patch.externalInvoiceNo,
          id: { not: id },
          status: { not: "voided" },
        },
      });
      if (dup) {
        res.status(400).json({ ok: false, message: "此發票號碼已被其他紀錄使用" });
        return;
      }
    }

    const updated = await prisma.taxInvoice.update({
      where: { id },
      data: patch,
      include: taxInvoiceInclude,
    });
    res.json({ ok: true, data: serializeTaxInvoice(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 對帳清單：含「待開立批次」之訂單（尚無月結 AR）＋舊制逐單月結之未沖銷 AR */
app.get("/api/billing/statements", async (req, res) => {
  try {
    const customerId = toBigInt(req.query.customerId);
    const cutoffDate = typeof req.query.cutoffDate === "string" ? req.query.cutoffDate.trim() : "";
    if (!customerId || !cutoffDate) {
      res.status(400).json({ ok: false, message: "customerId 與 cutoffDate 必填" });
      return;
    }
    const cutoffDayStart = cutoffDateStartLocal(cutoffDate);
    const deliveryUpper = cutoffInclusiveDeliveryUpperBound(cutoffDate);
    if (!cutoffDayStart || !deliveryUpper) {
      res.status(400).json({ ok: false, message: "cutoffDate 須為 YYYY-MM-DD" });
      return;
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      res.status(404).json({ ok: false, message: "找不到客戶" });
      return;
    }

    /** 對帳清單商品列：僅月結列（與尚欠／本期月結未稅一致；混單不列現金／預付列） */
    const monthlyStatementLines = (
      lines: Array<{ billingTypeAtLine: string | null; unitPrice: Prisma.Decimal; qtyOrdered: number; lineAmount: Prisma.Decimal; product: { name: string | null } | null }>,
    ) =>
      lines
        .filter((l) => (l.billingTypeAtLine ?? "").toLowerCase() === "monthly")
        .map((l) => ({
          productName: l.product?.name ?? "—",
          unitPrice: l.unitPrice.toString(),
          qty: l.qtyOrdered,
          subtotal: l.lineAmount.toString(),
        }));

    const pendingOrders = await fetchMonthlyOrdersEligibleForStatement(customerId, cutoffDate);
    let pendingUntaxed = new Prisma.Decimal(0);
    const pendingRows = pendingOrders.map((so) => {
      const cap = orderMonthlyCap(so);
      pendingUntaxed = pendingUntaxed.add(cap);
      const a = so.assignments?.[0];
      const d = a?.driverReportedAt ?? a?.assignmentDate ?? so.scheduledDeliveryDate ?? null;
      return {
        rowKind: "pending_statement",
        openItemId: null as string | null,
        salesOrderId: so.id.toString(),
        arNo: "—（待開立批次）",
        orderNo: so.orderNo,
        actualDeliveryDate: d ? toLocalYmd(new Date(d)) : null,
        dueDate: null as string | null,
        status: "pending_post",
        originalAmount: cap.toString(),
        allocatedAmount: "0",
        outstandingAmount: cap.toString(),
        lineItems: monthlyStatementLines(so.lines),
      };
    });

    const opens = await prisma.arOpenItem.findMany({
      where: {
        customerId,
        outstandingAmount: { gt: new Prisma.Decimal(0) },
        arDocument: { billingType: "monthly" },
      },
      include: {
        arDocument: true,
        salesOrder: {
          include: {
            customer: true,
            lines: {
              include: { product: true },
              orderBy: { id: "asc" },
            },
            assignments: {
              where: { status: { in: ["completed", "not_delivered"] } },
              orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
              take: 1,
            },
          },
        },
        allocations: { include: { receiptVoucher: true } },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });
    const filteredLegacy = opens.filter((o) => {
      const so = o.salesOrder;
      if (!so || so.status !== "completed") return false;
      if (!orderHasMonthlyPortion(so)) return false;
      const t = actualDeliveryInstant(so);
      return t != null && t.getTime() < deliveryUpper.getTime();
    });
    const legacyRows = filteredLegacy.map((o) => ({
      rowKind: "legacy_monthly_ar",
      openItemId: o.id.toString(),
      salesOrderId: o.salesOrderId?.toString() ?? null,
      arNo: o.arDocument.arNo,
      orderNo: o.salesOrder?.orderNo ?? null,
      actualDeliveryDate: (() => {
        const a = o.salesOrder?.assignments?.[0];
        const d = a?.driverReportedAt ?? a?.assignmentDate ?? o.salesOrder?.scheduledDeliveryDate ?? null;
        return d ? toLocalYmd(new Date(d)) : null;
      })(),
      dueDate: o.dueDate ? toLocalYmd(new Date(o.dueDate)) : null,
      status: o.status,
      originalAmount: o.originalAmount.toString(),
      allocatedAmount: o.allocatedAmount.toString(),
      outstandingAmount: o.outstandingAmount.toString(),
      lineItems: monthlyStatementLines(o.salesOrder?.lines ?? []),
    }));

    const legacyOutstanding = filteredLegacy.reduce((s, o) => s.add(new Prisma.Decimal(o.outstandingAmount)), new Prisma.Decimal(0));
    const legacyOriginal = filteredLegacy.reduce((s, o) => s.add(new Prisma.Decimal(o.originalAmount)), new Prisma.Decimal(0));

    const totalOriginalNum = Number(pendingUntaxed.add(legacyOriginal));
    const totalOutstandingNum = Number(pendingUntaxed.add(legacyOutstanding));

    res.json({
      ok: true,
      data: {
        customer: { id: customer.id.toString(), name: customer.name },
        cutoffDate,
        cutoffStartsAtLocal: cutoffDayStart.toISOString(),
        deliveryUpperBoundExclusiveLocal: deliveryUpper.toISOString(),
        generatedAt: new Date().toISOString(),
        pendingUntaxedTotal: pendingUntaxed.toFixed(2),
        legacyOutstandingTotal: legacyOutstanding.toFixed(2),
        totalOriginal: totalOriginalNum.toFixed(2),
        totalOutstanding: totalOutstandingNum.toFixed(2),
        rows: [...pendingRows, ...legacyRows],
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 空桶回收統一查詢（純收空桶任務 + 配送順便回收） */
app.get("/api/barrel-collections", async (req, res) => {
  try {
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const sourceParam = typeof req.query.source === "string" ? req.query.source.trim().toLowerCase() : "all";
    const customerId = toBigInt(req.query.customerId);
    const deliveryAddressId = toBigInt(req.query.deliveryAddressId);

    const includePickup = sourceParam === "all" || sourceParam === "pickup";
    const includeDelivery = sourceParam === "all" || sourceParam === "delivery";

    const pickupWhere: Prisma.BarrelPickupWhereInput = {};
    if (statusParam) {
      pickupWhere.status = statusParam;
    } else {
      pickupWhere.status = { in: ["assigned", "pending_settlement", "completed", "cancelled"] };
    }
    if (customerId) pickupWhere.customerId = customerId;
    if (deliveryAddressId) pickupWhere.deliveryAddressId = deliveryAddressId;

    const deliveryWhere: Prisma.DeliveryAssignmentWhereInput = {
      emptyBarrelsReturned: { gt: 0 },
      NOT: { settlementOutcome: "not_delivered" },
    };
    if (statusParam === "assigned") {
      deliveryWhere.status = { in: ["assigned", "delivering"] };
    } else if (statusParam) {
      deliveryWhere.status = statusParam;
    } else {
      deliveryWhere.status = { in: ["pending_settlement", "completed"] };
    }
    if (customerId || deliveryAddressId) {
      deliveryWhere.salesOrder = {};
      if (customerId) deliveryWhere.salesOrder.customerId = customerId;
      if (deliveryAddressId) deliveryWhere.salesOrder.deliveryAddressId = deliveryAddressId;
    }

    const [pickupRows, deliveryRows] = await Promise.all([
      includePickup
        ? prisma.barrelPickup.findMany({
            where: pickupWhere,
            include: barrelPickupInclude,
            orderBy: { updatedAt: "desc" },
            take: 400,
          })
        : Promise.resolve([]),
      includeDelivery
        ? prisma.deliveryAssignment.findMany({
            where: deliveryWhere,
            include: deliveryBarrelCollectionInclude,
            orderBy: { updatedAt: "desc" },
            take: 400,
          })
        : Promise.resolve([]),
    ]);

    const mapped: Array<Record<string, unknown>> = [];

    for (const row of pickupRows) {
      const collectionDate = toLocalYmd(row.pickupDate);
      if (!collectionDateInRange(collectionDate, dateFromParam, dateToParam)) continue;
      mapped.push({
        id: row.id.toString(),
        sourceType: "pickup",
        refNo: row.pickupNo,
        refId: row.id.toString(),
        status: row.status,
        collectionDate,
        barrelsReturned: row.barrelsReturned ?? 0,
        barrelsExpected: row.barrelsExpected,
        barrelsDelivered: null,
        barrelNet: null,
        customer: row.customer
          ? {
              id: row.customer.id.toString(),
              customerCode: row.customer.customerCode,
              name: row.customer.name,
            }
          : null,
        deliveryAddress: row.deliveryAddress
          ? {
              id: row.deliveryAddress.id.toString(),
              label: row.deliveryAddress.label,
              addressLine: row.deliveryAddress.addressLine,
              barrelsOnSite: row.deliveryAddress.barrelsOnSite,
            }
          : null,
        driver: row.driver?.user
          ? {
              employeeCode: row.driver.user.employeeCode,
              name: row.driver.user.name,
            }
          : null,
        vehicle: row.vehicle ? { plateNo: row.vehicle.plateNo } : null,
        driverReportedAt: row.driverReportedAt,
        officeSettledAt: row.officeSettledAt,
        note: row.driverNote || row.remark || null,
      });
    }

    for (const row of deliveryRows) {
      const order = row.salesOrder;
      const collectionDate = collectionDateFromAssignment(row);
      if (!collectionDateInRange(collectionDate, dateFromParam, dateToParam)) continue;
      const barrelsDelivered = countDepositBarrelsDelivered(order.lines);
      const barrelsReturned = row.emptyBarrelsReturned;
      mapped.push({
        id: row.id.toString(),
        sourceType: "delivery",
        refNo: order.orderNo,
        refId: order.id.toString(),
        status: mapAssignmentStatusForCollection(row.status),
        collectionDate,
        barrelsReturned,
        barrelsExpected: null,
        barrelsDelivered,
        barrelNet: barrelsDelivered - barrelsReturned,
        customer: order.customer
          ? {
              id: order.customer.id.toString(),
              customerCode: order.customer.customerCode,
              name: order.customer.name,
            }
          : null,
        deliveryAddress: order.deliveryAddress
          ? {
              id: order.deliveryAddress.id.toString(),
              label: order.deliveryAddress.label,
              addressLine: order.deliveryAddress.addressLine,
              barrelsOnSite: order.deliveryAddress.barrelsOnSite,
            }
          : null,
        driver: row.driver?.user
          ? {
              employeeCode: row.driver.user.employeeCode,
              name: row.driver.user.name,
            }
          : null,
        vehicle: row.vehicle ? { plateNo: row.vehicle.plateNo } : null,
        driverReportedAt: row.driverReportedAt,
        officeSettledAt: row.officeSettledAt,
        note: row.settlementNote || null,
      });
    }

    const filtered = q ? mapped.filter((row) => barrelCollectionHaystack(row as Parameters<typeof barrelCollectionHaystack>[0]).includes(q)) : mapped;

    filtered.sort((a, b) => {
      const da = String(a.collectionDate ?? "");
      const db = String(b.collectionDate ?? "");
      if (da !== db) return db.localeCompare(da);
      return String(b.id ?? "").localeCompare(String(a.id ?? ""));
    });

    const sliced = filtered.slice(0, 300);
    const completedRows = sliced.filter((row) => row.status === "completed");
    if (completedRows.length > 0) {
      const movements = await prisma.barrelMovement.findMany({
        where: {
          OR: completedRows.map((row) => ({
            sourceType: String(row.sourceType),
            sourceRefId: BigInt(String(row.id)),
          })),
        },
      });
      const movementMap = new Map(movements.map((m) => [`${m.sourceType}:${m.sourceRefId.toString()}`, m]));
      for (const row of sliced) {
        const movement = movementMap.get(`${String(row.sourceType)}:${String(row.id)}`);
        if (movement) {
          row.ledgerId = movement.id.toString();
          row.barrelsOnSiteBefore = movement.barrelsOnSiteBefore;
          row.barrelsOnSiteAfter = movement.barrelsOnSiteAfter;
        }
      }
    }

    await attachBarrelSiteBalances(sliced, prisma);

    res.json(sliced);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 空桶回收稽核流水 */
app.get("/api/barrel-movements", async (req, res) => {
  try {
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const sourceParam = typeof req.query.source === "string" ? req.query.source.trim().toLowerCase() : "all";
    const customerId = toBigInt(req.query.customerId);
    const deliveryAddressId = toBigInt(req.query.deliveryAddressId);

    const where: Prisma.BarrelMovementWhereInput = {};
    if (sourceParam === "pickup" || sourceParam === "delivery") {
      where.sourceType = sourceParam;
    }
    if (customerId) where.customerId = customerId;
    if (deliveryAddressId) where.deliveryAddressId = deliveryAddressId;
    if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.movementDate = range;
    }

    const rows = await prisma.barrelMovement.findMany({
      where,
      include: barrelMovementListInclude,
      orderBy: [{ movementDate: "desc" }, { id: "desc" }],
      take: 400,
    });

    const mapped = rows.map((row) => ({
      id: row.id.toString(),
      sourceType: row.sourceType,
      refNo: row.refNo,
      refId:
        row.sourceType === "delivery" && row.salesOrderId
          ? row.salesOrderId.toString()
          : row.barrelPickupId
            ? row.barrelPickupId.toString()
            : row.sourceRefId.toString(),
      movementDate: toLocalYmd(row.movementDate),
      occurredAt: row.occurredAt,
      barrelsReturned: row.barrelsReturned,
      barrelsDelivered: row.barrelsDelivered,
      barrelDelta: row.barrelDelta,
      barrelsOnSiteBefore: row.barrelsOnSiteBefore,
      barrelsOnSiteAfter: row.barrelsOnSiteAfter,
      customer: row.customer
        ? {
            id: row.customer.id.toString(),
            customerCode: row.customer.customerCode,
            name: row.customer.name,
          }
        : null,
      deliveryAddress: row.deliveryAddress
        ? {
            id: row.deliveryAddress.id.toString(),
            label: row.deliveryAddress.label,
            addressLine: row.deliveryAddress.addressLine,
            barrelsOnSite: row.deliveryAddress.barrelsOnSite,
          }
        : null,
      driver: row.driver?.user
        ? {
            employeeCode: row.driver.user.employeeCode,
            name: row.driver.user.name,
          }
        : null,
      vehicle: row.vehicle ? { plateNo: row.vehicle.plateNo } : null,
      note: row.note,
    }));

    const filtered = q
      ? mapped.filter((row) => barrelCollectionHaystack(row as Parameters<typeof barrelCollectionHaystack>[0]).includes(q))
      : mapped;

    const sliced = filtered.slice(0, 300) as Array<Record<string, unknown>>;
    for (const row of sliced) {
      row.status = "completed";
      row.ledgerId = row.id;
      row.barrelNet = row.barrelDelta;
      row.collectionDate = row.movementDate;
    }
    await attachBarrelSiteBalances(sliced, prisma);

    res.json(sliced);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 收空桶任務列表（後台） */
app.get("/api/barrel-pickups", async (req, res) => {
  try {
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const customerId = toBigInt(req.query.customerId);
    const deliveryAddressId = toBigInt(req.query.deliveryAddressId);

    const where: Prisma.BarrelPickupWhereInput = {};
    if (statusParam) {
      where.status = statusParam;
    } else {
      where.status = { in: ["assigned", "pending_settlement", "completed", "cancelled"] };
    }
    if (customerId) {
      where.customerId = customerId;
    }
    if (deliveryAddressId) {
      where.deliveryAddressId = deliveryAddressId;
    }
    if (dateParam) {
      const parsed = parseLocalYmdRange(dateParam);
      if (!parsed) {
        res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
        return;
      }
      where.pickupDate = parsed.start;
    } else if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.pickupDate = range;
    }

    const rows = await prisma.barrelPickup.findMany({
      where,
      include: barrelPickupInclude,
      orderBy: { updatedAt: "desc" },
      take: 400,
    });

    const filtered = q
      ? rows.filter((row) => {
          const hay = [
            row.pickupNo,
            row.customer?.name,
            row.customer?.customerCode,
            row.deliveryAddress?.addressLine,
            row.driver?.user?.employeeCode,
            row.driver?.user?.name,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : rows;

    res.json(filtered.slice(0, 300));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 飲水機服務單列表（後台） */
app.get("/api/service-tickets", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.ServiceTicketWhereInput = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { ticketNo: { contains: q } },
        { problemNote: { contains: q } },
        { customer: { name: { contains: q } } },
        { customer: { customerCode: { contains: q } } },
        { customer: { mobile: { contains: q } } },
      ];
    }
    const rows = await prisma.serviceTicket.findMany({
      where,
      include: serviceTicketAdminInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    res.json({ ok: true, data: rows.map(serializeServiceTicketAdmin) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/service-tickets/:ticketId", async (req, res) => {
  try {
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const row = await prisma.serviceTicket.findUnique({
      where: { id: ticketId },
      include: serviceTicketAdminInclude,
    });
    if (!row) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    res.json({ ok: true, data: serializeServiceTicketAdmin(row) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台手動建立飲水機服務單（電話進線等） */
app.post("/api/service-tickets", async (req, res) => {
  try {
    const serviceTypeRaw = req.body?.serviceType;
    if (!isServiceType(serviceTypeRaw)) {
      res.status(400).json({ ok: false, message: "請選擇服務類型（清洗／維修／兩者）" });
      return;
    }
    const customerId = toBigInt(req.body?.customerId);
    const deliveryAddressId = toBigInt(req.body?.deliveryAddressId);
    if (!customerId || !deliveryAddressId) {
      res.status(400).json({ ok: false, message: "請選擇客戶與服務地址" });
      return;
    }
    const addr = await prisma.deliveryAddress.findFirst({
      where: { id: deliveryAddressId, customerId },
      select: { id: true },
    });
    if (!addr) {
      res.status(400).json({ ok: false, message: "地址不屬於此客戶" });
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
    const needLoaner =
      req.body?.needLoaner === true || req.body?.needLoaner === "true" || req.body?.needLoaner === 1;
    const loanerNote =
      typeof req.body?.loanerNote === "string" ? req.body.loanerNote.trim() || null : null;

    if (!problemNote) {
      res.status(400).json({ ok: false, message: "請填寫問題說明（來電內容）" });
      return;
    }

    const created = await createServiceTicket(prisma, {
      customerId,
      deliveryAddressId,
      serviceType: serviceTypeRaw,
      preferredDate,
      preferredSlot,
      problemNote,
      customerNote,
      needLoaner,
      loanerNote: needLoaner
        ? loanerNote ?? "後台代開：若需載回廠維修，請提供備用機"
        : null,
      source: "admin",
    });

    void notifyCustomerViaLine(prisma, {
      customerId,
      eventType: "service_ticket_created",
      text: `已為您建立飲水機服務單（${created.ticketNo}｜${serviceTypeLabel(created.serviceType)}），客服受理後會安排人員評估，謝謝。`,
      payload: { serviceTicketId: created.id.toString(), ticketNo: created.ticketNo },
    }).catch((err) => console.error("[line-notify] service_ticket_created(admin)", err));

    const full = await prisma.serviceTicket.findUniqueOrThrow({
      where: { id: created.id },
      include: serviceTicketAdminInclude,
    });
    res.status(201).json({ ok: true, data: serializeServiceTicketAdmin(full) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 受理服務單 */
app.post("/api/service-tickets/:ticketId/accept", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (existing.status !== "reported") {
      res.status(400).json({ ok: false, message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法受理` });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "accepted",
          acceptedByUserId: userId,
          acceptedAt: new Date(),
        },
        include: serviceTicketAdminInclude,
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "accepted",
          createdByUserId: userId,
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });
    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 派司機外出評估（可從已回報直接派，會一併受理） */
app.post("/api/service-tickets/:ticketId/assign-assess", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const body = req.body as {
      driverId?: unknown;
      vehicleId?: unknown;
      assessDateYmd?: unknown;
      assessSlot?: unknown;
    };
    const driverId = toBigInt(body.driverId);
    const vehicleId = body.vehicleId != null && body.vehicleId !== "" ? toBigInt(body.vehicleId) : null;
    const assessDateYmd = typeof body.assessDateYmd === "string" ? body.assessDateYmd.trim() : "";
    const assessSlot = typeof body.assessSlot === "string" ? body.assessSlot.trim() || null : null;
    if (!driverId || !assessDateYmd) {
      res.status(400).json({ ok: false, message: "請指定司機與評估日期" });
      return;
    }
    const assessDate = parseLocalYmdToDbDate(assessDateYmd);
    if (!assessDate) {
      res.status(400).json({ ok: false, message: "assessDateYmd 須為 YYYY-MM-DD" });
      return;
    }

    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["reported", "accepted", "assess_assigned"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法派評估`,
      });
      return;
    }

    const driver = await prisma.driver.findFirst({
      where: { id: driverId, isActive: true },
      include: { user: true, vehicle: true },
    });
    if (!driver) {
      res.status(400).json({ ok: false, message: "找不到有效司機" });
      return;
    }
    const resolvedVehicleId = vehicleId ?? driver.vehicleId ?? null;
    if (resolvedVehicleId) {
      const vehicle = await prisma.vehicle.findFirst({ where: { id: resolvedVehicleId, isActive: true } });
      if (!vehicle) {
        res.status(400).json({ ok: false, message: "找不到有效車輛" });
        return;
      }
    }

    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "assess_assigned",
          acceptedByUserId: existing.acceptedByUserId ?? userId,
          acceptedAt: existing.acceptedAt ?? now,
          assessDriverId: driverId,
          assessVehicleId: resolvedVehicleId,
          assessDate,
          assessSlot,
          assessAssignedByUserId: userId,
          assessAssignedAt: now,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "assess_assigned",
          createdByUserId: userId,
          payloadJson: {
            driverId: driverId.toString(),
            vehicleId: resolvedVehicleId?.toString() ?? null,
            assessDateYmd,
            assessSlot,
            needLoaner: existing.needLoaner,
            loanerNote: existing.loanerNote,
          },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_assess_assigned",
      text: `您的飲水機服務單 ${existing.ticketNo}（${serviceTypeLabel(existing.serviceType)}）已安排評估：${assessDateYmd}${assessSlot ? ` ${assessSlot}` : ""}，司機將前往查看，謝謝。`,
      payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo, assessDateYmd },
    }).catch((err) => console.error("[line-notify] service_ticket_assess_assigned", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：現場維修補登（司機不使用手機回報時用；可依貨單備註補登） */
app.post("/api/service-tickets/:ticketId/admin-onsite-complete", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const body = req.body as { note?: unknown; feeAmount?: unknown; outcome?: unknown; alreadyInWorkshop?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const rawOutcome = typeof body.outcome === "string" ? body.outcome.trim() : "onsite_fixed";
    if (!["onsite_fixed", "unable", "bring_back"].includes(rawOutcome)) {
      res.status(400).json({ ok: false, message: "outcome 須為 onsite_fixed｜unable｜bring_back" });
      return;
    }
    const outcome = rawOutcome === "bring_back" ? "unable" : (rawOutcome as "onsite_fixed" | "unable");
    const alreadyInWorkshop =
      body.alreadyInWorkshop === true || body.alreadyInWorkshop === "true" || body.alreadyInWorkshop === 1;

    let feeAmount: Prisma.Decimal | null = null;
    if (outcome === "onsite_fixed") {
      const n = Number(body.feeAmount);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "feeAmount 無效" });
        return;
      }
      feeAmount = new Prisma.Decimal(String(n));
    }

    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["assess_assigned", "accepted"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法補登現場結果`,
      });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();

    const nextStatus =
      outcome === "onsite_fixed"
        ? "onsite_completed"
        : alreadyInWorkshop
          ? "in_workshop"
          : existing.needLoaner
            ? "pending_loaner"
            : "pending_pickup";

    const updated = await prisma.$transaction(async (tx) => {
      if (outcome === "onsite_fixed") {
        await tx.serviceTicket.update({
          where: { id: ticketId },
          data: {
            status: "onsite_completed",
            assessOutcome: "onsite_fixed",
            assessDriverNote: note ?? existing.assessDriverNote,
            assessFeeAmount: feeAmount!,
            assessCustomerAgreed: true,
            assessReportedAt: existing.assessReportedAt ?? now,
            chargeAmount: feeAmount!,
            closedAt: null,
          },
        });
        await tx.serviceTicketEvent.create({
          data: {
            serviceTicketId: ticketId,
            eventType: "onsite_completed_admin",
            createdByUserId: userId,
            payloadJson: { note, feeAmount: feeAmount!.toString(), agreed: true, via: "admin" },
          },
        });
      } else {
        await tx.serviceTicket.update({
          where: { id: ticketId },
          data: {
            status: nextStatus,
            assessOutcome: "unable",
            assessDriverNote: note ?? existing.assessDriverNote,
            assessFeeAmount: null,
            assessCustomerAgreed: existing.assessCustomerAgreed,
            assessReportedAt: existing.assessReportedAt ?? now,
            cancelledReason: existing.cancelledReason,
            closedAt: null,
            chargeAmount: existing.chargeAmount,
            workshopStatus: alreadyInWorkshop ? "received" : existing.workshopStatus,
            workshopNote: alreadyInWorkshop ? note ?? existing.workshopNote : existing.workshopNote,
            workshopUpdatedAt: alreadyInWorkshop ? now : existing.workshopUpdatedAt,
            workshopUpdatedByUserId: alreadyInWorkshop ? userId : existing.workshopUpdatedByUserId,
          },
        });

        await tx.serviceTicketEvent.create({
          data: {
            serviceTicketId: ticketId,
            eventType: "assess_reported",
            createdByUserId: userId,
            payloadJson: { outcome: "unable", note, nextStatus, via: "admin" },
          },
        });

        if (alreadyInWorkshop) {
          await tx.serviceTicketEvent.create({
            data: {
              serviceTicketId: ticketId,
              eventType: "workshop_received",
              createdByUserId: userId,
              payloadJson: { note, fromStatus: existing.status },
            },
          });
        }
      }
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    if (outcome === "onsite_fixed") {
      void notifyCustomerViaLine(prisma, {
        customerId: existing.customerId,
        eventType: "service_ticket_assess_reported",
        text: `服務單 ${existing.ticketNo} 已現場維修完成${note ? `（${note}）` : ""}。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo, via: "admin" },
      }).catch((err) => console.error("[line-notify] onsite_completed_admin", err));
    } else if (alreadyInWorkshop) {
      void notifyCustomerViaLine(prisma, {
        customerId: existing.customerId,
        eventType: "service_ticket_in_workshop",
        text: `您的飲水機服務單 ${existing.ticketNo} 經現場評估無法維修，已載回廠內處理，後續進度可於 LINE 會員頁查看。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo },
      }).catch((err) => console.error("[line-notify] unable_to_workshop", err));
    } else {
      void notifyCustomerViaLine(prisma, {
        customerId: existing.customerId,
        eventType: "service_ticket_assess_reported",
        text: `您的飲水機服務單 ${existing.ticketNo} 評估結果：無法處理${note ? `（${note}）` : ""}。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo, outcome: "unable", nextStatus },
      }).catch((err) => console.error("[line-notify] unable_assess_reported", err));
    }

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台／客戶：標記需要臨時機（載回換機） */
app.post("/api/service-tickets/:ticketId/mark-loaner", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const body = req.body as { note?: unknown; swapDateYmd?: unknown; driverId?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const swapDateYmd = typeof body.swapDateYmd === "string" ? body.swapDateYmd.trim() : "";
    const driverId = body.driverId != null && body.driverId !== "" ? toBigInt(body.driverId) : null;

    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["reported", "accepted", "pending_pickup", "pending_loaner", "assess_assigned"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法標記臨時機`,
      });
      return;
    }

    const earlyStage = ["reported", "accepted"].includes(existing.status);

    let swapDate = existing.assessDate;
    if (swapDateYmd) {
      const parsed = parseLocalYmdToDbDate(swapDateYmd);
      if (!parsed) {
        res.status(400).json({ ok: false, message: "swapDateYmd 須為 YYYY-MM-DD" });
        return;
      }
      swapDate = parsed;
    }
    if (driverId) {
      const driver = await prisma.driver.findFirst({ where: { id: driverId, isActive: true } });
      if (!driver) {
        res.status(400).json({ ok: false, message: "找不到有效司機" });
        return;
      }
    }

    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: earlyStage
          ? {
              needLoaner: true,
              loanerNote: note ?? existing.loanerNote ?? "後台登記：若需載回廠維修，請提供備用機",
              loanerRequestedAt: existing.loanerRequestedAt ?? now,
            }
          : {
              status: "pending_loaner",
              needLoaner: true,
              loanerNote: note ?? existing.loanerNote,
              loanerRequestedAt: existing.loanerRequestedAt ?? now,
              assessDriverId: driverId ?? existing.assessDriverId,
              assessDate: swapDate,
            },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: earlyStage ? "loaner_noted_at_report" : "loaner_needed",
          createdByUserId: userId,
          payloadJson: earlyStage
            ? { note, source: "admin" }
            : {
                note,
                swapDateYmd: swapDateYmd || null,
                driverId: (driverId ?? existing.assessDriverId)?.toString() ?? null,
              },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_loaner_needed",
      text: `您的服務單 ${existing.ticketNo} 已登記需要臨時機，我們會安排司機攜帶臨時機前往換機。`,
      payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo },
    }).catch((err) => console.error("[line-notify] service_ticket_loaner_needed", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：確認已載回入廠（無臨時機或已換機完成後） */
app.post("/api/service-tickets/:ticketId/confirm-workshop-received", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["pending_pickup", "pending_loaner", "unable"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法確認入廠`,
      });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "in_workshop",
          workshopStatus: "received",
          workshopNote: note,
          workshopUpdatedAt: now,
          workshopUpdatedByUserId: userId,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "workshop_received",
          createdByUserId: userId,
          payloadJson: { note, fromStatus: existing.status },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_in_workshop",
      text: `您的飲水機（服務單 ${existing.ticketNo}）已入廠處理，後續進度可於 LINE 會員頁查看。`,
      payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo },
    }).catch((err) => console.error("[line-notify] service_ticket_in_workshop", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

const WORKSHOP_STATUSES = ["received", "diagnosing", "in_progress", "done_pending_return"] as const;

function workshopStatusLabel(s: string): string {
  switch (s) {
    case "received":
      return "已入廠";
    case "diagnosing":
      return "診斷中";
    case "in_progress":
      return "清洗／維修中";
    case "done_pending_return":
      return "已完工待送回";
    default:
      return s;
  }
}

/** 後台：更新廠內進度（司機不可改） */
app.post("/api/service-tickets/:ticketId/workshop-progress", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const workshopStatus = typeof req.body?.workshopStatus === "string" ? req.body.workshopStatus.trim() : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;
    if (!(WORKSHOP_STATUSES as readonly string[]).includes(workshopStatus)) {
      res.status(400).json({ ok: false, message: "workshopStatus 無效" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["in_workshop", "quote_pending", "quote_accepted"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法更新廠內進度`,
      });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const nextTicketStatus =
      workshopStatus === "done_pending_return" && existing.status === "quote_accepted"
        ? "pending_return"
        : existing.status;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: nextTicketStatus,
          workshopStatus,
          workshopNote: note ?? existing.workshopNote,
          workshopUpdatedAt: now,
          workshopUpdatedByUserId: userId,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "workshop_progress",
          createdByUserId: userId,
          payloadJson: { workshopStatus, note, nextTicketStatus },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_workshop_updated",
      text: `服務單 ${existing.ticketNo} 廠內進度更新：${workshopStatusLabel(workshopStatus)}${note ? `（${note}）` : ""}`,
      payload: { serviceTicketId: existing.id.toString(), workshopStatus },
    }).catch((err) => console.error("[line-notify] workshop_updated", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：開立報價 */
app.post("/api/service-tickets/:ticketId/quote", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const amountRaw = req.body?.amount;
    const detail = typeof req.body?.detail === "string" ? req.body.detail.trim() || null : null;
    const n = Number(amountRaw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ ok: false, message: "報價金額無效" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["in_workshop", "quote_pending", "quote_rejected"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法開報價`,
      });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const amount = new Prisma.Decimal(String(n));
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "quote_pending",
          quoteAmount: amount,
          quoteDetail: detail,
          quoteStatus: "pending",
          quoteSentAt: now,
          quoteRespondedAt: null,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "quote_sent",
          createdByUserId: userId,
          payloadJson: { amount: amount.toString(), detail },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_quote",
      text: `服務單 ${existing.ticketNo} 有新報價：$${amount.toString()}${detail ? `（${detail}）` : ""}，請至會員頁確認同意或拒絕。`,
      payload: { serviceTicketId: existing.id.toString(), amount: amount.toString() },
    }).catch((err) => console.error("[line-notify] quote", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：代客戶同意／拒絕報價 */
app.post("/api/service-tickets/:ticketId/quote-respond", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    const accept = req.body?.accept === true || req.body?.accept === "true";
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing || existing.status !== "quote_pending") {
      res.status(400).json({ ok: false, message: "目前沒有待確認的報價" });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
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
          createdByUserId: userId,
          payloadJson: { via: "admin" },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });
    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：派送回 */
app.post("/api/service-tickets/:ticketId/assign-return", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    const driverId = toBigInt(req.body?.driverId);
    const vehicleId = req.body?.vehicleId != null && req.body.vehicleId !== "" ? toBigInt(req.body.vehicleId) : null;
    const returnDateYmd = typeof req.body?.returnDateYmd === "string" ? req.body.returnDateYmd.trim() : "";
    if (!ticketId || !driverId || !returnDateYmd) {
      res.status(400).json({ ok: false, message: "請指定司機與送回日期" });
      return;
    }
    const returnDate = parseLocalYmdToDbDate(returnDateYmd);
    if (!returnDate) {
      res.status(400).json({ ok: false, message: "returnDateYmd 須為 YYYY-MM-DD" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["quote_accepted", "pending_return", "in_workshop"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法派送回（廠內完工且報價同意後）`,
      });
      return;
    }
    const driver = await prisma.driver.findFirst({ where: { id: driverId, isActive: true } });
    if (!driver) {
      res.status(400).json({ ok: false, message: "找不到有效司機" });
      return;
    }
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "pending_return",
          returnDriverId: driverId,
          returnVehicleId: vehicleId ?? driver.vehicleId,
          returnDate,
          returnAssignedByUserId: userId,
          returnAssignedAt: now,
          workshopStatus: existing.workshopStatus ?? "done_pending_return",
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "return_assigned",
          createdByUserId: userId,
          payloadJson: { driverId: driverId.toString(), returnDateYmd },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });
    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：結案入帳（現金／月結；收費＞0 時建立正式訂單＋AR，冪等不重覆立帳） */
app.post("/api/service-tickets/:ticketId/close", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    const billingType = typeof req.body?.billingType === "string" ? req.body.billingType.trim() : "";
    if (!ticketId || !["cash", "monthly"].includes(billingType)) {
      res.status(400).json({ ok: false, message: "請指定 billingType：cash 或 monthly" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (!["pending_return", "returned", "onsite_completed", "quote_accepted"].includes(existing.status)) {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法結案`,
      });
      return;
    }
    if (existing.salesOrderId != null) {
      res.status(400).json({ ok: false, message: "此服務單已關聯帳務訂單，請勿重複結案" });
      return;
    }
    let charge = existing.chargeAmount ?? existing.quoteAmount ?? existing.assessFeeAmount;
    if (req.body?.chargeAmount != null && req.body.chargeAmount !== "") {
      const n = Number(req.body.chargeAmount);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "chargeAmount 無效" });
        return;
      }
      charge = new Prisma.Decimal(String(n));
    }
    const cashCollectedNow =
      billingType === "cash" &&
      (req.body?.cashCollectedNow === true || req.body?.cashCollectedNow === "true" || req.body?.cashCollectedNow === 1);
    const collectedCashRaw = req.body?.collectedCash != null && req.body.collectedCash !== "" ? Number(req.body.collectedCash) : null;
    const collectedCheckRaw = req.body?.collectedCheck != null && req.body.collectedCheck !== "" ? Number(req.body.collectedCheck) : null;
    if (cashCollectedNow) {
      if (collectedCashRaw != null && (!Number.isFinite(collectedCashRaw) || collectedCashRaw < 0)) {
        res.status(400).json({ ok: false, message: "collectedCash 無效" });
        return;
      }
      if (collectedCheckRaw != null && (!Number.isFinite(collectedCheckRaw) || collectedCheckRaw < 0)) {
        res.status(400).json({ ok: false, message: "collectedCheck 無效" });
        return;
      }
    }
    const collectedCash = cashCollectedNow ? (collectedCashRaw ?? (charge ? Number(charge) : 0)) : 0;
    const collectedCheck = cashCollectedNow ? (collectedCheckRaw ?? 0) : 0;

    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const now = new Date();
    const collectionMeta = resolveServiceTicketCollectionMeta(existing, now);
    if (billingType === "cash" && charge != null && charge.greaterThan(0) && !collectionMeta.collectorDriverId) {
      res.status(400).json({
        ok: false,
        message:
          existing.status === "onsite_completed" || existing.assessOutcome === "onsite_fixed"
            ? "現金結案需有評估司機，才能列入司機日收款核對"
            : "現金結案需有送回司機，才能列入司機日收款核對",
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      let salesOrderId: bigint | null = existing.salesOrderId;
      let orderNo: string | null = null;
      let billingCreated = false;
      let paymentPosted = false;
      if (charge != null && charge.greaterThan(0)) {
        const posted = await postServiceTicketBilling(tx, {
          ticket: existing,
          billingType: billingType as "cash" | "monthly",
          charge,
          userId,
          settledAt: now,
          cashCollectedNow,
          collectedCash,
          collectedCheck,
        });
        salesOrderId = posted.salesOrderId;
        orderNo = posted.orderNo;
        billingCreated = posted.created;
        paymentPosted = posted.paymentPosted;
      }
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "closed",
          billingType,
          chargeAmount: charge,
          salesOrderId,
          returnedAt: existing.status === "pending_return" ? now : existing.returnedAt,
          closedAt: now,
          collectorDriverId: collectionMeta.collectorDriverId,
          collectionDate: collectionMeta.collectionDate,
          driverCashReceived:
            billingType === "cash" ? new Prisma.Decimal(String(collectedCash)) : null,
          driverCheckReceived:
            billingType === "cash" ? new Prisma.Decimal(String(collectedCheck)) : null,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "closed",
          createdByUserId: userId,
          payloadJson: {
            billingType,
            chargeAmount: charge?.toString() ?? null,
            returnConfirmedByAdmin: existing.status === "pending_return",
            salesOrderId: salesOrderId?.toString() ?? null,
            orderNo,
            billingCreated,
            paymentPosted,
            cashCollectedNow,
            collectedCash,
            collectedCheck,
            collectorDriverId: collectionMeta.collectorDriverId?.toString() ?? null,
            collectionDate: collectionMeta.collectionDateYmd,
          },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_closed",
      text: `服務單 ${existing.ticketNo} 已結案${charge && Number(charge) > 0 ? `，費用 $${charge.toString()}（${billingType === "monthly" ? "月結" : "現金"}）` : ""}。`,
      payload: { serviceTicketId: existing.id.toString(), billingType },
    }).catch((err) => console.error("[line-notify] closed", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 後台：已結案但尚未立帳的服務單，補建立訂單／AR（冪等） */
app.post("/api/service-tickets/:ticketId/ensure-billing", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "ticketId 無效" });
      return;
    }
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (existing.status !== "closed") {
      res.status(400).json({ ok: false, message: "僅已結案服務單可補立帳" });
      return;
    }
    const billingTypeRaw = typeof req.body?.billingType === "string" ? req.body.billingType.trim() : existing.billingType;
    if (!billingTypeRaw || !["cash", "monthly"].includes(billingTypeRaw)) {
      res.status(400).json({ ok: false, message: "請指定 billingType：cash 或 monthly" });
      return;
    }
    const billingType = billingTypeRaw as "cash" | "monthly";
    let charge = existing.chargeAmount ?? existing.quoteAmount ?? existing.assessFeeAmount;
    if (req.body?.chargeAmount != null && req.body.chargeAmount !== "") {
      const n = Number(req.body.chargeAmount);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "chargeAmount 無效" });
        return;
      }
      charge = new Prisma.Decimal(String(n));
    }
    if (charge == null || !charge.greaterThan(0)) {
      res.status(400).json({ ok: false, message: "收費金額須大於 0" });
      return;
    }
    const cashCollectedNow =
      billingType === "cash" &&
      (req.body?.cashCollectedNow === true || req.body?.cashCollectedNow === "true" || req.body?.cashCollectedNow === 1);
    const collectedCash = cashCollectedNow
      ? Number(req.body?.collectedCash != null && req.body.collectedCash !== "" ? req.body.collectedCash : charge)
      : Number(existing.driverCashReceived ?? 0);
    const collectedCheck = cashCollectedNow
      ? Number(req.body?.collectedCheck != null && req.body.collectedCheck !== "" ? req.body.collectedCheck : 0)
      : Number(existing.driverCheckReceived ?? 0);
    const userId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const settledAt = existing.closedAt ?? new Date();
    const collectionMeta = resolveServiceTicketCollectionMeta(existing, settledAt);
    const updated = await prisma.$transaction(async (tx) => {
      const posted = await postServiceTicketBilling(tx, {
        ticket: existing,
        billingType,
        charge,
        userId,
        settledAt,
        cashCollectedNow,
        collectedCash: cashCollectedNow ? collectedCash : 0,
        collectedCheck: cashCollectedNow ? collectedCheck : 0,
      });
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          billingType,
          chargeAmount: charge,
          salesOrderId: posted.salesOrderId,
          collectorDriverId: existing.collectorDriverId ?? collectionMeta.collectorDriverId,
          collectionDate: existing.collectionDate ?? collectionMeta.collectionDate,
          ...(billingType === "cash"
            ? {
                driverCashReceived: new Prisma.Decimal(String(cashCollectedNow ? collectedCash : Number(existing.driverCashReceived ?? 0))),
                driverCheckReceived: new Prisma.Decimal(String(cashCollectedNow ? collectedCheck : Number(existing.driverCheckReceived ?? 0))),
              }
            : {}),
        },
      });
      if (posted.created || posted.paymentPosted) {
        await tx.serviceTicketEvent.create({
          data: {
            serviceTicketId: ticketId,
            eventType: posted.created ? "billing_posted" : "collection_posted",
            createdByUserId: userId,
            payloadJson: {
              billingType,
              chargeAmount: charge.toString(),
              salesOrderId: posted.salesOrderId.toString(),
              orderNo: posted.orderNo,
              via: "ensure-billing",
              cashCollectedNow,
              collectedCash: cashCollectedNow ? collectedCash : null,
              collectedCheck: cashCollectedNow ? collectedCheck : null,
              paymentPosted: posted.paymentPosted,
            },
          },
        });
      }
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });
    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 建立收空桶任務 */
app.post("/api/barrel-pickups", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const body = req.body as {
      customerId?: unknown;
      deliveryAddressId?: unknown;
      driverId?: unknown;
      vehicleId?: unknown;
      pickupDateYmd?: unknown;
      barrelsExpected?: unknown;
      remark?: unknown;
    };

    const customerId = toBigInt(body.customerId);
    const deliveryAddressId = toBigInt(body.deliveryAddressId);
    const driverId = toBigInt(body.driverId);
    const vehicleId = body.vehicleId != null && body.vehicleId !== "" ? toBigInt(body.vehicleId) : null;
    const pickupDateYmd = typeof body.pickupDateYmd === "string" ? body.pickupDateYmd.trim() : "";
    const remark = typeof body.remark === "string" ? body.remark.trim() : "";

    if (!customerId || !deliveryAddressId || !driverId || !pickupDateYmd) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId、deliveryAddressId、driverId、pickupDateYmd 必填" });
      return;
    }

    const parsedDate = parseLocalYmdToDbDate(pickupDateYmd);
    if (!parsedDate) {
      res.status(400).json({ ok: false, message: "pickupDateYmd 須為 YYYY-MM-DD" });
      return;
    }

    let barrelsExpected: number | null = null;
    if (body.barrelsExpected != null && body.barrelsExpected !== "") {
      const n = parseNonNegativeBarrelCount(body.barrelsExpected, "barrelsExpected");
      if (n === "INVALID") {
        res.status(400).json({ ok: false, message: "barrelsExpected 須為非負整數" });
        return;
      }
      barrelsExpected = n;
    }

    const addr = await prisma.deliveryAddress.findFirst({
      where: { id: deliveryAddressId, customerId },
    });
    if (!addr) {
      res.status(400).json({ ok: false, message: "送貨地址不屬於此客戶" });
      return;
    }

    const driver = await prisma.driver.findFirst({
      where: { id: driverId, isActive: true },
    });
    if (!driver) {
      res.status(400).json({ ok: false, message: "找不到有效司機" });
      return;
    }

    if (vehicleId) {
      const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, isActive: true } });
      if (!vehicle) {
        res.status(400).json({ ok: false, message: "找不到有效車輛" });
        return;
      }
    }

    const creatorId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const result = await prisma.$transaction(async (tx) => {
      const pickupNo = await allocatePickupNo(tx, parsedDate);
      const row = await tx.barrelPickup.create({
        data: {
          pickupNo,
          customerId,
          deliveryAddressId,
          driverId,
          vehicleId,
          assignedByUserId: creatorId,
          createdByUserId: creatorId,
          pickupDate: parsedDate,
          status: "assigned",
          barrelsExpected,
          remark: remark || null,
        },
        include: barrelPickupInclude,
      });
      await tx.barrelPickupEvent.create({
        data: {
          barrelPickupId: row.id,
          eventType: "created",
          payloadJson: {
            pickupNo,
            pickupDateYmd,
            barrelsOnSite: addr.barrelsOnSite,
          },
        },
      });
      return row;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 修改收空桶任務（僅 assigned 且司機未回報時可改司機／車輛） */
app.patch("/api/barrel-pickups/:pickupId", async (req, res) => {
  try {
    const pickupId = toBigInt(req.params.pickupId);
    if (!pickupId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }

    const body = req.body as {
      driverId?: unknown;
      vehicleId?: unknown;
      remark?: unknown;
      pickupDateYmd?: unknown;
    };

    const existing = await prisma.barrelPickup.findUnique({ where: { id: pickupId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到收空桶任務" });
      return;
    }
    if (existing.status === "completed" || existing.status === "cancelled") {
      res.status(400).json({ ok: false, message: "此任務已結案或已取消，不可修改" });
      return;
    }

    const driverNotReported = existing.driverReportedAt == null && existing.barrelsReturned == null;
    const data: Prisma.BarrelPickupUpdateInput = {};

    if (body.remark !== undefined) {
      data.remark = typeof body.remark === "string" ? body.remark.trim() || null : null;
    }

    if (body.driverId !== undefined || body.vehicleId !== undefined || body.pickupDateYmd !== undefined) {
      if (existing.status !== "assigned" || !driverNotReported) {
        res.status(400).json({ ok: false, message: "僅「已分派且司機尚未回報」時可改司機、車輛或收桶日" });
        return;
      }
      if (body.driverId !== undefined) {
        const newDriverId = toBigInt(body.driverId);
        if (!newDriverId) {
          res.status(400).json({ ok: false, message: "driverId 無效" });
          return;
        }
        const driver = await prisma.driver.findFirst({ where: { id: newDriverId, isActive: true } });
        if (!driver) {
          res.status(400).json({ ok: false, message: "找不到有效司機" });
          return;
        }
        data.driver = { connect: { id: newDriverId } };
      }
      if (body.vehicleId !== undefined) {
        if (body.vehicleId == null || body.vehicleId === "") {
          data.vehicle = { disconnect: true };
        } else {
          const newVehicleId = toBigInt(body.vehicleId);
          if (!newVehicleId) {
            res.status(400).json({ ok: false, message: "vehicleId 無效" });
            return;
          }
          const vehicle = await prisma.vehicle.findFirst({ where: { id: newVehicleId, isActive: true } });
          if (!vehicle) {
            res.status(400).json({ ok: false, message: "找不到有效車輛" });
            return;
          }
          data.vehicle = { connect: { id: newVehicleId } };
        }
      }
      if (body.pickupDateYmd !== undefined) {
        const ymd = typeof body.pickupDateYmd === "string" ? body.pickupDateYmd.trim() : "";
        const parsed = parseLocalYmdToDbDate(ymd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "pickupDateYmd 須為 YYYY-MM-DD" });
          return;
        }
        data.pickupDate = parsed;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.barrelPickup.update({
        where: { id: pickupId },
        data,
        include: barrelPickupInclude,
      });
      await tx.barrelPickupEvent.create({
        data: {
          barrelPickupId: pickupId,
          eventType: "updated",
          payloadJson: { fields: Object.keys(body) },
        },
      });
      return updated;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 取消收空桶任務 */
app.post("/api/barrel-pickups/:pickupId/cancel", async (req, res) => {
  try {
    const pickupId = toBigInt(req.params.pickupId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!pickupId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }

    const existing = await prisma.barrelPickup.findUnique({ where: { id: pickupId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到收空桶任務" });
      return;
    }
    if (existing.status === "completed" || existing.status === "cancelled") {
      res.status(400).json({ ok: false, message: "此任務已結案或已取消" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.barrelPickup.update({
        where: { id: pickupId },
        data: { status: "cancelled" },
        include: barrelPickupInclude,
      });
      await tx.barrelPickupEvent.create({
        data: {
          barrelPickupId: pickupId,
          eventType: "cancelled",
          payloadJson: { reason: reason || undefined },
        },
      });
      return updated;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 辦公室確認收空桶核銷：減少送貨點 barrels_on_site */
app.post("/api/barrel-pickups/:pickupId/approve", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const pickupId = toBigInt(req.params.pickupId);
    const body = req.body as {
      officeSettledAtYmd?: unknown;
      officeSettledAt?: unknown;
    };

    if (!pickupId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }

    let settledAt = new Date();
    const officeIso = typeof body.officeSettledAt === "string" ? body.officeSettledAt.trim() : "";
    if (officeIso) {
      const parsedIso = new Date(officeIso);
      if (Number.isNaN(parsedIso.getTime())) {
        res.status(400).json({ ok: false, message: "officeSettledAt 須為有效 ISO 日期時間" });
        return;
      }
      settledAt = parsedIso;
    } else {
      const ymd = typeof body.officeSettledAtYmd === "string" ? body.officeSettledAtYmd.trim() : "";
      if (ymd) {
        const parsed = parseLocalYmdRange(ymd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "officeSettledAtYmd 須為 YYYY-MM-DD" });
          return;
        }
        settledAt = parsed.start;
      }
    }

    const existing = await prisma.barrelPickup.findUnique({
      where: { id: pickupId },
      include: { deliveryAddress: true },
    });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到收空桶任務" });
      return;
    }
    if (existing.status !== "pending_settlement") {
      res.status(400).json({ ok: false, message: "此任務不在「待辦公室核銷」狀態" });
      return;
    }

    const barrelsReturned = Math.max(0, Math.floor(Number(existing.barrelsReturned ?? 0)));
    const onSite = existing.deliveryAddress.barrelsOnSite;
    if (barrelsReturned > onSite) {
      res.status(400).json({
        ok: false,
        message: `拒絕核銷：司機回報 ${barrelsReturned} 桶，超過送貨點在場空桶 ${onSite} 桶`,
      });
      return;
    }

    const settlerId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const result = await prisma.$transaction(async (tx) => {
      const newOnSite = Math.max(0, onSite - barrelsReturned);
      await tx.deliveryAddress.update({
        where: { id: existing.deliveryAddressId },
        data: { barrelsOnSite: newOnSite },
      });

      const updated = await tx.barrelPickup.update({
        where: { id: pickupId },
        data: {
          status: "completed",
          officeSettledByUserId: settlerId,
          officeSettledAt: settledAt,
        },
        include: barrelPickupInclude,
      });

      await tx.barrelPickupEvent.create({
        data: {
          barrelPickupId: pickupId,
          eventType: "settlement",
          createdAt: settledAt,
          payloadJson: {
            source: "office_approve",
            barrelsReturned,
            barrelsOnSiteBefore: onSite,
            barrelsOnSiteAfter: newOnSite,
            pickupNo: existing.pickupNo,
            officeSettledAt: settledAt.toISOString(),
          },
        },
      });

      await recordBarrelMovement(tx, {
        sourceType: "pickup",
        sourceRefId: pickupId,
        refNo: existing.pickupNo,
        movementDate: settledAt,
        occurredAt: settledAt,
        customerId: existing.customerId,
        deliveryAddressId: existing.deliveryAddressId,
        barrelsReturned,
        barrelsDelivered: 0,
        barrelDelta: -barrelsReturned,
        barrelsOnSiteBefore: onSite,
        barrelsOnSiteAfter: newOnSite,
        driverId: existing.driverId,
        vehicleId: existing.vehicleId,
        barrelPickupId: pickupId,
        note: existing.driverNote || existing.remark,
        createdByUserId: settlerId,
      });

      return updated;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機：當日收空桶任務 */
app.get("/api/driver/barrel-pickups", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const employeeCode =
      auth?.role === "driver"
        ? auth.employeeCode
        : String(req.query.employeeCode ?? "").trim();
    if (!employeeCode) {
      res.status(400).json({ ok: false, message: "employeeCode 必填" });
      return;
    }

    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    let start: Date;
    let end: Date;
    if (dateParam) {
      const parsed = parseLocalYmdRange(dateParam);
      if (!parsed) {
        res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
        return;
      }
      start = parsed.start;
      end = parsed.end;
    } else {
      const today = new Date();
      start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    }

    const rows = await prisma.barrelPickup.findMany({
      where: {
        status: { in: ["assigned", "pending_settlement", "completed", "cancelled"] },
        driver: { user: { employeeCode } },
        pickupDate: { gte: start, lt: end },
      },
      include: barrelPickupInclude,
      orderBy: { id: "asc" },
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機：當日飲水機評估任務 */
app.get("/api/driver/service-tickets", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    if (!auth?.driverId) {
      res.status(403).json({ ok: false, message: "僅司機可查看評估任務" });
      return;
    }
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const ymd = dateParam || toLocalYmd(new Date());
    const day = parseLocalYmdToDbDate(ymd);
    if (!day) {
      res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
      return;
    }
    const next = new Date(day);
    next.setUTCDate(next.getUTCDate() + 1);

    const rows = await prisma.serviceTicket.findMany({
      where: {
        OR: [
          {
            assessDriverId: auth.driverId,
            assessDate: { gte: day, lt: next },
            status: {
              in: [
                "assess_assigned",
                "onsite_completed",
                "pending_pickup",
                "pending_loaner",
                "in_workshop",
                "unable",
                "cancelled",
              ],
            },
          },
          {
            returnDriverId: auth.driverId,
            returnDate: { gte: day, lt: next },
            status: { in: ["pending_return", "returned"] },
          },
        ],
      },
      include: serviceTicketAdminInclude,
      orderBy: [{ id: "asc" }],
    });
    res.json({ ok: true, data: rows.map(serializeServiceTicketAdmin) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機：現場評估回報／臨時機換機回報 */
app.post("/api/driver/service-tickets/:ticketId/assess-report", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    if (!auth?.driverId) {
      res.status(403).json({ ok: false, message: "僅司機可回報評估" });
      return;
    }
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const body = req.body as {
      outcome?: unknown;
      note?: unknown;
      feeAmount?: unknown;
      customerAgreed?: unknown;
    };
    const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
    if (!["onsite_fixed", "bring_back", "unable", "cancelled", "loaner_swapped"].includes(outcome)) {
      res.status(400).json({
        ok: false,
        message: "outcome 須為 onsite_fixed｜bring_back｜unable｜cancelled｜loaner_swapped",
      });
      return;
    }
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const customerAgreed = body.customerAgreed === true || body.customerAgreed === "true" || body.customerAgreed === 1;

    let feeAmount: Prisma.Decimal | null = null;
    if (body.feeAmount != null && body.feeAmount !== "") {
      const n = Number(body.feeAmount);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ ok: false, message: "費用須為非負數字" });
        return;
      }
      feeAmount = new Prisma.Decimal(String(n));
    }

    if (outcome === "onsite_fixed" && !customerAgreed) {
      res.status(400).json({ ok: false, message: "現場維修須確認已詢問客戶同意" });
      return;
    }

    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (existing.assessDriverId !== auth.driverId) {
      res.status(403).json({ ok: false, message: "此服務單未分派給您" });
      return;
    }

    if (outcome === "loaner_swapped") {
      if (existing.status !== "pending_loaner" && !(existing.status === "assess_assigned" && existing.needLoaner)) {
        res.status(400).json({
          ok: false,
          message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法回報換機`,
        });
        return;
      }
    } else if (existing.status !== "assess_assigned") {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法回報評估`,
      });
      return;
    }

    const nextStatus =
      outcome === "onsite_fixed"
        ? "onsite_completed"
        : outcome === "bring_back"
          ? existing.needLoaner
            ? "pending_loaner"
            : "pending_pickup"
          : outcome === "loaner_swapped"
            ? "in_workshop"
            : outcome === "unable"
              ? existing.needLoaner
                ? "pending_loaner"
                : "pending_pickup"
              : "cancelled";

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: nextStatus,
          assessOutcome: outcome === "loaner_swapped" ? existing.assessOutcome ?? "bring_back" : outcome,
          assessDriverNote: note ?? existing.assessDriverNote,
          assessFeeAmount: outcome === "loaner_swapped" ? existing.assessFeeAmount : feeAmount,
          assessCustomerAgreed: outcome === "onsite_fixed" ? true : existing.assessCustomerAgreed,
          assessReportedAt: outcome === "loaner_swapped" ? existing.assessReportedAt ?? now : now,
          cancelledReason: outcome === "cancelled" ? note : existing.cancelledReason,
          closedAt: outcome === "cancelled" ? now : null,
          chargeAmount: outcome === "onsite_fixed" ? feeAmount : existing.chargeAmount,
          workshopStatus: outcome === "loaner_swapped" ? "received" : existing.workshopStatus,
          workshopUpdatedAt: outcome === "loaner_swapped" ? now : existing.workshopUpdatedAt,
          workshopNote: outcome === "loaner_swapped" ? note ?? existing.workshopNote : existing.workshopNote,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: outcome === "loaner_swapped" ? "loaner_swapped" : "assess_reported",
          createdByUserId: auth.id,
          payloadJson: {
            outcome,
            note,
            feeAmount: feeAmount?.toString() ?? null,
            customerAgreed: outcome === "onsite_fixed" ? true : null,
            nextStatus,
          },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    if (outcome === "loaner_swapped") {
      void notifyCustomerViaLine(prisma, {
        customerId: existing.customerId,
        eventType: "service_ticket_in_workshop",
        text: `已為您換上臨時機，原機（服務單 ${existing.ticketNo}）已載回廠內處理。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo, outcome },
      }).catch((err) => console.error("[line-notify] loaner_swapped", err));
    } else {
      const outcomeLabel =
        outcome === "onsite_fixed"
          ? "現場已維修完工"
          : outcome === "bring_back"
            ? "需載回廠內處理"
            : outcome === "unable"
              ? "無法處理"
              : "已取消";
      void notifyCustomerViaLine(prisma, {
        customerId: existing.customerId,
        eventType: "service_ticket_assess_reported",
        text: `您的飲水機服務單 ${existing.ticketNo} 評估結果：${outcomeLabel}${note ? `（${note}）` : ""}。`,
        payload: { serviceTicketId: existing.id.toString(), ticketNo: existing.ticketNo, outcome, nextStatus },
      }).catch((err) => console.error("[line-notify] service_ticket_assess_reported", err));
    }

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機：送回安裝回報 */
app.post("/api/driver/service-tickets/:ticketId/return-report", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    if (!auth?.driverId) {
      res.status(403).json({ ok: false, message: "僅司機可回報送回" });
      return;
    }
    const ticketId = toBigInt(req.params.ticketId);
    if (!ticketId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;
    const existing = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到服務單" });
      return;
    }
    if (existing.returnDriverId !== auth.driverId) {
      res.status(403).json({ ok: false, message: "此送回任務未分派給您" });
      return;
    }
    if (existing.status !== "pending_return") {
      res.status(400).json({
        ok: false,
        message: `目前狀態「${serviceTicketStatusLabel(existing.status)}」無法回報送回`,
      });
      return;
    }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: ticketId },
        data: {
          status: "returned",
          returnedAt: now,
          workshopNote: note ? `${existing.workshopNote ?? ""}\n送回：${note}`.trim() : existing.workshopNote,
        },
      });
      await tx.serviceTicketEvent.create({
        data: {
          serviceTicketId: ticketId,
          eventType: "returned",
          createdByUserId: auth.id,
          payloadJson: { note },
        },
      });
      return tx.serviceTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: serviceTicketAdminInclude,
      });
    });

    void notifyCustomerViaLine(prisma, {
      customerId: existing.customerId,
      eventType: "service_ticket_returned",
      text: `服務單 ${existing.ticketNo} 飲水機已送回安裝完成。`,
      payload: { serviceTicketId: existing.id.toString() },
    }).catch((err) => console.error("[line-notify] returned", err));

    res.json({ ok: true, data: serializeServiceTicketAdmin(updated) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** 司機：回報收空桶數 */
app.post("/api/driver/barrel-pickups/:pickupId/report", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const pickupId = toBigInt(req.params.pickupId);
    const body = req.body as {
      barrelsReturned?: unknown;
      note?: unknown;
      reportedAtYmd?: unknown;
      reportedAt?: unknown;
    };

    if (!pickupId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }

    const barrelsParsed = parseNonNegativeBarrelCount(body.barrelsReturned, "barrelsReturned");
    if (barrelsParsed === "INVALID") {
      res.status(400).json({ ok: false, message: "barrelsReturned 須為非負整數" });
      return;
    }
    const driverNote = typeof body.note === "string" ? body.note.trim() : "";

    const existing = await prisma.barrelPickup.findUnique({
      where: { id: pickupId },
      include: { driver: { include: { user: true } } },
    });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到收空桶任務" });
      return;
    }
    if (auth?.role === "driver" && existing.driverId !== auth.driverId) {
      res.status(403).json({ ok: false, message: "不可回報其他司機的任務" });
      return;
    }
    if (existing.status === "completed" || existing.status === "cancelled") {
      res.status(400).json({ ok: false, message: "此任務已結案或已取消" });
      return;
    }
    const isAmend = existing.status === "pending_settlement";
    if (!isAmend && existing.status !== "assigned") {
      res.status(400).json({ ok: false, message: "此任務狀態不可提交回報" });
      return;
    }

    let driverReportedAt = new Date();
    const reportedAtIso = typeof body.reportedAt === "string" ? body.reportedAt.trim() : "";
    if (reportedAtIso) {
      const parsedIso = new Date(reportedAtIso);
      if (Number.isNaN(parsedIso.getTime())) {
        res.status(400).json({ ok: false, message: "reportedAt 須為有效 ISO 日期時間" });
        return;
      }
      driverReportedAt = parsedIso;
    } else {
      const reportedYmd = typeof body.reportedAtYmd === "string" ? body.reportedAtYmd.trim() : "";
      if (reportedYmd) {
        const parsed = parseLocalYmdRange(reportedYmd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "reportedAtYmd 須為 YYYY-MM-DD" });
          return;
        }
        driverReportedAt = parsed.start;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.barrelPickup.update({
        where: { id: pickupId },
        data: {
          status: "pending_settlement",
          barrelsReturned: barrelsParsed,
          driverNote: driverNote || null,
          driverReportedAt,
        },
        include: barrelPickupInclude,
      });
      await tx.barrelPickupEvent.create({
        data: {
          barrelPickupId: pickupId,
          eventType: isAmend ? "driver_amend" : "driver_report",
          createdAt: driverReportedAt,
          payloadJson: {
            barrelsReturned: barrelsParsed,
            driverNote: driverNote || undefined,
            pickupNo: existing.pickupNo,
          },
        },
      });
      return updated;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

// ---------------------------------------------------------------------------
// 公司支出（expense vouchers）
// ---------------------------------------------------------------------------

const EXPENSE_PAYMENT_METHODS = ["cash", "transfer", "check", "monthly", "other"] as const;

const expenseVoucherInclude = {
  affiliatedCompany: true,
  createdBy: { select: { id: true, name: true, employeeCode: true } },
  verifiedBy: { select: { id: true, name: true, employeeCode: true } },
  lines: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      category: true,
      customer: { select: { id: true, name: true, customerCode: true } },
    },
  },
} as const;

function normalizeExpenseTaxMode(raw: unknown): "tax_inclusive" | "tax_exclusive" | "none" {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "tax_inclusive" || s === "tax_exclusive" || s === "none") return s;
  return "tax_exclusive";
}

function normalizeExpensePaymentMethod(raw: unknown): (typeof EXPENSE_PAYMENT_METHODS)[number] {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if ((EXPENSE_PAYMENT_METHODS as readonly string[]).includes(s)) return s as (typeof EXPENSE_PAYMENT_METHODS)[number];
  return "cash";
}

function computeExpenseLineTotals(
  qty: number,
  unitPrice: Prisma.Decimal,
  taxMode: "tax_inclusive" | "tax_exclusive" | "none",
): { untaxedAmount: Prisma.Decimal; taxAmount: Prisma.Decimal; lineAmount: Prisma.Decimal } {
  const subtotal = unitPrice.mul(qty);
  if (subtotal.lessThanOrEqualTo(0)) {
    return {
      untaxedAmount: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      lineAmount: new Prisma.Decimal(0),
    };
  }
  if (taxMode === "none") {
    return { untaxedAmount: subtotal, taxAmount: new Prisma.Decimal(0), lineAmount: subtotal };
  }
  if (taxMode === "tax_exclusive") {
    const { taxAmount, totalWithTax } = computeTaxFromUntaxed(subtotal, DEFAULT_VAT_RATE);
    return { untaxedAmount: subtotal, taxAmount, lineAmount: totalWithTax };
  }
  const br = breakdownCashTaxInvoice(subtotal, "tax_inclusive", DEFAULT_VAT_RATE);
  if (!br) {
    return { untaxedAmount: subtotal, taxAmount: new Prisma.Decimal(0), lineAmount: subtotal };
  }
  return { untaxedAmount: br.untaxedAmount, taxAmount: br.taxAmount, lineAmount: br.totalWithTax };
}

type ParsedExpenseLine = {
  categoryId: bigint | null;
  itemName: string;
  customerId: bigint | null;
  qty: number;
  unitPrice: Prisma.Decimal;
  taxMode: "tax_inclusive" | "tax_exclusive" | "none";
  taxAmount: Prisma.Decimal;
  lineAmount: Prisma.Decimal;
  sortOrder: number;
};

async function parseExpenseLinesInput(
  linesRaw: unknown,
): Promise<{ ok: true; lines: ParsedExpenseLine[]; totals: { untaxedTotal: Prisma.Decimal; taxTotal: Prisma.Decimal; totalAmount: Prisma.Decimal } } | { ok: false; message: string }> {
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) {
    return { ok: false, message: "至少需要一筆支出明細" };
  }
  if (linesRaw.length > 50) {
    return { ok: false, message: "單張憑證最多 50 筆明細" };
  }

  const categoryIds = new Set<bigint>();
  for (const row of linesRaw) {
    const cid = toBigInt((row as { categoryId?: unknown }).categoryId);
    if (cid) categoryIds.add(cid);
  }
  const categories =
    categoryIds.size > 0
      ? await prisma.expenseCategory.findMany({ where: { id: { in: [...categoryIds] }, isActive: true } })
      : [];
  const categoryMap = new Map(categories.map((c) => [c.id.toString(), c]));

  const parsed: ParsedExpenseLine[] = [];
  let untaxedTotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  let totalAmount = new Prisma.Decimal(0);

  for (let i = 0; i < linesRaw.length; i++) {
    const row = linesRaw[i] as {
      categoryId?: unknown;
      itemName?: unknown;
      customerId?: unknown;
      qty?: unknown;
      unitPrice?: unknown;
      taxMode?: unknown;
    };
    const itemName = typeof row.itemName === "string" ? row.itemName.trim() : "";
    if (!itemName) {
      return { ok: false, message: `第 ${i + 1} 筆明細：項目名稱為必填` };
    }
    if (itemName.length > 200) {
      return { ok: false, message: `第 ${i + 1} 筆明細：項目名稱不可超過 200 字` };
    }

    const categoryId = toBigInt(row.categoryId);
    const category = categoryId ? categoryMap.get(categoryId.toString()) : undefined;
    if (categoryId && !category) {
      return { ok: false, message: `第 ${i + 1} 筆明細：支出類別無效` };
    }

    const customerId = toBigInt(row.customerId);
    if (category?.requiresCustomer && !customerId) {
      return { ok: false, message: `第 ${i + 1} 筆明細：「${category.name}」須選擇客戶` };
    }
    if (customerId) {
      const cust = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!cust) {
        return { ok: false, message: `第 ${i + 1} 筆明細：找不到客戶` };
      }
    }

    const qtyRaw = row.qty != null && row.qty !== "" ? Number(row.qty) : 1;
    if (!Number.isInteger(qtyRaw) || qtyRaw <= 0) {
      return { ok: false, message: `第 ${i + 1} 筆明細：數量須為正整數` };
    }

    const unitPriceRaw = row.unitPrice != null && row.unitPrice !== "" ? String(row.unitPrice).trim() : "0";
    let unitPrice: Prisma.Decimal;
    try {
      unitPrice = new Prisma.Decimal(unitPriceRaw);
      if (unitPrice.lessThan(0)) throw new Error("negative");
    } catch {
      return { ok: false, message: `第 ${i + 1} 筆明細：單價格式錯誤` };
    }

    const taxMode = normalizeExpenseTaxMode(row.taxMode);
    const computed = computeExpenseLineTotals(qtyRaw, unitPrice, taxMode);

    parsed.push({
      categoryId: categoryId ?? null,
      itemName,
      customerId: customerId ?? null,
      qty: qtyRaw,
      unitPrice,
      taxMode,
      taxAmount: computed.taxAmount,
      lineAmount: computed.lineAmount,
      sortOrder: i,
    });
    untaxedTotal = untaxedTotal.plus(computed.untaxedAmount);
    taxTotal = taxTotal.plus(computed.taxAmount);
    totalAmount = totalAmount.plus(computed.lineAmount);
  }

  return {
    ok: true,
    lines: parsed,
    totals: {
      untaxedTotal: untaxedTotal.toDecimalPlaces(2),
      taxTotal: taxTotal.toDecimalPlaces(2),
      totalAmount: totalAmount.toDecimalPlaces(2),
    },
  };
}

function canModifyExpenseVoucher(user: AuthUser, voucher: { createdByUserId: bigint | null; status: string }): boolean {
  if (voucher.status === "verified") return false;
  if (user.role === "admin" || user.role === "accounting") return true;
  if (voucher.createdByUserId != null && voucher.createdByUserId === user.id) return true;
  return false;
}

function canVerifyExpense(user: AuthUser): boolean {
  return user.role === "admin" || user.role === "accounting";
}

const allocateExpenseVoucherNo = async (tx: Prisma.TransactionClient, expenseDate: Date): Promise<string> => {
  const yyyy = expenseDate.getUTCFullYear();
  const mm = String(expenseDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(expenseDate.getUTCDate()).padStart(2, "0");
  const prefix = `EX${yyyy}${mm}${dd}`;
  const last = await tx.expenseVoucher.findFirst({
    where: { voucherNo: { startsWith: prefix } },
    orderBy: { voucherNo: "desc" },
    select: { voucherNo: true },
  });
  let seq = 1;
  if (last) {
    const tail = last.voucherNo.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
};

type ExpenseFlatLine = {
  lineId: string;
  voucherId: string;
  voucherNo: string;
  expenseDate: string;
  vendorName: string;
  companyId: string;
  companyName: string;
  invoiceDate: string | null;
  paymentMethod: string;
  voucherRemark: string | null;
  status: string;
  categoryId: string | null;
  categoryName: string | null;
  itemName: string;
  customerId: string | null;
  customerName: string | null;
  customerCode: string | null;
  qty: number;
  unitPrice: string;
  taxMode: string;
  taxAmount: string;
  lineAmount: string;
  createdByName: string | null;
  verifiedAt: string | null;
};

function flattenExpenseVouchers(vouchers: Prisma.ExpenseVoucherGetPayload<{ include: typeof expenseVoucherInclude }>[]): ExpenseFlatLine[] {
  const out: ExpenseFlatLine[] = [];
  for (const v of vouchers) {
    const expenseDate = fmtDbDateYmd(v.expenseDate);
    const invoiceDate = v.invoiceDate ? fmtDbDateYmd(v.invoiceDate) : null;
    for (const line of v.lines) {
      out.push({
        lineId: line.id.toString(),
        voucherId: v.id.toString(),
        voucherNo: v.voucherNo,
        expenseDate,
        vendorName: v.vendorName,
        companyId: v.affiliatedCompanyId.toString(),
        companyName: v.affiliatedCompany?.name ?? "",
        invoiceDate,
        paymentMethod: v.paymentMethod,
        voucherRemark: v.remark,
        status: v.status,
        categoryId: line.categoryId?.toString() ?? null,
        categoryName: line.category?.name ?? null,
        itemName: line.itemName,
        customerId: line.customerId?.toString() ?? null,
        customerName: line.customer?.name ?? null,
        customerCode: line.customer?.customerCode ?? null,
        qty: line.qty,
        unitPrice: line.unitPrice.toString(),
        taxMode: line.taxMode,
        taxAmount: line.taxAmount.toString(),
        lineAmount: line.lineAmount.toString(),
        createdByName: v.createdBy?.name ?? null,
        verifiedAt: v.verifiedAt ? v.verifiedAt.toISOString() : null,
      });
    }
  }
  return out;
}

function fmtLocalYmdFromDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildExpenseSummary(
  vouchers: Prisma.ExpenseVoucherGetPayload<{ include: typeof expenseVoucherInclude }>[],
  dateLabel: string,
) {
  const flatLines = flattenExpenseVouchers(vouchers);
  let untaxedTotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  let totalAmount = new Prisma.Decimal(0);
  for (const v of vouchers) {
    untaxedTotal = untaxedTotal.plus(v.untaxedTotal);
    taxTotal = taxTotal.plus(v.taxTotal);
    totalAmount = totalAmount.plus(v.totalAmount);
  }
  const verifiedCount = vouchers.filter((v) => v.status === "verified").length;
  const pendingCount = vouchers.filter((v) => v.status === "pending").length;

  const byCategoryMap = new Map<string, { name: string; totalAmount: Prisma.Decimal; count: number }>();
  for (const line of flatLines) {
    const key = line.categoryId ?? "_none";
    const name = line.categoryName ?? "未分類";
    const prev = byCategoryMap.get(key) ?? { name, totalAmount: new Prisma.Decimal(0), count: 0 };
    prev.totalAmount = prev.totalAmount.plus(new Prisma.Decimal(line.lineAmount));
    prev.count += 1;
    byCategoryMap.set(key, prev);
  }

  const byCompanyMap = new Map<string, { name: string; totalAmount: Prisma.Decimal; count: number }>();
  for (const v of vouchers) {
    const key = v.affiliatedCompanyId.toString();
    const name = v.affiliatedCompany?.name ?? "";
    const prev = byCompanyMap.get(key) ?? { name, totalAmount: new Prisma.Decimal(0), count: 0 };
    prev.totalAmount = prev.totalAmount.plus(v.totalAmount);
    prev.count += 1;
    byCompanyMap.set(key, prev);
  }

  return {
    date: dateLabel,
    voucherCount: vouchers.length,
    lineCount: flatLines.length,
    untaxedTotal: untaxedTotal.toDecimalPlaces(2).toString(),
    taxTotal: taxTotal.toDecimalPlaces(2).toString(),
    totalAmount: totalAmount.toDecimalPlaces(2).toString(),
    verifiedCount,
    pendingCount,
    byCategory: [...byCategoryMap.values()]
      .map((x) => ({ name: x.name, totalAmount: x.totalAmount.toDecimalPlaces(2).toString(), count: x.count }))
      .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount)),
    byCompany: [...byCompanyMap.values()]
      .map((x) => ({ name: x.name, totalAmount: x.totalAmount.toDecimalPlaces(2).toString(), count: x.count }))
      .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount)),
    lines: flatLines.map((line) => ({
      ...line,
      lineId: line.lineId,
    })),
  };
}

app.get("/api/expense-categories", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const rows = await prisma.expenseCategory.findMany({
      where: all ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/expense-categories", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const body = req.body as { name?: unknown; sortOrder?: unknown; requiresCustomer?: unknown };
    const name = trimOptionalString(body.name);
    if (!name) {
      res.status(400).json({ ok: false, message: "類別名稱為必填" });
      return;
    }
    if (name.length > 80) {
      res.status(400).json({ ok: false, message: "類別名稱不可超過 80 字" });
      return;
    }
    const sortOrder = Math.floor(Number(body.sortOrder ?? 0));
    const row = await prisma.expenseCategory.create({
      data: {
        name,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        requiresCustomer: body.requiresCustomer === true,
      },
    });
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "此類別名稱已存在" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/expense-categories/:categoryId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const categoryId = toBigInt(req.params.categoryId);
    if (!categoryId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const body = req.body as { name?: unknown; sortOrder?: unknown; isActive?: unknown; requiresCustomer?: unknown };
    const data: Prisma.ExpenseCategoryUpdateInput = {};
    if (body.name !== undefined) {
      const name = trimOptionalString(body.name);
      if (!name) {
        res.status(400).json({ ok: false, message: "類別名稱不可為空" });
        return;
      }
      data.name = name;
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Math.floor(Number(body.sortOrder));
      data.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (typeof body.isActive === "boolean") data.isActive = body.isActive;
    if (typeof body.requiresCustomer === "boolean") data.requiresCustomer = body.requiresCustomer;
    if (Object.keys(data).length === 0) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }
    const row = await prisma.expenseCategory.update({ where: { id: categoryId }, data });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到類別" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/expense-categories/:categoryId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const categoryId = toBigInt(req.params.categoryId);
    if (!categoryId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const used = await prisma.expenseLine.count({ where: { categoryId } });
    if (used > 0) {
      res.status(400).json({ ok: false, message: `仍有 ${used} 筆支出明細使用此類別，請改為停用` });
      return;
    }
    await prisma.expenseCategory.delete({ where: { id: categoryId } });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      res.status(404).json({ ok: false, message: "找不到類別" });
      return;
    }
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers/daily-summary", async (req, res) => {
  try {
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const ymd = dateParam || fmtLocalYmdFromDate(new Date());
    const dateFilter = dbDateEqualsFilter(ymd);
    if (!dateFilter) {
      res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
      return;
    }
    const vouchers = await prisma.expenseVoucher.findMany({
      where: { expenseDate: dateFilter },
      include: expenseVoucherInclude,
      orderBy: [{ voucherNo: "asc" }],
    });
    res.json({ ok: true, data: buildExpenseSummary(vouchers, ymd) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers/today-summary", async (req, res) => {
  try {
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : fmtLocalYmdFromDate(new Date());
    const dateFilter = dbDateEqualsFilter(dateParam);
    if (!dateFilter) {
      res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
      return;
    }
    const companyId = toBigInt(req.query.companyId);
    const categoryId = toBigInt(req.query.categoryId);
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const vendorQ = typeof req.query.vendor === "string" ? req.query.vendor.trim().toLowerCase() : "";

    const where: Prisma.ExpenseVoucherWhereInput = { expenseDate: dateFilter };
    if (companyId) where.affiliatedCompanyId = companyId;
    if (statusParam === "pending" || statusParam === "verified") where.status = statusParam;
    if (categoryId) {
      where.lines = { some: { categoryId } };
    }

    let vouchers = await prisma.expenseVoucher.findMany({
      where,
      include: expenseVoucherInclude,
      orderBy: [{ voucherNo: "asc" }],
    });
    if (vendorQ) {
      vouchers = vouchers.filter((v) => v.vendorName.toLowerCase().includes(vendorQ));
    }
    res.json({ ok: true, data: buildExpenseSummary(vouchers, dateParam) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers/reports/monthly", async (req, res) => {
  try {
    const ym = typeof req.query.ym === "string" ? req.query.ym.trim() : "";
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      res.status(400).json({ ok: false, message: "ym 格式須為 YYYY-MM" });
      return;
    }
    const [y, m] = ym.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 1);
    const vouchers = await prisma.expenseVoucher.findMany({
      where: { expenseDate: { gte: start, lt: end } },
      include: expenseVoucherInclude,
      orderBy: [{ expenseDate: "asc" }, { voucherNo: "asc" }],
    });
    res.json({ ok: true, data: buildExpenseSummary(vouchers, ym) });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers/reports/by-category", async (req, res) => {
  try {
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const where: Prisma.ExpenseVoucherWhereInput = {};
    if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.expenseDate = range;
    }
    const vouchers = await prisma.expenseVoucher.findMany({
      where,
      include: expenseVoucherInclude,
    });
    const summary = buildExpenseSummary(vouchers, `${dateFromParam || "—"} ~ ${dateToParam || "—"}`);
    res.json({ ok: true, data: summary.byCategory });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers", async (req, res) => {
  try {
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const dateFromParam = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
    const dateToParam = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const companyId = toBigInt(req.query.companyId);
    const categoryId = toBigInt(req.query.categoryId);
    const customerId = toBigInt(req.query.customerId);
    const vendorQ = typeof req.query.vendor === "string" ? req.query.vendor.trim().toLowerCase() : "";

    const where: Prisma.ExpenseVoucherWhereInput = {};
    if (statusParam === "pending" || statusParam === "verified") where.status = statusParam;
    if (companyId) where.affiliatedCompanyId = companyId;
    if (dateParam) {
      const dateFilter = dbDateEqualsFilter(dateParam);
      if (!dateFilter) {
        res.status(400).json({ ok: false, message: "date 格式須為 YYYY-MM-DD" });
        return;
      }
      where.expenseDate = dateFilter;
    } else if (dateFromParam || dateToParam) {
      const range: Prisma.DateTimeFilter = {};
      if (dateFromParam) {
        const parsedFrom = parseLocalYmdRange(dateFromParam);
        if (!parsedFrom) {
          res.status(400).json({ ok: false, message: "dateFrom 格式須為 YYYY-MM-DD" });
          return;
        }
        range.gte = parsedFrom.start;
      }
      if (dateToParam) {
        const parsedTo = parseLocalYmdRange(dateToParam);
        if (!parsedTo) {
          res.status(400).json({ ok: false, message: "dateTo 格式須為 YYYY-MM-DD" });
          return;
        }
        range.lt = parsedTo.end;
      }
      where.expenseDate = range;
    }
    if (categoryId || customerId) {
      where.lines = {
        some: {
          ...(categoryId ? { categoryId } : {}),
          ...(customerId ? { customerId } : {}),
        },
      };
    }

    let rows = await prisma.expenseVoucher.findMany({
      where,
      include: expenseVoucherInclude,
      orderBy: [{ expenseDate: "desc" }, { voucherNo: "desc" }],
      take: 400,
    });

    if (q || vendorQ) {
      const needle = q || vendorQ;
      rows = rows.filter((v) => {
        const hay = [
          v.voucherNo,
          v.vendorName,
          v.remark,
          v.affiliatedCompany?.name,
          ...v.lines.map((l) => [l.itemName, l.category?.name, l.customer?.name].filter(Boolean).join(" ")),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }

    res.json(rows.slice(0, 300));
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.get("/api/expense-vouchers/:voucherId", async (req, res) => {
  try {
    const voucherId = toBigInt(req.params.voucherId);
    if (!voucherId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const row = await prisma.expenseVoucher.findUnique({
      where: { id: voucherId },
      include: expenseVoucherInclude,
    });
    if (!row) {
      res.status(404).json({ ok: false, message: "找不到支出憑證" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/expense-vouchers", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    const body = req.body as {
      expenseDateYmd?: unknown;
      vendorName?: unknown;
      affiliatedCompanyId?: unknown;
      invoiceDateYmd?: unknown;
      paymentMethod?: unknown;
      remark?: unknown;
      lines?: unknown;
    };

    const expenseDateYmd = typeof body.expenseDateYmd === "string" ? body.expenseDateYmd.trim() : "";
    const vendorName = typeof body.vendorName === "string" ? body.vendorName.trim() : "";
    const affiliatedCompanyId = toBigInt(body.affiliatedCompanyId);
    const invoiceDateYmd = typeof body.invoiceDateYmd === "string" ? body.invoiceDateYmd.trim() : "";
    const paymentMethod = normalizeExpensePaymentMethod(body.paymentMethod);
    const remark = typeof body.remark === "string" ? body.remark.trim() : "";

    if (!expenseDateYmd || !vendorName || !affiliatedCompanyId) {
      res.status(400).json({ ok: false, message: "支出日期、廠商／對象、發票歸屬公司為必填" });
      return;
    }
    if (vendorName.length > 200) {
      res.status(400).json({ ok: false, message: "廠商／對象不可超過 200 字" });
      return;
    }

    const expenseDate = parseLocalYmdToDbDate(expenseDateYmd);
    if (!expenseDate) {
      res.status(400).json({ ok: false, message: "expenseDateYmd 須為 YYYY-MM-DD" });
      return;
    }
    const companyOk = await assertAffiliatedCompanyId(affiliatedCompanyId);
    if (!companyOk) {
      res.status(400).json({ ok: false, message: "發票歸屬公司無效" });
      return;
    }

    let invoiceDate: Date | null = null;
    if (invoiceDateYmd) {
      invoiceDate = parseLocalYmdToDbDate(invoiceDateYmd);
      if (!invoiceDate) {
        res.status(400).json({ ok: false, message: "invoiceDateYmd 須為 YYYY-MM-DD" });
        return;
      }
    }

    const parsedLines = await parseExpenseLinesInput(body.lines);
    if (!parsedLines.ok) {
      res.status(400).json({ ok: false, message: parsedLines.message });
      return;
    }

    const creatorId = auth?.id ?? DEFAULT_CREATOR_USER_ID;
    const result = await prisma.$transaction(async (tx) => {
      const voucherNo = await allocateExpenseVoucherNo(tx, expenseDate);
      const voucher = await tx.expenseVoucher.create({
        data: {
          voucherNo,
          expenseDate,
          vendorName,
          affiliatedCompanyId,
          invoiceDate,
          paymentMethod,
          remark: remark || null,
          status: "pending",
          untaxedTotal: parsedLines.totals.untaxedTotal,
          taxTotal: parsedLines.totals.taxTotal,
          totalAmount: parsedLines.totals.totalAmount,
          createdByUserId: creatorId,
          lines: {
            create: parsedLines.lines.map((line) => ({
              categoryId: line.categoryId,
              itemName: line.itemName,
              customerId: line.customerId,
              qty: line.qty,
              unitPrice: line.unitPrice,
              taxMode: line.taxMode,
              taxAmount: line.taxAmount,
              lineAmount: line.lineAmount,
              sortOrder: line.sortOrder,
            })),
          },
        },
        include: expenseVoucherInclude,
      });
      return voucher;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.patch("/api/expense-vouchers/:voucherId", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    if (!auth) {
      res.status(401).json({ ok: false, message: "未登入" });
      return;
    }
    const voucherId = toBigInt(req.params.voucherId);
    if (!voucherId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const existing = await prisma.expenseVoucher.findUnique({ where: { id: voucherId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到支出憑證" });
      return;
    }
    if (!canModifyExpenseVoucher(auth, existing)) {
      res.status(403).json({ ok: false, message: existing.status === "verified" ? "已核銷不可修改" : "無權限修改此憑證" });
      return;
    }

    const body = req.body as {
      expenseDateYmd?: unknown;
      vendorName?: unknown;
      affiliatedCompanyId?: unknown;
      invoiceDateYmd?: unknown;
      paymentMethod?: unknown;
      remark?: unknown;
      lines?: unknown;
    };

    const headerData: Prisma.ExpenseVoucherUpdateInput = {};
    if (body.expenseDateYmd !== undefined) {
      const expenseDateYmd = typeof body.expenseDateYmd === "string" ? body.expenseDateYmd.trim() : "";
      const expenseDate = parseLocalYmdToDbDate(expenseDateYmd);
      if (!expenseDate) {
        res.status(400).json({ ok: false, message: "expenseDateYmd 須為 YYYY-MM-DD" });
        return;
      }
      headerData.expenseDate = expenseDate;
    }
    if (body.vendorName !== undefined) {
      const vendorName = typeof body.vendorName === "string" ? body.vendorName.trim() : "";
      if (!vendorName) {
        res.status(400).json({ ok: false, message: "廠商／對象不可為空" });
        return;
      }
      headerData.vendorName = vendorName;
    }
    if (body.affiliatedCompanyId !== undefined) {
      const affiliatedCompanyId = toBigInt(body.affiliatedCompanyId);
      if (!affiliatedCompanyId) {
        res.status(400).json({ ok: false, message: "發票歸屬公司無效" });
        return;
      }
      const companyOk = await assertAffiliatedCompanyId(affiliatedCompanyId);
      if (!companyOk) {
        res.status(400).json({ ok: false, message: "發票歸屬公司無效" });
        return;
      }
      headerData.affiliatedCompany = { connect: { id: affiliatedCompanyId } };
    }
    if (body.invoiceDateYmd !== undefined) {
      const invoiceDateYmd = typeof body.invoiceDateYmd === "string" ? body.invoiceDateYmd.trim() : "";
      if (!invoiceDateYmd) {
        headerData.invoiceDate = null;
      } else {
        const invoiceDate = parseLocalYmdToDbDate(invoiceDateYmd);
        if (!invoiceDate) {
          res.status(400).json({ ok: false, message: "invoiceDateYmd 須為 YYYY-MM-DD" });
          return;
        }
        headerData.invoiceDate = invoiceDate;
      }
    }
    if (body.paymentMethod !== undefined) {
      headerData.paymentMethod = normalizeExpensePaymentMethod(body.paymentMethod);
    }
    if (body.remark !== undefined) {
      headerData.remark = typeof body.remark === "string" && body.remark.trim() ? body.remark.trim() : null;
    }

    let parsedLines: Awaited<ReturnType<typeof parseExpenseLinesInput>> | null = null;
    if (body.lines !== undefined) {
      parsedLines = await parseExpenseLinesInput(body.lines);
      if (!parsedLines.ok) {
        res.status(400).json({ ok: false, message: parsedLines.message });
        return;
      }
      headerData.untaxedTotal = parsedLines.totals.untaxedTotal;
      headerData.taxTotal = parsedLines.totals.taxTotal;
      headerData.totalAmount = parsedLines.totals.totalAmount;
    }

    if (Object.keys(headerData).length === 0 && !parsedLines) {
      res.status(400).json({ ok: false, message: "沒有要更新的欄位" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      if (parsedLines?.ok) {
        await tx.expenseLine.deleteMany({ where: { expenseVoucherId: voucherId } });
        await tx.expenseLine.createMany({
          data: parsedLines.lines.map((line) => ({
            expenseVoucherId: voucherId,
            categoryId: line.categoryId,
            itemName: line.itemName,
            customerId: line.customerId,
            qty: line.qty,
            unitPrice: line.unitPrice,
            taxMode: line.taxMode,
            taxAmount: line.taxAmount,
            lineAmount: line.lineAmount,
            sortOrder: line.sortOrder,
          })),
        });
      }
      return tx.expenseVoucher.update({
        where: { id: voucherId },
        data: headerData,
        include: expenseVoucherInclude,
      });
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.delete("/api/expense-vouchers/:voucherId", async (req, res) => {
  try {
    const auth = getAuthUser(req);
    if (!auth) {
      res.status(401).json({ ok: false, message: "未登入" });
      return;
    }
    const voucherId = toBigInt(req.params.voucherId);
    if (!voucherId) {
      res.status(400).json({ ok: false, message: "參數錯誤" });
      return;
    }
    const existing = await prisma.expenseVoucher.findUnique({ where: { id: voucherId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "找不到支出憑證" });
      return;
    }
    if (!canModifyExpenseVoucher(auth, existing)) {
      res.status(403).json({ ok: false, message: existing.status === "verified" ? "已核銷不可刪除" : "無權限刪除此憑證" });
      return;
    }
    await prisma.expenseVoucher.delete({ where: { id: voucherId } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.post("/api/expense-vouchers/batch-verify", async (req, res) => {
  const auth = getAuthUser(req);
  if (!auth || !canVerifyExpense(auth)) {
    res.status(403).json({ ok: false, message: "僅會計或管理員可核銷支出" });
    return;
  }
  try {
    const body = req.body as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ ok: false, message: "請提供 ids 陣列" });
      return;
    }
    const ids = body.ids.map((id) => toBigInt(id)).filter((id): id is bigint => id != null);
    if (ids.length === 0) {
      res.status(400).json({ ok: false, message: "ids 無效" });
      return;
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const pending = await tx.expenseVoucher.findMany({
        where: { id: { in: ids }, status: "pending" },
        select: { id: true },
      });
      const pendingIds = pending.map((p) => p.id);
      if (pendingIds.length === 0) {
        return { count: 0 };
      }
      await tx.expenseVoucher.updateMany({
        where: { id: { in: pendingIds } },
        data: {
          status: "verified",
          verifiedAt: now,
          verifiedByUserId: auth.id,
        },
      });
      return { count: pendingIds.length };
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

registerLiffRoutes(app, {
  prisma,
  jwtSecret: JWT_SECRET,
  jwtSignOptions: JWT_SIGN_OPTIONS,
  createSalesOrder: createConfirmedSalesOrder,
  toBigInt,
  parseLocalYmdRange,
});

app.get("/api/notification-logs", async (req, res) => {
  try {
    const customerId = req.query.customerId ? toBigInt(req.query.customerId) : null;
    const eventType = typeof req.query.eventType === "string" ? req.query.eventType.trim() : "";
    const rows = await prisma.notificationLog.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        ...(eventType ? { eventType } : {}),
      },
      orderBy: { id: "desc" },
      take: 100,
    });
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** P5：查詢營業日關帳狀態 */
app.get("/api/admin/day-close", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const dateRaw = typeof req.query.date === "string" ? req.query.date.trim() : toLocalYmd(new Date());
    const businessDate = parseLocalYmdToDbDate(dateRaw);
    if (!businessDate) {
      res.status(400).json({ ok: false, message: "date 須為 YYYY-MM-DD" });
      return;
    }
    const row = await prisma.dayCloseLock.findUnique({
      where: { businessDate },
      include: {
        lockedBy: { select: { id: true, name: true, employeeCode: true } },
        unlockedBy: { select: { id: true, name: true, employeeCode: true } },
      },
    });
    const locked = Boolean(row && row.unlockedAt == null);

    // 關帳前檢查清單（與核銷／異常中心對齊）
    const dayRange = parseLocalYmdRange(dateRaw);
    let checklist: {
      pendingSettlement: number;
      cashShort: number;
      deliveredUnpaid: number;
      assignedUnreported: number;
    } | null = null;
    if (dayRange) {
      const [pendingSettlement, cashShort, deliveredUnpaid, assignedUnreported] = await Promise.all([
        prisma.deliveryAssignment.count({
          where: {
            status: "pending_settlement",
            OR: [
              { assignmentDate: businessDate },
              { driverReportedAt: { gte: dayRange.start, lt: dayRange.end } },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            status: "pending_settlement",
            settlementOutcome: "delivered_cash_short",
            OR: [
              { assignmentDate: businessDate },
              { driverReportedAt: { gte: dayRange.start, lt: dayRange.end } },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            status: "pending_settlement",
            settlementOutcome: "delivered_no_cash",
            OR: [
              { assignmentDate: businessDate },
              { driverReportedAt: { gte: dayRange.start, lt: dayRange.end } },
            ],
          },
        }),
        prisma.deliveryAssignment.count({
          where: {
            status: { in: ["assigned", "delivering"] },
            driverReportedAt: null,
            assignmentDate: businessDate,
          },
        }),
      ]);
      checklist = { pendingSettlement, cashShort, deliveredUnpaid, assignedUnreported };
    }

    res.json({
      ok: true,
      data: {
        businessDate: dateRaw.slice(0, 10),
        locked,
        lock: row,
        checklist,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** P5：鎖定營業日（關帳） */
app.post("/api/admin/day-close/lock", async (req, res) => {
  const auth = requireRole(req, res, ["admin"]);
  if (!auth) return;
  try {
    const body = req.body as { date?: unknown; note?: unknown; force?: unknown };
    const dateRaw = typeof body.date === "string" ? body.date.trim() : toLocalYmd(new Date());
    const businessDate = parseLocalYmdToDbDate(dateRaw);
    if (!businessDate) {
      res.status(400).json({ ok: false, message: "date 須為 YYYY-MM-DD" });
      return;
    }
    const force = body.force === true || body.force === 1 || body.force === "1";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    const now = new Date();
    const existing = await prisma.dayCloseLock.findUnique({ where: { businessDate } });
    if (existing && existing.unlockedAt == null) {
      res.status(400).json({ ok: false, message: "此營業日已關帳" });
      return;
    }

    const dayRange = parseLocalYmdRange(dateRaw);
    if (dayRange && !force) {
      const blockers = await prisma.deliveryAssignment.count({
        where: {
          OR: [
            {
              status: "pending_settlement",
              OR: [
                { assignmentDate: businessDate },
                { driverReportedAt: { gte: dayRange.start, lt: dayRange.end } },
              ],
            },
            {
              status: { in: ["assigned", "delivering"] },
              driverReportedAt: null,
              assignmentDate: businessDate,
            },
          ],
        },
      });
      if (blockers > 0) {
        res.status(409).json({
          ok: false,
          message: `尚有 ${blockers} 筆未核銷／未回報任務，請確認後以 force=1 二次確認關帳`,
          code: "DAY_CLOSE_HAS_EXCEPTIONS",
          blockerCount: blockers,
        });
        return;
      }
    }

    const row = existing
      ? await prisma.dayCloseLock.update({
          where: { businessDate },
          data: {
            lockedAt: now,
            lockedByUserId: auth.id,
            unlockedAt: null,
            unlockedByUserId: null,
            note,
          },
        })
      : await prisma.dayCloseLock.create({
          data: {
            businessDate,
            lockedAt: now,
            lockedByUserId: auth.id,
            note,
          },
        });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** P5：解鎖營業日 */
app.post("/api/admin/day-close/unlock", async (req, res) => {
  const auth = requireRole(req, res, ["admin"]);
  if (!auth) return;
  try {
    const body = req.body as { date?: unknown; note?: unknown };
    const dateRaw = typeof body.date === "string" ? body.date.trim() : toLocalYmd(new Date());
    const businessDate = parseLocalYmdToDbDate(dateRaw);
    if (!businessDate) {
      res.status(400).json({ ok: false, message: "date 須為 YYYY-MM-DD" });
      return;
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    const existing = await prisma.dayCloseLock.findUnique({ where: { businessDate } });
    if (!existing || existing.unlockedAt != null) {
      res.status(400).json({ ok: false, message: "此營業日未關帳或已解鎖" });
      return;
    }
    const row = await prisma.dayCloseLock.update({
      where: { businessDate },
      data: {
        unlockedAt: new Date(),
        unlockedByUserId: auth.id,
        ...(note ? { note } : {}),
      },
    });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

/** P5：簡易備份匯出（主檔計數＋近 30 日訂單 id，JSON 下載） */
app.get("/api/admin/backup-export", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [
      customers,
      products,
      drivers,
      vehicles,
      users,
      recentOrders,
      pendingSettlementCount,
      openArCount,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count(),
      prisma.driver.count(),
      prisma.vehicle.count(),
      prisma.user.count(),
      prisma.salesOrder.findMany({
        where: { createdAt: { gte: since } },
        select: {
          id: true,
          orderNo: true,
          status: true,
          customerId: true,
          totalAmount: true,
          createdAt: true,
          scheduledDeliveryDate: true,
        },
        orderBy: { id: "desc" },
        take: 5000,
      }),
      prisma.deliveryAssignment.count({ where: { status: "pending_settlement" } }),
      prisma.arOpenItem.count({ where: activeArOpenItemWhere({}) }),
    ]);

    const payload = {
      exportedAt: now.toISOString(),
      exportedByUserId: getAuthUser(req)?.id?.toString() ?? null,
      kind: "watererp_backup_export_v1",
      masters: {
        customers,
        products,
        drivers,
        vehicles,
        users,
      },
      operational: {
        pendingSettlementCount,
        openArCount,
      },
      recentOrdersWindowDays: 30,
      recentOrders: recentOrders.map((o) => ({
        id: o.id.toString(),
        orderNo: o.orderNo,
        status: o.status,
        customerId: o.customerId.toString(),
        totalAmount: o.totalAmount.toString(),
        createdAt: o.createdAt.toISOString(),
        scheduledDeliveryDate: o.scheduledDeliveryDate
          ? toLocalYmd(new Date(o.scheduledDeliveryDate))
          : null,
      })),
    };

    const ymd = toLocalYmd(now);
    const body = JSON.stringify(payload, null, 2);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="watererp-backup-${ymd}.json"`);
    res.send(body);
  } catch (e) {
    res.status(500).json({ ok: false, message: publicErrorMessage(e) });
  }
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
