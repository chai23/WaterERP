import type { PrismaClient } from "@prisma/client";
import { loadLegacyCustomers, groupRows, buildAddressesForGroup, normalizeCustomerName, trimToNull, normalizeTaxId, parseBillingType, parseDefaultInvoice, cleanAddressLine } from "./master-mapping.js";

/** Master fields only. Never writes opening balances, ledgers, orders or receipts. */
export async function syncLegacyMasters(legacy: PrismaClient, target: PrismaClient) {
  const rows = await loadLegacyCustomers(legacy);
  const { groups, invalid } = groupRows(rows);
  if (!groups.length) throw new Error("舊系統沒有可同步的客戶，未變更任何資料。");
  await target.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS legacy_id_map (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    entity_type VARCHAR(32) NOT NULL, legacy_key VARCHAR(100) NOT NULL,
    new_id BIGINT UNSIGNED NOT NULL, meta_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_legacy_map (entity_type, legacy_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  return target.$transaction(async tx => {
    // Serialize synchronization with the same row locks used by opening handover.
    await tx.$queryRaw`SELECT id FROM customers ORDER BY id FOR UPDATE`;
    const maps = await tx.$queryRaw<Array<{entity_type: string; legacy_key: string; new_id: bigint; meta_json: any}>>`SELECT entity_type, legacy_key, new_id, meta_json FROM legacy_id_map WHERE entity_type IN ('customer_code', 'customer_id', 'sync_address') FOR UPDATE`;
    const map = new Map(maps.map(m => [`${m.entity_type}:${m.legacy_key}`, m]));
    const result = { customersCreated: 0, customersUpdated: 0, addressesCreated: 0, addressesUpdated: 0, skipped: invalid.length, sourceCustomers: groups.length,
      issues: invalid.map(r => `${r.customerId || '無編號'}：編號格式、姓名或地址不完整`) };
    const put = async (kind: string, key: string, id: bigint, meta: object = {}) => {
      const json = JSON.stringify(meta);
      await tx.$executeRaw`INSERT INTO legacy_id_map (entity_type, legacy_key, new_id, meta_json) VALUES (${kind}, ${key}, ${id}, ${json}) ON DUPLICATE KEY UPDATE new_id=VALUES(new_id), meta_json=VALUES(meta_json)`;
    };
    for (const group of groups) {
      const p = group.rows[0]!;
      const existing = await tx.customer.findUnique({ where: { customerCode: group.customerCode }, include: { addresses: true } });
      const mapped = map.get(`customer_code:${group.customerCode}`);
      if (mapped && existing && mapped.new_id !== existing.id) throw new Error(`客戶 ${group.customerCode} 的舊新對照衝突，已取消整次同步。`);
      if (existing && !mapped && !group.rows.some(r => map.get(`customer_id:${r.customerId}`)?.new_id === existing.id)) {
        result.skipped++; result.issues.push(`${group.customerCode}：同編號客戶沒有舊新對照，保留新系統資料`); continue;
      }
      const data = { name: normalizeCustomerName(p.customerName), contactName: trimToNull(p.contactPerson), phone: trimToNull(p.customerPhone), mobile: trimToNull(p.customerTelephone), taxId: normalizeTaxId(p.customerInvoice), standingRemark: trimToNull(p.customerRemark) };
      const customer = existing
        ? await tx.customer.update({ where: { id: existing.id }, data })
        : await tx.customer.create({ data: { ...data, customerCode: group.customerCode, billingType: parseBillingType(p.customerCollectMoney), defaultCashInvoiceMode: parseDefaultInvoice(p.customerBillForm) } });
      if (existing) result.customersUpdated++; else result.customersCreated++;
      await put('customer_code', group.customerCode, customer.id);
      const addresses = existing?.addresses ?? [];
      const addressIds = new Map<string, bigint>();
      const usedIds = new Map<bigint, string>();
      for (const a of buildAddressesForGroup(group.rows)) {
        const oldMap = map.get(`customer_id:${a.legacyCustomerId}`);
        const meta = typeof oldMap?.meta_json === 'string' ? JSON.parse(oldMap.meta_json) : oldMap?.meta_json;
        const mappedId = map.get(`sync_address:${a.legacyCustomerId}`)?.new_id ?? (meta?.deliveryAddressId ? BigInt(meta.deliveryAddressId) : undefined);
        if (oldMap && oldMap.new_id !== customer.id) throw new Error(`客戶 ${group.customerCode} 地址對照衝突，已取消整次同步。`);
        const address = addresses.find(x => x.id === mappedId && (!usedIds.has(x.id) || usedIds.get(x.id) === a.data.addressLine)) ?? addresses.find(x => x.addressLine === a.data.addressLine);
        const fields = { label: a.data.label, addressLine: a.data.addressLine, contactName: a.data.contactName ?? null, contactPhone: a.data.contactPhone ?? null, contactMobile: a.data.contactMobile ?? null };
        const changedLocation = address && address.addressLine !== fields.addressLine;
        const saved = address
          ? await tx.deliveryAddress.update({ where: { id: address.id }, data: { ...fields, ...(changedLocation ? { latitude: null, longitude: null, geocodedAt: null, geocodedAddress: null, geocodeStatus: 'pending', locationAccuracy: null, manualLocationConfirmed: false } : {}) } })
          : await tx.deliveryAddress.create({ data: { ...fields, customerId: customer.id, isDefault: addresses.length === 0 } });
        if (address) result.addressesUpdated++; else { result.addressesCreated++; addresses.push(saved); }
        addressIds.set(fields.addressLine, saved.id);
        usedIds.set(saved.id, fields.addressLine);
        await put('sync_address', a.legacyCustomerId, saved.id);
      }
      for (const row of group.rows) await put('customer_id', row.customerId, customer.id, { customerCode: group.customerCode, deliveryAddressId: addressIds.get(cleanAddressLine(row.customerAddress))?.toString() });
    }
    return result;
  }, { timeout: 180000, maxWait: 10000, isolationLevel: 'Serializable' });
}
