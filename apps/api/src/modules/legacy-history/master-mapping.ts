import type { Prisma, PrismaClient } from "@prisma/client";
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

export function trimToNull(s: string | undefined | null): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
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
  if (!parsed || parsed.baseDigits.length > 6) return null;
  return normalizeCustomerCode(parsed.baseDigits);
}

export function normalizeCustomerName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/\s*[\(（][^)）]{4,}[\)）]\s*$/u, "").trim();
  return name || raw.trim();
}

export function parseDefaultInvoice(raw: string): CashInvoiceMode {
  const s = raw.trim();
  if (!s || s === "不開") return "none";
  if (s.includes("含稅")) return "tax_inclusive";
  if (s.includes("未稅")) return "tax_exclusive";
  return "none";
}

export function parseBillingType(raw: string): BillingType {
  const s = raw.trim();
  if (s === "月結") return "monthly";
  if (s === "預收") return "prepaid";
  return "cash";
}

export function normalizeTaxId(raw: string): string | null {
  const s = trimToNull(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

export function companyLabel(raw: string | undefined | null): string | null {
  const c = trimToNull(raw);
  if (!c || c === "尚未分配") return null;
  return c.slice(0, 200);
}

/** 主地址優先；主地址未分區時才用其他地址的分區。99 是舊系統的尚未分配。 */
export function resolveLegacyZoneKey(rows: Array<{ areaId: string; areaId2: string }>): string | null {
  for (const row of rows) {
    for (const raw of [row.areaId, row.areaId2]) {
      const key = String(raw ?? "").trim();
      if (!key || key === "99") continue;
      return key;
    }
  }
  return null;
}

export function resolveCompanyLabel(rows: Array<{ company: string }>): string | null {
  for (const row of rows) {
    const label = companyLabel(row.company);
    if (label) return label;
  }
  return null;
}

export type LegacyArea = { areaId: string; areaName: string };

export async function loadLegacyAreas(legacy: PrismaClient): Promise<LegacyArea[]> {
  const raw = await legacy.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT area_id, area_name FROM area ORDER BY area_id`,
  );
  const areas: LegacyArea[] = [];
  for (const r of raw) {
    const areaId = String(r.area_id ?? "").trim();
    if (!areaId || areaId === "99") continue;
    const areaName = (trimToNull(String(r.area_name ?? "")) ?? areaId).slice(0, 50);
    areas.push({ areaId, areaName });
  }
  return areas;
}

export function cleanAddressLine(raw: string): string {
  let addr = raw.trim();
  addr = addr.replace(/^[\{（(]\d{1,2}[\}）)]\s*/u, "");
  return addr.trim() || raw.trim();
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

export function groupRows(rows: OldCustomerRow[]): { groups: CustomerGroup[]; invalid: OldCustomerRow[] } {
  const map = new Map<string, OldCustomerRow[]>();
  const invalid: OldCustomerRow[] = [];
  for (const row of rows) {
    const code = groupKeyForRow(row);
    if (!code || !row.customerId || !row.customerName || !row.customerAddress) {
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

export function buildAddressesForGroup(rows: OldCustomerRow[]) {
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

export async function loadLegacyCustomers(legacy: PrismaClient): Promise<OldCustomerRow[]> {
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


