/**
 * 舊系統 customer 表 TSV 匯入（scripts/customer_data.txt）
 *
 * 舊系統語意：
 * - customer_id：資料列主鍵（可能為 310100 或 310100-1）
 * - customer_id_mark：邏輯客戶編號；310100、310100-1、310100-2… 為同一客戶的多個送貨地址
 * - 新系統 customerCode = mark 的數字基底（例 310100），多列合併為一客戶、多筆送貨地址
 *
 * 用法（於 apps/api）：
 *   npx tsx scripts/migrate-customer-data.ts --analyze
 *   npx tsx scripts/migrate-customer-data.ts --dry-run
 *   npx tsx scripts/migrate-customer-data.ts
 *   npx tsx scripts/migrate-customer-data.ts --replace   # 刪除無訂單客戶後重新匯入
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const COL = {
  customerId: 0,
  customerName: 1,
  customerAddress: 2,
  contactPerson: 3,
  customerPhone: 4,
  customerTelephone: 5,
  customerBillForm: 6,
  customerInvoice: 7,
  customerBillAddress: 8,
  customerCollectMoney: 9,
  customerBucket: 10,
  customerRemain: 11,
  areaId: 12,
  areaId2: 13,
  company: 14,
  customerRemark: 15,
  customerIdMark: 16,
} as const;

const EXPECTED_COLS = 20;

type CashInvoiceMode = "none" | "tax_inclusive" | "tax_exclusive";
type BillingType = "cash" | "monthly" | "prepaid";

interface OldCustomerRow {
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
}

interface ParsedMark {
  raw: string;
  baseDigits: string;
  suffix: number | null;
}

interface CustomerGroup {
  customerCode: string;
  rows: OldCustomerRow[];
}

function trimToNull(s: string | undefined): string | null {
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

/** 解析 customer_id_mark：310100、310100-1 → 基底 310100 */
function parseCustomerMark(raw: string): ParsedMark | null {
  const t = raw.trim();
  const m = t.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const baseDigits = m[1]!;
  const suffix = m[2] != null ? Number(m[2]) : null;
  return { raw: t, baseDigits, suffix };
}

function resolveMark(row: OldCustomerRow): ParsedMark | null {
  const fromMark = parseCustomerMark(row.customerIdMark);
  if (fromMark) return fromMark;
  return parseCustomerMark(row.customerId);
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
  if (!m) return null;
  return m[1]!.padStart(2, "0");
}

function cleanAddressLine(raw: string): string {
  let addr = raw.trim();
  addr = addr.replace(/^[\{（(]\d{1,2}[\}）)]\s*/u, "");
  return addr.trim() || raw.trim();
}

function zoneLabelFromCode(code: string): string | null {
  const c = code.trim();
  if (!c || c === "99") return null;
  return c;
}

function companyLabel(raw: string): string | null {
  const c = trimToNull(raw);
  if (!c || c === "尚未分配") return null;
  return c;
}

function parseRow(line: string): OldCustomerRow | null {
  const parts = line.split("\t");
  if (parts.length < EXPECTED_COLS) return null;
  const customerId = parts[COL.customerId]?.trim() ?? "";
  const customerIdMark = (parts[COL.customerIdMark] ?? "").trim() || customerId;
  const customerName = parts[COL.customerName]?.trim() ?? "";
  const customerAddress = parts[COL.customerAddress]?.trim() ?? "";
  if (!customerId || !customerName || !customerAddress) return null;

  return {
    customerId,
    customerIdMark,
    customerName,
    customerAddress,
    contactPerson: parts[COL.contactPerson] ?? "",
    customerPhone: parts[COL.customerPhone] ?? "",
    customerTelephone: parts[COL.customerTelephone] ?? "",
    customerBillForm: parts[COL.customerBillForm] ?? "",
    customerInvoice: parts[COL.customerInvoice] ?? "",
    customerBillAddress: parts[COL.customerBillAddress] ?? "",
    customerCollectMoney: parts[COL.customerCollectMoney] ?? "",
    customerBucket: parts[COL.customerBucket] ?? "",
    customerRemain: parts[COL.customerRemain] ?? "",
    areaId: parts[COL.areaId] ?? "",
    areaId2: parts[COL.areaId2] ?? "",
    company: parts[COL.company] ?? "",
    customerRemark: parts[COL.customerRemark] ?? "",
  };
}

