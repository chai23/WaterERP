import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import { randomBytes } from "crypto";
import jwt, { type JwtPayload, type Secret, type SignOptions } from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST ?? "127.0.0.1";
const DEFAULT_CREATOR_USER_ID = 1n;
const JWT_SECRET: Secret = process.env.JWT_SECRET ?? "change-me";
const JWT_SIGN_OPTIONS = { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" } as SignOptions;

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
};

const publicApiPaths = new Set(["/api/health", "/api/auth/login", "/api/auth/bootstrap"]);

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

const allocatePickupNo = async (tx: Prisma.TransactionClient, pickupDate: Date): Promise<string> => {
  const yyyy = pickupDate.getFullYear();
  const mm = String(pickupDate.getMonth() + 1).padStart(2, "0");
  const dd = String(pickupDate.getDate()).padStart(2, "0");
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

/** 現金應收／沖銷相關分錄（用於加總「現金欠款」與 FIFO；不含月結／預付） */
const CASH_AR_ENTRY_TYPES: readonly string[] = [
  "cash_ar_accrual",
  "cash_receipt_alloc",
  "cash_variance_short",
  "cash_variance_over",
  "cash_offset_order",
];

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
    orderBy: [{ id: "desc" }],
  });
  if (opens.length === 0) return { appliedAmount: new Prisma.Decimal(0), balanceAfter: remain };

  const allocRows: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];
  for (const open of opens) {
    if (remain.lessThanOrEqualTo(0)) break;
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
  for (const i of items) {
    const sid = i.arDocument.billingStatementId;
    if (sid != null) stmtIds.add(sid);
  }
  for (const sid of stmtIds) {
    await syncOneBillingStatementPaidFields(tx, sid);
  }
}

async function applyAllocations(
  tx: Prisma.TransactionClient,
  args: { voucherId: bigint; openItemAmounts: Array<{ openItemId: bigint; amount: Prisma.Decimal }> },
) {
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
        allocatedAt: new Date(),
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

const LINE_BILLING_TYPES = ["cash", "monthly", "prepaid"] as const;

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

/** 截止日 YYYY-MM-DD：本地該日 00:00（UI／兼容舊欄位 cutoffStartsAtLocal）；配送區間上界請用 cutoffInclusiveDeliveryUpperBound */
function cutoffDateStartLocal(ymd: string): Date | null {
  const r = parseLocalYmdRange(ymd);
  return r?.start ?? null;
}

/** 截止日「含當日」：實際送貨日須嚴格早於「截止日翌日 00:00（本地）」（與 parseLocalYmdRange 之 end 相同） */
function cutoffInclusiveDeliveryUpperBound(ymd: string): Date | null {
  const r = parseLocalYmdRange(ymd);
  return r?.end ?? null;
}

/** 實際送貨時點：司機回報日 → 排程配送日 → 訂單預定配送日 */
function actualDeliveryInstant(so: {
  scheduledDeliveryDate: Date | null;
  assignments?: Array<{ driverReportedAt: Date | null; assignmentDate: Date | null }> | null;
} | null): Date | null {
  if (!so) return null;
  const a = so.assignments?.[0];
  const d = a?.driverReportedAt ?? a?.assignmentDate ?? so.scheduledDeliveryDate ?? null;
  return d ? new Date(d) : null;
}

type MonthlyFifoOrderRow = {
  id: bigint;
  orderNo: string;
  monthlyCap: Prisma.Decimal;
  monthlyReceivedAmount: Prisma.Decimal;
};

/** 月結收款：依訂單列 FIFO 沖銷；須在交易內呼叫。若實收大於待沖合計則拋錯 */
async function allocateMonthlyFifoToOrders(
  tx: Prisma.TransactionClient,
  params: {
    customerId: bigint;
    orders: MonthlyFifoOrderRow[];
    payDec: Prisma.Decimal;
    paymentId: bigint;
    paymentNoteBase: string;
    createdByUserId: bigint;
  },
): Promise<{
  allocations: Array<{
    orderId: string;
    orderNo: string;
    allocated: string;
    newMonthlyReceived: string;
    fullyPaid: boolean;
  }>;
  openItemAmounts: Array<{ openItemId: bigint; amount: Prisma.Decimal }>;
}> {
  const { customerId, orders, payDec, paymentId, createdByUserId, paymentNoteBase } = params;
  let remaining = payDec;
  const out: Array<{
    orderId: string;
    orderNo: string;
    allocated: string;
    newMonthlyReceived: string;
    fullyPaid: boolean;
  }> = [];
  const openItemAmounts: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];

  for (const o of orders) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const outstanding = o.monthlyCap.minus(o.monthlyReceivedAmount);
    if (outstanding.lessThanOrEqualTo(0)) continue;
    const take = decMin(remaining, outstanding);
    if (take.lessThanOrEqualTo(0)) continue;
    const newReceived = o.monthlyReceivedAmount.plus(take);
    const fullyPaid = newReceived.greaterThanOrEqualTo(o.monthlyCap);
    let orderRemain = take;
    const orderOpenItems = await tx.arOpenItem.findMany({
      where: {
        customerId,
        salesOrderId: o.id,
        outstandingAmount: { gt: new Prisma.Decimal(0) },
        arDocument: { billingType: "monthly" },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });
    for (const open of orderOpenItems) {
      if (orderRemain.lessThanOrEqualTo(0)) break;
      const use = decMin(orderRemain, new Prisma.Decimal(open.outstandingAmount));
      if (use.lessThanOrEqualTo(0)) continue;
      openItemAmounts.push({ openItemId: open.id, amount: use });
      orderRemain = orderRemain.minus(use);
    }
    if (orderRemain.greaterThan(0)) throw new Error(`MONTHLY_AR_MISMATCH:${o.orderNo}`);

    await tx.customerLedgerEntry.create({
      data: {
        customerId,
        entryType: "monthly_receipt_alloc",
        amount: take.negated(),
        salesOrderId: o.id,
        paymentId,
        note: `${paymentNoteBase}｜FIFO 沖銷 ${o.orderNo}`,
        createdByUserId,
      },
    });
    await tx.salesOrder.update({
      where: { id: o.id },
      data: {
        monthlyReceivedAmount: newReceived,
        monthlyPeriodPaid: fullyPaid,
      },
    });
    remaining = remaining.minus(take);
    out.push({
      orderId: o.id.toString(),
      orderNo: o.orderNo,
      allocated: take.toString(),
      newMonthlyReceived: newReceived.toString(),
      fullyPaid,
    });
  }

  if (remaining.greaterThan(0)) {
    throw new Error("MONTHLY_OVERPAY");
  }
  return { allocations: out, openItemAmounts };
}

