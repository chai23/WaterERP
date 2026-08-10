import { Prisma, type PrismaClient } from "@prisma/client";

function toAuditJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export async function writePlanningAudit(
  prisma: PrismaClient,
  args: {
    planId?: bigint | null;
    action: string;
    modelVersion?: string | null;
    promptVersion?: string | null;
    inputSummary?: unknown;
    outputSummary?: unknown;
    actorUserId?: bigint | null;
  },
): Promise<void> {
  await prisma.deliveryPlanningAuditLog.create({
    data: {
      planId: args.planId ?? null,
      action: args.action,
      modelVersion: args.modelVersion ?? null,
      promptVersion: args.promptVersion ?? null,
      inputSummary: args.inputSummary === undefined ? undefined : toAuditJson(args.inputSummary),
      outputSummary: args.outputSummary === undefined ? undefined : toAuditJson(args.outputSummary),
      actorUserId: args.actorUserId ?? null,
    },
  });
}
