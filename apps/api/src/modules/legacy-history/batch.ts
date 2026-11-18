import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { buildHandoverMethodReport, type MethodRow } from "./method-report.js";
import { buildHandover, customerTargetHash, postIncludedBalances, targetState, type HandoverRow } from "./handover.js";

export function assess(a: MethodRow, r: HandoverRow | undefined, blockers: string[]) {
  if (r?.handedOver) return "已完成";
  if (!r?.customerId) return "客戶未對應";
  if (blockers.length) return blockers[0]!;
  if (a.reasons) return a.reasons;
  const excluded = new Set(a.excludedDeliveryIds);
  const warnings = r.warnings.filter(w => {
    const id = /^舊單 (\S+) /.exec(w)?.[1];
    return !(id && excluded.has(id) && (w.includes("未完成配送") || w.includes("為預收類型") || w.includes("有混合結帳方式")));
  });
  if (warnings.length) return warnings.join("；");
  if (r.prepayment !== a.overShort || r.prepaidBarrels !== a.prepaidBarrels ||
      r.addresses.reduce((sum, addr) => sum + addr.barrels, 0) !== a.emptyBarrels) return "來源餘額需核對";
  if (!a.churn && a.prepaidBarrels !== 0 && !a.productCode) return "預付商品需核對";
  if (a.churn && r.orders.length) return "歷史訂單需核對";
  for (const [kind, count, amount] of [["cash", a.cashCount, a.cashAmount], ["monthly_pending", a.monthlyCount, a.monthlyAmount], ["monthly_billed", a.billedCount, a.billedAmount]] as const) {
    const items = r.orders.filter(o => o.disposition === kind);
    if (items.length !== count || Math.round(items.reduce((sum,o) => sum + o.finalAmount, 0)*100) !== Math.round(amount*100)) return "逐單分類或金額需核對";
  }
  if (r.orders.some(o => o.disposition === "exclude" ? !(excluded.has(o.id) && !o.completed) : o.finalAmount <= 0 || (o.disposition === "monthly_pending" && o.received !== 0) || (o.monthlyKind !== "statement" && !["月結","現金"].includes(o.billing)))) return "舊單處置需核對";
  return "";
}

export async function batchPreview(legacy: PrismaClient, target: PrismaClient, date: string) {
  const report = await buildHandoverMethodReport(legacy,target,date);
  const snapshot = await buildHandover(legacy,target,date);
  const byCode = new Map(snapshot.rows.map(r => [r.code,r]));
  const items = report.rows.map(a => {
    const row = byCode.get(a.code);
    const reason = assess(a,row,snapshot.blockers);
    const version = createHash("sha256").update(JSON.stringify([date,a,row && {...row,draftId:undefined}])).digest("hex");
    return {code:a.code,reason,version,row,method:a};
  });
  return {report,items};
}

export async function postBatchItem(legacy: PrismaClient, target: PrismaClient, item: Awaited<ReturnType<typeof batchPreview>>["items"][number], date:string, userId:bigint) {
  const row = item.row;
  if (!row?.customerId || item.reason) throw new Error(item.reason || "未對應客戶");
  const customerId = BigInt(row.customerId);
  const latest = await buildHandoverMethodReport(legacy,target,date,row.code);
  const method = latest.rows.find(r=>r.code===row.code);
  if (JSON.stringify(method)!==JSON.stringify(item.method)) throw new Error("商品或舊單資料已變更，請重新分析");
  const fresh = await buildHandover(legacy,target,date,row.code);
  const next = fresh.rows.find(r=>r.code===row.code);
  const signature = (r:HandoverRow)=>JSON.stringify({...r,draftId:undefined});
  if (!next || fresh.blockers.length || signature(next)!==signature(row)) throw new Error("來源或主檔已變更，請重新分析");
  await target.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM customers WHERE id=${customerId} FOR UPDATE`;
    const state = await targetState(tx,{id:customerId});
    if (state.customers.find(c=>c.id===customerId)?.handoverCompletedAt) throw new Error("已完成交接");
    if (customerTargetHash(state,row.customerId!) !== row.targetHash) throw new Error("客戶資料已變更");
    const postingRow = {...row};
    if (row.prepaidBarrels !== 0 && !item.method.churn) {
      const code = item.method.productCode;
      if (!code) throw new Error("商品未對應");
      postingRow.prepaidAllocation = {
        products:[{code,barrels:row.prepaidBarrels}],
        unassignedReason:"",
        allowOverdraft:row.prepaidBarrels < 0,
      };
    }
    await postIncludedBalances(tx,postingRow,date,userId);
    if (item.method.churn) {
      const reason = await tx.customerChurnReason.findFirstOrThrow({where:{code:"other",isActive:true}});
      const effectiveAt = new Date();
      const note = "系統轉換標記流失";
      await tx.customer.update({where:{id:customerId},data:{lifecycleStatus:"churned",churnedAt:effectiveAt,churnReasonId:reason.id,churnReasonNote:note}});
      await tx.customerLifecycleEvent.create({data:{customerId,eventType:"churned",effectiveAt,churnReasonId:reason.id,note,recordedByUserId:userId}});
    }
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,timeout:60000});
}
