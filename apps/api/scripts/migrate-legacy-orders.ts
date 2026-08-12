/**
 * 【已不建議使用】舊庫 order → 新庫 sales_orders / AR / 收款
 *
 * 現行策略：舊系統訂單改由後台「舊系統歷史訂單」唯讀查詢（LEGACY_DATABASE_URL），
 * 不要寫入新系統訂單流程。本腳本僅保留給特殊維護，啟動器已移除轉換訂單入口。
 *
 * 用法（若仍需手動）：
 *   npx tsx scripts/migrate-legacy-orders.ts --dry-run
 *   npx tsx scripts/migrate-legacy-orders.ts --customer 300181 --completion completed
 */
import "dotenv/config";
import { inspect } from "node:util";
import { Prisma, PrismaClient } from "@prisma/client";

/** 啟動器透過 pipe 讀取 stdout 時，盡量逐行輸出 */
function installLineLogger() {
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: 120 }))).join(" ");
  console.log = (...args: unknown[]) => {
    process.stdout.write(fmt(args) + "\n");
  };
  console.warn = (...args: unknown[]) => {
    process.stderr.write(fmt(args) + "\n");
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(fmt(args) + "\n");
  };
}
installLineLogger();

const LEGACY_DB = "database";
const PLACEHOLDER_PRODUCT_CODE = "LEG";
const PLACEHOLDER_PRODUCT_NAME = "舊系統虛擬列";
const LEGACY_NOTE_TAG = "legacy_import";

const LEGACY_PRODUCT_SKIP_IDS = new Set([
  "000",
  "0000",
  "130",
  "201",
  "202",
  "205",
  "206",
  "207",
  "223",
  "224",
  "222",
  "300",
  "301",
  "302",
  "303",
  "304",
  "305",
  "306",
  "307",
  "308",
  "309",
  "387",
  "388",
  "389",
  "399",
  "400",
]);

type CompletionFilter = "all" | "completed" | "incomplete";

type CliOptions = {
  dryRun: boolean;
  customer: string | null;
  from: string | null;
  to: string | null;
  completion: CompletionFilter;
  ordersOnly: boolean;
  arOnly: boolean;
  invoicesOnly: boolean;
  /** 對已匯入訂單補建 AR／匯款沖帳（方案 B 補跑） */
  rebuildPayments: boolean;
  limit: number | null;
};

type LegacyOrderLine = {
  order_id: string;
  order_day: Date | null;
  product_index: string | null;
  product_id: string | null;
  product_name: string | null;
  product_price: string | null;
  product_quantity: string | null;
  give_free: string | null;
  give_nofree: string | null;
  tex: string | null;
  subtotal: string | null;
  remark: string | null;
  customer_id: string | null;
  customer_bill_form: string | null;
  driver_id: string | null;
  order_OK: string | null;
  recyele_quantity: string | null;
  collect_money: string | null;
  collect_OK: string | null;
  assign_OK: string | null;
  bill_number: string | null;
  order_id_day: Date | null;
  maker: string | null;
};

type ReportShift = { order_id: string; morningorafternoon: string | null };
type InvoiceRow = {
  order_id: string;
  bill_number: string | null;
  company: string | null;
  invoice_date: Date | null;
};

type RemittanceRow = {
  remittance_list_id: number;
  remittance_day: Date | null;
  order_id: string;
  bank: string | null;
  money: string | null;
  money_remittance: string | null;
  remark: string | null;
  maker: string | null;
  hand_money: string | null;
  over_short_money: string | null;
  month_order_id: string | null;
};

function legacyDbUrl(): string {
  const legacyUrl = process.env.LEGACY_DATABASE_URL?.trim();
  if (legacyUrl) return legacyUrl;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL");
  return url.replace(/\/[^/?]+(\?.*)?$/, `/${LEGACY_DB}$1`);
}

