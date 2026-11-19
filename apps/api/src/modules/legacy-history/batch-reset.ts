import type { Prisma, PrismaClient } from "@prisma/client";

export class HandoverResetBlocked extends Error {}

export async function resetBatchHandover(db: PrismaClient) {
  return db.$transaction(tx => resetHandoverInTransaction(tx),{isolationLevel:"Serializable",timeout:120000});
}

export async function resetHandoverInTransaction(tx: Prisma.TransactionClient, clearSyncedBalances = false) {
    await tx.$queryRaw`SELECT id FROM cutover_handover WHERE id=1 FOR UPDATE`;
    const customers = await tx.customer.findMany({where:{handoverCompletedAt:{not:null}},select:{id:true}});
    const ids = customers.map(c=>c.id);
    if (ids.length) {
      const customerId = {in:ids};
      const [orders, receipts, otherLedger, otherAR, otherWallet, otherEvents, movements, claimed] = await Promise.all([
        tx.salesOrder.count({where:{customerId}}), tx.receiptVoucher.count({where:{customerId}}),
        tx.customerLedgerEntry.count({where:{customerId, NOT:{sourceType:"cutover"}}}),
        tx.arDocument.count({where:{customerId, NOT:{documentType:"opening_balance"}}}),
        tx.prepaymentTxn.count({where:{customerId, NOT:{txnType:"opening_balance"}}}),
        tx.customerLifecycleEvent.count({where:{customerId, OR:[{note:null},{note:{not:"系統轉換標記流失"}},{eventType:{not:"churned"}}]}}),
        tx.barrelMovement.count({where:{customerId}}),
        tx.$queryRaw<{n:bigint}[]>`SELECT COUNT(*) AS n FROM cutover_monthly_items m JOIN customers c ON c.id=m.customer_id WHERE c.handover_completed_at IS NOT NULL AND m.billing_statement_id IS NOT NULL`,
      ]);
      const conflicts = [
        ["新系統訂單", orders], ["收款憑證", receipts], ["帳務流水", otherLedger],
        ["應收單", otherAR], ["預收交易", otherWallet], ["客戶狀態異動", otherEvents],
        ["桶數異動", movements], ["已結帳的月結承接", claimed[0]?.n ?? 0n],
      ].filter(([,count])=>Number(count)>0).map(([label,count])=>`${label} ${count} 筆`);
      if (conflicts.length) throw new HandoverResetBlocked(`已交接客戶有後續交易或狀態異動（${conflicts.join("、")}），請先核對再重新交接`);
      await tx.$executeRaw`DELETE m FROM cutover_monthly_items m JOIN customers c ON c.id=m.customer_id WHERE c.handover_completed_at IS NOT NULL`;
      await tx.arOpenItem.deleteMany({where:{customerId}});
      await tx.arDocument.deleteMany({where:{customerId,documentType:"opening_balance"}});
      await tx.prepaymentTxn.deleteMany({where:{customerId}});
      await tx.customerPrepaymentWallet.deleteMany({where:{customerId}});
      await tx.customerPrepaidProductBalance.deleteMany({where:{customerId}});
      await tx.customerLedgerEntry.deleteMany({where:{customerId,sourceType:"cutover"}});
      await tx.customerLifecycleEvent.deleteMany({where:{customerId,note:"系統轉換標記流失",eventType:"churned"}});
      await tx.deliveryAddress.updateMany({where:{customerId},data:{barrelsOnSite:0}});
      await tx.customer.updateMany({where:{id:{in:ids},churnReasonNote:"系統轉換標記流失"},data:{lifecycleStatus:"active",churnedAt:null,churnReasonId:null,churnReasonNote:null}});
      await tx.customer.updateMany({where:{id:{in:ids}},data:{handoverCompletedAt:null,prepaidBarrelBalance:0,barrelsOnSite:0,allowPrepaidOverdraft:false}});
    }
    if (clearSyncedBalances) {
      const remaining = await tx.$queryRaw<{id:bigint}[]>`
        SELECT c.id FROM customers c
        WHERE c.handover_completed_at IS NULL
          AND EXISTS (SELECT 1 FROM legacy_id_map m WHERE m.entity_type='customer_code' AND m.new_id=c.id)
          AND (c.prepaid_barrel_balance<>0 OR c.barrels_on_site<>0 OR EXISTS
            (SELECT 1 FROM delivery_addresses a WHERE a.customer_id=c.id AND a.barrels_on_site<>0))
      `;
      const pendingIds = remaining.map(row=>row.id);
      if (pendingIds.length) {
        const customerId = {in:pendingIds};
        const [orders, ledger, movements, products] = await Promise.all([
          tx.salesOrder.count({where:{customerId}}),
          tx.customerLedgerEntry.count({where:{customerId}}),
          tx.barrelMovement.count({where:{customerId}}),
          tx.customerPrepaidProductBalance.count({where:{customerId}}),
        ]);
        if (orders || ledger || movements || products) throw new HandoverResetBlocked("未交接客戶已有桶數交易，無法歸零同步");
        await tx.customer.updateMany({where:{id:{in:pendingIds}},data:{prepaidBarrelBalance:0,barrelsOnSite:0}});
        await tx.deliveryAddress.updateMany({where:{customerId},data:{barrelsOnSite:0}});
      }
    }
    await tx.$executeRaw`UPDATE cutover_handover SET revision=revision+1,status='empty',snapshot=NULL,created_by=NULL,applied_by=NULL,applied_at=NULL,updated_at=NOW(3) WHERE id=1`;
    return ids.length;

}
