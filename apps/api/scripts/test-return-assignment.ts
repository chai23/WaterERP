import 'dotenv/config';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {returnAssignmentToPool} from '../src/returnAssignmentToPool.js';
import {createDeliveryAssignment} from '../src/createDeliveryAssignment.js';
const name=process.argv[2];assert(/^watererp_master_sync_test_\d+$/.test(name||''),'Provide an isolated test DB');const u=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1'].includes(u.hostname));u.pathname='/'+name;
const db=new PrismaClient({datasources:{db:{url:u.toString()}}});
try {
 const actor=await db.user.findUniqueOrThrow({where:{employeeCode:'SYNCTEST'}});
 const tasks=await db.deliveryAssignment.findMany({where:{status:'assigned'},orderBy:{id:'asc'}}); assert(tasks.length>=2);
 const task=tasks[0];const ledgerBefore=await db.customerLedgerEntry.findMany();
 const result=await Promise.all([returnAssignmentToPool(db,task.id,actor.id),returnAssignmentToPool(db,task.id,actor.id)]);
 assert.equal(result.filter(x=>!x.alreadyReturned).length,1);
 assert.equal((await db.salesOrder.findUniqueOrThrow({where:{id:task.salesOrderId}})).status,'confirmed');
 assert.equal((await db.deliveryAssignment.findUniqueOrThrow({where:{id:task.id}})).status,'cancelled');
 assert.equal(await db.deliveryEvent.count({where:{deliveryAssignmentId:task.id,eventType:'returned_to_pool'}}),1);
 assert.deepEqual(await db.customerLedgerEntry.findMany(),ledgerBefore);
 const reassigned=await createDeliveryAssignment(db,{salesOrderId:task.salesOrderId,driverId:task.driverId,vehicleId:task.vehicleId,assignmentDate:task.assignmentDate,assignmentDateLabel:'2026-10-21',assignedByUserId:actor.id,skipLineNotify:true,checkStock:false});assert(reassigned.ok);
 const blocked=tasks[1];
 for(const status of ['delivering','pending_settlement','completed']) {await db.deliveryAssignment.update({where:{id:blocked.id},data:{status}});await assert.rejects(returnAssignmentToPool(db,blocked.id,actor.id));}
 await db.deliveryAssignment.update({where:{id:blocked.id},data:{status:'assigned',driverReportedAt:new Date()}});await assert.rejects(returnAssignmentToPool(db,blocked.id,actor.id));
 await db.deliveryAssignment.update({where:{id:blocked.id},data:{driverReportedAt:null}});
 console.log('PASS: atomic return, concurrent repeat, audit event, ledger preserved, reassignment, delivering/reported/settled rejection');
} finally {await db.$disconnect();}
