import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** 刪除該日該班未發布草稿（含路線／站點），正式 assignment 只清 routeStopId。 */
export async function discardOpenDrafts(
  prisma: Db,
  args: { planDate: Date; shift: string },
): Promise<{ deleted: number }> {
  const old = await prisma.deliveryPlan.findMany({
    where: {
      planDate: args.planDate,
      shift: args.shift,
      status: { in: ["draft", "pending_review"] },
    },
    select: {
      id: true,
      routes: { select: { stops: { select: { id: true } } } },
    },
  });
  if (old.length === 0) return { deleted: 0 };

  const stopIds = old.flatMap((p) => p.routes.flatMap((r) => r.stops.map((s) => s.id)));
  if (stopIds.length > 0) {
    await prisma.deliveryAssignment.updateMany({
      where: { routeStopId: { in: stopIds } },
      data: { routeStopId: null },
    });
  }
  const ids = old.map((p) => p.id);
  await prisma.deliveryPlan.deleteMany({ where: { id: { in: ids } } });
  return { deleted: ids.length };
}

export async function nextPlanVersion(
  prisma: Db,
  args: { planDate: Date; shift: string },
): Promise<number> {
  const last = await prisma.deliveryPlan.findFirst({
    where: { planDate: args.planDate, shift: args.shift },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (last?.version ?? 0) + 1;
}
