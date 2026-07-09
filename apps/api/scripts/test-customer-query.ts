import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.customer.findMany({
    take: 1,
    include: {
      addressZone: { select: { id: true, name: true } },
      affiliatedCompany: { select: { id: true, name: true } },
      addresses: true,
    },
  });
  console.log("ok", JSON.stringify(rows));
  const zones = await prisma.addressZone.findMany({ take: 3 });
  console.log("zones", zones.length);
}

main()
  .catch((e) => {
    console.error("err", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
