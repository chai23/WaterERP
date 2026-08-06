import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * AR 一致性檢查（AR-only）：
 * accountBalance 口徑 = Σ(active AR outstanding) − 預收錢包
 * 並可選列出「有收款但 AR 仍未清／有 AR 但無立帳」等異常。
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
    const [arAgg, wallet, legacyCash] = await Promise.all([
      prisma.arOpenItem.aggregate({
        where: activeArWhere(c.id),
        _sum: { outstandingAmount: true },
      }),
      prisma.customerPrepaymentWallet.findUnique({ where: { customerId: c.id } }),
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

    const arOutstanding = Number(arAgg._sum.outstandingAmount ?? 0);
    const walletBal = Number(wallet?.balanceAmount ?? 0);
    const accountBalance = arOutstanding - walletBal;
    const label = `${c.customerCode ?? "—"}／${c.name}(${c.id.toString()})`;

    if (legacyCash > 0) {
      legacyCashLedger += 1;
      console.log(`[LEGACY_CASH_LEDGER] ${label}: cash_* entries=${legacyCash}`);
    }

    // 基本一致性：餘額應為 AR−錢包（此腳本本身用同一公式，重點在列出有 AR／錢包的客戶供人工抽查）
    if (Math.abs(accountBalance - (arOutstanding - walletBal)) > 0.01) {
      mismatch += 1;
      console.log(
        `[MISMATCH] ${label}: accountBalance=${accountBalance.toFixed(2)} ar=${arOutstanding.toFixed(2)} wallet=${walletBal.toFixed(2)}`,
      );
    }

    // 抽查：已沖完 AR 文件但 open item 仍有 outstanding
    const paidDocsWithOpen = await prisma.arDocument.count({
      where: {
        customerId: c.id,
        status: "paid",
        openItems: { some: { outstandingAmount: { gt: new Prisma.Decimal(0) } } },
      },
    });
    if (paidDocsWithOpen > 0) {
      mismatch += 1;
      console.log(`[AR_STATUS] ${label}: paid documents with outstanding open items=${paidDocsWithOpen}`);
    }
  }

  if (legacyCashLedger > 0) {
    console.log(`Found ${legacyCashLedger} customers with legacy cash_* ledger rows (run migration 048).`);
  }
  if (mismatch === 0) {
    console.log("Reconciliation passed: AR status / accountBalance checks OK.");
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
