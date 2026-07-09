/**
 * 一次性修復：已取消訂單若仍有未作廢 AR，將立帳作廢並清零 outstanding。
 * 僅處理尚無沖帳（allocatedAmount = 0）之 open item。
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const cancelledOrders = await prisma.salesOrder.findMany({
    where: { status: "cancelled" },
    select: { id: true, orderNo: true, customerId: true },
  });
  let fixed = 0;
  for (const order of cancelledOrders) {
    const docs = await prisma.arDocument.findMany({
      where: { salesOrderId: order.id, status: { not: "voided" } },
      include: { openItems: { include: { allocations: true } } },
    });
    if (docs.length === 0) continue;

    await prisma.$transaction(async (tx) => {
      for (const d of docs) {
        for (const oi of d.openItems) {
          if (oi.allocations.length > 0 || new Prisma.Decimal(oi.allocatedAmount).greaterThan(0)) {
            console.warn(
              `略過 ${order.orderNo}：AR ${d.arNo} 已有沖帳（openItem ${oi.id.toString()}）`,
            );
            continue;
          }
          await tx.arOpenItem.update({
            where: { id: oi.id },
            data: { outstandingAmount: new Prisma.Decimal(0), status: "paid" },
          });
        }
        await tx.arDocument.update({ where: { id: d.id }, data: { status: "voided" } });
      }
      await tx.taxInvoice.updateMany({
        where: { salesOrderId: order.id, status: "issued" },
        data: { status: "voided" },
      });
    });
    fixed += 1;
    console.log(`已作廢 ${order.orderNo} 之 AR`);
  }
  console.log(`完成：處理 ${fixed} 筆已取消訂單`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