function readDataFile(filePath: string): OldCustomerRow[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows: OldCustomerRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const row = parseRow(trimmed);
    if (row) rows.push(row);
  }
  return rows;
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

  const groups: CustomerGroup[] = [...map.entries()].map(([customerCode, gRows]) => ({
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

function buildAddressesForGroup(
  rows: OldCustomerRow[],
): Prisma.DeliveryAddressCreateWithoutCustomerInput[] {
  const creates: Prisma.DeliveryAddressCreateWithoutCustomerInput[] = [];
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
        label: addressLabelForRow(row, isPrimary),
        addressLine,
        contactName,
        contactPhone: phone,
        contactMobile: mobile,
        isDefault: isPrimary,
      });
    }

    const billAddrRaw = trimToNull(row.customerBillAddress);
    if (billAddrRaw) {
      const billLine = cleanAddressLine(billAddrRaw);
      if (billLine !== addressLine && !seenLines.has(billLine)) {
        seenLines.add(billLine);
        creates.push({
          label: "帳單地址",
          addressLine: billLine,
          contactName,
          contactPhone: phone,
          contactMobile: mobile,
          isDefault: false,
        });
      }
    }
  });

  if (creates.length > 0 && !creates.some((a) => a.isDefault)) {
    creates[0]!.isDefault = true;
  }

  return creates;
}

function printAnalyze(groups: CustomerGroup[], invalid: OldCustomerRow[]) {
  const multi = groups.filter((g) => g.rows.length > 1);
  const suffixRows = groups.flatMap((g) =>
    g.rows.filter((r) => {
      const m = resolveMark(r);
      return m?.suffix != null;
    }),
  );

  console.log("\n=== customer_id / customer_id_mark 分析 ===");
  console.log(`資料列總數：${groups.reduce((n, g) => n + g.rows.length, 0)}`);
  console.log(`邏輯客戶數（依 mark 基底合併後）：${groups.length}`);
  console.log(`多地址客戶（≥2 列）：${multi.length}`);
  console.log(`含 -N 後綴的 mark 列：${suffixRows.length}`);
  console.log(`無法解析編號的列：${invalid.length}`);

  if (multi.length > 0) {
    console.log("\n多地址客戶範例（前 10 組）：");
    for (const g of multi.slice(0, 10)) {
      console.log(`  [${g.customerCode}] ${g.rows.length} 址`);
      for (const r of g.rows) {
        const m = resolveMark(r);
        console.log(
          `    - customer_id=${r.customerId} mark=${r.customerIdMark} suffix=${m?.suffix ?? "主"} → ${r.customerAddress.slice(0, 36)}`,
        );
      }
    }
  } else {
    console.log(
      "\n目前資料檔中，每列 customer_id 與 customer_id_mark 相同，且沒有 310100-1 這類後綴。",
    );
    console.log("若舊系統有多地址客戶，請從資料庫重新匯出完整 customer 表（含 mark 後綴列）。");
  }
}

async function ensureMasterMaps(prisma: PrismaClient, rows: OldCustomerRow[]) {
  const zoneNames = new Set<string>();
  const companyNames = new Set<string>();

  for (const r of rows) {
    const fromAddr = extractZoneFromAddress(r.customerAddress);
    const fromCol = zoneLabelFromCode(r.areaId);
    const zone = fromCol ?? fromAddr;
    if (zone) zoneNames.add(zone);

    const co = companyLabel(r.company);
    if (co) companyNames.add(co);
  }

  let sort = 0;
  for (const name of [...zoneNames].sort()) {
    await prisma.addressZone.upsert({
      where: { name },
      create: { name, sortOrder: sort++, isActive: true },
      update: {},
    });
  }

  sort = 0;
  for (const name of [...companyNames].sort()) {
    await prisma.affiliatedCompany.upsert({
      where: { name },
      create: { name, sortOrder: sort++, isActive: true },
      update: {},
    });
  }

  const zones = await prisma.addressZone.findMany();
  const companies = await prisma.affiliatedCompany.findMany();
  return {
    zoneByName: new Map(zones.map((z) => [z.name, z.id])),
    companyByName: new Map(companies.map((c) => [c.name, c.id])),
  };
}

function resolveZoneId(row: OldCustomerRow, zoneByName: Map<string, bigint>): bigint | undefined {
  const fromCol = zoneLabelFromCode(row.areaId);
  const fromAddr = extractZoneFromAddress(row.customerAddress);
  const code = fromCol ?? fromAddr;
  if (!code) return undefined;
  return zoneByName.get(code);
}

function resolveCompanyId(
  row: OldCustomerRow,
  companyByName: Map<string, bigint>,
): bigint | undefined {
  const label = companyLabel(row.company);
  if (!label) return undefined;
  return companyByName.get(label);
}

