import { Prisma, type PrismaClient } from "@prisma/client";
import {
  loadLegacyAreas,
  loadLegacyCustomers,
  groupRows,
  buildAddressesForGroup,
  normalizeCustomerName,
  trimToNull,
  normalizeTaxId,
  parseBillingType,
  parseDefaultInvoice,
  cleanAddressLine,
  resolveLegacyZoneKey,
  resolveCompanyLabel,
  companyLabel,
} from "./master-mapping.js";

type Tx = Prisma.TransactionClient;
type MapRow = { entity_type: string; legacy_key: string; new_id: bigint; meta_json: unknown };

async function referenceCount(tx: Tx, query: Prisma.Sql): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: bigint | number | null }>>(query);
  return Number(rows[0]?.n ?? 0);
}

function addressIsReferenced(tx: Tx, id: bigint): Promise<number> {
  return referenceCount(tx, Prisma.sql`
    SELECT (
      (SELECT COUNT(*) FROM sales_orders WHERE delivery_address_id = ${id}) +
      (SELECT COUNT(*) FROM barrel_pickups WHERE delivery_address_id = ${id}) +
      (SELECT COUNT(*) FROM barrel_movements WHERE delivery_address_id = ${id}) +
      (SELECT COUNT(*) FROM service_tickets WHERE delivery_address_id = ${id})
    ) AS n`);
}

function customerIsReferenced(tx: Tx, id: bigint): Promise<number> {
  return referenceCount(tx, Prisma.sql`
    SELECT (
      (SELECT COUNT(*) FROM sales_orders WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM payments WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM customer_ledger_entries WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM ar_documents WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM ar_open_items WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM receipt_vouchers WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM prepayment_txns WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM credit_notes WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM billing_statements WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM cutover_monthly_items WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM tax_invoices WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM barrel_pickups WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM barrel_movements WHERE customer_id = ${id}) +
      (SELECT COUNT(*) FROM service_tickets WHERE customer_id = ${id})
    ) AS n`);
}

