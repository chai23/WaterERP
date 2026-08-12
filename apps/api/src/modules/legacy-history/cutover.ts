import { Prisma, type PrismaClient } from "@prisma/client";

export type CutoverBillingType = "cash" | "monthly" | "prepaid";

export type LegacyUnpaidOrder = {
  orderId: string;
  customerId: string;
  billingLabel: string | null;
  billingType: CutoverBillingType;
  orderDay: string | null;
  orderOk: boolean;
  amount: number;
  remitted: number;
  outstanding: number;
};

export type CutoverCustomerRow = {
  customerCode: string;
  legacyCustomerIds: string[];
  newCustomerId: string | null;
  customerName: string | null;
  billingTypePreferred: CutoverBillingType | null;
  unpaidByType: Record<CutoverBillingType, { amount: number; orderCount: number }>;
  unpaidTotal: number;
  unpaidOrderCount: number;
  orders: LegacyUnpaidOrder[];
  newSystem: {
    prepaidBarrelBalance: number | null;
    barrelsOnSite: number | null;
    openArOutstanding: number | null;
    existingOpeningArCount: number;
  };
  legacyBalances: {
    prepaidBarrelBalance: number | null;
    barrelsOnSite: number | null;
  };
  mapped: boolean;
};

export type CutoverPreview = {
  asOf: string | null;
  orderCount: number;
  customerCount: number;
  mappedCustomerCount: number;
  unmappedCustomerCount: number;
  totals: Record<CutoverBillingType, number>;
  rows: CutoverCustomerRow[];
};

