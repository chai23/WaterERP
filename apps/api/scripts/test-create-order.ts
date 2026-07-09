import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { ADMIN_EMPLOYEE_CODE, ADMIN_PASSWORD, ensureAdminUser } from "./ensure-admin-user-core.js";

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const prisma = new PrismaClient();

async function main() {
  await ensureAdminUser(prisma);
  await prisma.user.update({
    where: { employeeCode: ADMIN_EMPLOYEE_CODE },
    data: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10) },
  });

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeCode: ADMIN_EMPLOYEE_CODE, password: ADMIN_PASSWORD }),
  });
  const lj = (await login.json()) as { ok?: boolean; token?: string };
  if (!login.ok || !lj.token) {
    console.error("登入失敗", lj);
    process.exit(1);
  }

  const customer = await prisma.customer.findFirst({
    where: { addresses: { some: {} } },
    include: { addresses: { take: 1, orderBy: { id: "asc" } } },
  });
  const product = await prisma.product.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } });
  if (!customer?.addresses[0] || !product) {
    console.error("缺少測試資料");
    process.exit(1);
  }

  const ymd = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${BASE}/api/sales-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lj.token}`,
    },
    body: JSON.stringify({
      customerId: customer.id.toString(),
      deliveryAddressId: customer.addresses[0].id.toString(),
      scheduledDeliveryDate: ymd,
      lines: [{ productId: product.id.toString(), qty: 1, billingType: "cash", linePurpose: "delivery" }],
    }),
  });
  const body = await res.json();
  console.log("status", res.status);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok || !(body as { ok?: boolean }).ok) process.exit(1);
  console.log("✓ 開單成功");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
