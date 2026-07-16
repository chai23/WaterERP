import type { Prisma, PrismaClient } from "@prisma/client";

export const SERVICE_TYPES = ["cleaning", "repair", "both"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TICKET_STATUSES = [
  "reported",
  "accepted",
  "assess_assigned",
  "onsite_completed",
  "pending_pickup",
  "pending_loaner",
  "in_workshop",
  "quote_pending",
  "quote_accepted",
  "quote_rejected",
  "pending_return",
  "returned",
  "closed",
  "cancelled",
  "unable",
] as const;
export type ServiceTicketStatus = (typeof SERVICE_TICKET_STATUSES)[number];

export function isServiceType(v: unknown): v is ServiceType {
  return typeof v === "string" && (SERVICE_TYPES as readonly string[]).includes(v);
}

export function serviceTypeLabel(type: string): string {
  switch (type) {
    case "cleaning":
      return "清洗飲水機";
    case "repair":
      return "維修飲水機";
    case "both":
      return "清洗＋維修";
    default:
      return type;
  }
}

export function workshopStatusLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  switch (s) {
    case "received":
      return "已入廠";
    case "diagnosing":
      return "診斷中";
    case "in_progress":
      return "清洗／維修中";
    case "done_pending_return":
      return "已完工待送回";
    default:
      return s;
  }
}

export function serviceTicketStatusLabel(status: string): string {
  switch (status) {
    case "reported":
      return "已回報，待受理";
    case "accepted":
      return "已受理";
    case "assess_assigned":
      return "已派評估";
    case "onsite_completed":
      return "現場已完工";
    case "pending_pickup":
      return "待載回";
    case "pending_loaner":
      return "待換臨時機";
    case "in_workshop":
      return "廠內處理中";
    case "quote_pending":
      return "待確認報價";
    case "quote_accepted":
      return "報價已同意";
    case "quote_rejected":
      return "報價已拒絕";
    case "pending_return":
      return "待送回";
    case "returned":
      return "已送回";
    case "closed":
      return "已結案";
    case "cancelled":
      return "已取消";
    case "unable":
      return "無法處理";
    default:
      return status;
  }
}

export const serviceTicketInclude = {
  deliveryAddress: true,
  events: { orderBy: { id: "asc" as const } },
} as const;

export const serviceTicketAdminInclude = {
  customer: { select: { id: true, customerCode: true, name: true, mobile: true, phone: true, billingType: true } },
  deliveryAddress: true,
  assessDriver: { include: { user: { select: { id: true, name: true, employeeCode: true } } } },
  assessVehicle: true,
  returnDriver: { include: { user: { select: { id: true, name: true, employeeCode: true } } } },
  events: { orderBy: { id: "asc" as const } },
} as const;

