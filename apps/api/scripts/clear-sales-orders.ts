/**
 * 清空銷貨相關交易資料：
 * - 銷貨訂單、配送任務、收款／收款憑證、客戶帳務流水、AR、發票、月結批次、折讓等
 * - 銷貨出庫 stock_movements（ref_type=sales_order），並還原庫存
 * - 客戶預付桶（商品別）、預收錢包、ledger、現場空桶／預付桶餘額欄位歸零
 * 保留：客戶、地址、商品、司機、車輛、進貨／生產等其他模組。
 *
 * 用法（在 apps/api 目錄）: npm run clear-sales-orders
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("開始清空銷貨與相關帳務交易…");

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE \`inventory_balances\` ib
      INNER JOIN (
        SELECT \`product_id\`, SUM(\`qty_delta\`) AS \`sum_delta\`
        FROM \`stock_movements\`
        WHERE \`ref_type\` = 'sales_order'
        GROUP BY \`product_id\`
      ) t ON t.\`product_id\` = ib.\`product_id\`
      SET ib.\`qty_on_hand\` = ib.\`qty_on_hand\` - t.\`sum_delta\`
    `;

    const sm = await tx.stockMovement.deleteMany({ where: { refType: "sales_order" } });
    console.log(`已刪除 stock_movements（銷貨） ${sm.count} 筆`);

    const le = await tx.customerLedgerEntry.deleteMany({});
    console.log(`已刪除 customer_ledger_entries ${le.count} 筆`);

    const ptxn = await tx.prepaymentTxn.deleteMany({});
    console.log(`已刪除 prepayment_txns ${ptxn.count} 筆`);

    const arMap = await tx.arAllocationMap.deleteMany({});
    console.log(`已刪除 ar_allocation_maps ${arMap.count} 筆`);

    const cn = await tx.creditNote.deleteMany({});
    console.log(`已刪除 credit_notes（含折讓沖銷） ${cn.count} 筆`);

    const pay = await tx.payment.deleteMany({});
    console.log(`已刪除 payments ${pay.count} 筆`);

    const rv = await tx.receiptVoucher.deleteMany({});
    console.log(`已刪除 receipt_vouchers ${rv.count} 筆`);

    const arDoc = await tx.arDocument.deleteMany({});
    console.log(`已刪除 ar_documents（含 open items） ${arDoc.count} 筆`);

    const ti = await tx.taxInvoice.deleteMany({});
    console.log(`已刪除 tax_invoices ${ti.count} 筆`);

    const bso = await tx.billingStatementOrder.deleteMany({});
    console.log(`已刪除 billing_statement_orders ${bso.count} 筆`);

    const bs = await tx.billingStatement.deleteMany({});
    console.log(`已刪除 billing_statements ${bs.count} 筆`);

    const da = await tx.deliveryAssignment.deleteMany({});
    console.log(`已刪除 delivery_assignments ${da.count} 筆`);

    const so = await tx.salesOrder.deleteMany({});
    console.log(`已刪除 sales_orders ${so.count} 筆`);

    const pb = await tx.customerPrepaidProductBalance.deleteMany({});
    console.log(`已刪除 customer_prepaid_product_balances ${pb.count} 筆`);

    const w = await tx.customerPrepaymentWallet.updateMany({
      data: { balanceAmount: 0 },
    });
    console.log(`已將 ${w.count} 筆預收錢包餘額歸零`);

    const cu = await tx.customer.updateMany({
      data: { barrelsOnSite: 0, prepaidBarrelBalance: 0 },
    });
    const addr = await tx.deliveryAddress.updateMany({ data: { barrelsOnSite: 0 } });
    console.log(`已將 ${cu.count} 位客戶 prepaid_barrel_balance 歸零，並清空 ${addr.count} 筆送貨地址 barrels_on_site`);
  });

  console.log("完成。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