async function sumCashArBalanceForCustomer(
  tx: Pick<PrismaClient, "customerLedgerEntry">,
  customerId: bigint,
): Promise<Prisma.Decimal> {
  const agg = await tx.customerLedgerEntry.aggregate({
    where: { customerId, entryType: { in: [...CASH_AR_ENTRY_TYPES] } },
    _sum: { amount: true },
  });
  return new Prisma.Decimal(agg._sum.amount ?? 0);
}

/** 依 sales_order_id 由小到大（先進先出）回傳仍有未沖銷餘額之訂單 */
async function getOpenCashArByOrderOldestFirst(
  tx: Pick<PrismaClient, "customerLedgerEntry">,
  customerId: bigint,
): Promise<Array<{ salesOrderId: bigint; balance: Prisma.Decimal }>> {
  const rows = await tx.customerLedgerEntry.groupBy({
    by: ["salesOrderId"],
    where: {
      customerId,
      salesOrderId: { not: null },
      entryType: { in: [...CASH_AR_ENTRY_TYPES] },
    },
    _sum: { amount: true },
  });
  const list: Array<{ salesOrderId: bigint; balance: Prisma.Decimal }> = [];
  for (const r of rows) {
    if (r.salesOrderId == null) continue;
    const bal = new Prisma.Decimal(r._sum.amount ?? 0);
    if (bal.greaterThan(0)) {
      list.push({ salesOrderId: r.salesOrderId, balance: bal });
    }
  }
  list.sort((a, b) => (a.salesOrderId < b.salesOrderId ? -1 : a.salesOrderId > b.salesOrderId ? 1 : 0));
  return list;
}

/**
 * 現金核銷：本單立帳（應收）後，將實收依 FIFO 沖最舊未結清應收；沖完仍有剩餘則為多收。
 * 須在交易內呼叫；呼叫前勿已寫入本單之 cash_ar_accrual。
 */
async function postCashArAccrualAndFifoReceipt(
  tx: Pick<PrismaClient, "customerLedgerEntry">,
  params: {
    customerId: bigint;
    salesOrderId: bigint;
    orderNo: string;
    orderTotal: Prisma.Decimal;
    receivedDec: Prisma.Decimal;
    createdByUserId: bigint;
    /** 與辦公室核銷時間一致（略過則用 DB 預設 now） */
    bookedAt?: Date;
  },
): Promise<void> {
  const { customerId, salesOrderId, orderNo, orderTotal, receivedDec, createdByUserId, bookedAt } = params;
  const ledgerTime = bookedAt ? { createdAt: bookedAt } : {};

  await tx.customerLedgerEntry.create({
    data: {
      customerId,
      entryType: "cash_ar_accrual",
      amount: orderTotal,
      salesOrderId,
      note: `現金應收立帳（訂單 ${orderNo}）`,
      createdByUserId,
      ...ledgerTime,
    },
  });

  let remaining = receivedDec;
  while (remaining.greaterThan(0)) {
    const open = await getOpenCashArByOrderOldestFirst(tx, customerId);
    if (open.length === 0) break;
    const oldest = open[0]!;
    const take = decMin(remaining, oldest.balance);
    if (take.lessThanOrEqualTo(0)) break;
    await tx.customerLedgerEntry.create({
      data: {
        customerId,
        entryType: "cash_receipt_alloc",
        amount: take.negated(),
        salesOrderId: oldest.salesOrderId,
        note: `FIFO 沖銷現金收款（核銷訂單 ${orderNo}）`,
        createdByUserId,
        ...ledgerTime,
      },
    });
    remaining = remaining.minus(take);
  }

  if (remaining.greaterThan(0)) {
    await tx.customerLedgerEntry.create({
      data: {
        customerId,
        entryType: "cash_variance_over",
        amount: remaining.negated(),
        salesOrderId,
        note: `多收（FIFO 沖銷後剩餘）訂單 ${orderNo}`,
        createdByUserId,
        ...ledgerTime,
      },
    });
  }
}

/** 辦公室核銷：依收款方式入帳收款單並 FIFO 沖 AR */
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
    where: { customerId: args.customerId, outstandingAmount: { gt: new Prisma.Decimal(0) } },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
  const allocs: Array<{ openItemId: bigint; amount: Prisma.Decimal }> = [];
  for (const open of opens) {
    if (remain.lessThanOrEqualTo(0)) break;
    const take = decMin(remain, new Prisma.Decimal(open.outstandingAmount));
    if (take.lessThanOrEqualTo(0)) continue;
    allocs.push({ openItemId: open.id, amount: take });
    remain = remain.minus(take);
  }
  await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: allocs });
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
 * - **建議收款** = 客戶名下所有未沖銷 AR（現金／月結等）合計 − 預收錢包餘額（不低於 0）。
 * - **其他未清**：總未清 − 本張訂單已立帳之 open item（供 UI 區分本單與舊欠）。
 * 實收沖帳：見核銷流程依 dueDate、id **FIFO** 沖 open items。
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
  const [totalAgg, thisOrderAgg, wallet] = await Promise.all([
    tx.arOpenItem.aggregate({
      where: activeArOpenItemWhere({ customerId: args.customerId }),
      _sum: { outstandingAmount: true },
    }),
    tx.arOpenItem.aggregate({
      where: activeArOpenItemWhere({
        customerId: args.customerId,
        salesOrderId: args.currentSalesOrderId,
      }),
      _sum: { outstandingAmount: true },
    }),
    tx.customerPrepaymentWallet.findUnique({ where: { customerId: args.customerId } }),
  ]);
  const totalArOutstanding = new Prisma.Decimal(totalAgg._sum.outstandingAmount ?? 0);
  const thisOrderArOutstanding = new Prisma.Decimal(thisOrderAgg._sum.outstandingAmount ?? 0);
  const priorOtherOutstanding = totalArOutstanding.minus(thisOrderArOutstanding);
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
  const cashReceivablePortion = orderCashReceivablePortion({
    cashSubtotal: params.order.cashSubtotal ?? null,
    totalAmount: orderTotal,
    billingTypeAtOrder: params.order.billingTypeAtOrder ?? null,
    cashInvoiceMode: params.order.cashInvoiceMode ?? null,
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

const corsOrigin = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? true;

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || req.method === "OPTIONS" || publicApiPaths.has(req.path)) {
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
    const payload = jwt.verify(match[1], JWT_SECRET) as AuthPayload;
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
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(503).json({ ok: false, db: "error", message: String(e) });
  }
});

