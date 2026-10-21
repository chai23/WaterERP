import type { PrismaClient } from '@prisma/client';

/** Return an untouched assignment to the pool; retain the cancelled task for audit. */
export async function returnAssignmentToPool(db: PrismaClient, id: bigint, actorId: bigint) {
  return db.$transaction(async tx => {
    const ref = await tx.deliveryAssignment.findUnique({where:{id},select:{salesOrderId:true}});
    if (!ref) throw new Error('找不到配送任務');
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id=${ref.salesOrderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM delivery_assignments WHERE id=${id} FOR UPDATE`;
    const task=await tx.deliveryAssignment.findUniqueOrThrow({where:{id},include:{salesOrder:true}});
    if (task.status==='cancelled') return {orderNo:task.salesOrder.orderNo,alreadyReturned:true};
    if(task.status!=='assigned' || task.driverReportedAt || task.completedAt || task.officeSettledAt || task.salesOrder.status!=='assigned') throw new Error('僅尚未配送、尚未回報的已分派任務可拉回訂單池');
    if(await tx.deliveryEvent.count({where:{deliveryAssignmentId:id,eventType:{in:['line_delivery_confirm','driver_report']}}})) throw new Error('此任務已有配送作業紀錄，不能直接拉回');
    if(await tx.deliveryAssignment.count({where:{salesOrderId:task.salesOrderId,id:{not:id},status:{in:['assigned','delivering','pending_settlement']}}})) throw new Error('此訂單另有進行中的配送任務，請先核對');
    const claimed = await tx.deliveryAssignment.updateMany({where:{id,status:'assigned',driverReportedAt:null},data:{status:'cancelled'}});
    if (claimed.count !== 1) throw new Error('任務狀態已改變，請重新整理');
    await tx.salesOrder.update({where:{id:task.salesOrderId,status:'assigned'},data:{status:'confirmed',lockVersion:{increment:1}}});
    await tx.deliveryEvent.create({data:{deliveryAssignmentId:id,eventType:'returned_to_pool',payloadJson:{actorUserId:actorId.toString(),previousDriverId:task.driverId.toString(),orderNo:task.salesOrder.orderNo}}});
    return {orderNo:task.salesOrder.orderNo,alreadyReturned:false};
  }, { isolationLevel: 'ReadCommitted' });
}