function asNum(v: unknown): number {
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

function isTrue(v: unknown): boolean {
  return String(v ?? "").trim() === "True";
}

export function mapBilling(collectMoney: string | null | undefined): CutoverBillingType {
  const s = String(collectMoney ?? "").trim();
  if (s === "月結") return "monthly";
  if (s === "預收") return "prepaid";
  return "cash";
}

function normalizeCustomerCode(raw: string): string | null {
  const id = raw.trim();
  if (!/^\d+$/.test(id)) return null;
  return id.padStart(6, "0").slice(-6);
}

function emptyTypeBag(): Record<CutoverBillingType, { amount: number; orderCount: number }> {
  return {
    cash: { amount: 0, orderCount: 0 },
    monthly: { amount: 0, orderCount: 0 },
    prepaid: { amount: 0, orderCount: 0 },
  };
}

async function ensureLegacyMapTable(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS legacy_id_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      entity_type VARCHAR(64) NOT NULL,
      legacy_key VARCHAR(128) NOT NULL,
      new_id BIGINT UNSIGNED NOT NULL,
      meta_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_legacy_id_map (entity_type, legacy_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function upsertLegacyMap(
  prisma: PrismaClient | Prisma.TransactionClient,
  entityType: string,
  legacyKey: string,
  newId: bigint,
  meta?: Record<string, unknown> | null,
) {
  const metaJson = meta == null ? null : JSON.stringify(meta);
  await prisma.$executeRaw`
    INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json)
    VALUES (${entityType}, ${legacyKey}, ${newId}, CAST(${metaJson} AS JSON))
    ON DUPLICATE KEY UPDATE new_id = VALUES(new_id), meta_json = VALUES(meta_json)
  `;
}

export async function loadOpeningArMap(
  prisma: PrismaClient,
): Promise<Map<string, bigint>> {
  await ensureLegacyMapTable(prisma);
  const rows = await prisma.$queryRaw<Array<{ legacy_key: string; new_id: bigint }>>`
    SELECT legacy_key, new_id FROM legacy_id_map WHERE entity_type = 'opening_ar'
  `;
  return new Map(rows.map((r) => [String(r.legacy_key), r.new_id]));
}

/** 從舊庫撈未收款訂單（collect_OK ≠ True），並扣掉已有匯款。 */
export async function fetchLegacyUnpaidOrders(
  legacy: PrismaClient,
  opts: { asOf: string | null; customerCode: string | null },
): Promise<LegacyUnpaidOrder[]> {
  const parts: string[] = [
    "(collect_OK IS NULL OR collect_OK <> 'True')",
    "order_id IS NOT NULL AND TRIM(order_id) <> ''",
  ];
  const params: unknown[] = [];
  if (opts.asOf) {
    parts.push("order_day <= ?");
    params.push(opts.asOf);
  }
  if (opts.customerCode) {
    const trimmed = opts.customerCode.trim();
    const padded = normalizeCustomerCode(trimmed) ?? trimmed;
    parts.push("(TRIM(customer_id) = ? OR LPAD(TRIM(customer_id), 6, '0') = ?)");
    params.push(trimmed, padded);
  }

  const agg = await legacy.$queryRawUnsafe<
    Array<{
      order_id: string;
      customer_id: string;
      collect_money: string | null;
      order_day: Date | null;
      order_OK: string | null;
      amount: unknown;
    }>
  >(
    `SELECT TRIM(order_id) AS order_id,
            TRIM(customer_id) AS customer_id,
            MAX(collect_money) AS collect_money,
            MAX(order_day) AS order_day,
            MAX(order_OK) AS order_OK,
            SUM(CAST(NULLIF(REPLACE(TRIM(IFNULL(subtotal,'')), ',', ''), '') AS DECIMAL(14,2))) AS amount
     FROM \`order\`
     WHERE ${parts.join(" AND ")}
     GROUP BY TRIM(order_id), TRIM(customer_id)
     HAVING amount > 0`,
    ...params,
  );

  if (agg.length === 0) return [];

  const remittanceMap = new Map<string, number>();
  const chunkSize = 400;
  for (let i = 0; i < agg.length; i += chunkSize) {
    const chunk = agg.slice(i, i + chunkSize);
    const ids = chunk.map((r) => String(r.order_id).trim());
    const ph = ids.map(() => "?").join(",");
    const remRows = await legacy.$queryRawUnsafe<Array<{ order_id: string; remitted: unknown }>>(
      `SELECT TRIM(order_id) AS order_id,
              SUM(CAST(NULLIF(REPLACE(TRIM(IFNULL(money,'')), ',', ''), '') AS DECIMAL(14,2))) AS remitted
       FROM remittance_list
       WHERE TRIM(order_id) IN (${ph})
       GROUP BY TRIM(order_id)`,
      ...ids,
    );
    for (const r of remRows) {
      remittanceMap.set(String(r.order_id).trim(), asNum(r.remitted));
    }
  }

  const out: LegacyUnpaidOrder[] = [];
  for (const r of agg) {
    const orderId = String(r.order_id).trim();
    const amount = Math.round(asNum(r.amount) * 100) / 100;
    const remitted = Math.round((remittanceMap.get(orderId) ?? 0) * 100) / 100;
    const outstanding = Math.round(Math.max(0, amount - remitted) * 100) / 100;
    if (outstanding <= 0) continue;
    out.push({
      orderId,
      customerId: String(r.customer_id ?? "").trim(),
      billingLabel: r.collect_money ? String(r.collect_money).trim() : null,
      billingType: mapBilling(r.collect_money),
      orderDay: ymd(r.order_day),
      orderOk: isTrue(r.order_OK),
      amount,
      remitted,
      outstanding,
    });
  }
  out.sort((a, b) => {
    const da = a.orderDay ?? "";
    const db = b.orderDay ?? "";
    if (da !== db) return db.localeCompare(da);
    return b.orderId.localeCompare(a.orderId);
  });
  return out;
}

type LegacyCustomerBalance = {
  customerId: string;
  customerCode: string | null;
  name: string | null;
  barrelsOnSite: number;
  prepaidBarrelBalance: number;
  billingType: CutoverBillingType;
};

async function fetchLegacyCustomerBalances(
  legacy: PrismaClient,
  customerIds: string[],
): Promise<Map<string, LegacyCustomerBalance>> {
  const map = new Map<string, LegacyCustomerBalance>();
  if (customerIds.length === 0) return map;
  const chunkSize = 400;
  for (let i = 0; i < customerIds.length; i += chunkSize) {
    const chunk = customerIds.slice(i, i + chunkSize);
    const ph = chunk.map(() => "?").join(",");
    const rows = await legacy.$queryRawUnsafe<
      Array<{
        customer_id: string;
        customer_id_mark: string | null;
        customer_name: string | null;
        customer_bucket: string | null;
        customer_remain: string | null;
        customer_collect_money: string | null;
      }>
    >(
      `SELECT customer_id, customer_id_mark, customer_name, customer_bucket, customer_remain, customer_collect_money
       FROM customer
       WHERE TRIM(customer_id) IN (${ph})`,
      ...chunk,
    );
    for (const r of rows) {
      const customerId = String(r.customer_id).trim();
      const mark = String(r.customer_id_mark ?? "").trim();
      const code = normalizeCustomerCode(mark) ?? normalizeCustomerCode(customerId);
      map.set(customerId, {
        customerId,
        customerCode: code,
        name: r.customer_name ? String(r.customer_name).trim() : null,
        barrelsOnSite: Math.max(0, Math.trunc(asNum(r.customer_bucket))),
        prepaidBarrelBalance: Math.trunc(asNum(r.customer_remain)),
        billingType: mapBilling(r.customer_collect_money),
      });
    }
  }
  return map;
}

function resolveGroupCode(legacyCustomerId: string, bal: LegacyCustomerBalance | undefined): string {
  if (bal?.customerCode) return bal.customerCode;
  return normalizeCustomerCode(legacyCustomerId) ?? legacyCustomerId.padStart(6, "0").slice(-6);
}

export async function buildCutoverPreview(
  legacy: PrismaClient,
  target: PrismaClient,
  opts: {
    asOf: string | null;
    customerCode: string | null;
    billingTypes: CutoverBillingType[];
  },
): Promise<CutoverPreview> {
  const unpaid = await fetchLegacyUnpaidOrders(legacy, {
    asOf: opts.asOf,
    customerCode: opts.customerCode,
  });
  const filtered = unpaid.filter((o) => opts.billingTypes.includes(o.billingType));

  const legacyIds = [...new Set(filtered.map((o) => o.customerId).filter(Boolean))];
  const balMap = await fetchLegacyCustomerBalances(legacy, legacyIds);

  const customers = await target.customer.findMany({
    where: { customerCode: { not: null } },
    select: {
      id: true,
      customerCode: true,
      name: true,
      billingType: true,
      prepaidBarrelBalance: true,
      addresses: { select: { barrelsOnSite: true, isDefault: true }, orderBy: { id: "asc" } },
    },
  });
  const byCode = new Map(customers.map((c) => [String(c.customerCode), c]));

  const openingMap = await loadOpeningArMap(target);
  const openArByCustomer = new Map<string, number>();
  const openAgg = await target.arOpenItem.groupBy({
    by: ["customerId"],
    where: {
      outstandingAmount: { gt: 0 },
      arDocument: { status: { not: "voided" } },
    },
    _sum: { outstandingAmount: true },
  });
  for (const row of openAgg) {
    openArByCustomer.set(row.customerId.toString(), asNum(row._sum.outstandingAmount));
  }

  type Acc = {
    customerCode: string;
    legacyCustomerIds: Set<string>;
    orders: LegacyUnpaidOrder[];
    unpaidByType: Record<CutoverBillingType, { amount: number; orderCount: number }>;
    legacyBalances: CutoverCustomerRow["legacyBalances"];
    billingTypePreferred: CutoverBillingType | null;
  };
  const groups = new Map<string, Acc>();

  for (const o of filtered) {
    const bal = balMap.get(o.customerId);
    const code = resolveGroupCode(o.customerId, bal);
    let g = groups.get(code);
    if (!g) {
      g = {
        customerCode: code,
        legacyCustomerIds: new Set(),
        orders: [],
        unpaidByType: emptyTypeBag(),
        legacyBalances: {
          prepaidBarrelBalance: bal?.prepaidBarrelBalance ?? null,
          barrelsOnSite: bal?.barrelsOnSite ?? null,
        },
        billingTypePreferred: bal?.billingType ?? null,
      };
      groups.set(code, g);
    }
    g.legacyCustomerIds.add(o.customerId);
    g.orders.push(o);
    g.unpaidByType[o.billingType].amount =
      Math.round((g.unpaidByType[o.billingType].amount + o.outstanding) * 100) / 100;
    g.unpaidByType[o.billingType].orderCount += 1;
    if (g.legacyBalances.prepaidBarrelBalance == null && bal) {
      g.legacyBalances.prepaidBarrelBalance = bal.prepaidBarrelBalance;
      g.legacyBalances.barrelsOnSite = bal.barrelsOnSite;
    }
    if (!g.billingTypePreferred && bal) g.billingTypePreferred = bal.billingType;
  }

  const totals: Record<CutoverBillingType, number> = { cash: 0, monthly: 0, prepaid: 0 };
  const rows: CutoverCustomerRow[] = [];

  for (const g of groups.values()) {
    const cust = byCode.get(g.customerCode) ?? null;
    const unpaidTotal =
      Math.round(
        (g.unpaidByType.cash.amount + g.unpaidByType.monthly.amount + g.unpaidByType.prepaid.amount) * 100,
      ) / 100;
    totals.cash = Math.round((totals.cash + g.unpaidByType.cash.amount) * 100) / 100;
    totals.monthly = Math.round((totals.monthly + g.unpaidByType.monthly.amount) * 100) / 100;
    totals.prepaid = Math.round((totals.prepaid + g.unpaidByType.prepaid.amount) * 100) / 100;

    let existingOpeningArCount = 0;
    for (const bt of ["cash", "monthly", "prepaid"] as const) {
      if (openingMap.has(`by_customer:${g.customerCode}:${bt}`)) existingOpeningArCount += 1;
    }
    for (const o of g.orders) {
      if (openingMap.has(`by_order:${o.orderId}`)) existingOpeningArCount += 1;
    }

    const barrelsOnSite = cust
      ? cust.addresses.reduce((s, a) => s + a.barrelsOnSite, 0)
      : null;

    rows.push({
      customerCode: g.customerCode,
      legacyCustomerIds: [...g.legacyCustomerIds],
      newCustomerId: cust ? cust.id.toString() : null,
      customerName: cust?.name ?? balMap.get([...g.legacyCustomerIds][0]!)?.name ?? null,
      billingTypePreferred:
        g.billingTypePreferred ??
        (cust?.billingType === "monthly" || cust?.billingType === "prepaid" || cust?.billingType === "cash"
          ? cust.billingType
          : null),
      unpaidByType: g.unpaidByType,
      unpaidTotal,
      unpaidOrderCount: g.orders.length,
      orders: g.orders,
      newSystem: {
        prepaidBarrelBalance: cust?.prepaidBarrelBalance ?? null,
        barrelsOnSite,
        openArOutstanding: cust ? (openArByCustomer.get(cust.id.toString()) ?? 0) : null,
        existingOpeningArCount,
      },
      legacyBalances: g.legacyBalances,
      mapped: Boolean(cust),
    });
  }

  rows.sort((a, b) => b.unpaidTotal - a.unpaidTotal || a.customerCode.localeCompare(b.customerCode));

  return {
    asOf: opts.asOf,
    orderCount: filtered.length,
    customerCount: rows.length,
    mappedCustomerCount: rows.filter((r) => r.mapped).length,
    unmappedCustomerCount: rows.filter((r) => !r.mapped).length,
    totals,
    rows,
  };
}

function generateArNo(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `${pad(d.getMilliseconds(), 3)}`;
  const suf = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `AROB${stamp}${suf}`;
}

export type CutoverApplyResult = {
  created: number;
  skipped: number;
  failed: number;
  createdArNos: string[];
  errors: string[];
};

export async function applyCutoverOpeningAr(
  legacy: PrismaClient,
  target: PrismaClient,
  opts: {
    asOf: string | null;
    customerCode: string | null;
    billingTypes: CutoverBillingType[];
    granularity: "by_order" | "by_customer";
    customerCodes: string[] | null;
    orderIds: string[] | null;
    cutoverDate: string;
    createdByUserId: bigint | null;
    dryRun: boolean;
  },
): Promise<CutoverApplyResult> {
  const preview = await buildCutoverPreview(legacy, target, {
    asOf: opts.asOf,
    customerCode: opts.customerCode,
    billingTypes: opts.billingTypes,
  });

  const selectedCodes = opts.customerCodes?.length
    ? new Set(opts.customerCodes.map((c) => c.trim()).filter(Boolean))
    : null;
  const selectedOrders = opts.orderIds?.length
    ? new Set(opts.orderIds.map((c) => c.trim()).filter(Boolean))
    : null;

  const openingMap = await loadOpeningArMap(target);
  const cutoverDate = new Date(`${opts.cutoverDate}T00:00:00`);
  const result: CutoverApplyResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    createdArNos: [],
    errors: [],
  };

  type Job = {
    mapKey: string;
    customerId: bigint;
    billingType: CutoverBillingType;
    amount: number;
    note: string;
    dueDate: Date;
  };
  const jobs: Job[] = [];

  for (const row of preview.rows) {
    if (selectedCodes && !selectedCodes.has(row.customerCode)) continue;
    if (!row.mapped || !row.newCustomerId) {
      result.failed += 1;
      result.errors.push(`客戶 ${row.customerCode} 尚未轉換主檔，略過`);
      continue;
    }
    const customerId = BigInt(row.newCustomerId);

    if (opts.granularity === "by_customer") {
      for (const bt of opts.billingTypes) {
        const bucket = row.unpaidByType[bt];
        if (!bucket || bucket.amount <= 0) continue;
        if (selectedOrders) {
          const has = row.orders.some((o) => o.billingType === bt && selectedOrders.has(o.orderId));
          if (!has) continue;
        }
        const mapKey = `by_customer:${row.customerCode}:${bt}`;
        if (openingMap.has(mapKey)) {
          result.skipped += 1;
          continue;
        }
        const sampleOrders = row.orders
          .filter((o) => o.billingType === bt)
          .slice(0, 8)
          .map((o) => o.orderId);
        jobs.push({
          mapKey,
          customerId,
          billingType: bt,
          amount: bucket.amount,
          note: `切換日開帳 ${opts.cutoverDate}／${bt}／${bucket.orderCount} 筆舊單（例：${sampleOrders.join(",")}）`,
          dueDate: cutoverDate,
        });
      }
    } else {
      for (const o of row.orders) {
        if (!opts.billingTypes.includes(o.billingType)) continue;
        if (selectedOrders && !selectedOrders.has(o.orderId)) continue;
        const mapKey = `by_order:${o.orderId}`;
        if (openingMap.has(mapKey)) {
          result.skipped += 1;
          continue;
        }
        jobs.push({
          mapKey,
          customerId,
          billingType: o.billingType,
          amount: o.outstanding,
          note: `切換日開帳 ${opts.cutoverDate}／舊單 ${o.orderId}（${o.orderDay ?? "?"}／${o.billingLabel ?? o.billingType}）`,
          dueDate: o.orderDay ? new Date(`${o.orderDay}T00:00:00`) : cutoverDate,
        });
      }
    }
  }

  if (opts.dryRun) {
    result.created = jobs.length;
    return result;
  }

  for (const job of jobs) {
    try {
      const amount = new Prisma.Decimal(job.amount.toFixed(2));
      if (amount.lessThanOrEqualTo(0)) {
        result.skipped += 1;
        continue;
      }
      const arNo = generateArNo();
      await target.$transaction(async (tx) => {
        const ar = await tx.arDocument.create({
          data: {
            arNo,
            customerId: job.customerId,
            salesOrderId: null,
            billingStatementId: null,
            documentType: "opening_balance",
            billingType: job.billingType,
            documentAmount: amount,
            dueDate: job.dueDate,
            status: "open",
            postedAt: cutoverDate,
            createdByUserId: opts.createdByUserId,
          },
        });
        await tx.arOpenItem.create({
          data: {
            arDocumentId: ar.id,
            customerId: job.customerId,
            salesOrderId: null,
            originalAmount: amount,
            allocatedAmount: new Prisma.Decimal(0),
            outstandingAmount: amount,
            dueDate: job.dueDate,
            expectedCollectDate: job.dueDate,
            status: "unpaid",
          },
        });
        await upsertLegacyMap(tx, "opening_ar", job.mapKey, ar.id, {
          arNo,
          billingType: job.billingType,
          amount: job.amount,
          note: job.note,
          cutoverDate: opts.cutoverDate,
          granularity: opts.granularity,
        });
      });
      openingMap.set(job.mapKey, 0n);
      result.created += 1;
      result.createdArNos.push(arNo);
    } catch (e) {
      result.failed += 1;
      result.errors.push(`${job.mapKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

export type SyncBalancesResult = {
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
};

/** 從舊庫 customer 同步空桶／預付剩餘桶到新系統主檔（不碰訂單）。 */
export async function syncLegacyBarrelBalances(
  legacy: PrismaClient,
  target: PrismaClient,
  opts: { customerCodes: string[] | null; dryRun: boolean },
): Promise<SyncBalancesResult> {
  const customers = await target.customer.findMany({
    where: opts.customerCodes?.length
      ? { customerCode: { in: opts.customerCodes } }
      : { customerCode: { not: null } },
    select: {
      id: true,
      customerCode: true,
      prepaidBarrelBalance: true,
      addresses: { select: { id: true, isDefault: true, barrelsOnSite: true }, orderBy: { id: "asc" } },
    },
  });

  const result: SyncBalancesResult = { updated: 0, skipped: 0, failed: 0, errors: [] };
  if (customers.length === 0) return result;

  const codes = customers.map((c) => String(c.customerCode));
  const ph = codes.map(() => "?").join(",");
  // 舊庫可能用 customer_id 或 mark；以 6 碼代號對應
  const legacyRows = await legacy.$queryRawUnsafe<
    Array<{
      customer_id: string;
      customer_id_mark: string | null;
      customer_bucket: string | null;
      customer_remain: string | null;
    }>
  >(
    `SELECT customer_id, customer_id_mark, customer_bucket, customer_remain
     FROM customer
     WHERE LPAD(TRIM(customer_id), 6, '0') IN (${ph})
        OR LPAD(TRIM(IFNULL(customer_id_mark,'')), 6, '0') IN (${ph})`,
    ...codes,
    ...codes,
  );

  const balByCode = new Map<string, { barrels: number; prepaid: number }>();
  for (const r of legacyRows) {
    const idCode = normalizeCustomerCode(String(r.customer_id)) ?? null;
    const markCode = normalizeCustomerCode(String(r.customer_id_mark ?? "")) ?? null;
    const code = markCode && codes.includes(markCode) ? markCode : idCode;
    if (!code || !codes.includes(code)) continue;
    // 同一代號多地址：取 customer_id 等於代號的那筆，否則第一筆
    const prefer = normalizeCustomerCode(String(r.customer_id)) === code;
    const next = {
      barrels: Math.max(0, Math.trunc(asNum(r.customer_bucket))),
      prepaid: Math.trunc(asNum(r.customer_remain)),
    };
    const prev = balByCode.get(code);
    if (!prev || prefer) balByCode.set(code, next);
  }

  for (const cust of customers) {
    const code = String(cust.customerCode);
    const bal = balByCode.get(code);
    if (!bal) {
      result.skipped += 1;
      continue;
    }
    const defaultAddr = cust.addresses.find((a) => a.isDefault) ?? cust.addresses[0] ?? null;
    const samePrepaid = cust.prepaidBarrelBalance === bal.prepaid;
    const sameBarrels = !defaultAddr || defaultAddr.barrelsOnSite === bal.barrels;
    if (samePrepaid && sameBarrels) {
      result.skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      result.updated += 1;
      continue;
    }
    try {
      await target.$transaction(async (tx) => {
        await tx.customer.update({
          where: { id: cust.id },
          data: { prepaidBarrelBalance: bal.prepaid },
        });
        if (defaultAddr) {
          await tx.deliveryAddress.update({
            where: { id: defaultAddr.id },
            data: { barrelsOnSite: bal.barrels },
          });
        }
      });
      result.updated += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
