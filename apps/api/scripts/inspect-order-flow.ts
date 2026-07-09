/**
 * 檢視指定訂單：明細、混單小計、發票、AR open items、配送狀態
 * npx tsx scripts/inspect-order-flow.ts SO20260510093411
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const orderNo = process.argv[2] ?? "SO20260510093411";
  const order = await prisma.salesOrder.findFirst({
    where: { orderNo },
    include: {
      lines: { include: { product: true } },
      taxInvoices: true,
      assignments: { orderBy: { id: "desc" }, take: 3 },
      payments: true,
    },
  });
  if (!order) {
    console.log(JSON.stringify({ ok: false, message: "找不到 " + orderNo }));
    return;
  }

  const opens = await prisma.arOpenItem.findMany({
    where: { salesOrderId: order.id },
    include: { arDocument: true },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        orderNo: order.orderNo,
        status: order.status,
        billingTypeAtOrder: order.billingTypeAtOrder,
        cashSubtotal: order.cashSubtotal?.toString(),
        monthlySubtotal: order.monthlySubtotal?.toString(),
        totalAmount: order.totalAmount.toString(),
        cashInvoiceMode: order.cashInvoiceMode,
        lines: order.lines.map((l) => ({
          billing: l.billingTypeAtLine,
          qty: l.qtyOrdered,
          lineAmount: l.lineAmount.toString(),
          product: l.product?.name,
        })),
        taxInvoices: order.taxInvoices.map((t) => ({
          untaxed: t.untaxedAmount.toString(),
          tax: t.taxAmount.toString(),
          total: t.totalAmount.toString(),
        })),
        arOpenItemsForThisOrder: opens.map((o) => ({
          billingType: o.arDocument.billingType,
          outstanding: o.outstandingAmount.toString(),
          arNo: o.arDocument.arNo,
        })),
        assignments: order.assignments.map((a) => ({
          id: a.id.toString(),
          status: a.status,
          expectedAmount: a.expectedAmount?.toString(),
          cashReceived: a.cashReceived.toString(),
          assignmentDate: a.assignmentDate,
        })),
        payments: order.payments.map((p) => ({ amount: p.amount.toString() })),
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(console.error);