function describeDbUrl(url: string): string {
  try {
    const normalized = url.includes("://") ? url.replace(/^mysql:\/\//i, "http://") : `http://${url}`;
    const u = new URL(normalized);
    const db = u.pathname.replace(/^\//, "") || LEGACY_DB;
    return `${u.hostname}:${u.port || "3306"}/${db}`;
  } catch {
    return "（無法解析連線字串）";
  }
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    customer: null,
    from: null,
    to: null,
    completion: "all",
    ordersOnly: false,
    arOnly: false,
    invoicesOnly: false,
    rebuildPayments: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`參數 ${a} 需要值`);
      return v;
    };
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--customer") opts.customer = next().trim();
    else if (a === "--from") opts.from = next().trim();
    else if (a === "--to") opts.to = next().trim();
    else if (a === "--completion") {
      const v = next().trim() as CompletionFilter;
      if (!["all", "completed", "incomplete"].includes(v)) {
        throw new Error(`--completion 必須為 all|completed|incomplete，收到：${v}`);
      }
      opts.completion = v;
    } else if (a === "--orders-only") opts.ordersOnly = true;
    else if (a === "--ar-only") opts.arOnly = true;
    else if (a === "--invoices-only") opts.invoicesOnly = true;
    else if (a === "--rebuild-payments") opts.rebuildPayments = true;
    else if (a === "--limit") opts.limit = Math.max(1, Number(next()));
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知參數：${a}`);
    }
  }
  if (opts.from && !/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) throw new Error("--from 格式須 YYYY-MM-DD");
  if (opts.to && !/^\d{4}-\d{2}-\d{2}$/.test(opts.to)) throw new Error("--to 格式須 YYYY-MM-DD");
  return opts;
}

function printHelp() {
  console.log(`用法：npx tsx scripts/migrate-legacy-orders.ts [選項]

  --dry-run                 只統計／預覽，不寫入
  --customer <代號>         只轉該客戶（舊庫 customer_id）
  --from YYYY-MM-DD         order_day 起（含）
  --to YYYY-MM-DD           order_day 迄（含）
  --completion <mode>       all | completed | incomplete
  --orders-only             只寫訂單／派送（不立 AR／收款／發票）
  --rebuild-payments        對已匯入訂單補建 AR＋匯款沖帳（方案 B）
  --limit N                 最多處理 N 張訂單（除錯）

方案 B：有金額即立 AR；remittance_list 轉收款憑證沖帳；已收無匯款則合成結清。
`);
}

function isTrue(v: string | null | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() === "true";
}

function parseNum(s: string | null | undefined, fallback = 0): number {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseQty(s: string | null | undefined): number {
  return Math.max(0, Math.floor(parseNum(s, 0)));
}

function normalizeCustomerCode(raw: string): string | null {
  const id = raw.trim();
  if (!/^\d+$/.test(id)) return null;
  return id.padStart(6, "0").slice(-6);
}

function mapBilling(collectMoney: string | null | undefined): "cash" | "monthly" | "prepaid" {
  const s = String(collectMoney ?? "").trim();
  if (s === "月結") return "monthly";
  if (s === "預收") return "prepaid";
  return "cash";
}

function mapInvoiceMode(billForm: string | null | undefined): "none" | "tax_inclusive" | "tax_exclusive" {
  const s = String(billForm ?? "").trim();
  if (!s || s === "不開") return "none";
  if (s.includes("含稅")) return "tax_inclusive";
  if (s.includes("未稅")) return "tax_exclusive";
  return "none";
}

function mapShift(v: string | null | undefined): "am" | "pm" | null {
  const s = String(v ?? "").trim();
  if (s === "上午") return "am";
  if (s === "下午") return "pm";
  return null;
}

function mapPayMethod(moneyRemittance: string | null | undefined, bank: string | null | undefined): string {
  const s = `${moneyRemittance ?? ""} ${bank ?? ""}`;
  if (/支票/.test(s)) return "check";
  if (/匯|銀行|轉帳|中信|合庫|玉山|國泰/.test(s)) return "bank_transfer";
  if (/預收|抵扣/.test(s)) return "prepayment";
  if (/現金/.test(s)) return "cash";
  return "cash";
}

function ymd(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function dateOnlyUtc(ymdStr: string): Date {
  return new Date(`${ymdStr}T00:00:00.000Z`);
}

function isVirtualLine(productId: string, productName: string): boolean {
  if (LEGACY_PRODUCT_SKIP_IDS.has(productId)) return true;
  if (/月結|請款|標語|未收款/.test(productName)) return true;
  return false;
}

async function ensureLegacyMapTable(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS legacy_id_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(32) NOT NULL,
      legacy_key VARCHAR(100) NOT NULL,
      new_id BIGINT UNSIGNED NOT NULL,
      meta_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_legacy_map (entity_type, legacy_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function upsertLegacyMap(
  prisma: PrismaClient,
  entityType: string,
  legacyKey: string,
  newId: bigint,
  meta?: Record<string, unknown>,
) {
  const metaJson = meta ? JSON.stringify(meta) : null;
  await prisma.$executeRaw`
    INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json)
    VALUES (${entityType}, ${legacyKey}, ${newId}, ${metaJson})
    ON DUPLICATE KEY UPDATE new_id = VALUES(new_id), meta_json = VALUES(meta_json)
  `;
}

async function loadMap(prisma: PrismaClient, entityType: string): Promise<Map<string, bigint>> {
  const rows = await prisma.$queryRaw<Array<{ legacy_key: string; new_id: bigint }>>`
    SELECT legacy_key, new_id FROM legacy_id_map WHERE entity_type = ${entityType}`;
  const map = new Map<string, bigint>();
  for (const r of rows) map.set(String(r.legacy_key).trim(), r.new_id);
  return map;
}

async function ensurePlaceholderProduct(prisma: PrismaClient, dryRun: boolean): Promise<bigint> {
  const existing = await prisma.product.findFirst({
    where: { OR: [{ productCode: PLACEHOLDER_PRODUCT_CODE }, { sku: PLACEHOLDER_PRODUCT_CODE }] },
  });
  if (existing) return existing.id;
  if (dryRun) {
    console.log(`[seed] dry-run：將建立占位商品 ${PLACEHOLDER_PRODUCT_CODE}`);
    return 0n;
  }
  const p = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        productCode: PLACEHOLDER_PRODUCT_CODE,
        sku: PLACEHOLDER_PRODUCT_CODE,
        name: PLACEHOLDER_PRODUCT_NAME,
        unit: "式",
        salePrice: 0,
        costPrice: 0,
        countsDepositBarrel: false,
        consumesPrepaidBarrel: false,
        isActive: true,
      },
    });
    await tx.inventoryBalance.create({ data: { productId: product.id, qtyOnHand: 0 } });
    return product;
  });
  console.log(`[seed] 已建立占位商品 id=${p.id.toString()} code=${PLACEHOLDER_PRODUCT_CODE}`);
  return p.id;
}

function buildWhereSql(opts: CliOptions): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  if (opts.customer) {
    const code = normalizeCustomerCode(opts.customer) ?? opts.customer.trim();
    parts.push("(TRIM(customer_id) = ? OR LPAD(TRIM(customer_id), 6, '0') = ?)");
    params.push(opts.customer.trim(), code);
  }
  if (opts.from) {
    parts.push("order_day >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    parts.push("order_day <= ?");
    params.push(opts.to);
  }
  if (opts.completion === "completed") {
    parts.push("order_OK = 'True'");
  } else if (opts.completion === "incomplete") {
    parts.push("(order_OK IS NULL OR order_OK <> 'True')");
  }
  return { sql: parts.join(" AND "), params };
}

async function fetchDistinctOrderIds(
  legacy: PrismaClient,
  opts: CliOptions,
): Promise<string[]> {
  const { sql, params } = buildWhereSql(opts);
  let q = `SELECT DISTINCT order_id FROM \`order\` WHERE ${sql} AND order_id IS NOT NULL AND TRIM(order_id) <> '' ORDER BY order_id`;
  if (opts.limit != null) q += ` LIMIT ${opts.limit}`;
  const rows = await legacy.$queryRawUnsafe<Array<{ order_id: string }>>(q, ...params);
  return rows.map((r) => String(r.order_id).trim()).filter(Boolean);
}