export async function allocateServiceTicketNo(
  tx: Prisma.TransactionClient,
  at: Date = new Date(),
): Promise<string> {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  const prefix = `ST${yyyy}${mm}${dd}`;
  const last = await tx.serviceTicket.findFirst({
    where: { ticketNo: { startsWith: prefix } },
    orderBy: { ticketNo: "desc" },
    select: { ticketNo: true },
  });
  let seq = 1;
  if (last) {
    const n = parseInt(last.ticketNo.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

function ymdLocal(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdDbDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function serializeServiceTicket(
  row: Prisma.ServiceTicketGetPayload<{ include: typeof serviceTicketInclude }>,
) {
  return {
    id: row.id.toString(),
    ticketNo: row.ticketNo,
    serviceType: row.serviceType,
    serviceTypeLabel: serviceTypeLabel(row.serviceType),
    status: row.status,
    statusLabel: serviceTicketStatusLabel(row.status),
    preferredDate: ymdDbDate(row.preferredDate),
    preferredSlot: row.preferredSlot,
    problemNote: row.problemNote,
    customerNote: row.customerNote,
    needLoaner: row.needLoaner,
    quoteAmount: row.quoteAmount?.toString() ?? null,
    quoteDetail: row.quoteDetail,
    quoteStatus: row.quoteStatus,
    workshopStatus: row.workshopStatus,
    workshopStatusLabel: workshopStatusLabel(row.workshopStatus),
    workshopNote: row.workshopNote,
    assessDate: ymdDbDate(row.assessDate),
    assessSlot: row.assessSlot,
    assessOutcome: row.assessOutcome,
    assessFeeAmount: row.assessFeeAmount?.toString() ?? null,
    chargeAmount: row.chargeAmount?.toString() ?? null,
    billingType: row.billingType,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    deliveryAddress: row.deliveryAddress
      ? {
          id: row.deliveryAddress.id.toString(),
          label: row.deliveryAddress.label,
          addressLine: row.deliveryAddress.addressLine,
        }
      : null,
    events: (row.events ?? []).map((e) => ({
      id: e.id.toString(),
      eventType: e.eventType,
      payloadJson: e.payloadJson,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export function serializeServiceTicketAdmin(
  row: Prisma.ServiceTicketGetPayload<{ include: typeof serviceTicketAdminInclude }>,
) {
  const base = serializeServiceTicket({
    ...row,
    deliveryAddress: row.deliveryAddress,
    events: row.events,
  } as Prisma.ServiceTicketGetPayload<{ include: typeof serviceTicketInclude }>);
  return {
    ...base,
    customerId: row.customerId.toString(),
    customer: row.customer
      ? {
          id: row.customer.id.toString(),
          customerCode: row.customer.customerCode,
          name: row.customer.name,
          mobile: row.customer.mobile,
          phone: row.customer.phone,
          billingType: row.customer.billingType,
        }
      : null,
    assessDriverId: row.assessDriverId?.toString() ?? null,
    assessDriver: row.assessDriver
      ? {
          id: row.assessDriver.id.toString(),
          name: row.assessDriver.user?.name ?? null,
          employeeCode: row.assessDriver.user?.employeeCode ?? row.assessDriver.employeeCode,
        }
      : null,
    assessVehicleId: row.assessVehicleId?.toString() ?? null,
    assessVehicle: row.assessVehicle
      ? { id: row.assessVehicle.id.toString(), plateNo: row.assessVehicle.plateNo }
      : null,
    assessAssignedAt: row.assessAssignedAt?.toISOString() ?? null,
    assessDriverNote: row.assessDriverNote,
    assessCustomerAgreed: row.assessCustomerAgreed,
    assessReportedAt: row.assessReportedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    loanerNote: row.loanerNote,
    loanerRequestedAt: row.loanerRequestedAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
    source: row.source,
  };
}

export type CreateServiceTicketInput = {
  customerId: bigint;
  deliveryAddressId: bigint;
  serviceType: ServiceType;
  preferredDate?: Date | null;
  preferredSlot?: string | null;
  problemNote?: string | null;
  customerNote?: string | null;
  source?: string;
};

export async function createServiceTicket(
  prisma: PrismaClient,
  input: CreateServiceTicketInput,
) {
  return prisma.$transaction(async (tx) => {
    const ticketNo = await allocateServiceTicketNo(tx);
    const row = await tx.serviceTicket.create({
      data: {
        ticketNo,
        customerId: input.customerId,
        deliveryAddressId: input.deliveryAddressId,
        serviceType: input.serviceType,
        status: "reported",
        preferredDate: input.preferredDate ?? null,
        preferredSlot: input.preferredSlot ?? null,
        problemNote: input.problemNote ?? null,
        customerNote: input.customerNote ?? null,
        source: input.source ?? "liff",
      },
      include: serviceTicketInclude,
    });
    await tx.serviceTicketEvent.create({
      data: {
        serviceTicketId: row.id,
        eventType: "reported",
        payloadJson: {
          serviceType: input.serviceType,
          preferredDate: input.preferredDate ? ymdLocal(input.preferredDate) : null,
          preferredSlot: input.preferredSlot ?? null,
        },
      },
    });
    const full = await tx.serviceTicket.findUniqueOrThrow({
      where: { id: row.id },
      include: serviceTicketInclude,
    });
    return full;
  });
}
