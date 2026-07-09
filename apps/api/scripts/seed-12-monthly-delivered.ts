import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 種子：將銷單／AR 立帳時間對齊實際配送日（報表／對帳單語意一致） */
function anchorFromLocalYmd(ymd: string): Date {
  const parts = ymd.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`無效配送日 ${ymd}`);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

async function alignOrderAccountingDates(prisma: PrismaClient, salesOrderId: bigint, deliveryYmd: string) {
  const anchor = anchorFromLocalYmd(deliveryYmd);
  await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({
      where: { id: salesOrderId },
      data: { createdAt: anchor, updatedAt: anchor },
    });
    await tx.arDocument.updateMany({
      where: { salesOrderId },
      data: { createdAt: anchor, updatedAt: anchor, postedAt: anchor },
    });
    await tx.arOpenItem.updateMany({
      where: { salesOrderId },
      data: { createdAt: anchor, updatedAt: anchor },
    });
  });
}

async function api<T>(base: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function clearTransactional(prisma: PrismaClient) {
  const raw = fs.readFileSync(path.join(process.cwd(), "scripts", "clear-transactional-data.sql"), "utf8");
  const stmts = raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) await prisma.$executeRawUnsafe(s);
}

async function main() {
  const prisma = new PrismaClient();
  const base = process.env.API_BASE_URL ?? "http://localhost:3000";

  await clearTransactional(prisma);

  const customer = await prisma.customer.findFirst({
    where: { billingType: "monthly" },
    include: { addresses: { where: { isDefault: true }, take: 1 } },
    orderBy: { id: "asc" },
  });
  if (!customer) throw new Error("找不到月結客戶（billing_type=monthly）");

  const addr =
    customer.addresses[0] ??
    (await prisma.deliveryAddress.findFirst({ where: { customerId: customer.id } }));
  if (!addr) throw new Error("該客戶無送貨地址");

  const driver = await prisma.driver.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });
  if (!driver) throw new Error("找不到啟用中的司機");

  const product = await prisma.product.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });
  if (!product) throw new Error("找不到啟用中的商品");

  /** 12 筆訂單配送／分派／司機回報日期：涵蓋 2026-05～06（間隔約 5 日） */
  const DELIVERY_YMD = [
    "2026-05-05",
    "2026-05-10",
    "2026-05-15",
    "2026-05-20",
    "2026-05-25",
    "2026-05-30",
    "2026-06-04",
    "2026-06-09",
    "2026-06-14",
    "2026-06-19",
    "2026-06-24",
    "2026-06-29",
  ] as const;

  const orderNos: string[] = [];

  for (let i = 1; i <= 12; i++) {
    await sleep(1100);

    const deliveryYmd = DELIVERY_YMD[i - 1];
    const officeSettledAt = `${deliveryYmd}T18:00:00+08:00`;

    type SoRes = { ok: boolean; data?: { id: string; orderNo: string } };
    const so = await api<SoRes>(base, "/api/sales-orders", {
      method: "POST",
      body: JSON.stringify({
        customerId: customer.id.toString(),
        deliveryAddressId: addr.id.toString(),
        lines: [{ productId: product.id.toString(), qty: 1, billingType: "monthly" }],
        scheduledDeliveryDate: deliveryYmd,
        remark: `seed-monthly-${i}/12`,
      }),
    });
    if (!so.ok || !so.data) throw new Error(`建立訂單失敗: ${JSON.stringify(so)}`);
    orderNos.push(so.data.orderNo);

    type AssignRes = { ok: boolean; data?: { id: string } };
    const assign = await api<AssignRes>(base, "/api/delivery-assignments", {
      method: "POST",
      body: JSON.stringify({
        salesOrderId: so.data.id,
        driverId: driver.id.toString(),
        assignmentDate: deliveryYmd,
      }),
    });
    if (!assign.ok || !assign.data) throw new Error(`分派失敗: ${JSON.stringify(assign)}`);

    type DrvRes = { ok: boolean };
    const drv = await api<DrvRes>(base, "/api/driver/complete", {
      method: "POST",
      body: JSON.stringify({
        assignmentId: assign.data.id,
        delivered: true,
        cashReceived: 0,
        emptyBarrelsReturned: 0,
        reportedAtYmd: deliveryYmd,
      }),
    });
    if (!drv.ok) throw new Error(`司機回報失敗: ${JSON.stringify(drv)}`);

    type ApproveRes = { ok: boolean };
    const ap = await api<ApproveRes>(base, "/api/settlements/approve", {
      method: "POST",
      body: JSON.stringify({
        assignmentId: assign.data.id,
        officeSettledAt,
      }),
    });
    if (!ap.ok) throw new Error(`核銷失敗: ${JSON.stringify(ap)}`);

    await alignOrderAccountingDates(prisma, BigInt(so.data.id), deliveryYmd);
  }

  const summary = await prisma.salesOrder.findMany({
    where: { orderNo: { in: orderNos } },
    select: {
      orderNo: true,
      status: true,
      scheduledDeliveryDate: true,
      totalAmount: true,
      monthlySubtotal: true,
      monthlyPeriodPaid: true,
      billingPeriodKey: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(
    JSON.stringify(
      {
        cleared: true,
        seededMonthlyDelivered: 12,
        apiBase: base,
        customer: { id: customer.id.toString(), name: customer.name },
        driverId: driver.id.toString(),
        productId: product.id.toString(),
        orderNos,
        summary,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
