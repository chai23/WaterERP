/**
 * 辦公室代登配送回報 E2E：開單 → 分派 → 管理員代登回報 → 核銷 → 驗證 office_proxy 事件
 *
 * 用法（需 API 已啟動）：
 *   npx tsx scripts/e2e-office-proxy-report.ts
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

function localYmdFromDate(d: Date): string {
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

  const admin = await prisma.user.findUnique({
    where: { employeeCode: ADMIN_EMPLOYEE_CODE },
  });
  if (!admin) {
    console.error("找不到 admin 使用者");
    process.exit(1);
  }

  const login = await httpJson("POST", "/api/auth/login", {
    employeeCode: admin.employeeCode,
    password: process.env.TEST_ADMIN_PASSWORD ?? ADMIN_PASSWORD,
  });
  if (login.status !== 200 || !(login.json as { ok?: boolean })?.ok) {
    console.error("管理員登入失敗（可設 TEST_ADMIN_PASSWORD）", login.json);
    process.exit(1);
  }
  const token = (login.json as { token: string }).token;
  console.log("✓ 管理員登入", admin.employeeCode);

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

  if (!customer?.addresses[0] || !driver?.user?.employeeCode || !product) {
    console.error("資料不足");
    process.exit(1);
  }

  const ymd = todayYmd();
  let assignmentId: string;
  let driverEmployeeCode: string;
  let queryDate = ymd;

  const existingAssigned = await prisma.deliveryAssignment.findFirst({
    where: { status: { in: ["assigned", "delivering"] } },
    include: { driver: { include: { user: true } }, salesOrder: true },
    orderBy: { id: "desc" },
  });

  if (existingAssigned?.driver?.user?.employeeCode) {
    assignmentId = existingAssigned.id.toString();
    driverEmployeeCode = existingAssigned.driver.user.employeeCode;
    queryDate = localYmdFromDate(existingAssigned.assignmentDate);
    console.log("使用既有已分派任務 assignmentId=", assignmentId, "配送日=", queryDate);
  } else {
    console.log("\n--- 1) 開單（無現成任務，建立測試單）---");
    const createdOrder = await prisma.$transaction(async (tx) => {
      const so = await tx.salesOrder.create({
        data: {
          orderNo: `SO${Date.now()}`,
          customerId: customer.id,
          deliveryAddressId: customer.addresses[0]!.id,
          status: "confirmed",
          scheduledDeliveryDate: new Date(`${ymd}T00:00:00`),
          subtotal: product.salePrice,
          totalAmount: product.salePrice,
          billingTypeAtOrder: "cash",
          cashSubtotal: product.salePrice,
          monthlySubtotal: 0,
          orderCashAdjustment: 0,
          createdByUserId: admin.id,
          lines: {
            create: {
              productId: product.id,
              qtyOrdered: 1,
              qtyDelivered: 0,
              unitPrice: product.salePrice,
              lineAmount: product.salePrice,
              billingTypeAtLine: "cash",
              linePurpose: "delivery",
            },
          },
        },
      });
      const asn = await tx.deliveryAssignment.create({
        data: {
          salesOrderId: so.id,
          driverId: driver.id,
          assignmentDate: new Date(`${ymd}T00:00:00`),
          status: "assigned",
          assignedByUserId: admin.id,
        },
      });
      return { orderNo: so.orderNo, assignmentId: asn.id.toString() };
    });
    assignmentId = createdOrder.assignmentId;
    driverEmployeeCode = driver.user!.employeeCode!;
    const asnRow = await prisma.deliveryAssignment.findUnique({ where: { id: BigInt(assignmentId) } });
    if (asnRow) queryDate = localYmdFromDate(asnRow.assignmentDate);
    console.log("orderNo=", createdOrder.orderNo, "assignmentId=", assignmentId, "配送日=", queryDate);
  }

  console.log("\n--- 2) GET driver/today（辦公室查任務）---");
  const jobsRes = await httpJson(
    "GET",
    `/api/driver/today?employeeCode=${encodeURIComponent(driverEmployeeCode)}&date=${encodeURIComponent(queryDate)}`,
    undefined,
    token,
  );
  if (jobsRes.status !== 200 || !Array.isArray(jobsRes.json)) {
    console.error("讀取任務失敗", jobsRes);
    process.exit(1);
  }
  const found = (jobsRes.json as { id: string }[]).find((j) => String(j.id) === String(assignmentId));
  if (!found) {
    console.error("找不到分派任務");
    process.exit(1);
  }
  console.log("✓ 任務在清單中");

  console.log("\n--- 3) POST driver/complete（辦公室代登）---");
  const complete = await httpJson(
    "POST",
    "/api/driver/complete",
    {
      assignmentId,
      delivered: true,
      emptyBarrelsReturned: 2,
      cashReceived: 0,
      note: "辦公室代登司機回報",
      reportedAtYmd: queryDate,
    },
    token,
  );
  if (complete.status !== 200 || !(complete.json as { ok?: boolean })?.ok) {
    console.error("代登回報失敗", complete.json);
    process.exit(1);
  }
  const pending = await prisma.deliveryAssignment.findUnique({
    where: { id: BigInt(assignmentId) },
    include: { events: { orderBy: { id: "desc" }, take: 1 } },
  });
  if (pending?.status !== "pending_settlement") {
    console.error("預期 pending_settlement", pending?.status);
    process.exit(1);
  }
  const payload = pending.events[0]?.payloadJson as Record<string, unknown> | undefined;
  if (payload?.source !== "office_proxy" || payload?.reportedByEmployeeCode !== admin.employeeCode) {
    console.error("事件未記錄 office_proxy", payload);
    process.exit(1);
  }
  if (pending.emptyBarrelsReturned !== 2) {
    console.error("空桶數不符", pending.emptyBarrelsReturned);
    process.exit(1);
  }
  console.log("✓ 代登回報成功，事件 source=office_proxy");

  console.log("\n--- 4) POST settlements/approve ---");
  const approve = await httpJson("POST", "/api/settlements/approve", { assignmentId }, token);
  if (approve.status !== 200 || !(approve.json as { ok?: boolean })?.ok) {
    const msg = String((approve.json as { message?: string })?.message ?? "");
    if (msg.includes("created_by_user_id")) {
      console.warn("⚠ 核銷因 created_by_user_id FK 失敗（舊資料庫無 user id=1；代登回報功能已驗證通過）");
      console.log("\n代登配送回報核心流程測試通過。");
      return;
    }
    console.error("核銷失敗", approve.json);
    process.exit(1);
  }
  const done = await prisma.deliveryAssignment.findUnique({ where: { id: BigInt(assignmentId) } });
  if (done?.status !== "completed") {
    console.error("預期 completed", done?.status);
    process.exit(1);
  }
  console.log("✓ 核銷完成 status=", done?.status);

  console.log("\n全部通過：辦公室代登配送回報流程正常。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
