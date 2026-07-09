import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const customers = await prisma.customer.findMany({ select: { id: true, name: true } });
  let mismatch = 0;
  for (const c of customers) {
    const [ledgerAgg, arAgg] = await Promise.all([
      prisma.customerLedgerEntry.aggregate({ where: { customerId: c.id }, _sum: { amount: true } }),
      prisma.arOpenItem.aggregate({ where: { customerId: c.id }, _sum: { outstandingAmount: true } }),
    ]);
    const ledger = Number(ledgerAgg._sum.amount ?? 0);
    const arOutstanding = Number(arAgg._sum.outstandingAmount ?? 0);
    const delta = Math.abs(ledger - arOutstanding);
    if (delta > 0.01) {
      mismatch += 1;
      console.log(`[MISMATCH] ${c.name}(${c.id.toString()}): ledger=${ledger.toFixed(2)} ar=${arOutstanding.toFixed(2)} delta=${delta.toFixed(2)}`);
    }
  }
  if (mismatch === 0) {
    console.log("Reconciliation passed: all customers matched.");
  } else {
    console.log(`Reconciliation completed with ${mismatch} mismatches.`);
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
