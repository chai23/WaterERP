/** Real MySQL/API regression suite. Creates isolated databases; never resets the configured database.
 * npm run test:cutover -w apps/api
 * npm run test:cutover -w apps/api -- --ui  (keeps isolated API 3107 / admin 5177 running)
 */
import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyHandover, buildHandover, mergeDraft, readHandover, saveHandover, validationErrors, validDay, type HandoverSnapshot } from "../src/modules/legacy-history/handover.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ui = process.argv.includes("--ui");
const scale = process.argv.includes("--scale");
const port = Number(process.env.CUTOVER_TEST_PORT) || (ui ? 3107 : 3108);
const webPort = Number(process.env.CUTOVER_TEST_WEB_PORT) || 5177;
const suffix = Date.now();
const targetName = `watererp_cutover_test_${suffix}`;
const legacyName = `watererp_cutover_legacy_test_${suffix}`;
const configured = new URL(process.env.DATABASE_URL!);
assert(["127.0.0.1", "localhost"].includes(configured.hostname), "Tests require local MySQL");
const admin = new PrismaClient();
const urlFor = (name: string) => { assert(/^watererp_cutover_(legacy_)?test_\d+$/.test(name)); const u = new URL(configured); u.pathname = `/${name}`; return u.toString(); };
const targetUrl = urlFor(targetName), legacyUrl = urlFor(legacyName);
const db = new PrismaClient({ datasources: { db: { url: targetUrl } } });
const legacy = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
let server: ChildProcess | undefined, web: ChildProcess | undefined;
const env = { ...process.env, DATABASE_URL: targetUrl, LEGACY_DATABASE_URL: legacyUrl, PORT: String(port), HOST: "127.0.0.1", JWT_SECRET: "cutover-isolated-integration-test-secret-2026", NODE_ENV: "development", VITE_API_PROXY_TARGET: `http://127.0.0.1:${port}` };
function sqlFile(file: string) {
  const p = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "execute", "--schema", path.join(root, "apps/api/prisma/schema.prisma"), "--file", path.join(root, file)], { env, encoding: "utf8", windowsHide: true });
  assert.equal(p.status, 0, p.stderr + p.stdout);
}
function sqlText(input: string) {
  const p = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "execute", "--schema", path.join(root, "apps/api/prisma/schema.prisma"), "--stdin"], { env, input, encoding: "utf8", windowsHide: true });
  assert.equal(p.status, 0, p.stderr + p.stdout);
}
function checked(s: HandoverSnapshot) {
  const d = structuredClone(s);
  for (const r of d.rows) {
    r.reviewed = true; r.prepayment = r.code === "000003" ? 500 : 0;
    r.note = "已核對舊帳與地址分配";
    for (const o of r.orders) {
      if (o.id === "BILLED") o.disposition = "monthly_billed";
      if (o.id === "PENDING-TAX") o.invoiceMode = "tax_inclusive";
      if (o.disposition === "exclude") o.note = "由新系統另開配送待辦，不帶入欠款";
    }
  }
  d.sourceFrozen = true; d.totalsConfirmed = true;
  return d;
}
let token = "";
async function api(route: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json(); return { status: res.status, ...data };
}
let checks = 0;
function ok(label: string) { checks++; console.log(`PASS ${checks}: ${label}`); }
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${targetName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${legacyName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  sqlFile("database/schema.sql");
  sqlFile("database/migrations/002_line_bind_challenges.sql");
  sqlFile("database/migrations/004_cutover_handover.sql");
  await db.user.create({ data: { id: 1n, employeeCode: "CUTOVERTEST", name: "交接測試管理員", role: "admin", passwordHash: await bcrypt.hash("CutoverTest2026!", 4) } });
  for (const [i, name] of ["一般與月結客戶", "未結月結客戶", "只有預收與桶數客戶"].entries()) {
    await db.customer.create({ data: { id: BigInt(i + 1), customerCode: String(i + 1).padStart(6, "0"), name, prepaidBarrelBalance: i === 2 ? 20 : 0,
      addresses: { create: i === 2 ? [{ addressLine: "台北總店", barrelsOnSite: 2, isDefault: true }, { addressLine: "台北分店", barrelsOnSite: 3 }] : [{ addressLine: `測試地址 ${i + 1}`, isDefault: true }] } } });
  }
  await legacy.$executeRawUnsafe("CREATE TABLE customer(customer_id VARCHAR(20), customer_id_mark VARCHAR(20), customer_name VARCHAR(100), customer_bucket VARCHAR(20), customer_remain VARCHAR(20))");
  await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('1','1','一般與月結客戶','0','0'),('2','2','未結月結客戶','0','0'),('3','3','只有預收與桶數客戶','5','20')");
  if (ui) {
    await db.customer.create({ data: { customerCode: "000004", name: "無異常批次核對客戶", addresses: { create: { addressLine: "測試地址 4", isDefault: true } } } });
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('4','4','無異常批次核對客戶','0','0')");
  }
  await legacy.$executeRawUnsafe("CREATE TABLE `order`(order_id VARCHAR(128), customer_id VARCHAR(20), order_day DATETIME, order_OK VARCHAR(10), collect_OK VARCHAR(10), collect_money VARCHAR(20), subtotal VARCHAR(30))");
  await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('CASH','1','2026-09-20','True','False','現金','1000'),('BILLED','1','2026-09-25','True','False','月結','1000'),('PENDING','2','2026-09-30 23:59:59','True','False','月結','300'),('PENDING-TAX','2','2026-09-26','True','False','月結','210'),('DELIVERY','1','2026-09-29','False','False','現金','200'),('PAID','1','2026-09-25','True','True','現金','500'),('AFTER','1','2026-10-01','True','False','現金','700')");
  await legacy.$executeRawUnsafe("CREATE TABLE remittance_list(order_id VARCHAR(128), remittance_day DATETIME, money VARCHAR(30))");
  await legacy.$executeRawUnsafe("INSERT INTO remittance_list VALUES ('CASH','2026-09-30 23:59:59','200'),('PAID','2026-09-26','500')");
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(root, "apps/api"), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", b => { if (ui) process.stdout.write(b); });
  server.stderr?.on("data", b => process.stderr.write(b));
  for (let i = 0; i < 60; i++) { try { if ((await api("/health")).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  token = (await api("/auth/login", { employeeCode: "CUTOVERTEST", password: "CutoverTest2026!" })).token;
  assert(token, "isolated API must start and log in");
  if (scale) {
    for (let offset = 10; offset < 5010; offset += 250) {
      const values = Array.from({ length: 250 }, (_, n) => ({ customerCode: String(offset + n).padStart(6, "0"), name: `批次測試 ${offset + n}` }));
      await db.customer.createMany({ data: values });
      const tuples = values.map(v => `('${v.customerCode}','${v.customerCode}','scale','0','0')`).join(",");
      await legacy.$executeRawUnsafe(`INSERT INTO customer VALUES ${tuples}`);
    }
    const started = Date.now();
    const snapshot = await buildHandover(legacy, db, "2026-10-01");
    assert.equal(snapshot.rows.length, 5003);
    const saved = await saveHandover(db, 0, checked(snapshot), 1n);
    const applied = await applyHandover(legacy, db, saved.revision, 1n);
    assert.equal(applied.status, "applied");
    assert.equal(await db.customerLedgerEntry.count({ where: { entryType: "cutover_prepaid_barrels" } }), 5003);
    console.log(`PASS: 5,003 customers preview/save/atomic activation; ${Date.now() - started}ms; ${Buffer.byteLength(JSON.stringify(applied.snapshot))} bytes`);
  } else if (ui) {
    web = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: path.join(root, "apps/web-admin"), env, windowsHide: true, stdio: "inherit" });
    console.log(`Isolated UI: http://127.0.0.1:${webPort}/data/legacy-cutover | CUTOVERTEST / CutoverTest2026! | start date 2026-10-01`);
    console.log(`Isolated databases: ${targetName}, ${legacyName}`);
    await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    assert.equal(validDay("2026-02-30"), false); assert.equal(validDay("2026-02-28"), true); ok("calendar dates validated");
    let snapshot = await buildHandover(legacy, db, "2026-10-01");
    assert.equal(snapshot.rows.length, 3); assert.equal(snapshot.rows[2]!.orders.length, 0); assert.equal(snapshot.rows[2]!.addresses.length, 2);
    assert.equal(snapshot.rows[0]!.orders.find(o => o.id === "CASH")!.outstanding, 800);
    assert(!snapshot.rows.flatMap(r => r.orders).some(o => ["AFTER", "PAID"].includes(o.id)));
    assert(snapshot.rows[1]!.orders.some(o => o.id === "PENDING")); ok("all customers, partial receipts, multi-address balances and inclusive cutoff");
    await legacy.$executeRawUnsafe("UPDATE `order` SET subtotal='+1000' WHERE order_id='CASH'");
    assert.equal((await buildHandover(legacy, db, "2026-10-01")).rows[0]!.orders.find(o => o.id === "CASH")!.outstanding, 800);
    await legacy.$executeRawUnsafe("UPDATE `order` SET subtotal='1000' WHERE order_id='CASH'"); ok("legacy signed number format accepted without changing amount");
    await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('PAID-DELIVERY','1','2026-09-28','False','True','現金','100')");
    await legacy.$executeRawUnsafe("INSERT INTO remittance_list VALUES ('PAID-DELIVERY','2026-09-28','100')");
    assert((await buildHandover(legacy, db, "2026-10-01")).rows[0]!.orders.some(o => o.id === "PAID-DELIVERY" && o.disposition === "exclude"));
    await legacy.$executeRawUnsafe("DELETE FROM `order` WHERE order_id='PAID-DELIVERY'");
    await legacy.$executeRawUnsafe("DELETE FROM remittance_list WHERE order_id='PAID-DELIVERY'"); ok("paid but undelivered work remains in handover tasks");
    await db.$executeRawUnsafe("CREATE TABLE legacy_id_map(entity_type VARCHAR(64), legacy_key VARCHAR(128), new_id BIGINT UNSIGNED)");
    await db.$executeRawUnsafe("INSERT INTO legacy_id_map VALUES ('opening_ar','by_customer:000001:cash',1)");
    assert((await buildHandover(legacy, db, "2026-10-01")).blockers.some(x => x.includes("舊版切換")));
    await db.$executeRawUnsafe("DELETE FROM legacy_id_map"); ok("previous legacy opening import blocks duplicate handover");
    await db.prepaymentTxn.create({ data: { customerId: 3n, txnType: "topup", amount: 1, balanceAfter: 1 } });
    assert(validationErrors(checked(await buildHandover(legacy, db, "2026-10-01"))).some(x => x.includes("已有新系統交易")));
    await db.prepaymentTxn.deleteMany(); ok("existing live transactions cannot be overwritten");
    assert(validationErrors(snapshot).length > 0); assert.throws(() => mergeDraft(snapshot, { ...snapshot, rows: [] }));
    const invalid = checked(snapshot); invalid.rows[0]!.prepayment = -1; assert.throws(() => mergeDraft(snapshot, invalid)); ok("unreviewed/negative/tampered drafts rejected");
    await legacy.$executeRawUnsafe("INSERT INTO remittance_list VALUES ('PAID','2026-10-02','10')");
    assert((await buildHandover(legacy, db, "2026-10-01")).blockers.some(x => x.includes("截止日以後")));
    await legacy.$executeRawUnsafe("DELETE FROM remittance_list WHERE money='10'"); ok("after-cutoff receipts on currently paid orders block historical misstatement");
    let saved = await saveHandover(db, 0, checked(snapshot), 1n);
    assert.equal(validationErrors(saved.snapshot!).length, 0);
    await assert.rejects(saveHandover(db, 0, checked(snapshot), 1n), /其他人更新/); ok("optimistic draft version protection");
    await legacy.$executeRawUnsafe("UPDATE customer SET customer_bucket='1' WHERE customer_id='1'");
    await assert.rejects(applyHandover(legacy, db, saved.revision, 1n), /舊資料.*變動/);
    await legacy.$executeRawUnsafe("UPDATE customer SET customer_bucket='0' WHERE customer_id='1'");
    const a = await db.deliveryAddress.findFirstOrThrow({ where: { customerId: 1n } });
    await db.deliveryAddress.update({ where: { id: a.id }, data: { barrelsOnSite: 7 } });
    await assert.rejects(applyHandover(legacy, db, saved.revision, 1n), /新系統.*變動/); ok("source and target changes invalidate stale snapshot");
    snapshot = await buildHandover(legacy, db, "2026-10-01");
    saved = await saveHandover(db, saved.revision, checked(snapshot), 1n);
    sqlText("CREATE TRIGGER cutover_test_fail BEFORE INSERT ON customer_prepayment_wallets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected failure';");
    await assert.rejects(applyHandover(legacy, db, saved.revision, 1n));
    assert.equal(await db.arDocument.count(), 0); assert.equal(await db.customerLedgerEntry.count(), 0);
    assert.equal((await readHandover(db)).status, "draft");
    sqlText("DROP TRIGGER cutover_test_fail;"); ok("mid-batch failure rolls back AR, ledgers, balances and batch status");
    const concurrent = await Promise.allSettled([applyHandover(legacy, db, saved.revision, 1n), applyHandover(legacy, db, saved.revision, 1n)]);
    assert(concurrent.some(r => r.status === "fulfilled"));
    assert.equal(await db.arDocument.count(), 2); assert.equal(await db.customerLedgerEntry.count({ where: { entryType: "cutover_opening" } }), 2);
    await applyHandover(legacy, db, saved.revision, 1n); assert.equal(await db.arDocument.count(), 2); ok("concurrent/repeated activation creates each receivable once");
    const applied = await readHandover(db);
    assert(Math.abs(Date.now() - Date.parse(applied.appliedAt!)) < 60000);
    assert(applied.snapshot!.rows[0]!.orders.find(o => o.id === "CASH")!.arNo?.startsWith("AROB")); ok("activation timestamp and source-to-AR audit links persisted");
    assert.equal(String((await db.customerPrepaymentWallet.findUniqueOrThrow({ where: { customerId: 3n } })).balanceAmount), "500");
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: 3n } })).prepaidBarrelBalance, 20);
    assert.deepEqual((await db.deliveryAddress.findMany({ where: { customerId: 3n }, orderBy: { id: "asc" } })).map(a => a.barrelsOnSite), [2, 3]);
    await assert.rejects(saveHandover(db, (await readHandover(db)).revision, checked(snapshot), 1n), /已啟用/); ok("money wallet, prepaid barrels, per-address barrels and activation lock");
    assert.equal((await api("/legacy-cutover/apply", {})).status, 410); assert.equal((await api("/legacy-cutover/sync-balances", {})).status, 410); ok("unsafe legacy write endpoints disabled");
    let monthly = await api("/billing/monthly-unsettled?customerId=2"); assert.equal(monthly.data.totalPending, "510");
    let statement = await api("/billing/statements?customerId=1&cutoffDate=2099-12-31"); assert(statement.data.rows.some((r: any) => r.orderNo === "舊系統期初"));
    statement = await api("/billing/statements?customerId=2&cutoffDate=2099-12-31"); assert.equal(statement.data.rows.length, 2); ok("opening monthly AR and pending legacy items appear in monthly screens");
    const posts = await Promise.all([api("/billing/statements/post", { customerId: "2", cutoffDate: "2099-12-31", invoiceMode: "none" }), api("/billing/statements/post", { customerId: "2", cutoffDate: "2099-12-31", invoiceMode: "none" })]);
    assert.equal(posts.filter(p => p.status === 201).length, 1, JSON.stringify(posts));
    assert.equal(await db.billingStatement.count(), 1);
    assert.equal((await api("/billing/monthly-unsettled?customerId=2")).data.totalPending, "210"); ok("concurrent monthly posting claims only matching tax mode once");
    const tax = await api("/billing/statements/post", { customerId: "2", cutoffDate: "2099-12-31", invoiceMode: "tax_inclusive" });
    assert.equal(tax.status, 201, JSON.stringify(tax)); assert.equal(String(tax.data.billingStatement.totalWithTax), "210");
    assert.equal((await api("/billing/monthly-unsettled?customerId=2")).data.totalPending, "0");
    assert.equal((await db.arOpenItem.aggregate({ where: { customerId: 2n }, _sum: { outstandingAmount: true } }))._sum.outstandingAmount?.toString(), "510"); ok("tax-inclusive handover produces correct invoice/AR and clears pending items");
    const receipt = await api("/ar/receipt-vouchers", { customerId: "1", amount: 1800, paymentMethod: "cash", paidAtYmd: "2026-10-02" });
    assert.equal(receipt.status, 201, JSON.stringify(receipt));
    assert.equal((await db.arOpenItem.aggregate({ where: { customerId: 1n }, _sum: { outstandingAmount: true } }))._sum.outstandingAmount?.toString(), "0"); ok("real receipt API settles carried opening receivables");
    console.log(`All ${checks} integration checks passed. Isolated databases retained: ${targetName}, ${legacyName}`);
  }
} finally {
  web?.kill(); server?.kill();
  await Promise.all([db.$disconnect(), legacy.$disconnect(), admin.$disconnect()]);
}