const customerMasterInclude = {
  addresses: { orderBy: { id: "asc" as const } },
  addressZone: { select: { id: true, name: true, isActive: true } },
  affiliatedCompany: { select: { id: true, name: true, isActive: true } },
} as const;

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

/** 二樓以上或地下樓（B1=-1）計入搬運獎金 */
function isFloorBonusEligible(floor: number): boolean {
  return floor >= 2 || floor < 0;
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
        product: { name: string; consumesPrepaidBarrel: boolean } | null;
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
    if ((line.linePurpose ?? "delivery") === "prepaid_barrel_topup") continue;
    if (!line.product?.consumesPrepaidBarrel) continue;
    await tx.floorDeliveryBonusRecord.create({
      data: {
        deliveryAssignmentId: opts.assignment.id,
        salesOrderId: opts.order.id,
        salesOrderLineId: line.id,
        orderNo: opts.order.orderNo,
        deliveryDate: opts.assignment.assignmentDate,
        driverId: opts.assignment.driverId,
        productId: line.productId,
        productName: line.product.name,
        qty: record.qty,
        floor: record.floor,
      },
    });
    created += 1;
  }
  return created;
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
        addresses: { orderBy: { id: "asc" } },
        salesOrders: {
          orderBy: { id: "desc" },
          take: 100,
          include: {
            deliveryAddress: true,
            lines: { include: { product: true } },
            assignments: {
              where: { status: { in: ["completed", "not_delivered"] } },
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

    // 同步修正：UI 顯示「月結已付」使用 sales_orders.monthlyPeriodPaid，
    // 但若沖帳走的是一般 receipt-voucher 路徑，DB 的 monthlyPeriodPaid 可能未更新。
    // 此處用 AR（月結）是否仍有 outstandingAmount>0 做計算回填，確保「月結期別已付：是/否」一致。
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
        salesOrder: { select: { orderNo: true, createdAt: true } },
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
      list.push({
        productId: key,
        productName: r.product.name,
        unitPrice: r.unitPrice.toString(),
        orderNo: r.salesOrder.orderNo,
        orderedAt: r.salesOrder.createdAt.toISOString(),
      });
    }
    res.json({ ok: true, data: list });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/customers/:customerId/prepaid-topup", async (req, res) => {
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
};

const normalizeAddressCreates = (raw: unknown): AddressCreateRow[] | "INVALID_BARRELS" | "INVALID_FLOOR" => {
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
    });
  }
  if (out.length > 0 && !out.some((a) => a.isDefault)) {
    out[0].isDefault = true;
  }
  return out;
};

