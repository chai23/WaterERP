import { Prisma, type PrismaClient } from "@prisma/client";
import {
  formatOrderAssignedMessage,
  notifyCustomerViaLine,
} from "./line/messaging.js";

const ACTIVE_ASSIGNMENT_STATUSES = ["assigned", "delivering", "pending_settlement"] as const;

export type CreateDeliveryAssignmentInput = {
  salesOrderId: bigint;
  driverId: bigint;
  vehicleId?: bigint | null;
  assignmentDate: Date;
  assignmentDateLabel: string;
  assignedByUserId: bigint;
  estimatedDeliverySlot?: string | null;
  estimatedDeliveryAt?: Date | null;
  routeStopId?: bigint | null;
  routeSequence?: number | null;
  assignmentShift?: string | null;
  /** 與單筆派單相同：檢查庫存並回傳 warnings（不阻擋） */
  checkStock?: boolean;
  /** publish 路徑可跳過 LINE（預設仍通知） */
  skipLineNotify?: boolean;
};

export type CreateDeliveryAssignmentSuccess = {
  ok: true;
  assignmentId: bigint;
  customerId: bigint;
  orderNo: string;
  warnings: string[];
  stockShortages: Array<{ productId: string; productName: string; need: number; onHand: number }>;
};

export type CreateDeliveryAssignmentFailure = {
  ok: false;
  reason: string;
  httpStatus?: number;
};

export type CreateDeliveryAssignmentResult =
  | CreateDeliveryAssignmentSuccess
  | CreateDeliveryAssignmentFailure;

function activeArOpenItemWhere(extra?: Prisma.ArOpenItemWhereInput): Prisma.ArOpenItemWhereInput {
  const filters: Prisma.ArOpenItemWhereInput[] = [
    { outstandingAmount: { gt: new Prisma.Decimal(0) } },
    { arDocument: { status: { not: "voided" } } },
    { OR: [{ salesOrderId: null }, { salesOrder: { status: { not: "cancelled" } } }] },
  ];
  if (extra && Object.keys(extra).length > 0) filters.unshift(extra);
  return filters.length === 1 ? filters[0]! : { AND: filters };
}

function isNonInventoryLinePurpose(purpose: string | null | undefined): boolean {
  const p = (purpose ?? "delivery").trim();
  return (
    p === "prepaid_barrel_topup" ||
    p === "floor_handling_fee" ||
    p === "service_fee"
  );
}

async function analyzeOrderStockShortage(
  tx: Prisma.TransactionClient | PrismaClient,
  salesOrderId: bigint,
): Promise<Array<{ productId: string; productName: string; need: number; onHand: number }>> {
  const orderLines = await tx.salesOrderLine.findMany({
    where: { salesOrderId },
    include: { product: { select: { name: true } } },
  });
  const needByProduct = new Map<bigint, { name: string; need: number }>();
  for (const line of orderLines) {
    if (isNonInventoryLinePurpose(line.linePurpose)) continue;
    const qty =
      line.qtyDelivered != null && Number(line.qtyDelivered) > 0
        ? Number(line.qtyDelivered)
        : Number(line.qtyOrdered);
    if (qty <= 0) continue;
    const name = line.product?.name ?? "商品";
    const cur = needByProduct.get(line.productId);
    if (cur) cur.need += qty;
    else needByProduct.set(line.productId, { name, need: qty });
  }
  const shortages: Array<{ productId: string; productName: string; need: number; onHand: number }> = [];
  for (const [productId, info] of needByProduct) {
    const inv = await tx.inventoryBalance.findUnique({ where: { productId } });
    const onHand = inv?.qtyOnHand ?? 0;
    if (onHand < info.need) {
      shortages.push({
        productId: productId.toString(),
        productName: info.name,
        need: info.need,
        onHand,
      });
    }
  }
  return shortages;
}

/**
 * 正式建立 DeliveryAssignment 的共用寫入點。
 * 行為對齊既有 POST /api/delivery-assignments（信用鎖、進行中不可重派、狀態檢查）。
 * 人工 API 與 AI publish 皆應呼叫此函式，避免兩套規則。
 */
