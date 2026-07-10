/**
 * 依各送貨點目前押桶餘額回推每筆流水之核銷前後在場桶數，並寫回資料庫。
 * 執行：cd apps/api && npx tsx scripts/reconcile-barrel-movements.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function reconcileAddressBarrelBalances(
  movements: Array<{ id: bigint; barrelDelta: number }>,
  currentOnSite: number,
): Map<string, { before: number; after: number }> {
  const result = new Map<string, { before: number; after: number }>();
  if (movements.length === 0) return result;
  const totalDelta = movements.reduce((sum, row) => sum + row.barrelDelta, 0);
  let balance = currentOnSite - totalDelta;
  for (const movement of movements) {
    const before = balance;
    const after = before + movement.barrelDelta;
    result.set(movement.id.toString(), { before, after });
    balance = after;
  }
  return result;
}

async function main() {
  const addresses = await prisma.deliveryAddress.findMany({
    select: { id: true, barrelsOnSite: true },
  });

  let updated = 0;
  for (const address of addresses) {
    const movements = await prisma.barrelMovement.findMany({
      where: { deliveryAddressId: address.id },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: { id: true, barrelDelta: true },
    });
    if (movements.length === 0) continue;

    const reconciled = reconcileAddressBarrelBalances(movements, address.barrelsOnSite);
    for (const movement of movements) {
      const site = reconciled.get(movement.id.toString());
      if (!site) continue;
      await prisma.barrelMovement.update({
        where: { id: movement.id },
        data: {
          barrelsOnSiteBefore: site.before,
          barrelsOnSiteAfter: site.after,
        },
      });
      updated += 1;
    }
  }

  console.log(`已更新 ${updated} 筆空桶流水之核銷前後在場桶數`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
