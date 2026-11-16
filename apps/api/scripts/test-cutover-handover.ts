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
import { customerVersion, saveCustomerEdits, saveCustomerDraft, applyCustomerHandover, applyHandover, buildCustomerDraft, buildHandover, handoverOrderBlock, mergeDraft, readHandover, saveHandover, validationErrors, validDay, type HandoverSnapshot } from "../src/modules/legacy-history/handover.js";

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
  sqlFile("database/migrations/006_role_permissions.sql");
  await db.user.create({ data: { id: 1n, employeeCode: "CUTOVERTEST", name: "交接測試管理員", role: "admin", passwordHash: await bcrypt.hash("CutoverTest2026!", 4) } });
  for (const [i, name] of ["一般與月結客戶", "未結月結客戶", "只有預收與桶數客戶"].entries()) {
    await db.customer.create({ data: { id: BigInt(i + 1), customerCode: String(i + 1).padStart(6, "0"), name, prepaidBarrelBalance: i === 2 ? 20 : 0,
      addresses: { create: i === 2 ? [{ addressLine: "台北總店", barrelsOnSite: 9, isDefault: true }, { addressLine: "台北分店", barrelsOnSite: 8 }] : [{ addressLine: `測試地址 ${i + 1}`, isDefault: true }] } } });
  }
  await legacy.$executeRawUnsafe("CREATE TABLE customer(customer_id VARCHAR(20), customer_id_mark VARCHAR(20), customer_name VARCHAR(100), customer_bucket VARCHAR(20), customer_remain VARCHAR(20), customer_address VARCHAR(500))");
  await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('1','1','一般與月結客戶','0','0',''),('2','2','未結月結客戶','0','0',''),('3','3','只有預收與桶數客戶','2','20','台北總店'),('3-1','3','只有預收與桶數客戶','3','0','台北分店')");
  if (ui) {
    await db.customer.create({ data: { customerCode: "000004", name: "無異常批次核對客戶", addresses: { create: { addressLine: "測試地址 4", isDefault: true } } } });
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('4','4','無異常批次核對客戶','0','0','')");
  }
  await legacy.$executeRawUnsafe("CREATE TABLE `order`(order_id VARCHAR(128), customer_id VARCHAR(20), order_day DATETIME, order_OK VARCHAR(10), collect_OK VARCHAR(10), collect_money VARCHAR(20), subtotal VARCHAR(30))");
  await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('CASH','1','2026-09-20','True','False','現金','1000'),('BILLED','1','2026-09-25','True','False','月結','1000'),('PENDING','2','2026-09-30 23:59:59','True','False','月結','300'),('PENDING-TAX','2','2026-09-26','True','False','月結','210'),('DELIVERY','1','2026-09-29','False','False','現金','200'),('PAID','1','2026-09-25','True','True','現金','500'),('AFTER','1','2026-10-02','True','False','現金','700')");
  await legacy.$executeRawUnsafe("CREATE TABLE remittance_list(order_id VARCHAR(128), remittance_day DATETIME, money VARCHAR(30))");
  await legacy.$executeRawUnsafe("INSERT INTO remittance_list VALUES ('CASH','2026-09-30 23:59:59','200'),('PAID','2026-09-26','500')");
  await legacy.$executeRawUnsafe("CREATE TABLE money_over_short(customer_id VARCHAR(20), money VARCHAR(30))");
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
      const tuples = values.map(v => `('${v.customerCode}','${v.customerCode}','scale','0','0','')`).join(",");
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
    await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('SAME-DAY','2','2026-10-01 23:59:59','True','False','月結','205')");
    await legacy.$executeRawUnsafe("INSERT INTO remittance_list VALUES ('SAME-DAY','2026-10-01 23:59:59','5')");
    const boundary = await buildHandover(legacy, db, "2026-10-01");
    assert.equal(boundary.cutoffDate, "2026-10-01");
    assert.equal(boundary.rows[1]!.orders.find(o => o.id === "SAME-DAY")!.outstanding, 200);
    assert(!boundary.rows.flatMap(r => r.orders).some(o => o.id === "AFTER"));
    const older = checked(await buildHandover(legacy, db, "2026-09-30"));
    const refreshed = await buildCustomerDraft(legacy, db, "2026-10-01", "000002", older);
    assert.equal(refreshed.rows[1]!.startDate, "2026-10-01");
    assert.equal(refreshed.rows[1]!.reviewed, false);
    assert(refreshed.rows[1]!.orders.some(o => o.id === "SAME-DAY"));
    assert.deepEqual(refreshed.rows[0], older.rows[0]);
    assert.equal(refreshed.rows[0]!.startDate, "2026-09-30");
    await legacy.$executeRawUnsafe("DELETE FROM remittance_list WHERE order_id='SAME-DAY'");
    await legacy.$executeRawUnsafe("DELETE FROM `order` WHERE order_id='SAME-DAY'");
    ok("single-customer date changes preserve other drafts; cutoff includes last-second orders and receipts");
    let snapshot = await buildHandover(legacy, db, "2026-10-01");
    assert.equal(snapshot.rows.length, 3); assert.equal(snapshot.rows[2]!.orders.length, 0); assert.equal(snapshot.rows[2]!.addresses.length, 2);
    assert.deepEqual(snapshot.rows[2]!.addresses.map(a => a.barrels), [2, 3]); assert.equal(snapshot.rows[2]!.legacyBarrels, 5);
    assert(!snapshot.rows[2]!.warnings.some(w => w.includes("多個配送地址") || w.includes("多筆舊主檔")));
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
    const invalid = checked(snapshot); invalid.rows[0]!.prepayment = 1.234; assert.throws(() => mergeDraft(snapshot, invalid)); ok("unreviewed or fractional short/over drafts rejected");
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
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('9','9','單戶交接客戶','1','0','單戶地址')");
    const single = await db.customer.create({ data: { customerCode: "000009", name: "單戶交接客戶", addresses: { create: { addressLine: "單戶地址", isDefault: true, barrelsOnSite: 4 } } } });
    await db.$executeRawUnsafe("UPDATE cutover_handover SET status='draft'");
    const singleDraft = checked(await buildHandover(legacy, db, "2026-10-01", "000009"));
    assert.equal(singleDraft.rows.length, 1); assert.equal(singleDraft.rows[0]!.addresses[0]!.barrels, 1);
    const singleSaved = await saveHandover(db, (await readHandover(db)).revision, singleDraft, 1n);
    const singleApplied = await applyCustomerHandover(legacy, db, singleSaved.revision, 1n, "9");
    assert.equal(singleApplied.status, "draft");
    assert.equal(singleApplied.snapshot!.rows.find(r => r.code === "000009")!.handedOver, true);
    assert.ok((await db.customer.findUniqueOrThrow({ where: { id: single.id } })).handoverCompletedAt);
    assert.equal((await db.deliveryAddress.findFirstOrThrow({ where: { customerId: single.id } })).barrelsOnSite, 1);
    const repeated = await applyCustomerHandover(legacy, db, singleApplied.revision, 1n, "000009");
    assert.equal(repeated.revision, singleApplied.revision);
    assert.equal((await db.deliveryAddress.findFirstOrThrow({ where: { customerId: single.id } })).barrelsOnSite, 1);
    await db.$executeRawUnsafe(`INSERT INTO legacy_id_map VALUES ('customer_code','000009',${single.id})`);
    assert.equal(await handoverOrderBlock(db, single.id), null);
    const blocked = await db.customer.create({ data: { customerCode: "000007", name: "未交接客戶" } });
    await db.$executeRawUnsafe(`INSERT INTO legacy_id_map VALUES ('customer_code','000007',${blocked.id})`);
    assert.match(String(await handoverOrderBlock(db, blocked.id)), /尚未完成上線交接/);
    const localOnly = await db.customer.create({ data: { customerCode: "000008", name: "新系統自建客戶" } });
    assert.equal(await handoverOrderBlock(db, localOnly.id), null);
    ok("single-customer handover posts only that customer and blocks unfinished legacy customers");
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('10','10','短收客戶','0','0',''),('11','11','溢收客戶','0','0','')");
    await legacy.$executeRawUnsafe("INSERT INTO money_over_short VALUES ('10','100'),('10','-30'),('10-1','-150'),('11','40'),('11','5')");
    const owe = await db.customer.create({ data: { customerCode: "000010", name: "短收客戶", addresses: { create: { addressLine: "短收地址", isDefault: true } } } });
    const credit = await db.customer.create({ data: { customerCode: "000011", name: "溢收客戶", addresses: { create: { addressLine: "溢收地址", isDefault: true } } } });
    const oweDraft = await buildHandover(legacy, db, "2026-10-01", "000010");
    assert.equal(oweDraft.rows[0]!.prepayment, -80);
    assert.equal(oweDraft.rows[0]!.sourceOverShort, -80);
    oweDraft.rows[0]!.reviewed = true; oweDraft.rows[0]!.note = "短溢收";
    oweDraft.sourceFrozen = true; oweDraft.totalsConfirmed = true;
    const oweSaved = await saveHandover(db, (await readHandover(db)).revision, oweDraft, 1n);
    const oweApplied = await applyCustomerHandover(legacy, db, oweSaved.revision, 1n, "000010");
    assert.equal((await db.arOpenItem.aggregate({ where: { customerId: owe.id }, _sum: { outstandingAmount: true } }))._sum.outstandingAmount?.toString(), "80");
    assert.equal(await db.customerPrepaymentWallet.findUnique({ where: { customerId: owe.id } }), null);
    const creditDraft = await buildHandover(legacy, db, "2026-10-01", "000011");
    assert.equal(creditDraft.rows[0]!.prepayment, 45);
    creditDraft.rows[0]!.reviewed = true; creditDraft.rows[0]!.note = "短溢收";
    creditDraft.sourceFrozen = true; creditDraft.totalsConfirmed = true;
    const creditSaved = await saveHandover(db, oweApplied.revision, creditDraft, 1n);
    const creditApplied = await applyCustomerHandover(legacy, db, creditSaved.revision, 1n, "000011");
    assert.equal(creditApplied.status, "draft");
    assert.equal(String((await db.customerPrepaymentWallet.findUniqueOrThrow({ where: { customerId: credit.id } })).balanceAmount), "45");
    assert.equal(await db.arOpenItem.count({ where: { customerId: credit.id } }), 0);
    ok("legacy over/short sum posts a receivable or a prepayment wallet");
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('12','12','並行甲','0','0',''),('13','13','並行乙','0','0','')");
    const parallelCustomers = await Promise.all(["000012", "000013"].map(customerCode => db.customer.create({ data: { customerCode, name: customerCode, addresses: { create: { addressLine: customerCode, isDefault: true } } } })));
    const generated = await Promise.all(["000012", "000013"].map(customerCode => api("/legacy-cutover/handover/draft", { startDate: "2026-10-01", customerCode, customerVersion: null, revision: 0 })));
    for (const response of generated) assert.equal(response.status, 200, JSON.stringify(response));
    const responseState = await api("/legacy-cutover/handover");
    assert.equal(typeof responseState.data.rows, "undefined");
    assert.equal(typeof responseState.data.snapshot.rows.find((r: any) => r.code === "000012").version, "string");
    const base = await readHandover(db);
    const stableRow = base.snapshot!.rows.find(r => r.code === "000012")!;
    const reordered = Object.fromEntries(Object.entries(stableRow).reverse()) as typeof stableRow;
    assert.equal(customerVersion(base.snapshot!, stableRow), customerVersion(base.snapshot!, reordered));
    const dated = { ...stableRow, startDate: stableRow.startDate ?? base.snapshot!.startDate, cutoffDate: stableRow.cutoffDate ?? base.snapshot!.cutoffDate };
    assert.equal(customerVersion(base.snapshot!, stableRow), customerVersion(base.snapshot!, dated));
    const editFor = (c: string) => {
      const row = base.snapshot!.rows.find(r => r.code === c)!;
      return { ...row, version: customerVersion(base.snapshot!, row), prepayment: 0, reviewed: true, note: "parallel test" };
    };
    const edits = [editFor("000012"), editFor("000013")];
    const savedEdits = await Promise.all(edits.map(row => api("/legacy-cutover/handover/draft", { customerVersions: true, revision: base.revision, snapshot: { rows: [row] } }, "PUT")));
    for (const response of savedEdits) assert.equal(response.status, 200, JSON.stringify(response));
    await assert.rejects(saveCustomerEdits(db, { rows: [edits[0]] }, 1n), /已被其他人更新/);
    const ready = await readHandover(db);
    const tokens = ["000012", "000013"].map(c => customerVersion(ready.snapshot!, ready.snapshot!.rows.find(r => r.code === c)!));
    const results = await Promise.all(["000012", "000013"].map((customerCode, i) => api("/legacy-cutover/handover/apply-customer", { revision: ready.revision, customerCode, customerVersion: tokens[i] })));
    for (const response of results) assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(results.length, 2);
    for (const customer of parallelCustomers) assert.ok((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).handoverCompletedAt);
    const ledgerCount = await db.customerLedgerEntry.count();
    await Promise.all([1, 2].map(() => applyCustomerHandover(legacy, db, ready.revision, 1n, "000012", tokens[0])));
    assert.equal(await db.customerLedgerEntry.count(), ledgerCount);
    ok("independent customer generation, concurrent stale-global-version saves and activation; same-customer stale writes rejected and repeated activation idempotent");
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('14','14','隔離檢查','0','0','')");
    const guarded = await db.customer.create({ data: { customerCode: "000014", name: "隔離檢查", addresses: { create: { addressLine: "guard", isDefault: true } } } });
    const guardedDraft = checked(await buildHandover(legacy, db, "2026-10-01", "000014"));
    const guardedSaved = await saveCustomerDraft(db, guardedDraft, null, 1n);
    const guardedRow = guardedSaved.snapshot!.rows.find(r => r.code === "000014")!;
    const guardedToken = customerVersion(guardedSaved.snapshot!, guardedRow);
    await db.customer.update({ where: { id: guarded.id }, data: { phone: "changed" } });
    await assert.rejects(applyCustomerHandover(legacy, db, guardedSaved.revision, 1n, "000014", guardedToken), /主檔或交易已變動/);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: guarded.id } })).handoverCompletedAt, null);
    const guardedRefreshed = checked(await buildHandover(legacy, db, "2026-10-01", "000014"));
    const refreshedSaved = await saveCustomerDraft(db, guardedRefreshed, guardedToken, 1n);
    const refreshedRow = refreshedSaved.snapshot!.rows.find(r => r.code === "000014")!;
    await db.customer.update({ where: { id: parallelCustomers[0]!.id }, data: { phone: "unrelated change" } });
    await applyCustomerHandover(legacy, db, 0, 1n, "000014", customerVersion(refreshedSaved.snapshot!, refreshedRow));
    assert.ok((await db.customer.findUniqueOrThrow({ where: { id: guarded.id } })).handoverCompletedAt);
    ok("same-customer target mutation blocks posting; unrelated customer mutation does not");
    await legacy.$executeRawUnsafe("INSERT INTO customer VALUES ('20','20','無單歸零','5','12','無單地址'),('21','21','已付歷史','0','0',''),('22','22','未來歷史','0','0',''),('23','23','新增歷史','0','0',''),('24','24','分址歷史','0','0',''),('000099-1','24','別名地址','0','0','')");
    await legacy.$executeRawUnsafe("INSERT INTO money_over_short VALUES ('20','50')");
    await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('OLDPAID','21','2020-01-01','True','True','現金','100'),('FUTURE','22','2099-01-01','True','True','現金','100'),('ALIAS','99-1','2020-01-01','True','True','現金','100')");
    const autoCustomer = await db.customer.create({ data: { customerCode: "000020", name: "無單歸零", prepaidBarrelBalance: 12, addresses: { create: { addressLine: "無單地址", barrelsOnSite: 5, isDefault: true } } } });
    for (const code of ["000021", "000022", "000023", "000024"]) await db.customer.create({ data: { customerCode: code, name: code } });
    for (const customerCode of ["000020", "000021", "000022", "000023", "000024"]) {
      const generated = await api("/legacy-cutover/handover/draft", { customerCode, startDate: "2026-10-01", customerVersion: null });
      assert.equal(generated.status, 200, JSON.stringify(generated));
    }
    const preview = await api("/legacy-cutover/handover/no-order-candidates");
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert(preview.data.rows.some((r: any) => r.code === "000020" && !r.reason));
    for (const code of ["000021", "000022", "000024"]) assert(!preview.data.rows.some((r: any) => r.code === code), `history must exclude ${code}`);
    const noOrderCandidate = preview.data.rows.find((r: any) => r.code === "000020");
    const autoBody = { customerCode: "000020", customerVersion: noOrderCandidate.version };
    await db.customerChurnReason.update({ where: { code: "other" }, data: { isActive: false } });
    assert.equal((await api("/legacy-cutover/handover/auto-no-orders", autoBody)).status, 409);
    const rolledBack = await db.customer.findUniqueOrThrow({ where: { id: autoCustomer.id } });
    assert.equal(rolledBack.handoverCompletedAt, null); assert.equal(rolledBack.prepaidBarrelBalance, 12);
    assert.equal(await db.customerLedgerEntry.count({ where: { customerId: autoCustomer.id } }), 0);
    await db.customerChurnReason.update({ where: { code: "other" }, data: { isActive: true } });
    const completedAuto = await api("/legacy-cutover/handover/auto-no-orders", autoBody);
    assert.equal(completedAuto.status, 200, JSON.stringify(completedAuto));
    const autoFinal = await db.customer.findUniqueOrThrow({ where: { id: autoCustomer.id }, include: { churnReason: true, addresses: true } });
    assert.ok(autoFinal.handoverCompletedAt); assert.equal(autoFinal.prepaidBarrelBalance, 0);
    assert.equal(autoFinal.lifecycleStatus, "churned"); assert.equal(autoFinal.churnReason!.code, "other");
    assert.equal(autoFinal.churnReasonNote, "系統轉換標記流失"); assert(autoFinal.addresses.every(a => a.barrelsOnSite === 0));
    const autoSnapshot = (await readHandover(db)).snapshot!;
    const autoRow = autoSnapshot.rows.find(r => r.code === "000020")!;
    assert.equal(autoRow.prepayment, 0); assert.equal(autoRow.sourceOverShort, 50);
    assert.equal(autoRow.sourcePrepaidBarrels, 12); assert.equal(autoRow.legacyBarrels, 5);
    assert.equal(autoRow.noLegacyOrders, true); assert(autoRow.note.includes("舊系統完全無資料"));
    assert.equal(await db.arDocument.count({ where: { customerId: autoCustomer.id } }), 0);
    assert.equal(await db.prepaymentTxn.count({ where: { customerId: autoCustomer.id } }), 0);
    const autoLedgerCount = await db.customerLedgerEntry.count({ where: { customerId: autoCustomer.id } });
    assert.equal((await api("/legacy-cutover/handover/auto-no-orders", autoBody)).status, 200);
    assert.equal(await db.customerLedgerEntry.count({ where: { customerId: autoCustomer.id } }), autoLedgerCount);
    assert.equal(await db.customerLifecycleEvent.count({ where: { customerId: autoCustomer.id, eventType: "churned" } }), 1);
    const late = preview.data.rows.find((r: any) => r.code === "000023");
    await legacy.$executeRawUnsafe("INSERT INTO `order` VALUES ('LATE','23','2099-01-01','True','True','現金','100')");
    assert.equal((await api("/legacy-cutover/handover/auto-no-orders", { customerCode: "000023", customerVersion: late.version })).status, 409);
    const alreadyDone = autoSnapshot.rows.find(r => r.code === "000014")!;
    assert.equal((await api("/legacy-cutover/handover/auto-no-orders", { customerCode: "000014", customerVersion: customerVersion(autoSnapshot, alreadyDone) })).status, 409);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: guarded.id } })).lifecycleStatus, "active");
    ok("no-history filter includes all dates and branch aliases; zero-and-churn is atomic, idempotent, and preserves completed customers");
    console.log(`All ${checks} integration checks passed. Isolated databases retained: ${targetName}, ${legacyName}`);
  }
} finally {
  web?.kill(); server?.kill();
  await Promise.all([db.$disconnect(), legacy.$disconnect(), admin.$disconnect()]);
}