app.post("/api/customers", async (req, res) => {
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
    if (addressCreates.length === 0) {
      res.status(400).json({ ok: false, message: "請至少新增一筆送貨地址（地址內容必填）" });
      return;
    }

    const created = await prisma.customer.create({
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

    res.status(201).json({ ok: true, data: enrichCustomerBarrels(created) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ ok: false, message: "客戶編號已存在，請改用其他 6 碼編號" });
      return;
    }
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.patch("/api/customers/:customerId", async (req, res) => {
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/customers/:customerId/addresses", async (req, res) => {
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
        },
      });
    });

    res.status(201).json({ ok: true, data: created });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.patch("/api/customers/:customerId/addresses/:addressId", async (req, res) => {
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
      include: { ...customerMasterInclude, addresses: { orderBy: { id: "asc" } } },
    });

    res.json({
      ok: true,
      data: updated,
      customer: fullCustomer ? enrichCustomerBarrels(fullCustomer) : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.delete("/api/customers/:customerId/addresses/:addressId", async (req, res) => {
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
      include: { ...customerMasterInclude, addresses: { orderBy: { id: "asc" } } },
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
    res.status(500).json({ ok: false, message: String(e) });
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
      salePrice?: unknown;
      costPrice?: unknown;
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
    const salePrice = Number(body.salePrice ?? 0);
    const costPrice = Number(body.costPrice ?? 0);
    const initialQty = Math.floor(Number(body.initialQty ?? 0));

    if (!name) {
      res.status(400).json({ ok: false, message: "商品名稱為必填" });
      return;
    }
    if (!Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(costPrice) || costPrice < 0) {
      res.status(400).json({ ok: false, message: "售價與成本須為非負數字" });
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
          salePrice,
          costPrice,
        } as Parameters<typeof tx.product.create>[0]["data"],
      });
      await tx.inventoryBalance.create({
        data: {
          productId: p.id,
          qtyOnHand: initialQty,
        },
      });
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
    res.status(500).json({ ok: false, message: String(e) });
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
      name?: unknown;
      unit?: unknown;
      salePrice?: unknown;
      costPrice?: unknown;
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
      name?: string;
      unit?: string;
      salePrice?: Prisma.Decimal;
      costPrice?: Prisma.Decimal;
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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

    const user = await prisma.user.findUnique({
      where: { employeeCode },
      include: { driver: true },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ ok: false, message: "帳號或密碼錯誤" });
      return;
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      res.status(401).json({ ok: false, message: "帳號或密碼錯誤" });
      return;
    }

    const token = jwt.sign(
      {
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/auth/bootstrap", async (req, res) => {
  try {
    const users = await prisma.user.count();
    if (users > 0) {
      res.status(409).json({ ok: false, message: "系統已有使用者，請由管理員新增帳號" });
      return;
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
    if (password.length < 6) {
      res.status(400).json({ ok: false, message: "密碼至少 6 字元" });
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
    const token = jwt.sign({ sub: user.id.toString(), role: user.role, employeeCode: user.employeeCode }, JWT_SECRET, JWT_SIGN_OPTIONS);
    res.status(201).json({ ok: true, token, user: toPublicUser(user) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    if (password.length < 6) {
      res.status(400).json({ ok: false, message: "密碼至少 6 字元" });
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
      if (body.password.length < 6) {
        res.status(400).json({ ok: false, message: "密碼至少 6 字元" });
        return;
      }
      data.passwordHash = await hashPassword(body.password);
    }
    const row = await prisma.user.update({ where: { id: userId }, data, include: { driver: true } });
    res.json({ ok: true, data: toPublicUser(row) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    if (!oldPassword || newPassword.length < 6) {
      res.status(400).json({ ok: false, message: "請輸入原密碼，且新密碼至少 6 字元" });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

/** 新增司機：建立 User（員編登入 + 聯絡手機）+ Driver（employee_code 與 users 同步） */
app.post("/api/drivers", async (req, res) => {
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
    if (password.length < 6) {
      res.status(400).json({ ok: false, message: "密碼至少 6 字元" });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.patch("/api/drivers/:driverId", async (req, res) => {
  if (!requireRole(req, res, ["admin"])) return;
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
      vehicleId?: unknown;
      isActive?: unknown;
      password?: unknown;
    };

    const driverData: {
      maxOrderCount?: number;
      maxBarrelQty?: number;
      vehicleId?: bigint | null;
      isActive?: boolean;
    } = {};
    let passwordHash: string | undefined;

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
      if (password.length < 6) {
        res.status(400).json({ ok: false, message: "密碼至少 6 字元" });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.get("/api/sales-orders", async (_req, res) => {
  try {
    const rows = await prisma.salesOrder.findMany({
      include: {
        customer: true,
        deliveryAddress: true,
        lines: {
          include: { product: true },
        },
        taxInvoices: { orderBy: { id: "asc" } },
        assignments: {
          include: {
            driver: {
              include: {
                user: true,
              },
            },
            vehicle: true,
          },
        },
      },
      orderBy: { id: "desc" },
      take: 100,
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
        status: { notIn: ["completed", "cancelled"] },
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

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
      res.status(404).json({ ok: false, message: "找不到配送任務" });
      return;
    }
    if (assignment.status !== "pending_settlement") {
      res.status(400).json({ ok: false, message: "此任務不在「待辦公室核銷」狀態" });
      return;
    }

    const outcome = assignment.settlementOutcome;
    const order = assignment.salesOrder;
    const customerRow = order.customer;
    const cashReceivablePortion = orderCashReceivablePortion(order);
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

      res.json({ ok: true, data: result });
      return;
    }

    if (
      outcome !== "delivered_no_cash" &&
      outcome !== "delivered_cash_exact" &&
      outcome !== "delivered_cash_short" &&
      outcome !== "delivered_cash_over"
    ) {
      res.status(400).json({ ok: false, message: "無效的核銷結果，無法確認" });
      return;
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

      await tx.salesOrder.update({
        where: { id: assignment.salesOrderId },
        data: {
          status: "completed",
          lockVersion: { increment: 1 },
          pendingPrepaidTopupBarrels: barrelsTopupCredit,
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

      for (const line of assignment.salesOrder.lines) {
        if ((line.linePurpose ?? "delivery") === "prepaid_barrel_topup") {
          continue;
        }
        const qty = effectiveLineDeliveryQty(line);
        if (qty <= 0) continue;
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
        let inv = await tx.inventoryBalance.findUnique({ where: { productId: line.productId } });
        if (!inv) {
          await tx.inventoryBalance.create({
            data: { productId: line.productId, qtyOnHand: 0 },
          });
          inv = await tx.inventoryBalance.findUnique({ where: { productId: line.productId } });
        }
        if (inv) {
          await tx.inventoryBalance.update({
            where: { productId: line.productId },
            data: { qtyOnHand: inv.qtyOnHand - qty },
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
        if (barrelNet !== 0) {
          const addr = await tx.deliveryAddress.findFirst({
            where: { id: deliveryAddressId, customerId },
          });
          if (addr) {
            const newAddrBarrels = Math.max(0, addr.barrelsOnSite + barrelNet);
            await tx.deliveryAddress.update({
              where: { id: deliveryAddressId },
              data: { barrelsOnSite: newAddrBarrels },
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

      if (cashReceivablePortion.greaterThan(0)) {
        await postCashArAccrualAndFifoReceipt(tx, {
          customerId,
          salesOrderId: assignment.salesOrderId,
          orderNo: order.orderNo,
          orderTotal: cashReceivablePortion,
          receivedDec,
          createdByUserId: DEFAULT_CREATOR_USER_ID,
          bookedAt: settledAt,
        });
      }

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
            cashSettlementMode: effective === "cash" ? "fifo_cash_ar" : undefined,
            cashDue: cashDueResolved.toString(),
            expectedAmount: cashDueResolved.toString(),
            cashVariance: varianceDisplayResolved.toString(),
            orderNo: assignment.salesOrder.orderNo,
            officeSettledAt: settledAt.toISOString(),
          },
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

    res.json({ ok: true, data: result });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("PREPAID_INSUFFICIENT:")) {
      const [, pName, need, avail] = msg.split(":");
      res.status(400).json({
        ok: false,
        message: `預付桶商品額度不足：${pName} 需 ${need} 桶、可用 ${avail} 桶。請先儲值同商品桶數後再核銷。`,
      });
      return;
    }
    res.status(500).json({ ok: false, message: msg });
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
    res.status(500).json({ ok: false, message: String(e) });
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

/** 月結對帳：依核銷完成日曆月 YYYY-MM 列出該期月結訂單 */
app.get("/api/billing/monthly-orders", async (req, res) => {
  try {
    const period = String(req.query.period ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      res.status(400).json({ ok: false, message: "query period 須為 YYYY-MM" });
      return;
    }
    const customerId = req.query.customerId ? toBigInt(req.query.customerId) : null;
    const unpaidOnly = String(req.query.unpaidOnly ?? "true") !== "false";

    const where: Prisma.SalesOrderWhereInput = {
      billingPeriodKey: period,
      status: "completed",
    };
    if (customerId) where.customerId = customerId;
    if (unpaidOnly) where.monthlyPeriodPaid = false;

    const orders = await prisma.salesOrder.findMany({
      where,
      include: {
        customer: true,
        deliveryAddress: true,
        lines: { include: { product: true } },
      },
      orderBy: [{ officeSettledAt: "asc" }, { id: "asc" }],
    });
    const monthlyOrders = orders.filter(isMonthlyBillingOrder);
    const totalAmount = monthlyOrders.reduce((s, o) => s.add(orderMonthlyCap(o)), new Prisma.Decimal(0));

    res.json({
      ok: true,
      data: {
        period,
        totalAmount: totalAmount.toString(),
        orders: monthlyOrders,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

/** 月結待結清：依截止日（YYYY-MM-DD）＋客戶；含截止日當日；實際送貨日須早於「截止日翌日 00:00（本地）」 */
app.get("/api/billing/monthly-pending", async (req, res) => {
  try {
    const cutoffDate = String(req.query.cutoffDate ?? "").trim();
    const customerId = req.query.customerId ? toBigInt(req.query.customerId) : null;
    if (!customerId) {
      res.status(400).json({ ok: false, message: "請指定 customerId" });
      return;
    }
    const cutoffDayStart = cutoffDateStartLocal(cutoffDate);
    const deliveryUpper = cutoffInclusiveDeliveryUpperBound(cutoffDate);
    if (!cutoffDayStart || !deliveryUpper) {
      res.status(400).json({
        ok: false,
        message: "cutoffDate 須為 YYYY-MM-DD（含當日；以實際送貨日篩選）",
      });
      return;
    }
    const unpaidOnly = String(req.query.unpaidOnly ?? "true") !== "false";

    const orders = await prisma.salesOrder.findMany({
      where: {
        customerId,
        status: "completed",
        officeSettledAt: { not: null },
        ...(unpaidOnly ? { monthlyPeriodPaid: false } : {}),
      },
      include: {
        customer: true,
        deliveryAddress: true,
        lines: { include: { product: true } },
        billingStatementOrder: true,
        assignments: {
          where: { status: { in: ["completed", "not_delivered"] } },
          orderBy: [{ officeSettledAt: "desc" }, { completedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ id: "asc" }],
    });
    const monthlyOrders = orders
      .filter(isMonthlyBillingOrder)
      .filter((o) => {
        const t = actualDeliveryInstant(o);
        return t != null && t.getTime() < deliveryUpper.getTime();
      })
      .sort((a, b) => {
        const ta = actualDeliveryInstant(a)?.getTime() ?? 0;
        const tb = actualDeliveryInstant(b)?.getTime() ?? 0;
        return ta - tb || Number(a.id - b.id);
      });
    const totalOutstanding = monthlyOrders.reduce(
      (s, o) => s.add(orderMonthlyCap(o).minus(o.monthlyReceivedAmount)),
      new Prisma.Decimal(0),
    );

    res.json({
      ok: true,
      data: {
        cutoffDate,
        cutoffStartsAtLocal: cutoffDayStart.toISOString(),
        deliveryUpperBoundExclusiveLocal: deliveryUpper.toISOString(),
        totalOutstanding: totalOutstanding.toString(),
        orderCount: monthlyOrders.length,
        orders: monthlyOrders,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

/** 解析營運指標／報表用的本地日期區間 */
function resolveAccountingPeriodRange(
  range: string,
  startDate: string,
  endDate: string,
  now = new Date(),
): { start: Date; end: Date } | { error: string } {
  if (range === "month") {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
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
  const todayRange = parseLocalYmdRange(toLocalYmd(now));
  if (!todayRange) return { error: "本日區間解析失敗" };
  return { start: todayRange.start, end: todayRange.end };
}

async function buildAccountingPeriodSummary(start: Date, end: Date) {
  const [todayCompleted, periodPayments] = await Promise.all([
    prisma.deliveryAssignment.findMany({
      where: {
        status: "completed",
        completedAt: { gte: start, lt: end },
      },
      include: {
        salesOrder: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        paymentMethod: { not: "prepayment" },
      },
    }),
  ]);

  const orderIds = [...new Set(todayCompleted.map((row) => row.salesOrderId))];
  const periodOrderOutstandingAgg =
    orderIds.length > 0
      ? await prisma.arOpenItem.aggregate({
          where: activeArOpenItemWhere({ salesOrderId: { in: orderIds } }),
          _sum: { outstandingAmount: true },
        })
      : { _sum: { outstandingAmount: null } };

  const periodRevenue = todayCompleted.reduce(
    (sum, row) => sum + Number(orderBillableAmount(row.salesOrder)),
    0,
  );
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
  const todayCompletedCount = todayCompleted.length;
  const periodOrderOutstanding = Number(periodOrderOutstandingAgg._sum.outstandingAmount ?? 0);
  const driverCashCollected = todayCompleted.reduce((sum, row) => sum + Number(row.cashReceived ?? 0), 0);

  return {
    periodRevenue,
    periodCollected,
    periodCollectedCash,
    periodCollectedTransfer,
    periodCollectedOther,
    todayCompletedCount,
    periodOrderOutstanding,
    driverCashCollected,
    todayCompleted,
    periodPayments,
  };
}

app.get("/api/accounting/summary", async (req, res) => {
  try {
    const now = new Date();
    const range = String(req.query.range ?? "today");
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";

    const resolved = resolveAccountingPeriodRange(range, startDate, endDate, now);
    if ("error" in resolved) {
      res.status(400).json({ ok: false, message: resolved.error });
      return;
    }
    const { start, end } = resolved;

    const summary = await buildAccountingPeriodSummary(start, end);

    res.json({
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
      // 相容舊欄位名稱
      todayRevenue: summary.periodRevenue,
      todayCashReceived: summary.periodCollectedCash,
      unpaidAmount: summary.periodOrderOutstanding,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

/** 日報／月報明細：區間內配送、收款與彙總（伺服器端篩選，不受列表筆數上限影響） */
app.get("/api/reports/period-detail", async (req, res) => {
  try {
    const range = String(req.query.range ?? "today");
    if (range !== "today" && range !== "month") {
      res.status(400).json({ ok: false, message: "range 須為 today 或 month" });
      return;
    }
    const resolved = resolveAccountingPeriodRange(range, "", "", new Date());
    if ("error" in resolved) {
      res.status(400).json({ ok: false, message: resolved.error });
      return;
    }
    const { start, end } = resolved;

    const summary = await buildAccountingPeriodSummary(start, end);

    const deliveries = await prisma.deliveryAssignment.findMany({
      where: {
        status: "completed",
        completedAt: { gte: start, lt: end },
      },
      include: {
        salesOrder: { include: { customer: true } },
        driver: { include: { user: true } },
        vehicle: true,
      },
      orderBy: { completedAt: "desc" },
    });

    const payments = await prisma.payment.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        paymentMethod: { not: "prepayment" },
      },
      include: {
        customer: true,
        salesOrder: true,
      },
      orderBy: { paidAt: "desc" },
    });

    const enrichedDeliveries = deliveries.map((row) => ({
      ...row,
      salesOrder: row.salesOrder
        ? {
            ...row.salesOrder,
            orderBillableAmount: orderBillableAmount(row.salesOrder).toString(),
          }
        : null,
    }));

    res.json({
      ok: true,
      data: {
        range,
        startDate: toLocalYmd(start),
        endDate: toLocalYmd(new Date(end.getTime() - 1)),
        summary: {
          periodRevenue: summary.periodRevenue,
          periodCollected: summary.periodCollected,
          periodCollectedCash: summary.periodCollectedCash,
          periodCollectedTransfer: summary.periodCollectedTransfer,
          periodCollectedOther: summary.periodCollectedOther,
          todayCompletedCount: summary.todayCompletedCount,
          periodOrderOutstanding: summary.periodOrderOutstanding,
          driverCashCollected: summary.driverCashCollected,
        },
        deliveries: enrichedDeliveries,
        payments,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
            return {
              id: ln.id.toString(),
              productName,
              unit,
              qty,
              unitPrice: ln.unitPrice.toString(),
              lineAmount: ln.lineAmount.toString(),
              billingType: billing,
              linePurpose: purpose,
              label:
                purpose === "prepaid_barrel_topup"
                  ? `${productName} 儲值 ${qty} ${unit}`
                  : `${productName} × ${qty} ${unit}`,
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
        },
        orders,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/delivery-assignments", async (req, res) => {
  try {
    const body = req.body as {
      salesOrderId?: unknown;
      driverId?: unknown;
      vehicleId?: unknown;
      assignmentDate?: unknown;
    };

    const salesOrderId = toBigInt(body.salesOrderId);
    const driverId = toBigInt(body.driverId);
    const vehicleId =
      body.vehicleId != null && String(body.vehicleId).trim() !== "" ? toBigInt(body.vehicleId) : null;
    const assignmentDate = body.assignmentDate ? new Date(String(body.assignmentDate)) : new Date();
    if (!salesOrderId || !driverId || Number.isNaN(assignmentDate.getTime())) {
      res.status(400).json({ ok: false, message: "參數錯誤：salesOrderId / driverId / assignmentDate 必填" });
      return;
    }

    const order = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
    if (!order) {
      res.status(404).json({ ok: false, message: "找不到訂單" });
      return;
    }
    if (["completed", "cancelled"].includes(order.status)) {
      res.status(400).json({ ok: false, message: "此訂單狀態不可分派" });
      return;
    }
    const customer = await prisma.customer.findUnique({ where: { id: order.customerId } });
    if (!customer) {
      res.status(400).json({ ok: false, message: "客戶不存在" });
      return;
    }
    const arOutstanding = await prisma.arOpenItem.aggregate({
      where: activeArOpenItemWhere({ customerId: order.customerId }),
      _sum: { outstandingAmount: true },
    });
    const outstanding = new Prisma.Decimal(arOutstanding._sum.outstandingAmount ?? 0);
    if (new Prisma.Decimal(customer.creditLimit).greaterThan(0) && outstanding.greaterThan(new Prisma.Decimal(customer.creditLimit))) {
      res.status(400).json({ ok: false, message: "客戶欠款超過信用額度，已鎖定分派" });
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

    const existing = await prisma.deliveryAssignment.findFirst({
      where: {
        salesOrderId,
        status: { in: ["assigned", "delivering", "pending_settlement"] },
      },
      orderBy: { id: "desc" },
    });
    if (existing) {
      res.status(400).json({ ok: false, message: "此訂單已有進行中的分派" });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { status: "assigned", lockVersion: { increment: 1 } },
      });
      return tx.deliveryAssignment.create({
        data: {
          salesOrderId,
          driverId,
          vehicleId,
          assignmentDate,
          status: "assigned",
          assignedByUserId: DEFAULT_CREATOR_USER_ID,
        },
        include: {
          salesOrder: true,
          driver: { include: { user: true } },
          vehicle: true,
        },
      });
    });

    res.status(201).json({ ok: true, data: created });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/sales-orders", async (req, res) => {
  try {
    const body = req.body as {
      customerId?: unknown;
      deliveryAddressId?: unknown;
      productId?: unknown;
      qty?: unknown;
      lines?: unknown;
      scheduledDeliveryDate?: unknown;
      remark?: unknown;
      orderCashAdjustment?: unknown;
      cashInvoiceMode?: unknown;
    };

    const customerId = toBigInt(body.customerId);
    const deliveryAddressId = toBigInt(body.deliveryAddressId);

    if (!customerId || !deliveryAddressId) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId / deliveryAddressId 必填" });
      return;
    }

    type LineIn = {
      productId: bigint;
      qty: number;
      unitPrice: Prisma.Decimal | null;
      billingType: string;
      linePurpose: "delivery" | "prepaid_barrel_topup";
      invoiceMode: string | null;
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
        };
        const pid = toBigInt(r.productId);
        const q = Number(r.qty);
        if (!pid || !Number.isInteger(q) || q < 0) {
          res.status(400).json({ ok: false, message: "明細錯誤：每列需有效 productId 與 qty（非負整數，0 表示數量待定）" });
          return;
        }
        let unitPrice: Prisma.Decimal | null = null;
        if (r.unitPrice !== undefined && r.unitPrice !== null && r.unitPrice !== "") {
          const up = Number(r.unitPrice);
          if (!Number.isFinite(up) || up < 0) {
            res.status(400).json({ ok: false, message: "明細錯誤：unitPrice 須為非負數字" });
            return;
          }
          unitPrice = new Prisma.Decimal(up);
        }
        linesIn.push({
          productId: pid,
          qty: q,
          unitPrice,
          billingType: normalizeLineBillingType(r.billingType, "cash"),
          linePurpose: normalizeLinePurpose(r.linePurpose),
          invoiceMode: normalizeLineInvoiceMode(r.invoiceMode),
        });
      }
    } else {
      const productId = toBigInt(body.productId);
      const qty = Number(body.qty);
      if (!productId || !Number.isInteger(qty) || qty < 0) {
        res.status(400).json({ ok: false, message: "參數錯誤：請傳入 lines[] 或單筆 productId + qty（非負整數）" });
        return;
      }
      linesIn.push({ productId, qty, unitPrice: null, billingType: "cash", linePurpose: "delivery", invoiceMode: null });
    }

    if (linesIn.length === 0) {
      res.status(400).json({ ok: false, message: "至少需要一筆商品明細" });
      return;
    }

    const address = await prisma.deliveryAddress.findUnique({ where: { id: deliveryAddressId } });
    if (!address || address.customerId !== customerId) {
      res.status(400).json({ ok: false, message: "送貨地址不存在，或不屬於該客戶" });
      return;
    }

    const cust = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!cust) {
      res.status(400).json({ ok: false, message: "客戶不存在" });
      return;
    }

    const linesInResolved: LineIn[] = linesIn.map((l) => {
      const billingType =
        l.linePurpose === "prepaid_barrel_topup"
          ? "cash"
          : normalizeLineBillingType(l.billingType, cust.billingType);
      const invoiceMode = billingType === "cash" ? l.invoiceMode : null;
      return { ...l, billingType, invoiceMode };
    });

    for (const l of linesInResolved) {
      if (l.linePurpose === "prepaid_barrel_topup") {
        if (l.billingType !== "cash") {
          res.status(400).json({ ok: false, message: "預付桶儲值明細須為現金列（司機收款／匯款）" });
          return;
        }
      }
    }

    const distinctLineBillings = new Set(linesInResolved.map((l) => l.billingType));
    const billingTypeAtOrder =
      distinctLineBillings.size === 1 ? [...distinctLineBillings][0]! : "mixed";
    let orderCashAdjustment = new Prisma.Decimal(0);
    if (body.orderCashAdjustment !== undefined && body.orderCashAdjustment !== null && body.orderCashAdjustment !== "") {
      const adj = new Prisma.Decimal(Number(body.orderCashAdjustment));
      if (adj.lessThan(0)) {
        res.status(400).json({ ok: false, message: "本單往來補額不可為負" });
        return;
      }
      orderCashAdjustment = adj;
    }

    const uniqueIds = [...new Set(linesInResolved.map((l) => l.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: uniqueIds } } });
    const productById = new Map(products.map((p) => [p.id, p]));

    for (const l of linesInResolved) {
      const p = productById.get(l.productId);
      if (!p || !p.isActive) {
        res.status(400).json({ ok: false, message: "商品不存在或已停用" });
        return;
      }
    }
    const prepaidTopupByProduct = sumPrepaidTopupByProduct(
      linesInResolved.map((l) => ({ productId: l.productId, qty: l.qty, linePurpose: l.linePurpose })),
    );
    const prepaidNeedByProduct = new Map<bigint, number>();
    for (const l of linesInResolved) {
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
          res.status(400).json({ ok: false, message });
          return;
        }
      }
    }

    let safeScheduled: Date | null = null;
    if (body.scheduledDeliveryDate !== undefined && body.scheduledDeliveryDate !== null && String(body.scheduledDeliveryDate).trim() !== "") {
      const raw = String(body.scheduledDeliveryDate).trim();
      // 對 date-only 輸入使用本地日期解析，避免 new Date("YYYY-MM-DD") 造成時區偏移。
      const ymdParsed = parseLocalYmdRange(raw);
      if (ymdParsed) {
        safeScheduled = ymdParsed.start;
      } else {
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          res.status(400).json({ ok: false, message: "scheduledDeliveryDate 格式錯誤（需 YYYY-MM-DD 或有效日期時間）" });
          return;
        }
        safeScheduled = parsed;
      }
    }

    const cashInvoiceMode = normalizeCashInvoiceMode(body.cashInvoiceMode);

    const lineCreates = linesInResolved.map((l) => {
      const product = productById.get(l.productId)!;
      const unitPrice = l.unitPrice ?? product.salePrice;
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

    const created = await prisma.$transaction(async (tx) => {
      const so = await tx.salesOrder.create({
        data: {
          orderNo: generateOrderNo(),
          customerId,
          deliveryAddressId,
          status: "confirmed",
          scheduledDeliveryDate: safeScheduled,
          subtotal,
          totalAmount: subtotal,
          remark: typeof body.remark === "string" ? body.remark.trim() || null : null,
          billingTypeAtOrder,
          cashSubtotal,
          monthlySubtotal,
          orderCashAdjustment,
          cashInvoiceMode: cashInvoiceMode === "none" ? null : cashInvoiceMode,
          createdByUserId: DEFAULT_CREATOR_USER_ID,
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
        createdByUserId: DEFAULT_CREATOR_USER_ID,
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

      return tx.salesOrder.findUnique({
        where: { id: so.id },
        include: {
          customer: true,
          deliveryAddress: true,
          lines: { include: { product: true } },
        },
      });
    });

    res.status(201).json({ ok: true, data: created });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
      const floorBonusCreated = await createFloorBonusRecords(tx, {
        assignment,
        order,
        records: parsedFloorBonusRecords,
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
      res.status(400).json({ ok: false, message: "訂單應收已沖帳，無法變更配送數量" });
      return;
    }
    res.status(500).json({ ok: false, message: String(e) });
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
        return { ...row, driverBillingHints: hints };
      }),
    );

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/sales-orders/:salesOrderId/cancel", async (req, res) => {
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
        return tx.salesOrder.findUnique({
          where: { id: salesOrderId },
          include: { customer: true, deliveryAddress: true, lines: { include: { product: true } } },
        });
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

      return tx.salesOrder.findUnique({
        where: { id: salesOrderId },
        include: { customer: true, deliveryAddress: true, lines: { include: { product: true } } },
      });
    });

    if (!result) return;
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/ar/receipt-vouchers", async (req, res) => {
  try {
    const body = req.body as {
      customerId?: unknown;
      paymentMethod?: unknown;
      amount?: unknown;
      note?: unknown;
      allocations?: unknown;
      toPrepayment?: unknown;
      paidAt?: unknown;
    };
    const customerId = toBigInt(body.customerId);
    const amount = new Prisma.Decimal(Number(body.amount ?? 0));
    if (!customerId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 與 amount(>0) 必填" });
      return;
    }

    const toPrepayment = body.toPrepayment === true;
    const paidAtRaw = typeof body.paidAt === "string" ? body.paidAt.trim() : "";
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      res.status(400).json({ ok: false, message: "paidAt 須為有效日期時間" });
      return;
    }

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
        await applyAllocations(tx, { voucherId: voucher.id, openItemAmounts: allocRows });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.post("/api/customers/:customerId/prepayment-topup-money", async (req, res) => {
  try {
    const customerId = toBigInt(req.params.customerId);
    const amount = new Prisma.Decimal(Number(req.body?.amount ?? 0));
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const invoiceModeRaw = req.body?.invoiceMode;
    if (!customerId || amount.lessThanOrEqualTo(0)) {
      res.status(400).json({ ok: false, message: "參數錯誤：customerId 與 amount(>0) 必填" });
      return;
    }

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
          note: note || "預收款儲值",
          createdByUserId: DEFAULT_CREATOR_USER_ID,
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
        if (open.salesOrderId && open.arDocument.billingType === "cash") {
          creditNoteCashOrderIds.add(open.salesOrderId);
        }
        remain = remain.minus(take);
      }
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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

    /** 整期未稅加總後計稅（策略 A）；invoice_mode=tax_inclusive 目前與外加同款數字寫入憑證，後續可再拆含稅總額語意 */
    let taxAmount = new Prisma.Decimal(0);
    let totalWithTax = untaxedTotal;
    if (invoiceMode !== "none") {
      const c = computeTaxFromUntaxed(untaxedTotal, taxRate);
      taxAmount = c.taxAmount;
      totalWithTax = c.totalWithTax;
    }

    const dueDate = computeMonthlyDueDate(cust.monthlySettlementDay, new Date());

    const postedBundle = await prisma.$transaction(async (tx) => {
      const stmt = await tx.billingStatement.create({
        data: {
          statementNo: generateStatementNo(),
          customerId,
          status: "posted",
          cutoffDate: cutoffDayStart,
          untaxedTotal,
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
          documentAmount: untaxedTotal,
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
          originalAmount: untaxedTotal,
          allocatedAmount: new Prisma.Decimal(0),
          outstandingAmount: untaxedTotal,
          dueDate,
          expectedCollectDate: dueDate,
          status: arStatusFromOutstanding(untaxedTotal, dueDate),
        },
      });

      const orderNos = eligible.map((o) => o.orderNo).join("、");
      await tx.customerLedgerEntry.create({
        data: {
          customerId,
          entryType: "statement_monthly_ar",
          amount: untaxedTotal,
          salesOrderId: null,
          sourceType: "billing_statement",
          sourceId: stmt.id,
          note: `月結批次立帳 ${stmt.statementNo}（未稅 ${untaxedTotal.toString()}）：${orderNos}`,
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
              untaxedAmount: untaxedTotal,
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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

    const parsedDate = parseLocalYmdRange(pickupDateYmd);
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
      const pickupNo = await allocatePickupNo(tx, parsedDate.start);
      const row = await tx.barrelPickup.create({
        data: {
          pickupNo,
          customerId,
          deliveryAddressId,
          driverId,
          vehicleId,
          assignedByUserId: creatorId,
          createdByUserId: creatorId,
          pickupDate: parsedDate.start,
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
    res.status(500).json({ ok: false, message: String(e) });
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
        const parsed = parseLocalYmdRange(ymd);
        if (!parsed) {
          res.status(400).json({ ok: false, message: "pickupDateYmd 須為 YYYY-MM-DD" });
          return;
        }
        data.pickupDate = parsed.start;
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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

      return updated;
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
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
    res.status(500).json({ ok: false, message: String(e) });
  }
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
