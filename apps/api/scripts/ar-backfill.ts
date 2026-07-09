import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function dueDateFromCustomerDay(day: number | null | undefined): Date | null {
  if (!day || day < 1 || day > 31) return null;
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), day);
}

async function main() {
  const orders = await prisma.salesOrder.findMany({
    where: { status: { notIn: ["cancelled"] } },
    include: { customer: true, arDocuments: true },
    orderBy: { id: "asc" },
  });

  let createdCount = 0;
  for (const order of orders) {
    if (order.arDocuments.length > 0) continue;
    const cashPortion = new Prisma.Decimal(order.cashSubtotal ?? 0);
    const monthlyPortion = new Prisma.Decimal(order.monthlySubtotal ?? 0);
    const docs: Array<{ billingType: string; amount: Prisma.Decimal; dueDate: Date | null }> = [];
    if (cashPortion.greaterThan(0) || order.billingTypeAtOrder === "cash") {
      const amt = cashPortion.greaterThan(0) ? cashPortion : new Prisma.Decimal(order.totalAmount);
      docs.push({ billingType: "cash", amount: amt, dueDate: new Date() });
    }
    if (monthlyPortion.greaterThan(0) || order.billingTypeAtOrder === "monthly") {
      const amt = monthlyPortion.greaterThan(0) ? monthlyPortion : new Prisma.Decimal(order.totalAmount);
      docs.push({
        billingType: "monthly",
        amount: amt,
        dueDate: dueDateFromCustomerDay(order.customer.monthlySettlementDay),
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const d of docs) {
        const ar = await tx.arDocument.create({
          data: {
            arNo: `ARB${order.id.toString().padStart(10, "0")}${d.billingType === "cash" ? "C" : "M"}`,
            customerId: order.customerId,
            salesOrderId: order.id,
            documentType: "delivery",
            billingType: d.billingType,
            documentAmount: d.amount,
            dueDate: d.dueDate,
            status: "open",
            postedAt: order.createdAt,
            createdByUserId: order.createdByUserId ?? 1n,
            createdAt: order.createdAt,
          },
        });
        await tx.arOpenItem.create({
          data: {
            arDocumentId: ar.id,
            customerId: order.customerId,
            salesOrderId: order.id,
            originalAmount: d.amount,
            allocatedAmount: new Prisma.Decimal(0),
            outstandingAmount: d.amount,
            dueDate: d.dueDate,
            expectedCollectDate: d.dueDate,
            status: "unpaid",
            createdAt: order.createdAt,
          },
        });
        createdCount += 1;
      }
    });
  }

  console.log(`Backfill complete. Created ${createdCount} AR documents/open items.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