async function fetchLinesForOrders(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<LegacyOrderLine[]> {
  if (orderIds.length === 0) return [];
  const ph = orderIds.map(() => "?").join(",");
  return legacy.$queryRawUnsafe<LegacyOrderLine[]>(
    `SELECT order_id, order_day, product_index, product_id, product_name, product_price, product_quantity,
            give_free, give_nofree, tex, subtotal, remark, customer_id, customer_bill_form, driver_id,
            order_OK, recyele_quantity, collect_money, collect_OK, assign_OK, bill_number, order_id_day, maker
     FROM \`order\` WHERE order_id IN (${ph})
     ORDER BY order_id, CAST(product_index AS UNSIGNED), product_index`,
    ...orderIds,
  );
}

async function fetchShifts(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<Map<string, "am" | "pm">> {
  const map = new Map<string, "am" | "pm">();
  if (orderIds.length === 0) return map;
  const ph = orderIds.map(() => "?").join(",");
  const rows = await legacy.$queryRawUnsafe<ReportShift[]>(
    `SELECT order_id, morningorafternoon FROM report_day WHERE order_id IN (${ph})`,
    ...orderIds,
  );
  for (const r of rows) {
    const shift = mapShift(r.morningorafternoon);
    if (shift && !map.has(String(r.order_id).trim())) map.set(String(r.order_id).trim(), shift);
  }
  return map;
}

async function fetchInvoices(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<Map<string, InvoiceRow>> {
  const map = new Map<string, InvoiceRow>();
  if (orderIds.length === 0) return map;
  const ph = orderIds.map(() => "?").join(",");
  const rows = await legacy.$queryRawUnsafe<InvoiceRow[]>(
    `SELECT order_id, bill_number, company, invoice_date FROM order_invoice_detail WHERE order_id IN (${ph})`,
    ...orderIds,
  );
  for (const r of rows) {
    const oid = String(r.order_id).trim();
    if (!map.has(oid)) map.set(oid, r);
  }
  return map;
}

async function fetchRemittances(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<Map<string, RemittanceRow[]>> {
  const map = new Map<string, RemittanceRow[]>();
  if (orderIds.length === 0) return map;
  const ph = orderIds.map(() => "?").join(",");
  // 刻意不選 cheque_due_date（舊庫有 0000-00-00 會炸）
  const rows = await legacy.$queryRawUnsafe<RemittanceRow[]>(
    `SELECT remittance_list_id, remittance_day, order_id, bank, money, money_remittance,
            remark, maker, hand_money, over_short_money, month_order_id
     FROM remittance_list WHERE order_id IN (${ph})
     ORDER BY remittance_list_id`,
    ...orderIds,
  );
  for (const r of rows) {
    const oid = String(r.order_id).trim();
    const arr = map.get(oid) ?? [];
    arr.push(r);
    map.set(oid, arr);
  }
  return map;
}

function generateReceiptVoucherNo(kind: "R" | "S", key: string): string {
  const safe = key.replace(/\W/g, "").slice(-18);
  return `RVL${kind}${safe}`;
}

type TxClient = Prisma.TransactionClient;

async function upsertLegacyMapTx(
  tx: TxClient,
  entityType: string,
  legacyKey: string,
  newId: bigint,
  meta?: Record<string, unknown>,
) {
  const metaJson = meta ? JSON.stringify(meta) : null;
  await tx.$executeRaw`
    INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json)
    VALUES (${entityType}, ${legacyKey}, ${newId}, ${metaJson})
    ON DUPLICATE KEY UPDATE new_id = VALUES(new_id), meta_json = VALUES(meta_json)
  `;
}

async function ensureArForOrder(
  tx: TxClient,
  args: {
    salesOrderId: bigint;
    customerId: bigint;
    orderDay: Date | null;
    totals: ReturnType<typeof orderTotals>;
    billingTypeAtOrder: string;
  },
): Promise<number> {
  const existing = await tx.arDocument.count({ where: { salesOrderId: args.salesOrderId } });
  if (existing > 0) return 0;
  if (args.totals.total <= 0) return 0;

  const docs: Array<{ billingType: string; amount: number }> = [];
  if (args.totals.cash > 0) docs.push({ billingType: "cash", amount: args.totals.cash });
  if (args.totals.monthly > 0) docs.push({ billingType: "monthly", amount: args.totals.monthly });
  if (args.totals.prepaid > 0) docs.push({ billingType: "prepaid", amount: args.totals.prepaid });
  if (docs.length === 0) {
    const bt = args.billingTypeAtOrder === "mixed" ? "cash" : args.billingTypeAtOrder;
    docs.push({ billingType: bt, amount: args.totals.total });
  }

  let created = 0;
  for (const d of docs) {
    const ar = await tx.arDocument.create({
      data: {
        arNo: generateArNo(args.salesOrderId, d.billingType),
        customerId: args.customerId,
        salesOrderId: args.salesOrderId,
        documentType: "legacy_rebuild",
        billingType: d.billingType,
        documentAmount: new Prisma.Decimal(d.amount.toFixed(2)),
        dueDate: args.orderDay,
        status: "open",
        postedAt: args.orderDay ?? new Date(),
      },
    });
    await tx.arOpenItem.create({
      data: {
        arDocumentId: ar.id,
        customerId: args.customerId,
        salesOrderId: args.salesOrderId,
        originalAmount: new Prisma.Decimal(d.amount.toFixed(2)),
        allocatedAmount: new Prisma.Decimal(0),
        outstandingAmount: new Prisma.Decimal(d.amount.toFixed(2)),
        dueDate: args.orderDay,
        expectedCollectDate: args.orderDay,
        status: "unpaid",
      },
    });
    created++;
  }
  return created;
}

async function applyReceiptToOrderOpens(
  tx: TxClient,
  args: {
    customerId: bigint;
    salesOrderId: bigint;
    amount: number;
    paidAt: Date;
    paymentMethod: string;
    note: string;
    voucherNo: string;
  },
): Promise<{ voucherId: bigint; allocated: number }> {
  const amount = new Prisma.Decimal(args.amount.toFixed(2));
  if (amount.lessThanOrEqualTo(0)) return { voucherId: 0n, allocated: 0 };

  const voucher = await tx.receiptVoucher.create({
    data: {
      voucherNo: args.voucherNo,
      customerId: args.customerId,
      voucherType: "receipt",
      paymentMethod: args.paymentMethod,
      totalAmount: amount,
      unappliedAmount: amount,
      status: "posted",
      paidAt: args.paidAt,
      note: args.note.slice(0, 500),
      createdAt: args.paidAt,
    },
  });
  await tx.payment.create({
    data: {
      customerId: args.customerId,
      salesOrderId: args.salesOrderId,
      amount,
      paymentMethod: args.paymentMethod,
      note: args.note.slice(0, 500),
      paidAt: args.paidAt,
      createdAt: args.paidAt,
      receiptVoucherId: voucher.id,
    },
  });

  let remain = amount;
  let allocated = new Prisma.Decimal(0);
  const opens = await tx.arOpenItem.findMany({
    where: { salesOrderId: args.salesOrderId, outstandingAmount: { gt: 0 } },
    orderBy: [{ id: "asc" }],
  });
  for (const open of opens) {
    if (remain.lessThanOrEqualTo(0)) break;
    const take = remain.lessThan(open.outstandingAmount) ? remain : new Prisma.Decimal(open.outstandingAmount);
    if (take.lessThanOrEqualTo(0)) continue;
    await tx.arAllocationMap.create({
      data: {
        receiptVoucherId: voucher.id,
        arOpenItemId: open.id,
        allocatedAmount: take,
        allocatedAt: args.paidAt,
        note: LEGACY_NOTE_TAG,
      },
    });
    const newAllocated = new Prisma.Decimal(open.allocatedAmount).plus(take);
    const newOutstanding = new Prisma.Decimal(open.outstandingAmount).minus(take);
    await tx.arOpenItem.update({
      where: { id: open.id },
      data: {
        allocatedAmount: newAllocated,
        outstandingAmount: newOutstanding,
        status: newOutstanding.lessThanOrEqualTo(0) ? "paid" : "partially_paid",
      },
    });
    remain = remain.minus(take);
    allocated = allocated.plus(take);
  }

  const unapplied = remain.greaterThan(0) ? remain : new Prisma.Decimal(0);
  await tx.receiptVoucher.update({
    where: { id: voucher.id },
    data: {
      unappliedAmount: unapplied,
      status: unapplied.greaterThan(0) ? "partial" : "applied",
    },
  });

  const so = await tx.salesOrder.findUnique({ where: { id: args.salesOrderId } });
  if (so && (so.billingTypeAtOrder === "monthly" || Number(so.monthlySubtotal) > 0)) {
    const opensLeft = await tx.arOpenItem.findMany({
      where: { salesOrderId: args.salesOrderId },
      select: { outstandingAmount: true, originalAmount: true },
    });
    const outSum = opensLeft.reduce((s, o) => s + Number(o.outstandingAmount), 0);
    const origSum = opensLeft.reduce((s, o) => s + Number(o.originalAmount), 0);
    const received = Math.max(0, origSum - outSum);
    await tx.salesOrder.update({
      where: { id: args.salesOrderId },
      data: {
        monthlyReceivedAmount: new Prisma.Decimal(received.toFixed(2)),
        monthlyPeriodPaid: outSum <= 0.009,
      },
    });
  }

  return { voucherId: voucher.id, allocated: Number(allocated) };
}

async function settleOrderPlanB(
  tx: TxClient,
  args: {
    salesOrderId: bigint;
    customerId: bigint;
    orderId: string;
    orderDay: Date | null;
    collectOk: boolean;
    remittances: RemittanceRow[];
  },
  stats: Stats,
): Promise<void> {
  const opens = await tx.arOpenItem.findMany({
    where: { salesOrderId: args.salesOrderId },
    select: { id: true },
  });
  if (opens.length === 0) return;

  let anyReceipt = false;
  for (const rem of args.remittances) {
    const remKey = String(rem.remittance_list_id);
    const voucherNo = generateReceiptVoucherNo("R", remKey);
    const existsV = await tx.receiptVoucher.findUnique({ where: { voucherNo }, select: { id: true } });
    if (existsV) continue;
    const mapped = await tx.$queryRaw<Array<{ new_id: bigint }>>`
      SELECT new_id FROM legacy_id_map WHERE entity_type = 'remittance' AND legacy_key = ${remKey} LIMIT 1`;
    if (mapped[0]) continue;

    const money = parseNum(rem.money, 0);
    if (money <= 0) continue;
    const paidAt = rem.remittance_day ? dateOnlyUtc(ymd(rem.remittance_day)!) : args.orderDay ?? new Date();
    const note = [
      LEGACY_NOTE_TAG,
      `remittance#${remKey}`,
      rem.bank ? `bank=${rem.bank}` : null,
      rem.money_remittance ? `via=${rem.money_remittance}` : null,
      rem.over_short_money && Number(rem.over_short_money) !== 0 ? `over_short=${rem.over_short_money}` : null,
      rem.remark ? `remark=${rem.remark}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const { voucherId } = await applyReceiptToOrderOpens(tx, {
      customerId: args.customerId,
      salesOrderId: args.salesOrderId,
      amount: money,
      paidAt,
      paymentMethod: mapPayMethod(rem.money_remittance, rem.bank),
      note,
      voucherNo,
    });
    if (voucherId !== 0n) {
      anyReceipt = true;
      stats.receiptsCreated++;
      await upsertLegacyMapTx(tx, "remittance", remKey, voucherId, { orderId: args.orderId });
    }
  }

  const still = await tx.arOpenItem.findMany({
    where: { salesOrderId: args.salesOrderId, outstandingAmount: { gt: 0 } },
  });
  const remainAmt = still.reduce((s, o) => s + Number(o.outstandingAmount), 0);
  if (args.collectOk && remainAmt > 0.009) {
    const settleKey = args.orderId;
    const voucherNo = generateReceiptVoucherNo("S", settleKey);
    const existsV = await tx.receiptVoucher.findUnique({ where: { voucherNo }, select: { id: true } });
    const mapped = await tx.$queryRaw<Array<{ new_id: bigint }>>`
      SELECT new_id FROM legacy_id_map WHERE entity_type = 'legacy_settle_rv' AND legacy_key = ${settleKey} LIMIT 1`;
    if (!existsV && !mapped[0]) {
      const { voucherId } = await applyReceiptToOrderOpens(tx, {
        customerId: args.customerId,
        salesOrderId: args.salesOrderId,
        amount: remainAmt,
        paidAt: args.orderDay ?? new Date(),
        paymentMethod: "cash",
        note: `${LEGACY_NOTE_TAG} | synthetic_settle | order=${args.orderId}`,
        voucherNo,
      });
      if (voucherId !== 0n) {
        anyReceipt = true;
        stats.receiptsCreated++;
        await upsertLegacyMapTx(tx, "legacy_settle_rv", settleKey, voucherId);
      }
    }
  }

  if (anyReceipt) {
    for (const d of await tx.arDocument.findMany({ where: { salesOrderId: args.salesOrderId } })) {
      const items = await tx.arOpenItem.findMany({ where: { arDocumentId: d.id } });
      const out = items.reduce((s, i) => s + Number(i.outstandingAmount), 0);
      await tx.arDocument.update({
        where: { id: d.id },
        data: { status: out <= 0.009 ? "paid" : "open" },
      });
    }
  }
}

type Stats = {
  candidates: number;
  created: number;
  skippedExisting: number;
  skippedError: number;
  assignments: number;
  arCreated: number;
  invoicesCreated: number;
  receiptsCreated: number;
  paymentsRebuilt: number;
  exceptions: string[];
};

function pushEx(stats: Stats, msg: string) {
  if (stats.exceptions.length < 200) stats.exceptions.push(msg);
  console.warn(`  ! ${msg}`);
}

async function resolveCustomerId(
  customerMaps: { byCode: Map<string, bigint>; byLegacyId: Map<string, bigint> },
  rawCustomerId: string,
): Promise<bigint | null> {
  const raw = rawCustomerId.trim();
  if (!raw) return null;
  const byId = customerMaps.byLegacyId.get(raw);
  if (byId) return byId;
  const code = normalizeCustomerCode(raw);
  if (code) {
    const byCode = customerMaps.byCode.get(code);
    if (byCode) return byCode;
  }
  return customerMaps.byCode.get(raw) ?? null;
}

async function loadCustomerAddressMap(
  target: PrismaClient,
  customerIds: bigint[],
): Promise<Map<bigint, bigint>> {
  const map = new Map<bigint, bigint>();
  if (customerIds.length === 0) return map;
  const addrs = await target.deliveryAddress.findMany({
    where: { customerId: { in: customerIds } },
    orderBy: [{ isDefault: "desc" }, { id: "asc" }],
    select: { id: true, customerId: true },
  });
  for (const a of addrs) {
    if (!map.has(a.customerId)) map.set(a.customerId, a.id);
  }
  return map;
}

function groupLines(lines: LegacyOrderLine[]): Map<string, LegacyOrderLine[]> {
  const map = new Map<string, LegacyOrderLine[]>();
  for (const line of lines) {
    const oid = String(line.order_id).trim();
    const arr = map.get(oid) ?? [];
    arr.push(line);
    map.set(oid, arr);
  }
  return map;
}

function orderTotals(lines: LegacyOrderLine[]) {
  let subtotal = 0;
  let tax = 0;
  let cash = 0;
  let monthly = 0;
  let prepaid = 0;
  for (const l of lines) {
    const amt = parseNum(l.subtotal, 0);
    const t = parseNum(l.tex, 0);
    subtotal += amt;
    tax += t;
    const bt = mapBilling(l.collect_money);
    if (bt === "cash") cash += amt;
    else if (bt === "monthly") monthly += amt;
    else prepaid += amt;
  }
  return { subtotal, tax, cash, monthly, prepaid, total: subtotal };
}

function deriveStatus(lines: LegacyOrderLine[]): {
  status: string;
  needAssignment: boolean;
  assignmentStatus: string | null;
  collectOk: boolean;
} {
  const orderOk = lines.every((l) => isTrue(l.order_OK));
  const assignOk = lines.every((l) => isTrue(l.assign_OK));
  const collectOk = lines.every((l) => isTrue(l.collect_OK));
  const qtySum = lines.reduce((s, l) => s + parseQty(l.product_quantity), 0);

  if (orderOk) {
    return {
      status: "completed",
      needAssignment: true,
      assignmentStatus: "completed",
      collectOk,
    };
  }
  if (assignOk) {
    return {
      status: "assigned",
      needAssignment: true,
      assignmentStatus: "assigned",
      collectOk,
    };
  }
  return {
    status: qtySum > 0 ? "confirmed" : "draft",
    needAssignment: false,
    assignmentStatus: null,
    collectOk,
  };
}

function generateArNo(salesOrderId: bigint, billingType: string): string {
  const suf = billingType === "cash" ? "C" : billingType === "monthly" ? "M" : "P";
  return `ARL${salesOrderId.toString().padStart(10, "0")}${suf}`;
}

function generateTaxInvoiceNo(salesOrderId: bigint): string {
  return `TIL${salesOrderId.toString().padStart(12, "0")}`;
}

async function migrateOneOrder(args: {
  target: PrismaClient;
  lines: LegacyOrderLine[];
  shift: "am" | "pm" | null;
  invoice: InvoiceRow | null;
  remittances: RemittanceRow[];
  customerMaps: { byCode: Map<string, bigint>; byLegacyId: Map<string, bigint> };
  productMap: Map<string, bigint>;
  driverMap: Map<string, bigint>;
  addressByCustomer: Map<bigint, bigint>;
  placeholderProductId: bigint;
  opts: CliOptions;
  stats: Stats;
  existingOrderIds: Set<string>;
}) {
  const { target, lines, opts, stats } = args;
  const orderId = String(lines[0]!.order_id).trim();

  const mappedExisting = await target.$queryRaw<Array<{ new_id: bigint }>>`
    SELECT new_id FROM legacy_id_map WHERE entity_type = 'sales_order' AND legacy_key = ${orderId} LIMIT 1`;

  if (mappedExisting[0] || args.existingOrderIds.has(orderId)) {
    args.existingOrderIds.add(orderId);
    if (opts.rebuildPayments && !opts.ordersOnly) {
      const salesOrderId = mappedExisting[0]?.new_id;
      if (salesOrderId) {
        if (opts.dryRun) {
          stats.paymentsRebuilt++;
          if (args.remittances.length > 0) stats.receiptsCreated += args.remittances.length;
          else if (deriveStatus(lines).collectOk && orderTotals(lines).total > 0) stats.receiptsCreated++;
          return;
        }
        try {
          await rebuildPaymentsForExisting({
            target,
            salesOrderId,
            lines,
            remittances: args.remittances,
            stats,
          });
          stats.paymentsRebuilt++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          pushEx(stats, `${orderId}：補建收款失敗 ${msg}`);
          stats.skippedError++;
        }
        return;
      }
    }
    stats.skippedExisting++;
    return;
  }

  const conflict = await target.salesOrder.findUnique({ where: { orderNo: orderId }, select: { id: true } });
  if (conflict) {
    pushEx(stats, `${orderId}：orderNo 已存在但無 legacy map，略過`);
    stats.skippedError++;
    return;
  }

  const customerRaw = String(lines[0]!.customer_id ?? "").trim();
  const customerId = await resolveCustomerId(args.customerMaps, customerRaw);
  if (!customerId) {
    pushEx(stats, `${orderId}：找不到客戶 ${customerRaw}`);
    stats.skippedError++;
    return;
  }
  const addressId = args.addressByCustomer.get(customerId);
  if (!addressId) {
    pushEx(stats, `${orderId}：客戶 ${customerRaw} 無送貨地址`);
    stats.skippedError++;
    return;
  }

  const totals = orderTotals(lines);
  const derived = deriveStatus(lines);
  const billingTypes = new Set(lines.map((l) => mapBilling(l.collect_money)));
  const billingTypeAtOrder =
    billingTypes.size === 1 ? [...billingTypes][0]! : billingTypes.size > 1 ? "mixed" : mapBilling(lines[0]!.collect_money);
  const cashInvoiceMode = mapInvoiceMode(lines[0]!.customer_bill_form);
  const orderDay = lines[0]!.order_day ? dateOnlyUtc(ymd(lines[0]!.order_day)!) : null;
  const orderIdDay = lines[0]!.order_id_day ? dateOnlyUtc(ymd(lines[0]!.order_id_day)!) : orderDay;
  const driverRaw = String(lines[0]!.driver_id ?? "").trim();
  const driverId = driverRaw ? args.driverMap.get(driverRaw) ?? args.driverMap.get(driverRaw.toUpperCase()) : null;
  const recycle = Math.max(...lines.map((l) => parseQty(l.recyele_quantity)), 0);
  const remarkParts = [
    LEGACY_NOTE_TAG,
    lines[0]!.maker ? `maker=${lines[0]!.maker}` : null,
    lines.map((l) => l.remark).find((r) => String(r ?? "").trim()) || null,
  ].filter(Boolean);
  const preferredShift = args.shift;

  if (opts.dryRun) {
    stats.created++;
    if (derived.needAssignment && driverId) stats.assignments++;
    if (totals.total > 0 && !opts.ordersOnly) stats.arCreated++;
    if (!opts.ordersOnly) {
      if (args.remittances.length > 0) stats.receiptsCreated += args.remittances.length;
      else if (derived.collectOk && totals.total > 0) stats.receiptsCreated++;
    }
    const bill =
      args.invoice?.bill_number?.trim() ||
      lines.map((l) => String(l.bill_number ?? "").trim()).find(Boolean);
    if (bill && !opts.ordersOnly) stats.invoicesCreated++;
    return;
  }

  try {
    await target.$transaction(
      async (tx) => {
        const so = await tx.salesOrder.create({
          data: {
            orderNo: orderId,
            customerId,
            deliveryAddressId: addressId,
            status: derived.status,
            scheduledDeliveryDate: orderDay,
            preferredShift,
            subtotal: new Prisma.Decimal(totals.subtotal.toFixed(2)),
            totalAmount: new Prisma.Decimal(totals.total.toFixed(2)),
            billingTypeAtOrder,
            cashSubtotal: new Prisma.Decimal(totals.cash.toFixed(2)),
            monthlySubtotal: new Prisma.Decimal(totals.monthly.toFixed(2)),
            cashInvoiceMode,
            source: "legacy",
            remark: remarkParts.join(" | ").slice(0, 2000),
            officeSettledAt: derived.status === "completed" ? orderDay : null,
            monthlyPeriodPaid: false,
            monthlyReceivedAmount: new Prisma.Decimal(0),
            createdAt: orderIdDay ?? new Date(),
            updatedAt: new Date(),
            preferredDriverId: driverId ?? undefined,
          },
        });

        for (const l of lines) {
          const pid = String(l.product_id ?? "").trim();
          const pname = String(l.product_name ?? "").trim();
          const virtual = isVirtualLine(pid, pname);
          let productId = args.productMap.get(pid);
          if (!productId || virtual) productId = args.placeholderProductId;
          if (!productId || productId === 0n) throw new Error(`無商品可對應 ${pid}`);
          const qty = parseQty(l.product_quantity);
          const unitPrice = parseNum(l.product_price, 0);
          const lineAmount = parseNum(l.subtotal, unitPrice * qty);
          const gift = isTrue(l.give_free) || /贈送/.test(pname);
          const replenishment = /補/.test(pname) && !/請款/.test(pname);
          await tx.salesOrderLine.create({
            data: {
              salesOrderId: so.id,
              productId,
              qtyOrdered: qty,
              qtyDelivered: derived.status === "completed" ? qty : 0,
              unitPrice: new Prisma.Decimal(unitPrice.toFixed(2)),
              lineAmount: new Prisma.Decimal(lineAmount.toFixed(2)),
              billingTypeAtLine: mapBilling(l.collect_money),
              invoiceMode: cashInvoiceMode === "none" ? null : cashInvoiceMode,
              isPromotionGift: gift,
              promotionNote: virtual || pname ? pname.slice(0, 200) : null,
              isReplenishment: replenishment,
            },
          });
        }

        if (derived.needAssignment && driverId && orderDay && derived.assignmentStatus) {
          await tx.deliveryAssignment.create({
            data: {
              salesOrderId: so.id,
              driverId,
              assignmentDate: orderDay,
              status: derived.assignmentStatus,
              assignmentShift: preferredShift,
              emptyBarrelsReturned: recycle,
              completedAt: derived.assignmentStatus === "completed" ? orderDay : null,
              officeSettledAt: derived.assignmentStatus === "completed" ? orderDay : null,
              settlementOutcome:
                derived.assignmentStatus === "completed"
                  ? mapBilling(lines[0]!.collect_money) === "cash"
                    ? "delivered_cash_exact"
                    : "delivered_no_cash"
                  : null,
              expectedAmount:
                mapBilling(lines[0]!.collect_money) === "cash"
                  ? new Prisma.Decimal(totals.cash.toFixed(2))
                  : new Prisma.Decimal(0),
            },
          });
          stats.assignments++;
        } else if (derived.needAssignment && !driverId && driverRaw) {
          pushEx(stats, `${orderId}：司機代號 ${driverRaw} 無對應，略過 assignment`);
        }

        if (!opts.ordersOnly && totals.total > 0) {
          const n = await ensureArForOrder(tx, {
            salesOrderId: so.id,
            customerId,
            orderDay,
            totals,
            billingTypeAtOrder,
          });
          stats.arCreated += n;
          await settleOrderPlanB(
            tx,
            {
              salesOrderId: so.id,
              customerId,
              orderId,
              orderDay,
              collectOk: derived.collectOk,
              remittances: args.remittances,
            },
            stats,
          );
        }

        if (!opts.ordersOnly) {
          const billNo =
            args.invoice?.bill_number?.trim() ||
            lines.map((l) => String(l.bill_number ?? "").trim()).find(Boolean) ||
            null;
          if (billNo && cashInvoiceMode !== "none") {
            const untaxed = Math.max(0, totals.total - totals.tax);
            await tx.taxInvoice.create({
              data: {
                invoiceNo: generateTaxInvoiceNo(so.id),
                externalInvoiceNo: billNo.slice(0, 20),
                customerId,
                basisType: "sales_order",
                salesOrderId: so.id,
                invoiceMode: cashInvoiceMode === "tax_inclusive" ? "tax_inclusive" : "tax_exclusive",
                untaxedAmount: new Prisma.Decimal(untaxed.toFixed(2)),
                taxAmount: new Prisma.Decimal(totals.tax.toFixed(2)),
                totalAmount: new Prisma.Decimal(totals.total.toFixed(2)),
                buyerName: args.invoice?.company?.trim()?.slice(0, 120) || null,
                note: LEGACY_NOTE_TAG,
                status: "issued",
                issuedAt: args.invoice?.invoice_date
                  ? dateOnlyUtc(ymd(args.invoice.invoice_date)!)
                  : orderDay ?? new Date(),
              },
            });
            stats.invoicesCreated++;
          }
        }

        await upsertLegacyMapTx(tx, "sales_order", orderId, so.id, {
          customerId: customerRaw,
          status: derived.status,
        });
      },
      { timeout: 60_000 },
    );

    args.existingOrderIds.add(orderId);
    stats.created++;
    if (stats.created % 100 === 0) {
      console.log(`  …已處理建立 ${stats.created} / 候選 ${stats.candidates}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushEx(stats, `${orderId}：寫入失敗 ${msg}`);
    stats.skippedError++;
  }
}

async function rebuildPaymentsForExisting(args: {
  target: PrismaClient;
  salesOrderId: bigint;
  lines: LegacyOrderLine[];
  remittances: RemittanceRow[];
  stats: Stats;
}) {
  const totals = orderTotals(args.lines);
  const derived = deriveStatus(args.lines);
  const orderId = String(args.lines[0]!.order_id).trim();
  const orderDay = args.lines[0]!.order_day ? dateOnlyUtc(ymd(args.lines[0]!.order_day)!) : null;
  const so = await args.target.salesOrder.findUnique({ where: { id: args.salesOrderId } });
  if (!so) throw new Error("sales_order 不存在");
  const billingTypeAtOrder = so.billingTypeAtOrder ?? mapBilling(args.lines[0]!.collect_money);

  await args.target.$transaction(
    async (tx) => {
      if (totals.total > 0) {
        const n = await ensureArForOrder(tx, {
          salesOrderId: so.id,
          customerId: so.customerId,
          orderDay,
          totals,
          billingTypeAtOrder,
        });
        args.stats.arCreated += n;
      }
      await settleOrderPlanB(
        tx,
        {
          salesOrderId: so.id,
          customerId: so.customerId,
          orderId,
          orderDay,
          collectOk: derived.collectOk,
          remittances: args.remittances,
        },
        args.stats,
      );
    },
    { timeout: 60_000 },
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = new PrismaClient();
  const legacy = new PrismaClient({ datasources: { db: { url: legacyDbUrl() } } });

  console.log("=== 舊庫訂單轉換（方案 B：完整重建收款／沖帳）===");
  console.log(`舊庫：${describeDbUrl(legacyDbUrl())}（唯讀）`);
  console.log(`新庫：${describeDbUrl(process.env.DATABASE_URL ?? "")}${opts.dryRun ? "（dry-run，不寫入）" : ""}`);
  console.log(
    `篩選：customer=${opts.customer ?? "全部"} from=${opts.from ?? "-"} to=${opts.to ?? "-"} completion=${opts.completion}` +
      (opts.rebuildPayments ? " rebuild-payments=ON" : ""),
  );

  const stats: Stats = {
    candidates: 0,
    created: 0,
    skippedExisting: 0,
    skippedError: 0,
    assignments: 0,
    arCreated: 0,
    invoicesCreated: 0,
    receiptsCreated: 0,
    paymentsRebuilt: 0,
    exceptions: [],
  };

  try {
    await ensureLegacyMapTable(target);
    const placeholderProductId = await ensurePlaceholderProduct(target, opts.dryRun);
    const productMap = await loadMap(target, "product");
    const driverMap = await loadMap(target, "driver");
    const customerByCode = await loadMap(target, "customer_code");
    const customerByLegacyId = await loadMap(target, "customer_id");
    console.log(
      `主檔 map：customer_code=${customerByCode.size} customer_id=${customerByLegacyId.size} product=${productMap.size} driver=${driverMap.size}`,
    );

    const orderIds = await fetchDistinctOrderIds(legacy, opts);
    stats.candidates = orderIds.length;
    console.log(`符合條件訂單：${orderIds.length} 張`);
    if (orderIds.length === 0) {
      console.log("無資料可轉，結束。");
      return;
    }

    const existingRows = await target.$queryRaw<Array<{ legacy_key: string }>>`
      SELECT legacy_key FROM legacy_id_map WHERE entity_type = 'sales_order'`;
    const existingOrderIds = new Set(existingRows.map((r) => String(r.legacy_key).trim()));

    const CHUNK = 100;
    for (let i = 0; i < orderIds.length; i += CHUNK) {
      const chunk = orderIds.slice(i, i + CHUNK);
      console.log(`\n批次 ${i + 1}–${i + chunk.length} / ${orderIds.length}`);
      const lines = await fetchLinesForOrders(legacy, chunk);
      const byOrder = groupLines(lines);
      const shifts = await fetchShifts(legacy, chunk);
      const invoices = await fetchInvoices(legacy, chunk);
      const remits = await fetchRemittances(legacy, chunk);

      const customerIdsNeeded = new Set<bigint>();
      for (const oid of chunk) {
        const ol = byOrder.get(oid);
        if (!ol?.length) continue;
        const cid = await resolveCustomerId(
          { byCode: customerByCode, byLegacyId: customerByLegacyId },
          String(ol[0]!.customer_id ?? ""),
        );
        if (cid) customerIdsNeeded.add(cid);
      }
      const addressByCustomer = await loadCustomerAddressMap(target, [...customerIdsNeeded]);

      for (const oid of chunk) {
        const ol = byOrder.get(oid);
        if (!ol?.length) {
          pushEx(stats, `${oid}：無明細列`);
          stats.skippedError++;
          continue;
        }
        await migrateOneOrder({
          target,
          lines: ol,
          shift: shifts.get(oid) ?? null,
          invoice: invoices.get(oid) ?? null,
          remittances: remits.get(oid) ?? [],
          customerMaps: { byCode: customerByCode, byLegacyId: customerByLegacyId },
          productMap,
          driverMap,
          addressByCustomer,
          placeholderProductId,
          opts,
          stats,
          existingOrderIds,
        });
      }
    }

    console.log("\n=== 結果摘要 ===");
    console.log(`候選訂單：${stats.candidates}`);
    console.log(`${opts.dryRun ? "預估建立" : "已建立"}：${stats.created}`);
    console.log(`已存在略過：${stats.skippedExisting}`);
    console.log(`補建收款：${stats.paymentsRebuilt}`);
    console.log(`錯誤略過：${stats.skippedError}`);
    console.log(`派送單：${stats.assignments}`);
    console.log(`AR：${stats.arCreated}`);
    console.log(`收款憑證：${stats.receiptsCreated}`);
    console.log(`發票：${stats.invoicesCreated}`);
    if (stats.exceptions.length) {
      console.log(`例外（最多列 200）：${stats.exceptions.length}`);
      for (const e of stats.exceptions.slice(0, 30)) console.log(`  - ${e}`);
      if (stats.exceptions.length > 30) console.log(`  …另有 ${stats.exceptions.length - 30} 筆`);
    }
    if (opts.dryRun) console.log("（dry-run：未寫入資料庫）");
  } finally {
    await legacy.$disconnect();
    await target.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
