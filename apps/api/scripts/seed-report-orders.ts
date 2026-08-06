import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const BASE = process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const TAG = "REPORT-SEED-20260806-V1";
let authToken = "";

type Billing = "cash" | "monthly" | "prepaid";
type Stage = "completed" | "not_delivered" | "pending_settlement" | "assigned";
type PayMode = "full" | "partial" | "none";

type MasterCustomer = {
  id: bigint;
  customerCode: string | null;
  name: string;
  addresses: Array<{ id: bigint }>;
};

type Scenario = {
  index: number;
  kind: string;
  billing: Billing;
  stage: Stage;
  payMode: PayMode;
  delivered: boolean;
  customer: MasterCustomer;
  productId: bigint;
  driverId: bigint;
  ymd: string;
  qty: number;
  linePurpose?: "delivery" | "prepaid_barrel_topup";
};

function ymdAt(index: number): string {
  const start = new Date(2026, 0, 1, 12, 0, 0, 0);
  // 217 天內重複落點：同日多客戶、同客戶跨不同日期。
  const offset = (index * 17 + Math.floor(index / 7) * 3) % 217;
  const d = new Date(start);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function anchor(ymd: string, hour = 12): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!, hour, 0, 0, 0);
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  if (!res.ok || (parsed as { ok?: boolean } | null)?.ok === false) {
    throw new Error(`${path} ${res.status} ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function alignDates(orderId: bigint, ymd: string) {
  const at = anchor(ymd, 12);
  await prisma.$transaction([
    prisma.salesOrder.update({ where: { id: orderId }, data: { createdAt: at, updatedAt: at } }),
    prisma.salesOrderLine.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, updatedAt: at } }),
    prisma.deliveryAssignment.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, updatedAt: at } }),
    prisma.arDocument.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, updatedAt: at, postedAt: at } }),
    prisma.arOpenItem.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, updatedAt: at } }),
    prisma.payment.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, paidAt: at } }),
    prisma.customerLedgerEntry.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at } }),
    prisma.stockMovement.updateMany({ where: { refType: "sales_order", refId: orderId }, data: { createdAt: at } }),
    prisma.barrelMovement.updateMany({ where: { salesOrderId: orderId }, data: { createdAt: at, occurredAt: at, movementDate: at } }),
  ]);
}

async function createOne(s: Scenario) {
  const remark = `${TAG}#${String(s.index).padStart(4, "0")} ${s.kind}`;
  const existing = await prisma.salesOrder.findFirst({
    where: { remark },
    include: { assignments: { orderBy: { id: "desc" }, take: 1 } },
  });
  if (existing) {
    const assignment = existing.assignments[0];
    if (
      assignment?.status === "pending_settlement" &&
      (s.stage === "completed" || s.stage === "not_delivered")
    ) {
      await api("/api/settlements/approve", {
        assignmentId: assignment.id.toString(),
        officeSettledAt: `${s.ymd}T18:00:00+08:00`,
      });
      await alignDates(existing.id, s.ymd);
    }
    return { skipped: true, orderNo: existing.orderNo };
  }

  type CreateResponse = { ok: true; data: { id: string; orderNo: string } };
  const created = await api<CreateResponse>("/api/sales-orders", {
    customerId: s.customer.id.toString(),
    deliveryAddressId: s.customer.addresses[0]!.id.toString(),
    scheduledDeliveryDate: s.ymd,
    cashInvoiceMode: "none",
    remark,
    lines: [{
      productId: s.productId.toString(),
      qty: s.qty,
      billingType: s.billing,
      linePurpose: s.linePurpose ?? "delivery",
    }],
  });
  const orderId = BigInt(created.data.id);

  type AssignResponse = { ok: true; data: { id: string } };
  const assigned = await api<AssignResponse>("/api/delivery-assignments", {
    salesOrderId: created.data.id,
    driverId: s.driverId.toString(),
    assignmentDate: `${s.ymd}T08:00:00+08:00`,
    estimatedDeliverySlot: s.index % 3 === 0 ? "上午" : s.index % 3 === 1 ? "下午" : "傍晚",
  });

  if (s.stage !== "assigned") {
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
    const amount = Number(order.cashSubtotal);
    const cashReceived = s.billing !== "cash" || !s.delivered || s.payMode === "none"
      ? 0
      : s.payMode === "partial"
        ? Math.max(1, Math.floor(amount / 2))
        : amount;

    await api("/api/driver/complete", {
      assignmentId: assigned.data.id,
      delivered: s.delivered,
      failureReason: s.delivered ? undefined : ["客戶不在", "臨時取消", "地址無人收貨"][s.index % 3],
      emptyBarrelsReturned: 0,
      cashReceived,
      checkReceived: 0,
      reportedAt: `${s.ymd}T17:00:00+08:00`,
      note: `${remark} 司機回報`,
      lines: s.delivered
        ? order.lines
            .filter((line) => line.linePurpose === "delivery")
            .map((line) => ({ lineId: line.id.toString(), qtyDelivered: line.qtyOrdered }))
        : undefined,
    });

    if (s.stage === "completed" || s.stage === "not_delivered") {
      await api("/api/settlements/approve", {
        assignmentId: assigned.data.id,
        officeSettledAt: `${s.ymd}T18:00:00+08:00`,
      });
    }
  }

  await alignDates(orderId, s.ymd);
  return { skipped: false, orderNo: created.data.orderNo };
}

function addScenarios(
  out: Scenario[],
  count: number,
  spec: Omit<Scenario, "index" | "customer" | "productId" | "driverId" | "ymd" | "qty">,
  customers: MasterCustomer[],
  products: Array<{ id: bigint }>,
  drivers: Array<{ id: bigint }>,
) {
  for (let j = 0; j < count; j++) {
    const index = out.length + 1;
    out.push({
      ...spec,
      index,
      customer: customers[j % customers.length]!,
      productId: products[(j * 5 + index) % products.length]!.id,
      driverId: drivers[(j * 3 + index) % drivers.length]!.id,
      ymd: ymdAt(index),
      qty: 1 + (index % 4),
    });
  }
}

async function main() {
  const health = await fetch(BASE + "/api/health");
  if (!health.ok) throw new Error(`API 未啟動：${BASE}`);

  const admin = await prisma.user.findFirst({ where: { role: "admin", isActive: true }, orderBy: { id: "asc" } });
  if (!admin) throw new Error("找不到啟用中的管理員帳號");
  authToken = jwt.sign(
    { sub: admin.id.toString(), role: admin.role, employeeCode: admin.employeeCode },
    process.env.JWT_SECRET ?? "change-me",
    { expiresIn: "2h" },
  );

  const customerSelect = { id: true, customerCode: true, name: true, addresses: { take: 1, orderBy: { id: "asc" as const }, select: { id: true } } };
  const [cashCustomers, monthlyCustomers, prepaidCustomers, products, prepaidProducts, drivers] = await Promise.all([
    prisma.customer.findMany({ where: { billingType: "cash", lifecycleStatus: "active", addresses: { some: {} }, creditLimit: 0 }, take: 180, orderBy: { id: "asc" }, select: customerSelect }),
    prisma.customer.findMany({ where: { billingType: "monthly", lifecycleStatus: "active", addresses: { some: {} }, creditLimit: 0 }, take: 120, orderBy: { id: "asc" }, select: customerSelect }),
    prisma.customer.findMany({ where: { billingType: "prepaid", lifecycleStatus: "active", addresses: { some: {} }, creditLimit: 0 }, take: 20, orderBy: { id: "asc" }, select: customerSelect }),
    prisma.product.findMany({ where: { isActive: true, salePrice: { gt: 0 }, sku: { not: { startsWith: "SYS-" } } }, take: 12, orderBy: { id: "asc" }, select: { id: true } }),
    prisma.product.findMany({ where: { isActive: true, salePrice: { gt: 0 }, consumesPrepaidBarrel: true }, take: 1, orderBy: { id: "asc" }, select: { id: true } }),
    prisma.driver.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, select: { id: true } }),
  ]);

  if (cashCustomers.length < 20 || monthlyCustomers.length < 20 || prepaidCustomers.length < 10 || products.length < 3 || prepaidProducts.length < 1 || drivers.length < 2) {
    throw new Error("既有主檔不足：需要現金／月結／預付客戶、商品與司機");
  }

  // 報表資料會實際核銷出庫；先以可追蹤的庫存調整紀錄補足測試所需數量。
  const stockProductIds = [...new Set([...products, ...prepaidProducts].map((p) => p.id.toString()))].map(BigInt);
  for (const productId of stockProductIds) {
    const inventory = await prisma.inventoryBalance.findUnique({ where: { productId } });
    const before = inventory?.qtyOnHand ?? 0;
    if (before >= 5000) continue;
    const qtyDelta = 5000 - before;
    await prisma.$transaction(async (tx) => {
      await tx.inventoryBalance.upsert({
        where: { productId },
        create: { productId, qtyOnHand: 5000 },
        update: { qtyOnHand: 5000 },
      });
      await tx.stockMovement.create({
        data: {
          productId,
          movementType: "adjustment_in",
          qtyDelta,
          refType: "report_seed",
          note: `${TAG} 報表測試資料庫存補足（${before} → 5000）`,
          createdByUserId: admin.id,
        },
      });
    });
  }

  const scenarios: Scenario[] = [];
  const prepaidProduct = prepaidProducts[0]!;

  // 20 筆儲值單先為既有預付客戶建立同商品額度，每筆 30 桶。
  for (let j = 0; j < 20; j++) {
    const index = scenarios.length + 1;
    scenarios.push({
      index,
      kind: "預付儲值已送達足額",
      billing: "cash",
      stage: "completed",
      payMode: "full",
      delivered: true,
      customer: prepaidCustomers[j]!,
      productId: prepaidProduct.id,
      driverId: drivers[j % drivers.length]!.id,
      ymd: ymdAt(index),
      qty: 30,
      linePurpose: "prepaid_barrel_topup",
    });
  }

  addScenarios(scenarios, 100, { kind: "現金已送達足額", billing: "cash", stage: "completed", payMode: "full", delivered: true }, cashCustomers, products, drivers);
  addScenarios(scenarios, 50, { kind: "現金已送達未收款", billing: "cash", stage: "completed", payMode: "none", delivered: true }, cashCustomers, products, drivers);
  addScenarios(scenarios, 30, { kind: "現金已送達部分收款", billing: "cash", stage: "completed", payMode: "partial", delivered: true }, cashCustomers, products, drivers);
  addScenarios(scenarios, 120, { kind: "月結已送達", billing: "monthly", stage: "completed", payMode: "none", delivered: true }, monthlyCustomers, products, drivers);
  addScenarios(scenarios, 80, { kind: "預付已送達扣桶", billing: "prepaid", stage: "completed", payMode: "none", delivered: true }, prepaidCustomers, [prepaidProduct], drivers);
  addScenarios(scenarios, 25, { kind: "現金未送達已核銷", billing: "cash", stage: "not_delivered", payMode: "none", delivered: false }, cashCustomers, products, drivers);
  addScenarios(scenarios, 25, { kind: "月結未送達已核銷", billing: "monthly", stage: "not_delivered", payMode: "none", delivered: false }, monthlyCustomers, products, drivers);
  addScenarios(scenarios, 20, { kind: "現金已回報待核銷", billing: "cash", stage: "pending_settlement", payMode: "none", delivered: true }, cashCustomers, products, drivers);
  addScenarios(scenarios, 15, { kind: "月結已回報待核銷", billing: "monthly", stage: "pending_settlement", payMode: "none", delivered: true }, monthlyCustomers, products, drivers);
  addScenarios(scenarios, 15, { kind: "預付未送達待核銷", billing: "prepaid", stage: "pending_settlement", payMode: "none", delivered: false }, prepaidCustomers, [prepaidProduct], drivers);
  addScenarios(scenarios, 20, { kind: "現金已分派待回報", billing: "cash", stage: "assigned", payMode: "none", delivered: true }, cashCustomers, products, drivers);
  addScenarios(scenarios, 10, { kind: "月結已分派待回報", billing: "monthly", stage: "assigned", payMode: "none", delivered: true }, monthlyCustomers, products, drivers);
  addScenarios(scenarios, 10, { kind: "預付已分派待回報", billing: "prepaid", stage: "assigned", payMode: "none", delivered: true }, prepaidCustomers, [prepaidProduct], drivers);

  // 預付配送需依商品分帳；額外補充 20 筆儲值，避免大量歷史情境耗盡首輪額度。
  const supplementalTopups: Scenario[] = prepaidCustomers.map((customer, j) => ({
    index: 1001 + j,
    kind: "預付報表批次補充儲值",
    billing: "cash",
    stage: "completed",
    payMode: "full",
    delivered: true,
    customer,
    productId: prepaidProduct.id,
    driverId: drivers[j % drivers.length]!.id,
    ymd: ymdAt(501 + j),
    qty: 100,
    linePurpose: "prepaid_barrel_topup",
  }));

  console.log(`準備建立 ${scenarios.length + supplementalTopups.length} 筆，標記 ${TAG}`);
  let created = 0;
  let skipped = 0;
  for (const scenario of supplementalTopups) {
    const result = await createOne(scenario);
    result.skipped ? skipped++ : created++;
  }
  for (const scenario of scenarios) {
    const result = await createOne(scenario);
    result.skipped ? skipped++ : created++;
    if (scenario.index % 25 === 0 || scenario.index === scenarios.length) {
      console.log(`進度 ${scenario.index}/${scenarios.length}（新增 ${created}、略過 ${skipped}）`);
    }
  }

  const rows = await prisma.salesOrder.findMany({
    where: { remark: { startsWith: TAG } },
    select: {
      status: true,
      billingTypeAtOrder: true,
      scheduledDeliveryDate: true,
      assignments: { select: { status: true, settlementOutcome: true } },
    },
  });
  const byOrderStatus: Record<string, number> = {};
  const byBilling: Record<string, number> = {};
  const byAssignment: Record<string, number> = {};
  const days = new Set<string>();
  for (const row of rows) {
    byOrderStatus[row.status] = (byOrderStatus[row.status] ?? 0) + 1;
    const billing = row.billingTypeAtOrder ?? "unknown";
    byBilling[billing] = (byBilling[billing] ?? 0) + 1;
    for (const assignment of row.assignments) {
      const key = `${assignment.status}/${assignment.settlementOutcome ?? "none"}`;
      byAssignment[key] = (byAssignment[key] ?? 0) + 1;
    }
    if (row.scheduledDeliveryDate) days.add(row.scheduledDeliveryDate.toISOString().slice(0, 10));
  }

  console.log(JSON.stringify({ tag: TAG, total: rows.length, created, skipped, distinctDates: days.size, byOrderStatus, byBilling, byAssignment }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