export async function createDeliveryAssignment(
  prisma: PrismaClient,
  input: CreateDeliveryAssignmentInput,
): Promise<CreateDeliveryAssignmentResult> {
  const {
    salesOrderId,
    driverId,
    vehicleId = null,
    assignmentDate,
    assignmentDateLabel,
    assignedByUserId,
    estimatedDeliverySlot = null,
    estimatedDeliveryAt = null,
    routeStopId = null,
    routeSequence = null,
    assignmentShift = null,
    checkStock = true,
    skipLineNotify = false,
  } = input;

  const order = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
  if (!order) return { ok: false, reason: "找不到訂單", httpStatus: 404 };
  if (["completed", "cancelled", "pending_review"].includes(order.status)) {
    return {
      ok: false,
      reason:
        order.status === "pending_review"
          ? "此訂單尚未經辦公室確認，不可分派"
          : "此訂單狀態不可分派",
      httpStatus: 400,
    };
  }

  const customer = await prisma.customer.findUnique({ where: { id: order.customerId } });
  if (!customer) return { ok: false, reason: "客戶不存在", httpStatus: 400 };

  const arOutstanding = await prisma.arOpenItem.aggregate({
    where: activeArOpenItemWhere({ customerId: order.customerId }),
    _sum: { outstandingAmount: true },
  });
  const outstanding = new Prisma.Decimal(arOutstanding._sum.outstandingAmount ?? 0);
  if (
    new Prisma.Decimal(customer.creditLimit).greaterThan(0) &&
    outstanding.greaterThan(new Prisma.Decimal(customer.creditLimit))
  ) {
    return { ok: false, reason: "客戶欠款超過信用額度，已鎖定分派", httpStatus: 400 };
  }

  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver || !driver.isActive) {
    return { ok: false, reason: "司機不存在或未啟用", httpStatus: 400 };
  }

  if (vehicleId) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || !vehicle.isActive) {
      return { ok: false, reason: "車輛不存在或未啟用", httpStatus: 400 };
    }
  }

  const existing = await prisma.deliveryAssignment.findFirst({
    where: {
      salesOrderId,
      status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] },
    },
    orderBy: { id: "desc" },
  });
  if (existing) {
    return { ok: false, reason: "此訂單已有進行中的分派", httpStatus: 400 };
  }

  let stockShortages: CreateDeliveryAssignmentSuccess["stockShortages"] = [];
  let warnings: string[] = [];
  if (checkStock) {
    stockShortages = await analyzeOrderStockShortage(prisma, salesOrderId);
    warnings = stockShortages.map(
      (s) => `缺貨警告：${s.productName} 需 ${s.need}、目前庫存 ${s.onHand}`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: "assigned", lockVersion: { increment: 1 } },
    });
    return tx.deliveryAssignment.create({
      data: {
        salesOrderId,
        driverId,
        vehicleId,
        assignmentDate,
        status: "assigned",
        assignedByUserId,
        estimatedDeliverySlot,
        estimatedDeliveryAt,
        routeStopId,
        routeSequence,
        assignmentShift,
      },
    });
  });

  if (!skipLineNotify) {
    void notifyCustomerViaLine(prisma, {
      customerId: order.customerId,
      eventType: "order_assigned",
      salesOrderId,
      deliveryAssignmentId: created.id,
      text: formatOrderAssignedMessage({
        orderNo: order.orderNo,
        assignmentDate: assignmentDateLabel,
        estimatedSlot: estimatedDeliverySlot,
      }),
      payload: { estimatedDeliveryAt: estimatedDeliveryAt?.toISOString() ?? null },
    }).catch((err) => console.error("[line-notify] order_assigned", err));
  }

  return {
    ok: true,
    assignmentId: created.id,
    customerId: order.customerId,
    orderNo: order.orderNo,
    warnings,
    stockShortages,
  };
}
