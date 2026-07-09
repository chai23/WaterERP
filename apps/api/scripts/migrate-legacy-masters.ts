/**
 * 舊庫連線：
 *   - 預設：與 DATABASE_URL 同主機，資料庫名 `database`
 *   - 遠端舊庫：在 .env 設定 LEGACY_DATABASE_URL（唯讀）
 *     例：LEGACY_DATABASE_URL="mysql://user:pass@遠端IP:3306/database"
 *
 * 1. area → address_zones
 * 2. customer.company → affiliated_companies
 * 3. customer → customers + delivery_addresses
 * 4. personnel_list → users（不含 driver 表）
 * 5. driver → users + drivers（--drivers-only，帳號 driver_id、密碼 888888）
 *
 * 用法（於 apps/api）：
 *   npx tsx scripts/migrate-legacy-masters.ts --dry-run
 *   npx tsx scripts/migrate-legacy-masters.ts
 *   npx tsx scripts/migrate-legacy-masters.ts --fix-zones      # 僅重匯 area → address_zones
 *   npx tsx scripts/migrate-legacy-masters.ts --companies-only # 僅匯入 affiliated_companies
 *   npx tsx scripts/migrate-legacy-masters.ts --customers-only # 僅匯入 customers + delivery_addresses
 *   npx tsx scripts/migrate-legacy-masters.ts --personnel-only  # 清空 users，匯入 personnel_list + admin
 *   npx tsx scripts/migrate-legacy-masters.ts --drivers-only    # 清空司機帳號，匯入 driver 表 + 預設密碼 888888
 *   npx tsx scripts/migrate-legacy-masters.ts --products-only   # 匯入實體商品（排除標語／帳務虛擬行）
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { Prisma, PrismaClient } from "@prisma/client";
import { ADMIN_EMPLOYEE_CODE, ensureAdminUserId1 } from "./ensure-admin-user-core.js";

const LEGACY_DB = "database";
const DEFAULT_DRIVER_PASSWORD = "888888";

/** 舊庫 product 不轉入主檔：套印標語、帳務虛擬行、流程標記 */
const LEGACY_PRODUCT_SKIP_IDS = new Set([
  "000",
  "0000",
  "130",
  "201",
  "202",
  "205",
  "206",
  "207",
  "223",
  "224",
  "222",
  "300",
  "301",
  "302",
  "303",
  "304",
  "305",
  "306",
  "307",
  "308",
  "309",
  "387",
  "388",
  "389",
  "399",
  "400",
]);

/** 箱裝／罐裝等：不計押桶，但預付出貨要扣桶餘額 */
const LEGACY_PREPAID_BOX_PRODUCT_CODES = new Set(["181", "182", "183", "184", "185", "186"]);

type LegacyProductRow = {
  product_id: string;
  product_name: string | null;
  product_unit: string | null;
  product_cost: string | null;
  product_price: string | null;
  is_join_bucket: number | null;
  special_product: number | null;
};

type OldCustomerRow = {
  customerId: string;
  customerIdMark: string;
  customerName: string;
  customerAddress: string;
  contactPerson: string;
  customerPhone: string;
  customerTelephone: string;
  customerBillForm: string;
  customerInvoice: string;
  customerBillAddress: string;
  customerCollectMoney: string;
  customerBucket: string;
  customerRemain: string;
  areaId: string;
  areaId2: string;
  company: string;
  customerRemark: string;
};

type CashInvoiceMode = "none" | "tax_inclusive" | "tax_exclusive";
type BillingType = "cash" | "monthly" | "prepaid";

type CustomerGroup = { customerCode: string; rows: OldCustomerRow[] };

type LegacyAreaRow = { area_id: string; area_name: string | null };
type LegacyDriverRow = {
  driver_id: string;
  driver_name: string | null;
  driver_telephone: string | null;
  order_num: string | null;
  order_quantity: string | null;
  isOnLine: number | null;
};
type LegacyPersonnelRow = {
  personnel_id: string;
  personnel_name: string | null;
  personnel_account_number: string | null;
  personnel_password: string | null;
  personnel_level: string | null;
};

function legacyDbUrl(): string {
  const legacyUrl = process.env.LEGACY_DATABASE_URL?.trim();
  if (legacyUrl) return legacyUrl;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL");
  return url.replace(/\/[^/?]+(\?.*)?$/, `/${LEGACY_DB}$1`);
}

function describeDbUrl(url: string): string {
  try {
    const normalized = url.includes("://") ? url.replace(/^mysql:\/\//i, "http://") : `http://${url}`;
    const u = new URL(normalized);
    const db = u.pathname.replace(/^\//, "") || LEGACY_DB;
    const port = u.port || "3306";
    return `${u.hostname}:${port}/${db}`;
  } catch {
    return "（無法解析連線字串）";
  }
}

function trimToNull(s: string | undefined | null): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function parseIntField(s: string | undefined, fallback = 0): number {
  const n = Math.floor(Number((s ?? "").trim()));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCustomerCode(raw: string): string | null {
  const id = raw.trim();
  if (!/^\d+$/.test(id)) return null;
  return id.padStart(6, "0").slice(-6);
}

function parseCustomerMark(raw: string): { raw: string; baseDigits: string; suffix: number | null } | null {
  const t = raw.trim();
  const m = t.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { raw: t, baseDigits: m[1]!, suffix: m[2] != null ? Number(m[2]) : null };
}

function resolveMark(row: OldCustomerRow) {
  return parseCustomerMark(row.customerIdMark) ?? parseCustomerMark(row.customerId);
}

function groupKeyForRow(row: OldCustomerRow): string | null {
  const parsed = resolveMark(row);
  if (!parsed) return null;
  return normalizeCustomerCode(parsed.baseDigits);
}

function normalizeCustomerName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/\s*[\(（][^)）]{4,}[\)）]\s*$/u, "").trim();
  return name || raw.trim();
}

