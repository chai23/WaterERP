import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * AR 一致性檢查（AR-only）：
 * - open item：allocated + outstanding 應等於 original
 * - document status 與 open items 是否矛盾
 * - 預收錢包餘額 vs prepayment_txn 加總
 * - accountBalance 口徑抽查（Σ outstanding − wallet）
 */
const prisma = new PrismaClient();

function activeArWhere(customerId: bigint): Prisma.ArOpenItemWhereInput {
  return {
    customerId,
    outstandingAmount: { gt: new Prisma.Decimal(0) },
    arDocument: { status: { not: "voided" } },
    OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }],
  };
}

async function main() {
  const customers = await prisma.customer.findMany({
    select: { id: true, name: true, customerCode: true },
    orderBy: [{ customerCode: "asc" }, { id: "asc" }],
  });
  let mismatch = 0;
  let legacyCashLedger = 0;

  for (const c of customers) {
    const label = `${c.customerCode ?? "—"}／${c.name}(${c.id.toString()})`;

    const [opens, docs, wallet, prepayAgg, legacyCash] = await Promise.all([
      prisma.arOpenItem.findMany({
        where: {
          customerId: c.id,
          arDocument: { status: { not: "voided" } },
        },
        select: {
          id: true,
          originalAmount: true,
          allocatedAmount: true,
          outstandingAmount: true,
          arDocumentId: true,
        },
      }),
      prisma.arDocument.findMany({
        where: { customerId: c.id, status: { not: "voided" } },
        include: { openItems: { select: { outstandingAmount: true } } },
      }),
      prisma.customerPrepaymentWallet.findUnique({ where: { customerId: c.id } }),
      prisma.prepaymentTxn.aggregate({
        where: { customerId: c.id },
        _sum: { amount: true },
      }),
      prisma.customerLedgerEntry.count({
        where: {
          customerId: c.id,
          entryType: {
            in: [
              "cash_ar_accrual",
              "cash_receipt_alloc",
              "cash_variance_over",
              "cash_variance_short",
              "cash_offset_order",
            ],
          },
        },
      }),
    ]);

    if (legacyCash > 0) {
      legacyCashLedger += 1;
      console.log(`[LEGACY_CASH_LEDGER] ${label}: cash_* entries=${legacyCash}`);
    }

    for (const oi of opens) {
      const expected = new Prisma.Decimal(oi.originalAmount)
        .minus(oi.allocatedAmount)
        .toDecimalPlaces(2);
      const actual = new Prisma.Decimal(oi.outstandingAmount).toDecimalPlaces(2);
      if (!expected.equals(actual)) {
        mismatch += 1;
        console.log(
          `[OPEN_ITEM_MATH] ${label}: openItem=${oi.id.toString()} expectedOutstanding=${expected.toString()} actual=${actual.toString()}`,
        );
      }
    }

    for (const d of docs) {
      const hasOpen = d.openItems.some((i) => new Prisma.Decimal(i.outstandingAmount).greaterThan(0));
      if (d.status === "paid" && hasOpen) {
        mismatch += 1;
        console.log(`[AR_STATUS] ${label}: paid document ${d.arNo} still has outstanding open items`);
      }
      if ((d.status === "open" || d.status === "partial") && !hasOpen && d.openItems.length > 0) {
        mismatch += 1;
        console.log(`[AR_STATUS] ${label}: document ${d.arNo} status=${d.status} but all open items cleared`);
      }
    }

    const walletBal = new Prisma.Decimal(wallet?.balanceAmount ?? 0);
    const txnSum = new Prisma.Decimal(prepayAgg._sum.amount ?? 0);
    if (!walletBal.equals(txnSum) && (wallet != null || txnSum.abs().greaterThan(0))) {
      // 允許無 wallet 列且 txn 加總為 0
      mismatch += 1;
      console.log(
        `[WALLET] ${label}: wallet=${walletBal.toString()} prepaymentTxnSum=${txnSum.toString()}`,
      );
    }

    const arAgg = await prisma.arOpenItem.aggregate({
      where: activeArWhere(c.id),
      _sum: { outstandingAmount: true },
    });
    const arOutstanding = new Prisma.Decimal(arAgg._sum.outstandingAmount ?? 0);
    const accountBalance = arOutstanding.minus(walletBal);
    if (accountBalance.abs().greaterThan(0) || arOutstanding.greaterThan(0) || walletBal.greaterThan(0)) {
      // 僅記錄大額異常：負錢包過大等（抽查用）
      if (walletBal.lessThan(0)) {
        mismatch += 1;
        console.log(`[WALLET_NEG] ${label}: wallet=${walletBal.toString()} accountBalance=${accountBalance.toString()}`);
      }
    }
  }

  // 全庫：負庫存
  const negInv = await prisma.inventoryBalance.count({ where: { qtyOnHand: { lt: 0 } } });
  if (negInv > 0) {
    console.log(`[INVENTORY] negative stock products=${negInv} (see GET /api/reports/inventory-exceptions)`);
  }

  if (legacyCashLedger > 0) {
    console.log(`Found ${legacyCashLedger} customers with legacy cash_* ledger rows (run migration 048).`);
  }
  if (mismatch === 0) {
    console.log("Reconciliation passed: open-item math / AR status / wallet checks OK.");
  } else {
    console.log(`Reconciliation completed with ${mismatch} issues.`);
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
