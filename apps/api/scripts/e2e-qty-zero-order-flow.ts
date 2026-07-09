/**
 * E2E：開單 qty=0（待定）→ 代登填實際桶數 → 核銷 → 驗證金額與出庫
 *
 * 用法（需 API 已啟動）：
 *   npx tsx scripts/e2e-qty-zero-order-flow.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { ADMIN_EMPLOYEE_CODE, ADMIN_PASSWORD, ensureAdminUser } from "./ensure-admin-user-core.js";

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const prisma = new PrismaClient();

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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
    console.error("API 未啟動");
    process.exit(1);
  }

  await ensureAdminUser(prisma);
  await prisma.user.update({
    where: { employeeCode: ADMIN_EMPLOYEE_CODE },
    data: { passwordHash: await bcrypt.hash(process.env.TEST_ADMIN_PASSWORD ?? ADMIN_PASSWORD, 10) },
  });

  const login = await httpJson("POST", "/api/auth/login", {
    employeeCode: ADMIN_EMPLOYEE_CODE,
    password: process.env.TEST_ADMIN_PASSWORD ?? ADMIN_PASSWORD,
  });
  if (login.status !== 200 || !(login.json as { ok?: boolean })?.ok) {
    console.error("管理員登入失敗", login.json);
    process.exit(1);
  }
  const token = (login.json as { token: string }).token;

  const customer = await prisma.customer.findFirst({
    where: { addresses: { some: {} } },
    include: { addresses: { take: 1, orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  const driver = await prisma.driver.findFirst({
    where: { isActive: true },
    include: { user: true },
  });
  const product = await prisma.product.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });
  const vehicle = await prisma.vehicle.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });

  if (!customer?.addresses[0] || !driver?.user?.employeeCode || !product) {
    console.error("資料不足（客戶／司機／商品）");
    process.exit(1);
  }

  const ymd = todayYmd();
  const actualQty = 3;
  const unitPrice = Number(product.salePrice) > 0 ? Number(product.salePrice) : 100;

  console.log("\n--- 1) POST sales-orders（qty=0 待定）---");
  const created = await httpJson(
    "POST",
    "/api/sales-orders",
    {
      customerId: customer.id.toString(),
      deliveryAddressId: customer.addresses[0]!.id.toString(),
      scheduledDeliveryDate: ymd,
      remark: "E2E qty=0 待定測試",
      lines: [{ productId: product.id.toString(), qty: 0, billingType: "cash", unitPrice }],
    },
    token,
  );
  if (created.status !== 201 || !(created.json as { ok?: boolean })?.ok) {
    console.error("開單失敗", created.json);
    process.exit(1);
  }
  const orderData = (created.json as { data: { id: string; orderNo: string; totalAmount: string; lines: { id: string }[] } }).data;
  if (Number(orderData.totalAmount) !== 0) {
    console.error("預期開單總額為 0", orderData.totalAmount);
    process.exit(1);
  }
  const lineId = orderData.lines[0]!.id;
  console.log("✓ 開單", orderData.orderNo, "總額=0 lineId=", lineId);

  console.log("\n--- 2) POST delivery-assignments ---");
  const assign = await httpJson(
    "POST",
    "/api/delivery-assignments",
    {
      salesOrderId: orderData.id,
      driverId: driver.id.toString(),
      ...(vehicle ? { vehicleId: vehicle.id.toString() } : {}),
      assignmentDate: ymd,
    },
    token,
  );
  if (assign.status !== 201 || !(assign.json as { ok?: boolean })?.ok) {
    console.error("分派失敗", assign.json);
    process.exit(1);
  }
  const assignmentId = (assign.json as { data: { id: string } }).data.id;
  console.log("✓ 分派 assignmentId=", assignmentId);

  console.log("\n--- 3) POST confirm-line-deliveries ---");
  const confirm = await httpJson(
    "POST",
    "/api/driver/confirm-line-deliveries",
    {
      assignmentId,
      lines: [{ lineId, qtyDelivered: actualQty }],
    },
    token,
  );
  if (confirm.status !== 200 || !(confirm.json as { ok?: boolean })?.ok) {
    console.error("確認配送數量失敗", confirm.json);
    process.exit(1);
  }
  console.log("✓ 已確認配送數量");

  console.log("\n--- 4) POST driver/complete ---");
  const complete = await httpJson(
    "POST",
    "/api/driver/complete",
    {
      assignmentId,
      delivered: true,
      emptyBarrelsReturned: 0,
      cashReceived: 0,
      note: "E2E 代登",
      reportedAtYmd: ymd,
    },
    token,
  );
  if (complete.status !== 200 || !(complete.json as { ok?: boolean })?.ok) {
    console.error("代登回報失敗", complete.json);
    process.exit(1);
  }

  const orderAfterReport = await prisma.salesOrder.findUnique({
    where: { id: BigInt(orderData.id) },
    include: { lines: true },
  });
  const lineAfter = orderAfterReport?.lines[0];
  if (!lineAfter || lineAfter.qtyDelivered !== actualQty) {
    console.error("回報後 qtyDelivered 不符", lineAfter?.qtyDelivered);
    process.exit(1);
  }
  const expectedTotal = unitPrice * actualQty;
  if (Math.abs(Number(orderAfterReport?.totalAmount) - expectedTotal) > 0.01) {
    console.error("回報後訂單總額不符", orderAfterReport?.totalAmount, "預期", expectedTotal);
    process.exit(1);
  }
  console.log("✓ 回報後總額=", orderAfterReport?.totalAmount, "qtyDelivered=", lineAfter.qtyDelivered);

  const invBefore = await prisma.inventoryBalance.findUnique({ where: { productId: product.id } });
  const onHandBefore = invBefore?.qtyOnHand ?? 0;

  console.log("\n--- 5) POST settlements/approve ---");
  const approve = await httpJson("POST", "/api/settlements/approve", { assignmentId }, token);
  if (approve.status !== 200 || !(approve.json as { ok?: boolean })?.ok) {
    console.error("核銷失敗", approve.json);
    process.exit(1);
  }

  const invAfter = await prisma.inventoryBalance.findUnique({ where: { productId: product.id } });
  const onHandAfter = invAfter?.qtyOnHand ?? 0;
  if (onHandBefore - onHandAfter !== actualQty) {
    console.error("出庫數量不符", onHandBefore, onHandAfter, "預期扣", actualQty);
    process.exit(1);
  }

  const done = await prisma.deliveryAssignment.findUnique({ where: { id: BigInt(assignmentId) } });
  if (done?.status !== "completed") {
    console.error("預期 completed", done?.status);
    process.exit(1);
  }

  console.log("\n全部通過：qty=0 開單 → 回報實際桶數 → 核銷出庫 流程正常。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