function parseDefaultInvoice(raw: string): CashInvoiceMode {
  const s = raw.trim();
  if (!s || s === "不開") return "none";
  if (s.includes("含稅")) return "tax_inclusive";
  if (s.includes("未稅")) return "tax_exclusive";
  return "none";
}

function parseBillingType(raw: string): BillingType {
  const s = raw.trim();
  if (s === "月結") return "monthly";
  if (s === "預收") return "prepaid";
  return "cash";
}

function normalizeTaxId(raw: string): string | null {
  const s = trimToNull(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

function extractZoneFromAddress(address: string): string | null {
  const m = address.trim().match(/^[\{（(](\d{1,2})[\}）)]/);
  return m ? m[1]!.padStart(2, "0") : null;
}

function cleanAddressLine(raw: string): string {
  let addr = raw.trim();
  addr = addr.replace(/^[\{（(]\d{1,2}[\}）)]\s*/u, "");
  return addr.trim() || raw.trim();
}

function zoneLabelFromCode(code: string): string | null {
  const c = code.trim();
  if (!c || c === "99") return null;
  return c.padStart(2, "0");
}

function companyLabel(raw: string): string | null {
  const c = trimToNull(raw);
  if (!c || c === "尚未分配") return null;
  return c;
}

function sortRowsForGroup(rows: OldCustomerRow[], customerCode: string): OldCustomerRow[] {
  return [...rows].sort((a, b) => {
    const ma = resolveMark(a);
    const mb = resolveMark(b);
    const priA = ma?.raw === customerCode || ma?.suffix == null ? 0 : 1;
    const priB = mb?.raw === customerCode || mb?.suffix == null ? 0 : 1;
    if (priA !== priB) return priA - priB;
    const sa = ma?.suffix ?? 0;
    const sb = mb?.suffix ?? 0;
    if (sa !== sb) return sa - sb;
    return a.customerId.localeCompare(b.customerId);
  });
}

function groupRows(rows: OldCustomerRow[]): { groups: CustomerGroup[]; invalid: OldCustomerRow[] } {
  const map = new Map<string, OldCustomerRow[]>();
  const invalid: OldCustomerRow[] = [];
  for (const row of rows) {
    const code = groupKeyForRow(row);
    if (!code) {
      invalid.push(row);
      continue;
    }
    if (!map.has(code)) map.set(code, []);
    map.get(code)!.push(row);
  }
  const groups = [...map.entries()].map(([customerCode, gRows]) => ({
    customerCode,
    rows: sortRowsForGroup(gRows, customerCode),
  }));
  groups.sort((a, b) => a.customerCode.localeCompare(b.customerCode));
  return { groups, invalid };
}

function addressLabelForRow(row: OldCustomerRow, isPrimary: boolean): string {
  const mark = resolveMark(row);
  if (isPrimary) return "預設";
  if (mark?.suffix != null) return `地址 ${mark.raw}`;
  const name = trimToNull(row.customerName);
  return name ? name.slice(0, 100) : `地址 ${row.customerId}`;
}

function buildAddressesForGroup(rows: OldCustomerRow[]) {
  const creates: Array<{
    legacyCustomerId: string;
    data: Prisma.DeliveryAddressCreateWithoutCustomerInput;
  }> = [];
  const seenLines = new Set<string>();

  rows.forEach((row, idx) => {
    const isPrimary = idx === 0;
    const addressLine = cleanAddressLine(row.customerAddress);
    const phone = trimToNull(row.customerPhone);
    const mobile = trimToNull(row.customerTelephone);
    const contactName = trimToNull(row.contactPerson);

    if (!seenLines.has(addressLine)) {
      seenLines.add(addressLine);
      creates.push({
        legacyCustomerId: row.customerId.trim(),
        data: {
          label: addressLabelForRow(row, isPrimary),
          addressLine,
          contactName: contactName ?? undefined,
          contactPhone: phone ?? undefined,
          contactMobile: mobile ?? undefined,
          isDefault: isPrimary,
        },
      });
    }

    const billAddrRaw = trimToNull(row.customerBillAddress);
    if (billAddrRaw) {
      const billLine = cleanAddressLine(billAddrRaw);
      if (billLine !== addressLine && !seenLines.has(billLine)) {
        seenLines.add(billLine);
        creates.push({
          legacyCustomerId: `${row.customerId.trim()}#bill`,
          data: {
            label: "帳單地址",
            addressLine: billLine,
            contactName: contactName ?? undefined,
            contactPhone: phone ?? undefined,
            contactMobile: mobile ?? undefined,
            isDefault: false,
          },
        });
      }
    }
  });

  if (creates.length > 0 && !creates.some((c) => c.data.isDefault)) {
    creates[0]!.data.isDefault = true;
  }
  return creates;
}

function mapPersonnelRole(level: string | null | undefined): string {
  const s = (level ?? "").trim();
  if (s === "0" || /管理|admin|老闆/i.test(s)) return "admin";
  if (s === "1" || /調度|dispatcher/i.test(s)) return "dispatcher";
  if (s === "2" || /倉|warehouse/i.test(s)) return "warehouse";
  if (/員工/i.test(s)) return "dispatcher";
  return "dispatcher";
}

async function ensureLegacyMapTable(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS legacy_id_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(32) NOT NULL,
      legacy_key VARCHAR(100) NOT NULL,
      new_id BIGINT UNSIGNED NOT NULL,
      meta_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_legacy_map (entity_type, legacy_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function upsertLegacyMap(
  prisma: PrismaClient,
  entityType: string,
  legacyKey: string,
  newId: bigint,
  meta?: Record<string, unknown>,
) {
  const metaJson = meta ? JSON.stringify(meta) : null;
  await prisma.$executeRaw`
    INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json)
    VALUES (${entityType}, ${legacyKey}, ${newId}, ${metaJson})
    ON DUPLICATE KEY UPDATE new_id = VALUES(new_id), meta_json = VALUES(meta_json)
  `;
}

async function loadLegacyCustomers(legacy: PrismaClient): Promise<OldCustomerRow[]> {
  const raw = await legacy.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT
      customer_id,
      customer_name,
      customer_address,
      contact_person,
      customer_phone,
      customer_telephone,
      customer_bill_form,
      customer_invoice,
      customer_bill_address,
      customer_collect_money,
      customer_bucket,
      customer_remain,
      area_id,
      area_id_2,
      company,
      customer_remark,
      customer_id_mark
    FROM customer
  `);
  const rows: OldCustomerRow[] = [];
  for (const r of raw) {
    const customerId = String(r.customer_id ?? "").trim();
    const customerName = String(r.customer_name ?? "").trim();
    const customerAddress = String(r.customer_address ?? "").trim();
    if (!customerId || !customerName || !customerAddress) continue;
    const customerIdMark = String(r.customer_id_mark ?? "").trim() || customerId;
    rows.push({
      customerId,
      customerIdMark,
      customerName,
      customerAddress,
      contactPerson: String(r.contact_person ?? ""),
      customerPhone: String(r.customer_phone ?? ""),
      customerTelephone: String(r.customer_telephone ?? ""),
      customerBillForm: String(r.customer_bill_form ?? ""),
      customerInvoice: String(r.customer_invoice ?? ""),
      customerBillAddress: String(r.customer_bill_address ?? ""),
      customerCollectMoney: String(r.customer_collect_money ?? ""),
      customerBucket: String(r.customer_bucket ?? ""),
      customerRemain: String(r.customer_remain ?? ""),
      areaId: String(r.area_id ?? ""),
      areaId2: String(r.area_id_2 ?? ""),
      company: String(r.company ?? ""),
      customerRemark: String(r.customer_remark ?? ""),
    });
  }
  return rows;
}

async function migrateAreas(legacy: PrismaClient, target: PrismaClient, dryRun: boolean) {
  const areas = await legacy.$queryRawUnsafe<LegacyAreaRow[]>(
    `SELECT area_id, area_name FROM area ORDER BY area_id`,
  );
  const filtered = areas.filter((a) => String(a.area_id ?? "").trim() !== "99");

  console.log(
    `\n[area → address_zones] ${filtered.length} 筆（來源 area 表 ${areas.length} 筆，已排除 99 尚未分配）`,
  );

  const areaByLegacyId = new Map<string, bigint>();
  if (dryRun) return areaByLegacyId;

  let sort = 0;
  for (const a of filtered) {
    const legacyKey = String(a.area_id ?? "").trim();
    if (!legacyKey) continue;
    const name = (trimToNull(a.area_name) ?? legacyKey).slice(0, 50);
    const row = await target.addressZone.upsert({
      where: { name },
      create: { name, sortOrder: sort++, isActive: true },
      update: { sortOrder: sort - 1 },
    });
    areaByLegacyId.set(legacyKey, row.id);
    await upsertLegacyMap(target, "area", legacyKey, row.id, { name });
  }
  return areaByLegacyId;
}

async function migrateCompanies(target: PrismaClient, customerRows: OldCustomerRow[], dryRun: boolean) {
  const names = new Set<string>();
  for (const r of customerRows) {
    const co = companyLabel(r.company);
    if (co) names.add(co);
  }
  const sorted = [...names].sort();
  console.log(`\n[company → affiliated_companies] 將建立/對齊 ${sorted.length} 家公司`);
  if (dryRun) return new Map<string, bigint>();

  let sort = 0;
  const companyByName = new Map<string, bigint>();
  for (const name of sorted) {
    const row = await target.affiliatedCompany.upsert({
      where: { name },
      create: { name, sortOrder: sort++, isActive: true },
      update: {},
    });
    companyByName.set(name, row.id);
    await upsertLegacyMap(target, "affiliated_company", name, row.id);
  }
  return companyByName;
}

function resolveZoneId(row: OldCustomerRow, areaByLegacyId: Map<string, bigint>): bigint | undefined {
  for (const raw of [row.areaId, row.areaId2]) {
    const key = String(raw ?? "").trim();
    if (!key || key === "99") continue;
    const id = areaByLegacyId.get(key);
    if (id) return id;
  }
  return undefined;
}

function resolveCompanyId(row: OldCustomerRow, companyByName: Map<string, bigint>): bigint | undefined {
  const label = companyLabel(row.company);
  if (!label) return undefined;
  return companyByName.get(label);
}

async function migrateCustomers(
  target: PrismaClient,
  groups: CustomerGroup[],
  areaByLegacyId: Map<string, bigint>,
  companyByName: Map<string, bigint>,
  dryRun: boolean,
) {
  const existingCodes = dryRun
    ? new Set<string>()
    : new Set(
        (await target.customer.findMany({ select: { customerCode: true } }))
          .map((c) => c.customerCode)
          .filter((c): c is string => !!c),
      );

  let created = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\n[customer → customers] 邏輯客戶 ${groups.length} 組`);

  for (const group of groups) {
    const { customerCode, rows: groupRows } = group;
    if (existingCodes.has(customerCode)) {
      skipped++;
      continue;
    }

    const primary = groupRows[0]!;
    const addressCreates = buildAddressesForGroup(groupRows);
    if (addressCreates.length === 0) {
      failed++;
      continue;
    }

    const barrelsOnSite = Math.max(0, parseIntField(primary.customerBucket, 0));
    const prepaidBarrelBalance = parseIntField(primary.customerRemain, 0);
    if (dryRun) {
      created++;
      continue;
    }

    try {
      const customer = await target.customer.create({
        data: {
          customerCode,
          name: normalizeCustomerName(primary.customerName),
          contactName: trimToNull(primary.contactPerson) ?? undefined,
          phone: trimToNull(primary.customerPhone) ?? undefined,
          mobile: trimToNull(primary.customerTelephone) ?? undefined,
          taxId: normalizeTaxId(primary.customerInvoice) ?? undefined,
          billingType: parseBillingType(primary.customerCollectMoney),
          defaultCashInvoiceMode: parseDefaultInvoice(primary.customerBillForm),
          addressZoneId: resolveZoneId(primary, areaByLegacyId),
          affiliatedCompanyId: resolveCompanyId(primary, companyByName),
          standingRemark: trimToNull(primary.customerRemark) ?? undefined,
          prepaidBarrelBalance,
          addresses: {
            create: addressCreates.map((a) => a.data),
          },
        },
        include: { addresses: true },
      });

      if (barrelsOnSite > 0) {
        const defaultAddr = customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0];
        if (defaultAddr) {
          await target.deliveryAddress.update({
            where: { id: defaultAddr.id },
            data: { barrelsOnSite },
          });
        }
      }

      await upsertLegacyMap(target, "customer_code", customerCode, customer.id);

      const addrByLine = new Map(customer.addresses.map((a) => [a.addressLine, a.id]));
      for (const row of groupRows) {
        const legacyId = row.customerId.trim();
        const line = cleanAddressLine(row.customerAddress);
        const deliveryAddressId = addrByLine.get(line);
        await upsertLegacyMap(target, "customer_id", legacyId, customer.id, {
          deliveryAddressId: deliveryAddressId?.toString() ?? null,
          customerCode,
        });
      }

      existingCodes.add(customerCode);
      created++;
      if (created % 200 === 0) console.log(`  已建立 ${created} 筆客戶…`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  失敗 ${customerCode}: ${msg}`);
    }
  }

  console.log(`  建立：${created}，略過：${skipped}，失敗：${failed}`);
}

async function migratePersonnelOnly(
  legacy: PrismaClient,
  target: PrismaClient,
  dryRun: boolean,
  clearExisting = true,
) {
  const personnel = await legacy.$queryRawUnsafe<LegacyPersonnelRow[]>(
    `SELECT personnel_id, personnel_name, personnel_account_number, personnel_password, personnel_level FROM personnel_list ORDER BY personnel_id`,
  );

  console.log(`\n[personnel_list → users] ${personnel.length} 筆（不含司機 driver 表）`);

  if (!dryRun && clearExisting) {
    console.log("[personnel-only] 清空 drivers 與 users…");
    await target.driver.deleteMany({});
    await target.user.deleteMany({});
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type IN ('user', 'driver')`;
    await ensureAdminUserId1(target);
  }

  let created = 0;
  let skipped = 0;
  const hashPassword = async (plain: string) => bcrypt.hash(plain, 10);

  for (const pe of personnel) {
    const accountRaw = trimToNull(pe.personnel_account_number);
    const code = (accountRaw ?? String(pe.personnel_id).trim()).toUpperCase();
    if (!code) {
      skipped++;
      continue;
    }
    if (code === ADMIN_EMPLOYEE_CODE.toUpperCase()) {
      skipped++;
      continue;
    }

    const name = trimToNull(pe.personnel_name) ?? code;
    const plainPassword = trimToNull(pe.personnel_password) ?? `erp${code.toLowerCase()}`;
    const role = mapPersonnelRole(pe.personnel_level);

    if (dryRun) {
      created++;
      continue;
    }

    const passwordHash = await hashPassword(plainPassword);
    const user = await target.user.create({
      data: {
        employeeCode: code,
        name: name.slice(0, 100),
        phone: null,
        passwordHash,
        role,
        isActive: true,
      },
    });
    await upsertLegacyMap(target, "user", code, user.id, {
      role,
      legacyPersonnelId: pe.personnel_id,
    });
    created++;
  }

  if (!dryRun) {
    await target.user.updateMany({ data: { phone: null } });
  }

  console.log(`  使用者建立：${created}，略過：${skipped}`);
  if (!dryRun) {
    const n = await target.user.count();
    const admin = await target.user.findUnique({ where: { id: 1n } });
    console.log(`  users 目前共 ${n} 筆（phone 皆為空）`);
    console.log("  員編來自 personnel_account_number；若舊庫無密碼，預設密碼為 erp{員編小寫}。");
    console.log(
      admin
        ? `  系統管理員 id=1（${ADMIN_EMPLOYEE_CODE}）已就緒。`
        : "  警告：未找到 id=1 系統管理員，請檢查 ensureAdminUserId1。",
    );
  }
}

function normalizeDriverPhone(raw: string | null | undefined): string | null {
  const t = trimToNull(raw);
  if (!t || t === "無" || t.length < 4) return null;
  return t.slice(0, 32);
}

function parseCapacityField(raw: string | null | undefined, fallback: number): number {
  const n = Math.floor(Number((raw ?? "").trim()));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

async function migrateDriversOnly(
  legacy: PrismaClient,
  target: PrismaClient,
  dryRun: boolean,
  replace = true,
) {
  const drivers = await legacy.$queryRawUnsafe<LegacyDriverRow[]>(
    `SELECT driver_id, driver_name, driver_telephone, order_num, order_quantity, isOnLine FROM driver ORDER BY driver_id`,
  );

  console.log(`\n[driver → users + drivers] ${drivers.length} 筆（帳號=driver_id，密碼=${DEFAULT_DRIVER_PASSWORD}）`);

  if (!dryRun && replace) {
    const assignments = await target.deliveryAssignment.count();
    if (assignments > 0) {
      throw new Error(`新庫已有 ${assignments} 筆配送分派關聯司機，無法清空司機重匯。`);
    }
    console.log("[drivers-only] 清空司機帳號（role=driver）…");
    const driverUsers = await target.user.findMany({ where: { role: "driver" }, select: { id: true } });
    await target.driver.deleteMany({});
    if (driverUsers.length > 0) {
      await target.user.deleteMany({ where: { id: { in: driverUsers.map((u) => u.id) } } });
    }
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type IN ('driver')`;
  }

  const existingCodes = dryRun
    ? new Set<string>()
    : new Set(
        (await target.user.findMany({ select: { employeeCode: true } })).map((u) =>
          u.employeeCode.toUpperCase(),
        ),
      );

  let usersCreated = 0;
  let driversCreated = 0;
  let skipped = 0;
  const hashPassword = async (plain: string) => bcrypt.hash(plain, 10);
  const passwordHash = dryRun ? "" : await hashPassword(DEFAULT_DRIVER_PASSWORD);

  for (const d of drivers) {
    const code = String(d.driver_id).trim().toUpperCase();
    if (!code) {
      skipped++;
      continue;
    }
    if (existingCodes.has(code)) {
      skipped++;
      continue;
    }

    const name = trimToNull(d.driver_name) ?? code;
    const phone = normalizeDriverPhone(d.driver_telephone);
    const maxOrderCount = parseCapacityField(d.order_num, 20);
    const maxBarrelQty = parseCapacityField(d.order_quantity, 150);
    const isActive = d.isOnLine == null ? true : Number(d.isOnLine) !== 0;

    if (dryRun) {
      usersCreated++;
      driversCreated++;
      existingCodes.add(code);
      continue;
    }

    const user = await target.user.create({
      data: {
        employeeCode: code,
        name: name.slice(0, 100),
        phone,
        passwordHash,
        role: "driver",
        isActive,
      },
    });
    const driver = await target.driver.create({
      data: {
        userId: user.id,
        employeeCode: code,
        maxOrderCount,
        maxBarrelQty,
        isActive,
      },
    });
    await upsertLegacyMap(target, "driver", String(d.driver_id).trim(), driver.id, {
      userId: user.id.toString(),
      maxOrderCount: String(maxOrderCount),
      maxBarrelQty: String(maxBarrelQty),
    });
    existingCodes.add(code);
    usersCreated++;
    driversCreated++;
  }

  console.log(`  使用者建立：${usersCreated}，司機建立：${driversCreated}，略過：${skipped}`);
  if (!dryRun) {
    const n = await target.driver.count();
    console.log(`  drivers 目前共 ${n} 筆；登入帳號為 driver_id，預設密碼 ${DEFAULT_DRIVER_PASSWORD}`);
  }
}

function parseDecimalField(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeLegacyProductCode(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d{3}$/.test(t)) return null;
  return t;
}

function normalizeLegacyProductUnit(raw: string | null | undefined, specialProduct: boolean): string {
  const t = (raw ?? "").trim();
  if (t && t !== "0") return t.slice(0, 20);
  if (specialProduct) return "台";
  return "桶";
}

function legacyProductSkipReason(productId: string): string {
  if (["387", "388", "389", "399", "400"].includes(productId)) return "slogan";
  if (["000", "0000", "201", "202", "205", "206", "207", "223"].includes(productId)) return "accounting_line";
  if (["130", "300", "224"].includes(productId)) return "system_action";
  return "service_workflow_label";
}

async function migrateProductsOnly(legacy: PrismaClient, target: PrismaClient, dryRun: boolean, replace = true) {
  const rows = await legacy.$queryRawUnsafe<LegacyProductRow[]>(
    `SELECT product_id, product_name, product_unit, product_cost, product_price, is_join_bucket, special_product
     FROM product ORDER BY product_id`,
  );

  const toMigrate = rows.filter((r) => !LEGACY_PRODUCT_SKIP_IDS.has(String(r.product_id).trim()));
  const skipped = rows.filter((r) => LEGACY_PRODUCT_SKIP_IDS.has(String(r.product_id).trim()));

  console.log(
    `\n[product → products] 舊庫 ${rows.length} 筆，轉入 ${toMigrate.length} 筆，略過標語/虛擬行 ${skipped.length} 筆`,
  );

  if (!dryRun && replace) {
    const [orders, production, purchase] = await Promise.all([
      target.salesOrder.count(),
      target.productionOrder.count(),
      target.purchaseOrder.count(),
    ]);
    if (orders > 0 || production > 0 || purchase > 0) {
      throw new Error(
        `新庫已有業務單據（銷售訂單 ${orders}、生產單 ${production}、採購單 ${purchase}），無法清空商品重匯。`,
      );
    }
    console.log("[products-only] 清空 products 與庫存…");
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type IN ('product', 'product_skip')`;
    await target.customerPrepaidProductBalance.deleteMany({});
    await target.stockMovement.deleteMany({});
    await target.inventoryBalance.deleteMany({});
    await target.product.deleteMany({});
  }

  let created = 0;
  let failed = 0;

  for (const row of toMigrate) {
    const legacyId = String(row.product_id).trim();
    const productCode = normalizeLegacyProductCode(legacyId);
    if (!productCode) {
      console.warn(`  略過 ${legacyId}：商品編號非 3 碼數字`);
      failed++;
      continue;
    }

    const name = trimToNull(row.product_name)?.slice(0, 200);
    if (!name) {
      failed++;
      continue;
    }

    const specialProduct = Number(row.special_product) === 1;
    const unit = normalizeLegacyProductUnit(row.product_unit, specialProduct);
    const salePrice = parseDecimalField(row.product_price);
    const costPrice = parseDecimalField(row.product_cost);
    const countsDepositBarrel =
      !LEGACY_PREPAID_BOX_PRODUCT_CODES.has(productCode) && Number(row.is_join_bucket) === 1;
    const consumesPrepaidBarrel = LEGACY_PREPAID_BOX_PRODUCT_CODES.has(productCode)
      ? true
      : countsDepositBarrel && !specialProduct && !["203", "204"].includes(productCode);

    if (dryRun) {
      created++;
      continue;
    }

    try {
      const product = await target.$transaction(async (tx) => {
        const p = await tx.product.create({
          data: {
            productCode,
            name,
            sku: legacyId,
            unit,
            salePrice,
            costPrice,
            countsDepositBarrel,
            consumesPrepaidBarrel,
            isActive: true,
          },
        });
        await tx.inventoryBalance.create({
          data: { productId: p.id, qtyOnHand: 0 },
        });
        return p;
      });
      await upsertLegacyMap(target, "product", legacyId, product.id, {
        productCode,
        specialProduct,
        countsDepositBarrel,
      });
      created++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  失敗 ${legacyId} ${name}: ${msg}`);
    }
  }

  if (!dryRun) {
    for (const row of skipped) {
      const legacyId = String(row.product_id).trim();
      await upsertLegacyMap(target, "product_skip", legacyId, 0n, {
        reason: legacyProductSkipReason(legacyId),
        productName: trimToNull(row.product_name),
      });
    }
  }

  console.log(`  商品建立：${created}，轉換失敗：${failed}`);
  if (!dryRun) {
    const n = await target.product.count();
    console.log(`  products 目前共 ${n} 筆；略過項目已記錄於 legacy_id_map（product_skip）`);
    if (skipped.length > 0) {
      console.log(`  未轉入之舊編號：${skipped.map((r) => r.product_id).join(", ")}`);
    }
  }
}

async function migrateUsersAndDrivers(legacy: PrismaClient, target: PrismaClient, dryRun: boolean) {
  await migrateDriversOnly(legacy, target, dryRun, false);
  const personnel = await legacy.$queryRawUnsafe<LegacyPersonnelRow[]>(
    `SELECT personnel_id, personnel_name, personnel_account_number, personnel_password, personnel_level FROM personnel_list`,
  );
  const driverIds = new Set(
    (
      await legacy.$queryRawUnsafe<Array<{ driver_id: string }>>(`SELECT driver_id FROM driver`)
    ).map((d) => String(d.driver_id).trim()),
  );

  console.log(`\n[personnel → users] 人員 ${personnel.length}（不含 driver 表）`);

  const existingCodes = dryRun
    ? new Set<string>()
    : new Set(
        (await target.user.findMany({ select: { employeeCode: true } })).map((u) =>
          u.employeeCode.toUpperCase(),
        ),
      );

  let usersCreated = 0;
  let skipped = 0;

  const hashPassword = async (plain: string) => bcrypt.hash(plain, 10);

  for (const pe of personnel) {
    const accountRaw = trimToNull(pe.personnel_account_number);
    const code = (accountRaw ?? String(pe.personnel_id).trim()).toUpperCase();
    if (!code || driverIds.has(String(pe.personnel_id).trim())) continue;
    if (existingCodes.has(code)) {
      skipped++;
      continue;
    }

    const name = trimToNull(pe.personnel_name) ?? code;
    const plainPassword = trimToNull(pe.personnel_password) ?? `erp${code.toLowerCase()}`;
    const role = mapPersonnelRole(pe.personnel_level);

    if (dryRun) {
      usersCreated++;
      existingCodes.add(code);
      continue;
    }

    const passwordHash = await hashPassword(plainPassword);
    const user = await target.user.create({
      data: {
        employeeCode: code,
        name: name.slice(0, 100),
        phone: null,
        passwordHash,
        role,
        isActive: true,
      },
    });
    await upsertLegacyMap(target, "user", code, user.id, { role, legacyPersonnelId: pe.personnel_id });
    existingCodes.add(code);
    usersCreated++;
  }

  console.log(`  使用者建立：${usersCreated}，略過：${skipped}`);
}

async function loadAreaByLegacyId(target: PrismaClient): Promise<Map<string, bigint>> {
  const rows = await target.$queryRaw<Array<{ legacy_key: string; new_id: bigint }>>`
    SELECT legacy_key, new_id FROM legacy_id_map WHERE entity_type = 'area'`;
  const map = new Map<string, bigint>();
  for (const r of rows) map.set(String(r.legacy_key).trim(), r.new_id);
  return map;
}

async function loadCompanyByName(target: PrismaClient): Promise<Map<string, bigint>> {
  const rows = await target.affiliatedCompany.findMany();
  return new Map(rows.map((r) => [r.name, r.id]));
}

async function fixCompaniesOnly(
  target: PrismaClient,
  customerRows: OldCustomerRow[],
  dryRun: boolean,
  replace: boolean,
) {
  if (!dryRun && replace) {
    console.log("[companies-only] 清空 affiliated_companies…");
    await target.customer.updateMany({ data: { affiliatedCompanyId: null } });
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'affiliated_company'`;
    await target.affiliatedCompany.deleteMany({});
  }

  const companyByName = await migrateCompanies(target, customerRows, dryRun);
  if (!dryRun) {
    const n = await target.affiliatedCompany.count();
    console.log(`\naffiliated_companies 目前共 ${n} 筆`);
  }
  return companyByName;
}

async function fixCustomersOnly(
  legacy: PrismaClient,
  target: PrismaClient,
  customerRows: OldCustomerRow[],
  dryRun: boolean,
  replace: boolean,
) {
  const { groups, invalid } = groupRows(customerRows);
  console.log(`邏輯客戶 ${groups.length} 組，無效 ${invalid.length} 列`);

  if (!dryRun && replace) {
    const orders = await target.salesOrder.count();
    if (orders > 0) {
      throw new Error(`新庫已有 ${orders} 筆訂單，無法清空客戶重匯。請先清空業務資料。`);
    }
    console.log("[customers-only] 清空 customers / delivery_addresses…");
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type IN ('customer_id', 'customer_code')`;
    await target.deliveryAddress.deleteMany({});
    await target.customer.deleteMany({});
  }

  let areaByLegacyId = await loadAreaByLegacyId(target);
  if (areaByLegacyId.size === 0 && !dryRun) {
    console.log("新庫尚無區域對照，先匯入 area…");
    areaByLegacyId = await migrateAreas(legacy, target, false);
  } else if (areaByLegacyId.size === 0 && dryRun) {
    console.log("（dry-run）將假設已存在 address_zones 對照");
  }

  let companyByName = await loadCompanyByName(target);
  if (companyByName.size === 0 && !dryRun) {
    console.log("新庫尚無隸屬公司，先匯入 company…");
    companyByName = await migrateCompanies(target, customerRows, false);
  }

  await migrateCustomers(target, groups, areaByLegacyId, companyByName, dryRun);

  if (!dryRun) {
    const [customers, addresses] = await Promise.all([
      target.customer.count(),
      target.deliveryAddress.count(),
    ]);
    console.log(`\ncustomers: ${customers}，delivery_addresses: ${addresses}`);
  }
}

async function relinkCustomerZones(
  target: PrismaClient,
  groups: CustomerGroup[],
  areaByLegacyId: Map<string, bigint>,
  dryRun: boolean,
) {
  const customers = await target.customer.findMany({ select: { id: true, customerCode: true } });
  const byCode = new Map(
    customers.filter((c) => c.customerCode).map((c) => [c.customerCode!, c.id] as const),
  );

  let linked = 0;
  let unassigned = 0;
  let missing = 0;

  for (const group of groups) {
    const customerId = byCode.get(group.customerCode);
    if (!customerId) {
      missing++;
      continue;
    }
    const zoneId = resolveZoneId(group.rows[0]!, areaByLegacyId);
    if (dryRun) {
      if (zoneId) linked++;
      else unassigned++;
      continue;
    }
    await target.customer.update({
      where: { id: customerId },
      data: { addressZoneId: zoneId ?? null },
    });
    if (zoneId) linked++;
    else unassigned++;
  }

  console.log(`  客戶區域已連結：${linked}，未分配(99/空)：${unassigned}，新庫無此客戶：${missing}`);
}

async function fixAddressZonesOnly(
  legacy: PrismaClient,
  target: PrismaClient,
  customerRows: OldCustomerRow[],
  dryRun: boolean,
) {
  const { groups } = groupRows(customerRows);

  if (!dryRun) {
    console.log("\n[fix-zones] 清空 address_zones 並重匯…");
    await target.customer.updateMany({ data: { addressZoneId: null } });
    await target.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type IN ('area', 'address_zone')`;
    await target.addressZone.deleteMany({});
  }

  const areaByLegacyId = await migrateAreas(legacy, target, dryRun);
  console.log("\n[fix-zones] 依舊 customer.area_id 重連客戶…");
  await relinkCustomerZones(target, groups, areaByLegacyId, dryRun);

  if (!dryRun) {
    const n = await target.addressZone.count();
    console.log(`\naddress_zones 目前共 ${n} 筆（預期 34）`);
  }
}

async function clearMastersForReplace(target: PrismaClient) {
  console.log("\n[replace] 清空新庫主檔（保留 id=1 admin）…");
  await target.$executeRawUnsafe(`DELETE FROM legacy_id_map`).catch(() => {});
  await target.driver.deleteMany({});
  await target.user.deleteMany({});
  await target.deliveryAddress.deleteMany({});
  await target.customer.deleteMany({});
  await target.affiliatedCompany.deleteMany({});
  await target.addressZone.deleteMany({});
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const replace = args.includes("--replace");
  const fixZones = args.includes("--fix-zones") || args.includes("--zones-only");
  const companiesOnly = args.includes("--companies-only");
  const customersOnly = args.includes("--customers-only");
  const personnelOnly = args.includes("--personnel-only");
  const driversOnly = args.includes("--drivers-only");
  const productsOnly = args.includes("--products-only");

  const target = new PrismaClient();
  const legacy = new PrismaClient({ datasources: { db: { url: legacyDbUrl() } } });

  console.log(`舊庫：${describeDbUrl(legacyDbUrl())}（唯讀）`);
  console.log(`新庫：${describeDbUrl(process.env.DATABASE_URL ?? "")}${dryRun ? "（dry-run，不寫入）" : ""}`);

  try {
    if (personnelOnly) {
      if (!dryRun) await ensureLegacyMapTable(target);
      await migratePersonnelOnly(legacy, target, dryRun);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n人員帳號遷移完成。");
      return;
    }

    if (driversOnly) {
      if (!dryRun) await ensureLegacyMapTable(target);
      await migrateDriversOnly(legacy, target, dryRun, replace);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n司機資料轉換完成。");
      return;
    }

    if (productsOnly) {
      if (!dryRun) await ensureLegacyMapTable(target);
      await migrateProductsOnly(legacy, target, dryRun, replace);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n商品資料轉換完成。");
      return;
    }

    const customerRows = await loadLegacyCustomers(legacy);

    if (fixZones) {
      console.log(`讀取 customer ${customerRows.length} 列（用於重連區域）`);
      if (!dryRun) await ensureLegacyMapTable(target);
      await fixAddressZonesOnly(legacy, target, customerRows, dryRun);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n區域轉換完成。");
      return;
    }

    if (companiesOnly) {
      console.log(`讀取 customer ${customerRows.length} 列（用於擷取 company）`);
      if (!dryRun) await ensureLegacyMapTable(target);
      await fixCompaniesOnly(target, customerRows, dryRun, replace);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n隸屬公司轉換完成。");
      return;
    }

    if (customersOnly) {
      console.log(`讀取 customer ${customerRows.length} 列`);
      if (!dryRun) await ensureLegacyMapTable(target);
      await fixCustomersOnly(legacy, target, customerRows, dryRun, replace);
      console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n客戶資料轉換完成。");
      return;
    }

    const { groups, invalid } = groupRows(customerRows);
    console.log(`讀取 customer ${customerRows.length} 列 → ${groups.length} 個邏輯客戶，無效 ${invalid.length} 列`);

    if (!dryRun) {
      await ensureLegacyMapTable(target);
      if (replace) await clearMastersForReplace(target);
    }

    const areaByLegacyId = await migrateAreas(legacy, target, dryRun);
    const companyByName = await migrateCompanies(target, customerRows, dryRun);
    await migrateCustomers(target, groups, areaByLegacyId, companyByName, dryRun);
    await migratePersonnelOnly(legacy, target, dryRun, false);

    if (!dryRun) {
      const counts = await Promise.all([
        target.addressZone.count(),
        target.affiliatedCompany.count(),
        target.customer.count(),
        target.deliveryAddress.count(),
        target.user.count(),
        target.driver.count(),
      ]);
      console.log("\n=== 新庫筆數 ===");
      console.log(`address_zones: ${counts[0]}`);
      console.log(`affiliated_companies: ${counts[1]}`);
      console.log(`customers: ${counts[2]}`);
      console.log(`delivery_addresses: ${counts[3]}`);
      console.log(`users: ${counts[4]}`);
      console.log(`drivers: ${counts[5]}`);
    }

    console.log(dryRun ? "\n（dry-run 完成，未寫入資料庫）" : "\n主檔遷移完成。");
  } finally {
    await legacy.$disconnect();
    await target.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
