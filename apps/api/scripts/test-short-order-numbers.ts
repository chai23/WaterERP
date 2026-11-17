/** Run from apps/api: npx tsx scripts/test-short-order-numbers.ts
 * Creates and retains an isolated local database. Never changes the configured database.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { allocateShortOrderNo, formatShortOrderNo, orderNumberDay } from "../src/shortOrderNo.js";
import { slipFromDashboardOrder } from "../../web-admin/src/orderPrint/slipFromApiOrder.js";
import { buildOrderSlipHtml } from "../../web-admin/src/orderPrint/buildOrderSlipDocument.js";
import { DEFAULT_ORDER_PRINT_LAYOUT } from "../../web-admin/src/orderPrint/defaultLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configured = new URL(process.env.DATABASE_URL!);
assert(["localhost", "127.0.0.1"].includes(configured.hostname), "Local MySQL only");
const name = `watererp_short_order_test_${Date.now()}`;
assert(/^watererp_short_order_test_\d+$/.test(name));
const isolated = new URL(configured); isolated.pathname = `/${name}`;
isolated.searchParams.set("connection_limit", "5");
const admin = new PrismaClient();
const db = new PrismaClient({ datasources: { db: { url: isolated.toString() } } });
const port = 3118;
const env = { ...process.env, DATABASE_URL: isolated.toString(), PORT: String(port), HOST: "127.0.0.1", JWT_SECRET: "short-order-isolated-test-only-2026", NODE_ENV: "development" };
let server: ChildProcess | undefined;
let token = "";
function sql(file: string) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "execute", "--schema", "prisma/schema.prisma", "--file", path.join(root, file)], { cwd: path.join(root, "apps/api"), env, windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
async function api(route: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
try {
  assert.equal(orderNumberDay(new Date("2026-11-17T15:59:59Z")), "20261117");
  assert.equal(orderNumberDay(new Date("2026-11-17T16:00:00Z")), "20261118");
  assert.equal(formatShortOrderNo("20261117", 1), "261117-001");
  assert.equal(formatShortOrderNo("20261117", 1000), "261117-1000");
  assert.throws(() => formatShortOrderNo("20261117", 0));
  console.log("PASS: Taipei date boundary, padding and overflow");

  await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  sql("database/schema.sql");
  sql("database/migrations/004_cutover_handover.sql");
  await db.user.create({ data: { id: 1n, employeeCode: "SHORTTEST", name: "短單號測試", role: "admin", passwordHash: await bcrypt.hash("ShortTest2026!", 4) } });
  const customer = await db.customer.create({ data: { customerCode: "000001", name: "短單號測試客戶", prepaidBarrelBalance: 100, addresses: { create: { addressLine: "測試地址", isDefault: true } } }, include: { addresses: true } });
  const address = customer.addresses[0]!;
  const base = { customerId: customer.id, deliveryAddressId: address.id };
  const old = await db.salesOrder.create({ data: { ...base, orderNo: "SO20261117120000000abcd", createdAt: new Date("2026-11-17T04:00:00Z") } });
  await db.salesOrder.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({ ...base, orderNo: `LEGACY-${i}`, createdAt: new Date("2026-11-15T16:00:00Z") })) });
  // Exercise an actual upgrade from a schema with no short-number column.
  await db.$executeRawUnsafe("ALTER TABLE sales_orders DROP INDEX uk_sales_order_short_no, DROP COLUMN short_order_no");
  sql("database/migrations/007_short_order_numbers.sql");
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: old.id } })).shortOrderNo, "261117-001");
  assert.equal(await db.salesOrder.count({ where: { shortOrderNo: { startsWith: "261116-" } } }), 1001);
  assert(await db.salesOrder.findUnique({ where: { shortOrderNo: "261116-1000" } }));
  sql("database/migrations/007_short_order_numbers.sql");
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: old.id } })).shortOrderNo, "261117-001");
  console.log("PASS: historical backfill, additive migration and repeatability");

  const now = new Date("2026-11-17T05:00:00Z");
  const generated = await Promise.all(Array.from({ length: 20 }, (_, i) => db.$transaction(async tx => {
    const shortOrderNo = await allocateShortOrderNo(tx, now);
    return tx.salesOrder.create({ data: { ...base, orderNo: `TEST-CONCURRENT-${i}`, shortOrderNo } });
  }, { maxWait: 20000, timeout: 20000 })));
  assert.equal(new Set(generated.map(o => o.shortOrderNo)).size, 20);
  assert.deepEqual(generated.map(o => o.shortOrderNo).sort(), Array.from({ length: 20 }, (_, i) => `261117-${String(i + 2).padStart(3, "0")}`));
  await assert.rejects(db.$transaction(async tx => { await allocateShortOrderNo(tx, now); throw new Error("rollback"); }));
  assert.equal(await db.$transaction(tx => allocateShortOrderNo(tx, now)), "261117-022");
  assert.equal(await db.$transaction(tx => allocateShortOrderNo(tx, new Date("2026-11-17T16:00:00Z"))), "261118-001");
  await db.orderNumberSequence.upsert({ where: { dayKey: "20261119" }, create: { dayKey: "20261119", lastValue: 999 }, update: { lastValue: 999 } });
  assert.equal(await db.$transaction(tx => allocateShortOrderNo(tx, new Date("2026-11-19T00:00:00Z"))), "261119-1000");
  console.log("PASS: concurrent creation, transaction rollback, next day and >999");

  await db.salesOrder.update({ where: { id: old.id }, data: { scheduledDeliveryDate: new Date("2027-01-01"), status: "cancelled" } });
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: old.id } })).shortOrderNo, "261117-001");
  const slip = slipFromDashboardOrder({ orderNo: old.orderNo, shortOrderNo: "261117-001", customer: { name: "測試" } });
  const html = buildOrderSlipHtml(slip, DEFAULT_ORDER_PRINT_LAYOUT);
  assert(html.includes("261117-001")); assert(!html.includes(old.orderNo));
  assert(buildOrderSlipHtml({ orderNo: old.orderNo }, DEFAULT_ORDER_PRINT_LAYOUT).includes(old.orderNo));
  console.log("PASS: date/status changes preserve numbers; print adapter and legacy fallback");

  const product = await db.product.create({ data: { productCode: "001", name: "測試桶裝水", salePrice: 100, consumesPrepaidBarrel: true, countsDepositBarrel: true } });
  await db.customerPrepaidProductBalance.create({ data: { customerId: customer.id, productId: product.id, balanceBarrels: 100 } });
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(root, "apps/api"), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; server.stderr?.on("data", b => { errors += b.toString(); });
  for (let i = 0; i < 80; i++) { try { if ((await api("/health")).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  const login = await api("/auth/login", { employeeCode: "SHORTTEST", password: "ShortTest2026!" });
  token = login.body.token; assert(token, JSON.stringify(login) + errors);
  for (const billingType of ["cash", "monthly", "prepaid"]) {
    const result = await api("/sales-orders", { customerId: String(customer.id), deliveryAddressId: String(address.id), scheduledDeliveryDate: "2026-12-01", lines: [{ productId: String(product.id), qty: 2, unitPrice: 100, billingType }] });
    assert.equal(result.status, 201, JSON.stringify(result));
    const order = result.body.data;
    assert.match(order.shortOrderNo, /^\d{6}-\d{3,}$/);
    assert.match(order.orderNo, /^SO/);
    assert.equal(order.lines.length, 1);
    assert.equal(order.billingTypeAtOrder, billingType);
    const detail = await api(`/sales-orders/${order.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail));
    assert.equal(detail.body.shortOrderNo, order.shortOrderNo);
    const enrichment = await api(`/sales-orders/${order.id}/print-enrichment`);
    assert.equal(enrichment.status, 200);
    assert.equal(enrichment.body.data.shortOrderNo, order.shortOrderNo);
    for (const q of [order.shortOrderNo, order.orderNo]) {
      const found = await api(`/sales-orders?q=${encodeURIComponent(q)}`);
      assert(found.body.some((r: any) => r.id === order.id), q);
      const queue = await api(`/sales-orders/assignment-queue?q=${encodeURIComponent(q)}`);
      assert(queue.body.data.orders.some((r: any) => r.id === order.id), q);
    }
    if (billingType === "cash") {
      const ar = await db.arDocument.findFirstOrThrow({ where: { salesOrderId: BigInt(order.id) } });
      assert.equal(String(ar.documentAmount), "200");
    } else {
      assert.equal(await db.arDocument.count({ where: { salesOrderId: BigInt(order.id) } }), 0);
    }
    const cancelled = await api(`/sales-orders/${order.id}/cancel`, { reason: "隔離測試" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: BigInt(order.id) } })).shortOrderNo, order.shortOrderNo);
  }
  console.log("PASS: cash/monthly/prepaid creation, details, print enrichment, full/short search, assignment search and cancellation");
  // Old rows beyond the unfiltered 100-row window must still be searchable.
  await db.salesOrder.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ ...base, orderNo: `SEARCH-PADDING-${i}` })) });
  const older = await api("/sales-orders?q=261117-001");
  assert(older.body.some((r: any) => r.id === String(old.id)));
  console.log(`PASS: search beyond latest 100 orders. Isolated database retained: ${name}`);
} finally {
  server?.kill();
  await Promise.all([db.$disconnect(), admin.$disconnect()]);
}
