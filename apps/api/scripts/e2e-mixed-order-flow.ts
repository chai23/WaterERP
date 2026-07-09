/**
 * E2E：混合訂單（現金列 + 月結列）— 開單 → 分派 → 司機任務預覽 → 司機回報 → 核銷 → 驗證 AR／沖帳
 *
 * 用法（需 API 已啟動：npm run dev）：
 *   npx tsx scripts/e2e-mixed-order-flow.ts
 *
 * 環境：讀取 apps/api/.env（DATABASE_URL）與 PORT（預設 3000）
 */
import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const prisma = new PrismaClient();

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 與 API parseLocalYmdRange 一致：以本地曆日對齊 driver/today */
function localYmdFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

async function main() {
  const health = await httpJson("GET", "/api/health");
  if (health.status !== 200 || !(health.json as { ok?: boolean })?.ok) {
    console.error("API 未啟動或無法連線：請在 apps/api 執行 npm run dev（PORT=", process.env.PORT ?? "3000", ")");
    console.error(health);
    process.exit(1);
  }

  const referenceOrderNo = "SO20260510093411";
  const ref = await prisma.salesOrder.findFirst({
    where: { orderNo: referenceOrderNo },
    include: { lines: true },
  });
  if (ref) {
    console.log("參考訂單存在:", referenceOrderNo, "billingTypeAtOrder=", ref.billingTypeAtOrder, "cash=", ref.cashSubtotal?.toString(), "monthly=", ref.monthlySubtotal?.toString());
  } else {
    console.log("參考訂單不存在於 DB，將新建測試混合單");
  }

  const customer = await prisma.customer.findFirst({
    where: { addresses: { some: {} } },
    include: { addresses: { take: 1, orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  const driver = await prisma.driver.findFirst({
    where: { isActive: true },
    include: { user: true },
  });
  const products = await prisma.product.findMany({
    where: { isActive: true },
    take: 2,
    orderBy: { id: "asc" },
  });

  if (!customer?.addresses[0] || !driver?.user?.employeeCode || products.length < 1) {
    console.error("資料不足：需要至少一客戶含地址、一司機含員編、一啟用商品");
    process.exit(1);
  }

  const pCash = products[0]!;
  const pMonthly = products[1] ?? products[0]!;
  const addrId = customer.addresses[0]!.id.toString();
  const custId = customer.id.toString();

  const cashLineAmt = 100;
  const monthlyLineAmt = 200;
  const taxRate = Number(process.env.VAT_RATE ?? 0.05);
  const cashReceivableExpected = cashLineAmt * (1 + taxRate);

  console.log("\n--- 1) POST 開混合單（現金列 + 月結列） ---");
  const createBody = {
    customerId: custId,
    deliveryAddressId: addrId,
    scheduledDeliveryDate: todayYmd(),
    cashInvoiceMode: "tax_exclusive",
    remark: `E2E mixed ${Date.now()}`,
    lines: [
      { productId: pCash.id.toString(), qty: 1, unitPrice: cashLineAmt, billingType: "cash", linePurpose: "delivery" },
      { productId: pMonthly.id.toString(), qty: 1, unitPrice: monthlyLineAmt, billingType: "monthly", linePurpose: "delivery" },
    ],
  };
  const created = await httpJson("POST", "/api/sales-orders", createBody);
  if (created.status !== 201 || !(created.json as { ok?: boolean })?.ok) {
    console.error("開單失敗", created.status, created.json);
    process.exit(1);
  }
  const orderData = (created.json as { data: { id: string; orderNo: string; billingTypeAtOrder: string; cashSubtotal: string; monthlySubtotal: string; totalAmount: string } }).data;
  console.log("orderNo=", orderData.orderNo, "billingTypeAtOrder=", orderData.billingTypeAtOrder);
  const salesOrderId = orderData.id;

  const orderRow = await prisma.salesOrder.findUnique({
    where: { id: BigInt(salesOrderId) },
    include: { taxInvoices: true, lines: true },
  });
  if (!orderRow || orderRow.billingTypeAtOrder !== "mixed") {
    console.error("預期 billingTypeAtOrder=mixed", orderRow?.billingTypeAtOrder);
    process.exit(1);
  }
  const cs = Number(orderRow.cashSubtotal ?? 0);
  const ms = Number(orderRow.monthlySubtotal ?? 0);
  if (Math.abs(cs - cashLineAmt) > 0.01 || Math.abs(ms - monthlyLineAmt) > 0.01) {
    console.error("小計不符", cs, ms);
    process.exit(1);
  }

  const ti = orderRow.taxInvoices[0];
  if (!ti || Number(ti.totalAmount) !== cashReceivableExpected) {
    console.error("預期現金發票含稅=", cashReceivableExpected, "got", ti?.totalAmount?.toString());
    process.exit(1);
  }

  const openAfterCreate = await prisma.arOpenItem.findMany({
    where: { customerId: customer.id, salesOrderId: BigInt(salesOrderId) },
    include: { arDocument: true },
  });
  const cashOi = openAfterCreate.find((x) => x.arDocument.billingType === "cash");
  if (!cashOi || Number(cashOi.outstandingAmount) !== cashReceivableExpected) {
    console.error("開單後現金 AR 應為含稅", cashReceivableExpected, openAfterCreate.map((x) => x.outstandingAmount.toString()));
    process.exit(1);
  }

  console.log("✓ 開單：mixed / 現金 AR（含稅）=", cashOi.outstandingAmount.toString(), "/ 月結列=", ms, "（尚未立月結 AR）");

  console.log("\n--- 2) POST 分派司機 ---");
  const assignBody = {
    salesOrderId,
    driverId: driver.id.toString(),
    vehicleId: null,
    assignmentDate: `${todayYmd()}T00:00:00`,
  };
  const assigned = await httpJson("POST", "/api/delivery-assignments", assignBody);
  if (assigned.status !== 201 || !(assigned.json as { ok?: boolean })?.ok) {
    console.error("分派失敗（若為信用額度請調整客戶欠款或 credit_limit）", assigned.status, assigned.json);
    process.exit(1);
  }
  const assignmentId = (assigned.json as { data: { id: string } }).data.id;
  console.log("assignmentId=", assignmentId);

  const assRow = await prisma.deliveryAssignment.findUnique({ where: { id: BigInt(assignmentId) } });
  const assignmentDateYmd = assRow ? localYmdFromDate(assRow.assignmentDate) : todayYmd();
  console.log("分派日（本地）=", assignmentDateYmd);

  console.log("\n--- 3) GET 司機今日任務（應含 driverBillingHints） ---");
  const code = driver.user!.employeeCode!;
  const jobsRes = await fetch(`${BASE}/api/driver/today?employeeCode=${encodeURIComponent(code)}&date=${encodeURIComponent(assignmentDateYmd)}`);
  const jobs = (await jobsRes.json()) as Array<{ id: string; driverBillingHints?: { cashDue: string; billingType: string } }>;
  const job = jobs.find((j) => String(j.id) === String(assignmentId));
  if (!job?.driverBillingHints) {
    console.error("找不到任務或無 hints", jobs.length);
    process.exit(1);
  }
  const collectDue = await prisma.$transaction(async (tx) => {
    const totalAgg = await tx.arOpenItem.aggregate({
      where: { customerId: customer.id, outstandingAmount: { gt: new Prisma.Decimal(0) } },
      _sum: { outstandingAmount: true },
    });
    const wallet = await tx.customerPrepaymentWallet.findUnique({ where: { customerId: customer.id } });
    const w = new Prisma.Decimal(wallet?.balanceAmount ?? 0);
    const t = new Prisma.Decimal(totalAgg._sum.outstandingAmount ?? 0);
    return t.minus(w).lessThan(0) ? new Prisma.Decimal(0) : t.minus(w);
  });
  const hintDue = new Prisma.Decimal(job.driverBillingHints.cashDue);
  if (!hintDue.equals(collectDue)) {
    console.error("司機 cashDue 與 DB 合計應收不符", hintDue.toString(), collectDue.toString());
    process.exit(1);
  }
  console.log("✓ driverBillingHints.cashDue=", hintDue.toString(), "(全客戶未清 − 預收)");

  console.log("\n--- 4) POST 司機回報送達 + 現場收款 ---");
  const payAmount = Number(collectDue.toString());
  const complete = await httpJson("POST", "/api/driver/complete", {
    assignmentId,
    delivered: true,
    emptyBarrelsReturned: 0,
    cashReceived: payAmount,
    note: "E2E",
  });
  const completeOk = complete.status === 200 && (complete.json as { ok?: boolean })?.ok === true;
  if (!completeOk) {
    console.error("司機回報失敗", complete.status, complete.json);
    process.exit(1);
  }

  const pending = await prisma.deliveryAssignment.findUnique({ where: { id: BigInt(assignmentId) } });
  if (pending?.status !== "pending_settlement") {
    console.error("預期 pending_settlement", pending?.status);
    process.exit(1);
  }
  console.log("✓ 狀態 pending_settlement, expectedAmount=", pending?.expectedAmount?.toString());

  console.log("\n--- 5) POST 辦公室核銷 ---");
  const approve = await httpJson("POST", "/api/settlements/approve", { assignmentId });
  if (approve.status !== 200 || !(approve.json as { ok?: boolean })?.ok) {
    console.error("核銷失敗", approve.status, approve.json);
    process.exit(1);
  }

  const finalOrder = await prisma.salesOrder.findUnique({
    where: { id: BigInt(salesOrderId) },
    include: {
      payments: true,
      assignments: true,
    },
  });
  if (finalOrder?.status !== "completed") {
    console.error("訂單應已完成", finalOrder?.status);
    process.exit(1);
  }

  const remainingAr = await prisma.arOpenItem.aggregate({
    where: { customerId: customer.id, outstandingAmount: { gt: new Prisma.Decimal(0) } },
    _sum: { outstandingAmount: true },
  });
  const rem = new Prisma.Decimal(remainingAr._sum.outstandingAmount ?? 0);
  const monthlyOi = await prisma.arOpenItem.findMany({
    where: {
      customerId: customer.id,
      outstandingAmount: { gt: new Prisma.Decimal(0) },
      arDocument: { billingType: "monthly" },
    },
  });

  console.log("\n--- 結果 ---");
  console.log("訂單狀態:", finalOrder.status);
  console.log("收款筆數:", finalOrder.payments.length, "金額合計:", finalOrder.payments.reduce((s, p) => s + Number(p.amount), 0));
  console.log("客戶剩餘未清 AR 總額:", rem.toString());
  console.log("仍為月結類別之未清 open items 筆數:", monthlyOi.length, "（月結貨款於批次結帳時才立帳，配送完成通常為 0）");
  if (!rem.equals(new Prisma.Decimal(0))) {
    console.warn("仍有未清 AR（可能為同客戶其他訂單欠款），本次測試仍視為流程成功");
  }

  console.log("\n✅ E2E 混合訂單流程通過（訂單號:", orderData.orderNo, ")");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
