import type { PrismaClient } from "@prisma/client";

export type LegacyOrderLineRow = {
  order_id: string;
  order_day: Date | null;
  product_index: string | null;
  product_id: string | null;
  product_name: string | null;
  product_price: string | null;
  product_quantity: string | null;
  give_free: string | null;
  give_nofree: string | null;
  tex: string | null;
  subtotal: string | null;
  remark: string | null;
  customer_id: string | null;
  customer_bill_form: string | null;
  driver_id: string | null;
  order_OK: string | null;
  recyele_quantity: string | null;
  collect_money: string | null;
  collect_OK: string | null;
  assign_OK: string | null;
  bill_number: string | null;
  order_id_day: Date | null;
  maker: string | null;
};

export type LegacyOrderSummary = {
  orderId: string;
  orderDay: string | null;
  orderedAt: string | null;
  customerId: string | null;
  billingLabel: string | null;
  billingType: "cash" | "monthly" | "prepaid";
  invoiceForm: string | null;
  driverCode: string | null;
  orderOk: boolean;
  assignOk: boolean;
  collectOk: boolean;
  billNumber: string | null;
  maker: string | null;
  shiftLabel: string | null;
  lineCount: number;
  qtyTotal: number;
  amountTotal: number;
  taxTotal: number;
  recycleQtyTotal: number;
  productNames: string[];
};

export type LegacyOrderDetail = LegacyOrderSummary & {
  lines: Array<{
    productIndex: string | null;
    productId: string | null;
    productName: string | null;
    unitPrice: number;
    qty: number;
    giveFree: number;
    giveNofree: number;
    tax: number;
    subtotal: number;
    remark: string | null;
    recycleQty: number;
  }>;
  remittances: Array<{
    id: number;
    remittanceDay: string | null;
    bank: string | null;
    money: number;
    moneyRemittance: number;
    handMoney: number;
    overShortMoney: number;
    remark: string | null;
    maker: string | null;
  }>;
};

function normalizeCustomerCode(raw: string): string | null {
  const id = raw.trim();
  if (!/^\d+$/.test(id)) return null;
  return id.padStart(6, "0").slice(-6);
}

function asBool(v: string | null | undefined): boolean {
  return String(v ?? "").trim() === "True";
}