/** Master fields only. Never writes opening balances, ledgers, orders or receipts. */
export async function syncLegacyMasters(legacy: PrismaClient, target: PrismaClient) {
  const [rows, areas] = await Promise.all([loadLegacyCustomers(legacy), loadLegacyAreas(legacy)]);
  const { groups, invalid } = groupRows(rows);
  if (!groups.length) throw new Error("舊系統沒有可同步的客戶，未變更任何資料。");
  await target.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS legacy_id_map (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    entity_type VARCHAR(32) NOT NULL, legacy_key VARCHAR(100) NOT NULL,
    new_id BIGINT UNSIGNED NOT NULL, meta_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_legacy_map (entity_type, legacy_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  return target.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM customers ORDER BY id FOR UPDATE`;
    const maps = await tx.$queryRaw<MapRow[]>`SELECT entity_type, legacy_key, new_id, meta_json FROM legacy_id_map WHERE entity_type IN ('customer_code', 'customer_id', 'sync_address', 'area', 'affiliated_company') FOR UPDATE`;
    const map = new Map(maps.map((m) => [`${m.entity_type}:${m.legacy_key}`, m]));
    const result = {
      customersCreated: 0,
      customersUpdated: 0,
      customersDeleted: 0,
      addressesCreated: 0,
      addressesUpdated: 0,
      addressesDeleted: 0,
      skipped: invalid.length,
      sourceCustomers: groups.length,
      issues: invalid.map((r) => `${r.customerId || "無編號"}：編號格式、姓名或地址不完整`),
    };
    const put = async (kind: string, key: string, id: bigint, meta: object = {}) => {
      const json = JSON.stringify(meta);
      await tx.$executeRaw`INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json) VALUES (${kind}, ${key}, ${id}, ${json}) ON DUPLICATE KEY UPDATE new_id=VALUES(new_id), meta_json=VALUES(meta_json)`;
    };

    const zoneByLegacy = new Map<string, bigint>();
    for (const area of areas) {
      const existingZone = await tx.addressZone.findUnique({ where: { name: area.areaName } });
      const zone = existingZone
        ? await tx.addressZone.update({ where: { id: existingZone.id }, data: { isActive: true } })
        : await tx.addressZone.create({ data: { name: area.areaName, sortOrder: zoneByLegacy.size, isActive: true } });
      zoneByLegacy.set(area.areaId, zone.id);
      await put("area", area.areaId, zone.id, { name: area.areaName });
    }
    const companyNames = new Set<string>();
    for (const group of groups) {
      for (const row of group.rows) {
        const label = companyLabel(row.company);
        if (label) companyNames.add(label);
      }
    }
    const companyByName = new Map<string, bigint>();
    for (const name of [...companyNames].sort()) {
      const existingCompany = await tx.affiliatedCompany.findUnique({ where: { name } });
      const company = existingCompany
        ? await tx.affiliatedCompany.update({ where: { id: existingCompany.id }, data: { isActive: true } })
        : await tx.affiliatedCompany.create({ data: { name, sortOrder: companyByName.size, isActive: true } });
      companyByName.set(name, company.id);
      await put("affiliated_company", name, company.id);
    }

    const liveCodes = new Set(groups.map((g) => g.customerCode));
    for (const group of groups) {
      const p = group.rows[0]!;
      const existing = await tx.customer.findUnique({ where: { customerCode: group.customerCode }, include: { addresses: true } });
      const mapped = map.get(`customer_code:${group.customerCode}`);
      if (mapped && existing && mapped.new_id !== existing.id) throw new Error(`客戶 ${group.customerCode} 的舊新對照衝突，已取消整次同步。`);
      if (existing && !mapped && !group.rows.some((r) => map.get(`customer_id:${r.customerId}`)?.new_id === existing.id)) {
        result.skipped++;
        result.issues.push(`${group.customerCode}：同編號客戶沒有舊新對照，保留新系統資料`);
        continue;
      }
      const zoneKey = resolveLegacyZoneKey(group.rows);
      const companyName = resolveCompanyLabel(group.rows);
      const data = {
        name: normalizeCustomerName(p.customerName),
        contactName: trimToNull(p.contactPerson),
        phone: trimToNull(p.customerPhone),
        mobile: trimToNull(p.customerTelephone),
        taxId: normalizeTaxId(p.customerInvoice),
        standingRemark: trimToNull(p.customerRemark),
        addressZoneId: zoneKey ? zoneByLegacy.get(zoneKey) ?? null : null,
        affiliatedCompanyId: companyName ? companyByName.get(companyName) ?? null : null,
      };
      const customer = existing
        ? await tx.customer.update({ where: { id: existing.id }, data })
        : await tx.customer.create({
            data: {
              ...data,
              customerCode: group.customerCode,
              billingType: parseBillingType(p.customerCollectMoney),
              defaultCashInvoiceMode: parseDefaultInvoice(p.customerBillForm),
            },
          });
      if (existing) result.customersUpdated++;
      else result.customersCreated++;
      await put("customer_code", group.customerCode, customer.id);
      const addresses = existing?.addresses ?? [];
      const addressIds = new Map<string, bigint>();
      const usedIds = new Map<bigint, string>();
      const liveSyncKeys: string[] = [];
      for (const a of buildAddressesForGroup(group.rows)) {
        liveSyncKeys.push(a.legacyCustomerId);
        const oldMap = map.get(`customer_id:${a.legacyCustomerId}`);
        const meta = typeof oldMap?.meta_json === "string" ? JSON.parse(oldMap.meta_json) : oldMap?.meta_json;
        const mappedId = map.get(`sync_address:${a.legacyCustomerId}`)?.new_id ?? (meta?.deliveryAddressId ? BigInt(meta.deliveryAddressId) : undefined);
        if (oldMap && oldMap.new_id !== customer.id) throw new Error(`客戶 ${group.customerCode} 地址對照衝突，已取消整次同步。`);
        const address = addresses.find((x) => x.id === mappedId && (!usedIds.has(x.id) || usedIds.get(x.id) === a.data.addressLine)) ?? addresses.find((x) => x.addressLine === a.data.addressLine && !usedIds.has(x.id));
        const fields = { label: a.data.label, addressLine: a.data.addressLine, contactName: a.data.contactName ?? null, contactPhone: a.data.contactPhone ?? null, contactMobile: a.data.contactMobile ?? null };
        const changedLocation = address && address.addressLine !== fields.addressLine;
        const saved = address
          ? await tx.deliveryAddress.update({ where: { id: address.id }, data: { ...fields, ...(changedLocation ? { latitude: null, longitude: null, geocodedAt: null, geocodedAddress: null, geocodeStatus: "pending", locationAccuracy: null, manualLocationConfirmed: false } : {}) } })
          : await tx.deliveryAddress.create({ data: { ...fields, customerId: customer.id, isDefault: addresses.length === 0 } });
        if (address) result.addressesUpdated++;
        else {
          result.addressesCreated++;
          addresses.push(saved);
        }
        addressIds.set(fields.addressLine, saved.id);
        usedIds.set(saved.id, fields.addressLine);
        await put("sync_address", a.legacyCustomerId, saved.id);
      }
      const removedIds: bigint[] = [];
      for (const address of [...addresses]) {
        if (usedIds.has(address.id)) continue;
        if (await addressIsReferenced(tx, address.id)) {
          result.skipped++;
          result.issues.push(`${group.customerCode}：地址「${address.addressLine}」舊系統已不存在，但新系統已有訂單或服務紀錄，無法刪除`);
          continue;
        }
        await tx.deliveryAddress.delete({ where: { id: address.id } });
        await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'sync_address' AND new_id = ${address.id}`;
        removedIds.push(address.id);
        result.addressesDeleted++;
      }
      const kept = addresses.filter((a) => !removedIds.some((id) => id === a.id));
      if (kept.length > 0 && !kept.some((a) => a.isDefault)) {
        await tx.deliveryAddress.update({ where: { id: kept[0]!.id }, data: { isDefault: true } });
      }
      const liveLegacyIds = group.rows.map((r) => r.customerId.trim());
      await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'customer_id' AND new_id = ${customer.id} AND legacy_key NOT IN (${Prisma.join(liveLegacyIds)})`;
      const keptIds = kept.map((a) => a.id);
      if (keptIds.length > 0 && liveSyncKeys.length > 0) {
        await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'sync_address' AND new_id IN (${Prisma.join(keptIds)}) AND legacy_key NOT IN (${Prisma.join(liveSyncKeys)})`;
      }
      for (const row of group.rows) {
        await put("customer_id", row.customerId, customer.id, { customerCode: group.customerCode, deliveryAddressId: addressIds.get(cleanAddressLine(row.customerAddress))?.toString() });
      }
    }

    for (const m of maps) {
      if (m.entity_type !== "customer_code" || liveCodes.has(m.legacy_key)) continue;
      const customer = await tx.customer.findUnique({ where: { id: m.new_id }, include: { addresses: true } });
      if (!customer || customer.customerCode !== m.legacy_key) {
        await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'customer_code' AND legacy_key = ${m.legacy_key} AND new_id = ${m.new_id}`;
        continue;
      }
      const blockedCustomer = await customerIsReferenced(tx, customer.id);
      let blockedAddress = false;
      if (!blockedCustomer) {
        for (const address of customer.addresses) {
          if (await addressIsReferenced(tx, address.id)) {
            blockedAddress = true;
            break;
          }
        }
      }
      if (blockedCustomer || blockedAddress) {
        result.skipped++;
        result.issues.push(`${customer.customerCode}：舊系統已刪除，但新系統已有訂單或帳務，無法刪除`);
        continue;
      }
      if (customer.addresses.length > 0) {
        await tx.deliveryAddress.deleteMany({ where: { customerId: customer.id } });
        await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'sync_address' AND new_id IN (${Prisma.join(customer.addresses.map((a) => a.id))})`;
        result.addressesDeleted += customer.addresses.length;
      }
      await tx.customer.delete({ where: { id: customer.id } });
      await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'customer_code' AND legacy_key = ${m.legacy_key}`;
      await tx.$executeRaw`DELETE FROM legacy_id_map WHERE entity_type = 'customer_id' AND new_id = ${customer.id}`;
      result.customersDeleted++;
    }
    return result;
  }, { timeout: 180000, maxWait: 10000, isolationLevel: "Serializable" });
}
