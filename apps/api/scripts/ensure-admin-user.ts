import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { ensureAdminUser } from "./ensure-admin-user-core.js";

const prisma = new PrismaClient();

await ensureAdminUser(prisma);

const users = await prisma.user.findMany({
  select: { id: true, employeeCode: true, name: true, role: true },
  orderBy: { id: "asc" },
});
console.log(JSON.stringify(users, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

await prisma.$disconnect();
