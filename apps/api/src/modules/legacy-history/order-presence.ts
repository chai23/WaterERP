import type { PrismaClient } from "@prisma/client";

const normalize = (value: unknown) => {
  const match = String(value ?? "").trim().match(/^(\d{1,6})(?:-\d+)?$/);
  return match ? match[1]!.padStart(6, "0") : null;
};
const aliasKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,6})(-\d+)?$/);
  return match ? `${match[1]!.padStart(6, "0")}${match[2] ?? ""}` : text;
};

// Includes paid, cancelled-looking, future-dated and branch orders: any order is history.
export async function legacyCustomersWithOrders(legacy: PrismaClient): Promise<Set<string>> {
  const { customers, orders } = await legacy.$transaction(async tx => ({
    customers: await tx.$queryRawUnsafe<Array<{ customer_id: string; customer_id_mark: string }>>("SELECT customer_id, customer_id_mark FROM customer"),
    orders: await tx.$queryRawUnsafe<Array<{ customer_id: string }>>("SELECT DISTINCT customer_id FROM `order`"),
  }), { isolationLevel: "RepeatableRead", timeout: 60000 });
  const aliases = new Map<string, Set<string>>();
  for (const c of customers) {
    const owner = normalize(c.customer_id_mark) ?? normalize(c.customer_id);
    if (!owner) continue;
    for (const id of [c.customer_id, c.customer_id_mark]) {
      const key = aliasKey(id);
      if (!key) continue;
      const codes = aliases.get(key) ?? new Set<string>(); codes.add(owner); aliases.set(key, codes);
    }
  }
  const result = new Set<string>();
  for (const order of orders) {
    const id = String(order.customer_id ?? "").trim();
    for (const owner of aliases.get(aliasKey(id)) ?? []) result.add(owner);
    const normalized = normalize(id);
    if (normalized) result.add(normalized);
  }
  return result;
}