async function deleteCustomersWithoutOrders(prisma: PrismaClient) {
  const orderCustomerIds = await prisma.salesOrder.findMany({
    select: { customerId: true },
    distinct: ["customerId"],
  });
  const protectedIds = orderCustomerIds.map((o) => o.customerId);
  const result = await prisma.customer.deleteMany({
    where: protectedIds.length > 0 ? { id: { notIn: protectedIds } } : {},
  });
  console.log(`已刪除 ${result.count} 筆客戶（保留 ${protectedIds.length} 筆有訂單的客戶）`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const analyzeOnly = args.includes("--analyze");
  const replace = args.includes("--replace");
  const fileArg = args.find((a) => a.startsWith("--file="));
  const filePath = path.resolve(
    process.cwd(),
    fileArg?.slice("--file=".length) ?? "scripts/customer_data.txt",
  );

  if (!fs.existsSync(filePath)) {
    console.error(`找不到資料檔：${filePath}`);
    process.exit(1);
  }

  const rows = readDataFile(filePath);
  const { groups, invalid } = groupRows(rows);

  console.log(`讀取 ${rows.length} 列 → ${groups.length} 個邏輯客戶（${filePath}）`);

  printAnalyze(groups, invalid);

  if (analyzeOnly) return;

  const prisma = new PrismaClient();
  try {
    if (replace && !dryRun) {
      await deleteCustomersWithoutOrders(prisma);
    }

    const allRows = groups.flatMap((g) => g.rows);
    const { zoneByName, companyByName } = dryRun
      ? { zoneByName: new Map<string, bigint>(), companyByName: new Map<string, bigint>() }
      : await ensureMasterMaps(prisma, allRows);

    const existingCodes = dryRun
      ? new Set<string>()
      : new Set(
          (await prisma.customer.findMany({ select: { customerCode: true } }))
            .map((c) => c.customerCode)
            .filter((c): c is string => !!c),
        );

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const group of groups) {
      const { customerCode, rows: groupRows } = group;
      if (existingCodes.has(customerCode)) {
        skipped++;
        continue;
      }

      const primary = groupRows[0]!;
      const name = normalizeCustomerName(primary.customerName);
      const phone = trimToNull(primary.customerPhone);
      const mobile = trimToNull(primary.customerTelephone);
      const contactName = trimToNull(primary.contactPerson);
      const taxId = normalizeTaxId(primary.customerInvoice);
      const defaultCashInvoiceMode = parseDefaultInvoice(primary.customerBillForm);
      const billingType = parseBillingType(primary.customerCollectMoney);
      const barrelsOnSite = Math.max(0, parseIntField(primary.customerBucket, 0));
      const prepaidBarrelBalance = parseIntField(primary.customerRemain, 0);
      const standingRemark = trimToNull(primary.customerRemark);
      const addressCreates = buildAddressesForGroup(groupRows);
      if (addressCreates.length > 0 && barrelsOnSite > 0) {
        const defaultIdx = Math.max(
          0,
          addressCreates.findIndex((a) => a.isDefault),
        );
        addressCreates[defaultIdx] = { ...addressCreates[defaultIdx]!, barrelsOnSite };
      }

      if (addressCreates.length === 0) {
        failed++;
        errors.push(`${customerCode}: 無有效地址`);
        continue;
      }

      if (dryRun) {
        created++;
        continue;
      }

      try {
        await prisma.customer.create({
          data: {
            customerCode,
            name,
            contactName: contactName ?? undefined,
            phone: phone ?? undefined,
            mobile: mobile ?? undefined,
            taxId: taxId ?? undefined,
            billingType,
            defaultCashInvoiceMode,
            addressZoneId: resolveZoneId(primary, zoneByName),
            affiliatedCompanyId: resolveCompanyId(primary, companyByName),
            standingRemark: standingRemark ?? undefined,
            prepaidBarrelBalance,
            addresses: { create: addressCreates },
          },
        });
        existingCodes.add(customerCode);
        created++;
        if (created % 200 === 0) console.log(`  已建立 ${created} 筆…`);
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${customerCode} ${name}: ${msg}`);
        if (errors.length > 50) break;
      }
    }

    console.log("\n完成");
    console.log(`  建立：${created}`);
    console.log(`  略過（編號已存在）：${skipped}`);
    console.log(`  失敗：${failed}`);
    if (invalid.length > 0) {
      console.log(`  無效列：${invalid.length}`);
    }
    if (errors.length > 0) {
      console.log("\n錯誤範例：");
      for (const e of errors.slice(0, 20)) console.log(`  - ${e}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
