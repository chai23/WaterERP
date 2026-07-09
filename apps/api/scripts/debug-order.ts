import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const ORDER_NO = process.argv[2] ?? "SO202607031801076449d4b";

async function main() {
  const order = await prisma.salesOrder.findFirst({
    where: { orderNo: ORDER_NO },
    include: {
      lines: { include: { product: true } },
      customer: true,
      arDocuments: { where: { status: { not: "voided" } }, include: { openItems: true } },
      taxInvoices: { where: { status: "issued" } },
      assignments: {
        include: { events: { orderBy: { id: "desc" }, take: 5 } },
        orderBy: { id: "desc" },
      },
    },
  });
  if (!order) {
    console.log("找不到訂單");
    return;
  }
  console.log("=== 訂單 ===");
  console.log({
    orderNo: order.orderNo,
    status: order.status,
    subtotal: order.subtotal.toString(),
    totalAmount: order.totalAmount.toString(),
    cashSubtotal: order.cashSubtotal?.toString(),
    cashInvoiceMode: order.cashInvoiceMode,
  });
  console.log("=== 明細 ===");
  for (const l of order.lines) {
    console.log({
      id: l.id.toString(),
      product: l.product.name,
      qtyOrdered: l.qtyOrdered,
      qtyDelivered: l.qtyDelivered,
      unitPrice: l.unitPrice.toString(),
      lineAmount: l.lineAmount.toString(),
    });
  }
  console.log("=== AR ===");
  for (const d of order.arDocuments) {
    console.log({
      arNo: d.arNo,
      amount: d.documentAmount.toString(),
      openItems: d.openItems.map((o) => ({
        outstanding: o.outstandingAmount.toString(),
        original: o.originalAmount.toString(),
      })),
    });
  }
  console.log("=== 發票 ===");
  for (const inv of order.taxInvoices) {
    console.log({
      invoiceNo: inv.invoiceNo,
      mode: inv.invoiceMode,
      untaxed: inv.untaxedAmount.toString(),
      tax: inv.taxAmount.toString(),
      total: inv.totalAmount.toString(),
    });
  }
  console.log("=== 配送任務 ===");
  for (const a of order.assignments) {
    const events = await prisma.deliveryEvent.findMany({
      where: { deliveryAssignmentId: a.id },
      orderBy: { id: "desc" },
      take: 3,
    });
    console.log(
      JSON.stringify(
        {
          id: a.id.toString(),
          status: a.status,
          expectedAmount: a.expectedAmount?.toString(),
          cashReceived: a.cashReceived.toString(),
          cashVariance: a.cashVariance?.toString(),
          settlementOutcome: a.settlementOutcome,
          events: events.map((e) => ({ type: e.eventType, payload: e.payloadJson })),
        },
        null,
        2,
      ),
    );
  }
}

main()
  .finally(() => prisma.$disconnect());
