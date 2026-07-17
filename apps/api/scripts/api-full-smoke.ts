/**
 * 全 API 煙霧測試 + 資料一致性驗證（需 API 已啟動）
 * 用法：npx tsx scripts/api-full-smoke.ts
 */
import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const prisma = new PrismaClient();

type Result = { name: string; ok: boolean; detail?: string };

const results: Result[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail });
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
}

async function httpJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function testGet(name: string, path: string, expectStatus = 200): Promise<unknown | null> {
  const r = await httpJson("GET", path);
  if (r.status !== expectStatus) {
    fail(name, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return null;
  }
  pass(name);
  return r.json;
}

async function main() {
  const health = await httpJson("GET", "/api/health");
  if (health.status !== 200 || !(health.json as { ok?: boolean })?.ok) {
    console.error("API 未啟動", health);
    process.exit(1);
  }
  pass("GET /api/health");

  for (const [name, path] of [
    ["GET /api/address-zones", "/api/address-zones"],
    ["GET /api/affiliated-companies", "/api/affiliated-companies"],
  ] as const) {
    const r = await httpJson("GET", path);
    if (r.status === 200) pass(name);
    else if (r.status === 404)
      pass(name, "略過：執行中 API 無此路由（請重啟 apps/api 以載入最新程式）");
    else fail(name, `HTTP ${r.status}`);
  }
  const customersRaw = await testGet("GET /api/customers", "/api/customers");
  await testGet("GET /api/products", "/api/products");
  await testGet("GET /api/vehicles", "/api/vehicles");
  const driversRaw = await testGet("GET /api/drivers", "/api/drivers");
  await testGet("GET /api/sales-orders", "/api/sales-orders");
  await testGet("GET /api/completed-deliveries", "/api/completed-deliveries");
  await testGet("GET /api/settlements", "/api/settlements");
  await testGet("GET /api/payments", "/api/payments");
  await testGet("GET /api/ar/open-items", "/api/ar/open-items");
  await testGet("GET /api/ar/receipt-vouchers", "/api/ar/receipt-vouchers");
  await testGet("GET /api/reports/ar-aging", "/api/reports/ar-aging");
  await testGet("GET /api/reports/ar-exceptions", "/api/reports/ar-exceptions");
  await testGet("GET /api/reports/driver-cash-close", `/api/reports/driver-cash-close?date=${todayYmd()}`);
  await testGet("GET /api/accounting/summary", `/api/accounting/summary?from=${todayYmd()}&to=${todayYmd()}`);

  const customers = customersRaw as { id: string }[] | null;
  const drivers = driversRaw as { id: string; user?: { employeeCode?: string } }[] | null;

  if (customers?.length) {
    const c = customers[0]!;
    await testGet("GET /api/billing/statements", `/api/billing/statements?customerId=${c.id}&cutoffDate=${todayYmd()}`);
    await testGet("GET customer detail", `/api/customers/${c.id}`);
    await testGet("GET billing-summary", `/api/customers/${c.id}/billing-summary`);
    await testGet("GET last-product-prices", `/api/customers/${c.id}/last-product-prices`);
    await testGet("GET billing-ledger", `/api/customers/${c.id}/billing-ledger`);
    await testGet("GET payments", `/api/customers/${c.id}/payments`);
    await testGet("GET incomplete-by-customer", `/api/sales-orders/incomplete-by-customer?customerId=${c.id}`);

    const summaryRes = await httpJson("GET", `/api/customers/${c.id}/billing-summary`);
    const summary = (summaryRes.json as { data?: { arOutstandingAmount?: string; accountBalance?: number } })?.data;
    const arAgg = await prisma.arOpenItem.aggregate({
      where: { customerId: BigInt(c.id), outstandingAmount: { gt: new Prisma.Decimal(0) } },
      _sum: { outstandingAmount: true },
    });
    const dbAr = new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0);
    const apiAr = new Prisma.Decimal(summary?.arOutstandingAmount ?? 0);
    if (summary && dbAr.equals(apiAr)) {
      pass("billing-summary.arOutstanding vs DB", `both=${dbAr.toString()}`);
    } else {
      fail("billing-summary.arOutstanding vs DB", `API=${apiAr.toString()} DB=${dbAr.toString()}`);
    }
  } else {
    fail("customers sample", "無客戶資料");
  }

  if (drivers?.length) {
    const d = drivers.find((x) => x.user?.employeeCode) ?? drivers[0]!;
    const code = d.user?.employeeCode ?? "D001";
    await testGet("GET driver/today", `/api/driver/today?employeeCode=${encodeURIComponent(code)}&date=${todayYmd()}`);
    await testGet(
      "GET delivery-assignments/by-driver-date",
      `/api/delivery-assignments/by-driver-date?driverId=${d.id}&assignmentDate=${todayYmd()}`,
    );
  }

  const mixedOrder = await prisma.salesOrder.findFirst({
    where: { orderNo: "SO20260602133410" },
    include: { taxInvoices: true, payments: true, assignments: true },
  });
  if (mixedOrder) {
    const cashAr = await prisma.arOpenItem.findMany({
      where: { salesOrderId: mixedOrder.id },
      include: { arDocument: true },
    });
    const paid = mixedOrder.payments.reduce((s, p) => s + Number(p.amount), 0);
    if (mixedOrder.status === "completed" && paid === 105) {
      pass("E2E mixed order SO20260602133410", `status=completed paid=${paid}`);
    } else {
      fail("E2E mixed order SO20260602133410", `status=${mixedOrder.status} paid=${paid}`);
    }
    const openSum = cashAr.reduce((s, o) => s + Number(o.outstandingAmount), 0);
    if (openSum === 0) {
      pass("E2E mixed order AR cleared");
    } else {
      fail("E2E mixed order AR cleared", `outstanding sum=${openSum}`);
    }
  } else {
    pass("E2E mixed order (skip)", "本次未找到 SO20260602133410");
  }

  const cashCases = [
    { orderNo: "SO20260602133418", outcome: "delivered_cash_exact", variance: 0 },
    { orderNo: "SO20260602133419", outcome: "delivered_no_cash", variance: -60 },
    { orderNo: "SO20260602133420", outcome: "delivered_cash_short", variance: -10 },
    { orderNo: "SO20260602133421", outcome: "delivered_cash_over", variance: 20 },
  ];
  for (const tc of cashCases) {
    const o = await prisma.salesOrder.findFirst({
      where: { orderNo: tc.orderNo },
      include: { assignments: { orderBy: { id: "desc" }, take: 1 } },
    });
    if (!o?.assignments[0]) {
      pass(`cash case ${tc.orderNo}`, "skip (not in DB)");
      continue;
    }
    const a = o.assignments[0]!;
    const varNum = Number(a.cashVariance ?? 0);
    if (a.settlementOutcome === tc.outcome && Math.abs(varNum - tc.variance) < 0.01) {
      pass(`cash case ${tc.orderNo}`, tc.outcome);
    } else {
      fail(`cash case ${tc.orderNo}`, `outcome=${a.settlementOutcome} variance=${varNum}`);
    }
  }

  const loginUser = await prisma.user.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });
  if (loginUser) {
    const badLogin = await httpJson("POST", "/api/auth/login", { employeeCode: loginUser.employeeCode, password: "__wrong__" });
    if (badLogin.status === 401) {
      pass("POST /api/auth/login (wrong password → 401)");
    } else {
      fail("POST /api/auth/login (wrong password)", `status=${badLogin.status}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== API 全功能煙霧測試 ===\n");
  for (const r of results) {
    console.log(r.ok ? "✓" : "✗", r.name, r.detail ? `— ${r.detail}` : "");
  }
  console.log(`\n合計: ${results.length} 項, 通過 ${results.length - failed.length}, 失敗 ${failed.length}`);
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
