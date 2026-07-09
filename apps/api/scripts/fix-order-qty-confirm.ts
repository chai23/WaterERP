/** 一次性修正：對指定訂單確認配送數量（例：代登改了桶數但未按確認） */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const ORDER_NO = process.argv[2] ?? "SO202607031801076449d4b";
const QTY = Number(process.argv[3] ?? "2");
const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;

async function main() {
  const prisma = new PrismaClient();
  const order = await prisma.salesOrder.findFirst({
    where: { orderNo: ORDER_NO },
    include: { lines: true, assignments: { where: { status: "pending_settlement" }, take: 1 } },
  });
  if (!order?.assignments[0]) {
    console.error("找不到待核銷任務");
    process.exit(1);
  }
  const line = order.lines.find((l) => (l.linePurpose ?? "delivery") === "delivery");
  if (!line) {
    console.error("找不到配送明細");
    process.exit(1);
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeCode: "admin", password: process.env.TEST_ADMIN_PASSWORD ?? "admin123" }),
  }).then((r) => r.json());
  if (!login.token) {
    console.error("登入失敗", login);
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/driver/confirm-line-deliveries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({
      assignmentId: order.assignments[0]!.id.toString(),
      lines: [{ lineId: line.id.toString(), qtyDelivered: QTY }],
    }),
  }).then((r) => r.json());
  console.log(JSON.stringify(res, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
