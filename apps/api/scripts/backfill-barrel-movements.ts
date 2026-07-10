/**
 * 回填歷史空桶回收稽核流水（已完成之純收空桶、配送順收）。
 * 執行：cd apps/api && npx tsx scripts/backfill-barrel-movements.ts
 */
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function effectiveLineDeliveryQty(line: {
  qtyOrdered: number;
  qtyDelivered: number;
  linePurpose?: string | null;
}): number {
  const purpose = line.linePurpose ?? "delivery";
  if (purpose === "prepaid_barrel_topup") return line.qtyOrdered;
  if (line.qtyDelivered > 0) return line.qtyDelivered;
  if (line.qtyOrdered === 0) return 0;
  return line.qtyOrdered;
}

function countDepositBarrelsDelivered(
  lines: Array<{
    qtyOrdered: number;
    qtyDelivered: number;
    linePurpose?: string | null;
    product?: { countsDepositBarrel?: boolean } | null;
  }>,
): number {
  let total = 0;
  for (const line of lines) {
    const purpose = line.linePurpose ?? "delivery";
    if (purpose === "prepaid_barrel_topup") continue;
    if (line.product?.countsDepositBarrel === true) {
      total += effectiveLineDeliveryQty(line);
    }
  }
  return total;
}

function toLocalYmd(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseLocalYmdStart(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((v) => Number(v));
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0);
}

async function main() {
  let pickupCount = 0;
  let deliveryCount = 0;

  const pickups = await prisma.barrelPickup.findMany({
    where: { status: "completed", barrelsReturned: { gt: 0 } },
    include: {
      events: {
        where: { eventType: "settlement" },
        orderBy: { id: "desc" },
        take: 1,
      },
    },
  });

  for (const row of pickups) {
    const exists = await prisma.barrelMovement.findUnique({
      where: {
        sourceType_sourceRefId: { sourceType: "pickup", sourceRefId: row.id },
      },
    });
    if (exists) continue;

    const event = row.events[0];
    const payload = (event?.payloadJson ?? {}) as Record<string, unknown>;
    const barrelsReturned = Math.max(0, Math.floor(Number(row.barrelsReturned ?? 0)));
    const before =
      payload.barrelsOnSiteBefore != null ? Math.max(0, Math.floor(Number(payload.barrelsOnSiteBefore))) : null;
    const after =
      payload.barrelsOnSiteAfter != null ? Math.max(0, Math.floor(Number(payload.barrelsOnSiteAfter))) : null;
    const occurredAt = row.officeSettledAt ?? event?.createdAt ?? row.updatedAt;
    const movementYmd = toLocalYmd(row.pickupDate);

    await prisma.barrelMovement.create({
      data: {
        movementDate: parseLocalYmdStart(movementYmd),
        occurredAt,
        sourceType: "pickup",
        sourceRefId: row.id,
        refNo: row.pickupNo,
        customerId: row.customerId,
        deliveryAddressId: row.deliveryAddressId,
        barrelsReturned,
        barrelsDelivered: 0,
        barrelDelta: -barrelsReturned,
        barrelsOnSiteBefore: before,
        barrelsOnSiteAfter: after,
        driverId: row.driverId,
        vehicleId: row.vehicleId,
        barrelPickupId: row.id,
        note: row.driverNote || row.remark,
      },
    });
    pickupCount += 1;
  }

  const assignments = await prisma.deliveryAssignment.findMany({
    where: {
      status: "completed",
      emptyBarrelsReturned: { gt: 0 },
      NOT: { settlementOutcome: "not_delivered" },
    },
    include: {
      salesOrder: {
        include: {
          lines: { include: { product: { select: { countsDepositBarrel: true } } } },
        },
      },
      events: {
        where: { eventType: "settlement" },
        orderBy: { id: "desc" },
        take: 1,
      },
    },
  });

  for (const row of assignments) {
    const exists = await prisma.barrelMovement.findUnique({
      where: {
        sourceType_sourceRefId: { sourceType: "delivery", sourceRefId: row.id },
      },
    });
    if (exists) continue;

    const order = row.salesOrder;
    const event = row.events[0];
    const payload = (event?.payloadJson ?? {}) as Record<string, unknown>;
    const barrelsReturned = Math.max(0, Math.floor(Number(row.emptyBarrelsReturned)));
    const barrelsDelivered =
      payload.barrelsDeliveredCount != null
        ? Math.max(0, Math.floor(Number(payload.barrelsDeliveredCount)))
        : countDepositBarrelsDelivered(order.lines);
    const barrelDelta =
      payload.barrelNetCustomer != null
        ? Math.floor(Number(payload.barrelNetCustomer))
        : barrelsDelivered - barrelsReturned;
    const occurredAt = row.officeSettledAt ?? event?.createdAt ?? row.updatedAt;
    const movementYmd = row.driverReportedAt ? toLocalYmd(row.driverReportedAt) : toLocalYmd(row.assignmentDate);

    await prisma.barrelMovement.create({
      data: {
        movementDate: parseLocalYmdStart(movementYmd),
        occurredAt,
        sourceType: "delivery",
        sourceRefId: row.id,
        refNo: order.orderNo,
        customerId: order.customerId,
        deliveryAddressId: order.deliveryAddressId,
        barrelsReturned,
        barrelsDelivered,
        barrelDelta,
        barrelsOnSiteBefore: null,
        barrelsOnSiteAfter: null,
        driverId: row.driverId,
        vehicleId: row.vehicleId,
        salesOrderId: order.id,
        deliveryAssignmentId: row.id,
        note: row.settlementNote,
      },
    });
    deliveryCount += 1;
  }

  console.log(`回填完成：純收空桶 ${pickupCount} 筆、配送順收 ${deliveryCount} 筆`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