function asNum(v: string | null | undefined): number {
  const n = Number(String(v ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function ymd(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mapBilling(collectMoney: string | null | undefined): "cash" | "monthly" | "prepaid" {
  const s = String(collectMoney ?? "").trim();
  if (s === "月結") return "monthly";
  if (s === "預收") return "prepaid";
  return "cash";
}

function mapShift(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

export function customerMatchParams(customerCode: string): { sql: string; params: string[] } {
  const trimmed = customerCode.trim();
  const padded = normalizeCustomerCode(trimmed) ?? trimmed;
  return {
    sql: "(TRIM(customer_id) = ? OR LPAD(TRIM(customer_id), 6, '0') = ?)",
    params: [trimmed, padded],
  };
}

function buildDateSql(from: string | null, to: string | null): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (from) {
    parts.push("order_day >= ?");
    params.push(from);
  }
  if (to) {
    parts.push("order_day <= ?");
    params.push(to);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

function summarizeOrder(
  orderId: string,
  lines: LegacyOrderLineRow[],
  shiftLabel: string | null,
): LegacyOrderSummary {
  const head = lines[0];
  const productNames: string[] = [];
  let qtyTotal = 0;
  let amountTotal = 0;
  let taxTotal = 0;
  let recycleQtyTotal = 0;
  for (const ln of lines) {
    const name = String(ln.product_name ?? "").trim();
    if (name && !productNames.includes(name)) productNames.push(name);
    qtyTotal += asNum(ln.product_quantity);
    amountTotal += asNum(ln.subtotal);
    taxTotal += asNum(ln.tex);
    recycleQtyTotal += asNum(ln.recyele_quantity);
  }
  return {
    orderId,
    orderDay: ymd(head?.order_day ?? null),
    orderedAt: ymd(head?.order_id_day ?? null),
    customerId: head?.customer_id ? String(head.customer_id).trim() : null,
    billingLabel: head?.collect_money ? String(head.collect_money).trim() : null,
    billingType: mapBilling(head?.collect_money),
    invoiceForm: head?.customer_bill_form ? String(head.customer_bill_form).trim() : null,
    driverCode: head?.driver_id ? String(head.driver_id).trim() : null,
    orderOk: asBool(head?.order_OK),
    assignOk: asBool(head?.assign_OK),
    collectOk: asBool(head?.collect_OK),
    billNumber: head?.bill_number ? String(head.bill_number).trim() : null,
    maker: head?.maker ? String(head.maker).trim() : null,
    shiftLabel,
    lineCount: lines.length,
    qtyTotal,
    amountTotal,
    taxTotal,
    recycleQtyTotal,
    productNames,
  };
}

async function fetchShifts(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (orderIds.length === 0) return map;
  const ph = orderIds.map(() => "?").join(",");
  const rows = await legacy.$queryRawUnsafe<Array<{ order_id: string; morningorafternoon: string | null }>>(
    `SELECT order_id, morningorafternoon FROM report_day WHERE order_id IN (${ph})`,
    ...orderIds,
  );
  for (const r of rows) {
    const id = String(r.order_id).trim();
    const label = mapShift(r.morningorafternoon);
    if (id && label && !map.has(id)) map.set(id, label);
  }
  return map;
}

async function fetchLines(
  legacy: PrismaClient,
  orderIds: string[],
): Promise<LegacyOrderLineRow[]> {
  if (orderIds.length === 0) return [];
  const ph = orderIds.map(() => "?").join(",");
  return legacy.$queryRawUnsafe<LegacyOrderLineRow[]>(
    `SELECT order_id, order_day, product_index, product_id, product_name, product_price, product_quantity,
            give_free, give_nofree, tex, subtotal, remark, customer_id, customer_bill_form, driver_id,
            order_OK, recyele_quantity, collect_money, collect_OK, assign_OK, bill_number, order_id_day, maker
     FROM \`order\` WHERE order_id IN (${ph})
     ORDER BY order_id DESC, CAST(product_index AS UNSIGNED), product_index`,
    ...orderIds,
  );
}

export async function countLegacyOrdersForCustomer(
  legacy: PrismaClient,
  customerCode: string,
  from: string | null,
  to: string | null,
): Promise<number> {
  const match = customerMatchParams(customerCode);
  const dates = buildDateSql(from, to);
  const rows = await legacy.$queryRawUnsafe<Array<{ c: bigint | number }>>(
    `SELECT COUNT(DISTINCT order_id) AS c FROM \`order\`
     WHERE ${match.sql}${dates.sql}
       AND order_id IS NOT NULL AND TRIM(order_id) <> ''`,
    ...match.params,
    ...dates.params,
  );
  return Number(rows[0]?.c ?? 0);
}

export async function listLegacyOrdersForCustomer(
  legacy: PrismaClient,
  opts: {
    customerCode: string;
    from: string | null;
    to: string | null;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; orders: LegacyOrderSummary[] }> {
  const match = customerMatchParams(opts.customerCode);
  const dates = buildDateSql(opts.from, opts.to);
  const total = await countLegacyOrdersForCustomer(legacy, opts.customerCode, opts.from, opts.to);
  if (total === 0) return { total: 0, orders: [] };

  const idRows = await legacy.$queryRawUnsafe<Array<{ order_id: string }>>(
    `SELECT DISTINCT order_id FROM \`order\`
     WHERE ${match.sql}${dates.sql}
       AND order_id IS NOT NULL AND TRIM(order_id) <> ''
     ORDER BY order_id DESC
     LIMIT ${Math.max(1, Math.min(opts.limit, 200))} OFFSET ${Math.max(0, opts.offset)}`,
    ...match.params,
    ...dates.params,
  );
  const orderIds = idRows.map((r) => String(r.order_id).trim()).filter(Boolean);
  const [lines, shifts] = await Promise.all([fetchLines(legacy, orderIds), fetchShifts(legacy, orderIds)]);
  const byOrder = new Map<string, LegacyOrderLineRow[]>();
  for (const ln of lines) {
    const id = String(ln.order_id).trim();
    if (!byOrder.has(id)) byOrder.set(id, []);
    byOrder.get(id)!.push(ln);
  }
  const orders = orderIds.map((id) => summarizeOrder(id, byOrder.get(id) ?? [], shifts.get(id) ?? null));
  return { total, orders };
}

export async function getLegacyOrderDetail(
  legacy: PrismaClient,
  orderId: string,
): Promise<LegacyOrderDetail | null> {
  const id = orderId.trim();
  if (!id) return null;
  const lines = await fetchLines(legacy, [id]);
  if (lines.length === 0) return null;
  const shifts = await fetchShifts(legacy, [id]);
  const summary = summarizeOrder(id, lines, shifts.get(id) ?? null);

  const remittanceRows = await legacy.$queryRawUnsafe<
    Array<{
      remittance_list_id: number;
      remittance_day: Date | null;
      bank: string | null;
      money: string | null;
      money_remittance: string | null;
      remark: string | null;
      maker: string | null;
      hand_money: string | null;
      over_short_money: string | null;
    }>
  >(
    `SELECT remittance_list_id, remittance_day, bank, money, money_remittance, remark, maker, hand_money, over_short_money
     FROM remittance_list WHERE order_id = ? ORDER BY remittance_list_id`,
    id,
  );

  return {
    ...summary,
    lines: lines.map((ln) => ({
      productIndex: ln.product_index ? String(ln.product_index).trim() : null,
      productId: ln.product_id ? String(ln.product_id).trim() : null,
      productName: ln.product_name ? String(ln.product_name).trim() : null,
      unitPrice: asNum(ln.product_price),
      qty: asNum(ln.product_quantity),
      giveFree: asNum(ln.give_free),
      giveNofree: asNum(ln.give_nofree),
      tax: asNum(ln.tex),
      subtotal: asNum(ln.subtotal),
      remark: ln.remark ? String(ln.remark).trim() : null,
      recycleQty: asNum(ln.recyele_quantity),
    })),
    remittances: remittanceRows.map((r) => ({
      id: Number(r.remittance_list_id),
      remittanceDay: ymd(r.remittance_day),
      bank: r.bank ? String(r.bank).trim() : null,
      money: asNum(r.money),
      moneyRemittance: asNum(r.money_remittance),
      handMoney: asNum(r.hand_money),
      overShortMoney: asNum(r.over_short_money),
      remark: r.remark ? String(r.remark).trim() : null,
      maker: r.maker ? String(r.maker).trim() : null,
    })),
  };
}
