import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

type DB = PrismaClient | Prisma.TransactionClient;
export type HandoverOrder = {
  id: string; day: string; amount: number; received: number; outstanding: number;
  completed: boolean; billing: string; disposition: "cash" | "monthly_billed" | "monthly_pending" | "exclude";
  finalAmount: number; dueDate: string; invoiceMode: "none" | "tax_inclusive" | "tax_exclusive"; note: string;
  arDocumentId?: string; arNo?: string;
};
export type HandoverRow = {
  key: string; code: string; name: string; customerId: string | null; included: boolean;
  warnings: string[]; reviewed: boolean; note: string; prepayment: number | null;
  prepaidBarrels: number; sourcePrepaidBarrels: number;
  addresses: { id: string; label: string; barrels: number; original: number }[];
  legacyBarrels: number; orders: HandoverOrder[];
};
export type HandoverSnapshot = {
  startDate: string; cutoffDate: string; capturedAt: string; sourceHash: string; targetHash: string;
  sourceFrozen: boolean; totalsConfirmed: boolean; rows: HandoverRow[]; blockers: string[];
};
type Stored = { revision: number; status: string; snapshot: HandoverSnapshot | null; appliedAt: string | null };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x)).digest("hex");
const code = (v: unknown) => {
  const s = String(v ?? "").trim();
  const match = s.match(/^(\d{1,6})(?:-\d+)?$/);
  return match ? match[1]!.padStart(6, "0") : null;
};
const num = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (s && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) throw new Error(`舊資料有無法辨識的數字：${s.slice(0, 40)}`);
  return Number(s || 0);
};
const day = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);
export function validDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}
const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 999999999999.99 && Math.abs(v * 100 - Math.round(v * 100)) < 0.001;
const whole = (v: unknown, negative = false) => typeof v === "number" && Number.isInteger(v) && v >= (negative ? -2147483648 : 0) && v <= 2147483647;
const round = (v: number) => Math.round(v * 100) / 100;

export async function readHandover(db: DB, lock = false): Promise<Stored> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT revision, status, snapshot, applied_at FROM cutover_handover WHERE id=1${lock ? " FOR UPDATE" : ""}`);
  if (!rows[0]) throw new Error("請先執行資料庫結構升級（004_cutover_handover）");
  const r = rows[0];
  return { revision: r.revision, status: r.status, snapshot: typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot, appliedAt: r.applied_at?.toISOString() ?? null };
}

async function targetState(db: DB) {
  const customers = await db.customer.findMany({ orderBy: { id: "asc" }, include: {
    addresses: { orderBy: { id: "asc" } }, prepaymentWallet: true,
    _count: { select: { salesOrders: true, ledgerEntries: true, prepaymentTxns: true, arDocuments: true, receiptVouchers: true, barrelMovements: true, prepaidProductBalances: true } },
  } });
  const maps = await db.$queryRawUnsafe<any[]>("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='legacy_id_map'");
  const old = maps.length ? await db.$queryRawUnsafe<any[]>("SELECT legacy_key, new_id FROM legacy_id_map WHERE entity_type='opening_ar' ORDER BY legacy_key") : [];
  return { customers, old };
}

async function sourceState(legacy: PrismaClient, startDate: string) {
  // A dated, frozen legacy snapshot is required: a current paid flag cannot reconstruct historical cash receipts.
  return legacy.$transaction(async tx => {
    const customers = await tx.$queryRawUnsafe<any[]>("SELECT customer_id, customer_id_mark, customer_name, customer_bucket, customer_remain FROM customer ORDER BY customer_id");
    const orders = await tx.$queryRawUnsafe<any[]>("SELECT order_id, customer_id, order_day, order_OK, collect_OK, collect_money, subtotal FROM `order` WHERE order_day < ? OR order_day IS NULL ORDER BY order_id, customer_id, subtotal", startDate);
    const receipts = await tx.$queryRawUnsafe<any[]>("SELECT order_id, remittance_day, money FROM remittance_list ORDER BY order_id, remittance_day, money");
    return { customers, orders, receipts };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60000 });
}

export async function buildHandover(legacy: PrismaClient, target: PrismaClient, startDate: string): Promise<HandoverSnapshot> {
  if (!validDay(startDate)) throw new Error("請輸入有效的啟用日期");
  const cutoffDate = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const source = await sourceState(legacy, startDate);
  const state = await targetState(target);
  const blockers: string[] = [];
  if (state.old.length) blockers.push("已有舊版切換日開帳紀錄，請先核對並處理既有期初帳，不能重複交接。");
  const byCode = new Map(state.customers.map(c => [c.customerCode, c]));
  const byTargetId = new Map(state.customers.map(c => [c.id.toString(), c]));
  const rows = new Map<string, HandoverRow>();
  const customerKeys = new Map<string, string>();
  const markKeys = new Map<string, string>();
  // Same primary/address convention as migrate-legacy-masters; primary balances precede branches.
  const orderedCustomers = [...source.customers].sort((a, b) => Number(/-\d+$/.test(String(a.customer_id_mark || a.customer_id))) - Number(/-\d+$/.test(String(b.customer_id_mark || b.customer_id))));
  for (const c of orderedCustomers) {
    const id = String(c.customer_id).trim();
    const customerCode = code(c.customer_id_mark) ?? code(id);
    const key = customerCode ?? `unmapped:${id}`;
    customerKeys.set(id, key);
    const mark = String(c.customer_id_mark ?? "").trim();
    if (mark) {
      if (markKeys.has(mark) && markKeys.get(mark) !== key) blockers.push(`舊客戶代號 ${mark} 有多個對應，請先核對主檔。`);
      else markKeys.set(mark, key);
    }
    const existing = rows.get(key);
    if (existing) {
      existing.warnings.push(`同一客戶代號有多筆舊主檔（${id}），請核對預付桶及各地址空桶。`);
      existing.legacyBarrels += num(c.customer_bucket);
      continue;
    }
    const targetCustomer = byCode.get(customerCode ?? "");
    const prepaid = num(c.customer_remain);
    const barrels = num(c.customer_bucket);
    const addresses = targetCustomer?.addresses.map(a => ({ id: a.id.toString(), label: a.addressLine, original: a.barrelsOnSite, barrels: a.barrelsOnSite })) ?? [];
    if (addresses.length === 1) addresses[0]!.barrels = barrels;
    const warnings: string[] = [];
    if (!targetCustomer) warnings.push("尚未對應新系統客戶；請先轉換主檔，或排除並記錄原因。");
    if (addresses.length > 1) warnings.push("有多個配送地址，請按地址核對空桶，不會把合計塞入預設地址。");
    if (!addresses.length && barrels !== 0) warnings.push("有空桶但沒有配送地址；請先補上地址。");
    rows.set(key, { key, code: customerCode ?? id, name: targetCustomer?.name ?? String(c.customer_name ?? id),
      customerId: targetCustomer?.id.toString() ?? null, included: true, warnings, reviewed: false, note: "", prepayment: null,
      prepaidBarrels: prepaid, sourcePrepaidBarrels: prepaid, legacyBarrels: barrels, addresses, orders: [] });
  }
  const receipts = new Map<string, { before: number; after: boolean; unknown: boolean }>();
  for (const r of source.receipts) {
    const id = String(r.order_id ?? "").trim();
    const acc = receipts.get(id) ?? { before: 0, after: false, unknown: false };
    const d = day(r.remittance_day);
    if (!validDay(d)) acc.unknown = true;
    else if (d >= startDate) acc.after = true;
    else acc.before = round(acc.before + num(r.money));
    receipts.set(id, acc);
  }
  const grouped = new Map<string, any[]>();
  for (const o of source.orders) {
    const id = String(o.order_id ?? "").trim();
    if (!id) { blockers.push("舊訂單缺少單號，請先修正來源資料。"); continue; }
    const group = grouped.get(id) ?? []; group.push(o); grouped.set(id, group);
  }
  for (const [id, lines] of grouped) {
    const first = lines[0];
    const r = receipts.get(id);
    if (r?.after) blockers.push(`舊單 ${id} 有截止日以後的收款，請使用截止日凍結備份或調整啟用日。`);
    const completed = lines.every(l => String(l.order_OK).trim() === "True");
    if (completed && lines.every(l => String(l.collect_OK).trim() === "True") && !r?.after) continue;
    const customerId = String(first.customer_id ?? "").trim();
    const key = customerKeys.get(customerId) ?? markKeys.get(customerId);
    const row = key ? rows.get(key) : undefined;
    if (!row) { blockers.push(`舊單 ${id} 找不到客戶主檔 ${customerId}`); continue; }
    if (lines.some(l => String(l.customer_id).trim() !== customerId)) blockers.push(`舊單 ${id} 對應多位客戶，不能自動沖帳。`);
    const amount = round(lines.reduce((s, l) => s + num(l.subtotal), 0));
    const received = r?.before ?? 0;
    const outstanding = round(amount - received);
    if (outstanding === 0 && completed) continue;
    if (r?.unknown) row.warnings.push(`舊單 ${id} 有無日期收款，請人工核對剩餘金額。`);
    if (lines.some(l => String(l.collect_OK).trim() === "True")) row.warnings.push(`舊單 ${id} 明細收款狀態不一致，請核對。`);
    const billing = String(first.collect_money ?? "").trim();
    if (lines.some(l => String(l.collect_money ?? "").trim() !== billing)) row.warnings.push(`舊單 ${id} 有混合結帳方式，請先拆分來源或排除後另外處理。`);
    const d = day(first.order_day);
    if (!validDay(d)) row.warnings.push(`舊單 ${id} 無有效日期，請核對並填入到期日。`);
    if (billing === "預收") row.warnings.push(`舊單 ${id} 為預收類型，請判斷是未收儲值款或已扣預付桶；不能直接視為欠款。`);
    if (!completed) row.warnings.push(`舊單 ${id} 未完成配送，預設排除；請記錄移交處理方式。`);
    if (outstanding < 0) row.warnings.push(`舊單 ${id} 溢收 ${-outstanding}，請核對後納入金額預收，不會自動抵銷其他欠款。`);
    row.orders.push({ id, day: validDay(d) ? d : cutoffDate, amount, received, outstanding, completed, billing,
      disposition: !completed || outstanding < 0 ? "exclude" : billing === "月結" ? "monthly_pending" : "cash",
      finalAmount: Math.max(0, outstanding), dueDate: startDate, invoiceMode: "none", note: "" });
  }
  for (const row of rows.values()) {
    const c = row.customerId ? byTargetId.get(row.customerId) : null;
    if (c && (Object.values(c._count).some(n => n > 0) || Number(c.prepaymentWallet?.balanceAmount ?? 0) !== 0)) {
      row.warnings.push("新系統已有交易或商品預付餘額：不得以期初覆蓋，請排除並另行對帳。");
    }
  }
  return { startDate, cutoffDate, capturedAt: new Date().toISOString(), sourceHash: hash(source), targetHash: hash(state),
    sourceFrozen: false, totalsConfirmed: false, rows: [...rows.values()].sort((a, b) => a.code.localeCompare(b.code)), blockers: [...new Set(blockers)] };
}

export function totals(snapshot: HandoverSnapshot) {
  const result = { customers: 0, cash: 0, monthlyBilled: 0, monthlyPending: 0, prepayment: 0, prepaidBarrels: 0, barrels: 0, excluded: 0 };
  for (const r of snapshot.rows) {
    if (!r.included) { result.excluded++; continue; }
    result.customers++;
    result.prepayment = round(result.prepayment + (r.prepayment ?? 0));
    result.prepaidBarrels += r.prepaidBarrels;
    result.barrels += r.addresses.reduce((s, a) => s + a.barrels, 0);
    for (const o of r.orders) {
      const key = o.disposition === "cash" ? "cash" : o.disposition === "monthly_billed" ? "monthlyBilled" : o.disposition === "monthly_pending" ? "monthlyPending" : null;
      if (key) result[key] = round(result[key] + o.finalAmount);
    }
  }
  return result;
}

// Only editable fields are accepted. Source IDs, mappings, hashes and evidence stay server-owned.
export function mergeDraft(original: HandoverSnapshot, input: any): HandoverSnapshot {
  if (!Array.isArray(input?.rows) || input.rows.length !== original.rows.length) throw new Error("交接客戶清單不完整，請重新載入");
  const next = structuredClone(original);
  const edits = new Map(input.rows.map((r: any) => [r.key, r]));
  if (edits.size !== original.rows.length) throw new Error("交接客戶重複");
  next.sourceFrozen = input.sourceFrozen === true;
  next.totalsConfirmed = input.totalsConfirmed === true;
  for (const r of next.rows) {
    const edit: any = edits.get(r.key);
    if (!edit || typeof edit.included !== "boolean" || typeof edit.note !== "string" || edit.note.length > 400) throw new Error("客戶編輯格式錯誤");
    r.included = edit.included; r.note = edit.note.trim(); r.reviewed = edit.reviewed === true;
    if (edit.prepayment !== null && !money(edit.prepayment)) throw new Error(`${r.code} 預收金額須為非負數、最多兩位小數`);
    if (!whole(edit.prepaidBarrels, true)) throw new Error(`${r.code} 預付桶數須為整數`);
    r.prepayment = edit.prepayment; r.prepaidBarrels = edit.prepaidBarrels;
    if (!Array.isArray(edit.addresses) || edit.addresses.length !== r.addresses.length || new Set(edit.addresses.map((a: any) => a.id)).size !== r.addresses.length) throw new Error("地址清單不完整");
    for (const a of r.addresses) {
      const e = edit.addresses.find((x: any) => x.id === a.id);
      if (!e || !whole(e.barrels)) throw new Error(`${r.code} 空桶數須為非負整數`);
      a.barrels = e.barrels;
    }
    if (!Array.isArray(edit.orders) || edit.orders.length !== r.orders.length || new Set(edit.orders.map((o: any) => o.id)).size !== r.orders.length) throw new Error("舊單清單不完整");
    for (const o of r.orders) {
      const e = edit.orders.find((x: any) => x.id === o.id);
      if (!e || !["cash", "monthly_billed", "monthly_pending", "exclude"].includes(e.disposition) || !money(e.finalAmount) || !validDay(e.dueDate) || !["none", "tax_inclusive", "tax_exclusive"].includes(e.invoiceMode) || typeof e.note !== "string" || e.note.length > 400) throw new Error(`${r.code} 舊單 ${o.id} 格式錯誤`);
      Object.assign(o, { disposition: e.disposition, finalAmount: e.finalAmount, dueDate: e.dueDate, invoiceMode: e.invoiceMode, note: e.note.trim() });
    }
  }
  return next;
}

export function validationErrors(s: HandoverSnapshot): string[] {
  const errors = [...s.blockers];
  if (!s.sourceFrozen) errors.push("請確認舊系統資料已凍結於截止日，現金收款與桶數均已核對。");
  if (!s.totalsConfirmed) errors.push("請核對並確認各類交接總額。");
  if (!s.rows.some(r => r.included)) errors.push("至少需有一位交接客戶。");
  for (const r of s.rows) {
    const prefix = `${r.code} ${r.name}：`;
    if (!r.included) { if (!r.note) errors.push(prefix + "排除客戶須填寫原因及後續處理方式"); continue; }
    if (!r.customerId) errors.push(prefix + "尚未對應客戶");
    if (!r.reviewed) errors.push(prefix + "尚未確認交接內容");
    if (r.prepayment === null) errors.push(prefix + "請填寫金額預收（沒有則填 0）");
    if (r.warnings.length && !r.note) errors.push(prefix + "請填寫異常核對說明");
    if (r.warnings.some(w => w.startsWith("新系統已有交易"))) errors.push(prefix + "已有新系統交易，不能覆蓋期初");
    if (r.addresses.length === 0 && r.legacyBarrels !== 0) errors.push(prefix + "請先補上配送地址");
    if ((r.prepaidBarrels !== r.sourcePrepaidBarrels || r.addresses.reduce((s, a) => s + a.barrels, 0) !== r.legacyBarrels) && !r.note) errors.push(prefix + "桶數與舊資料不同，須填寫原因");
    for (const o of r.orders) {
      if ((o.disposition === "exclude" || o.finalAmount !== o.outstanding || (o.billing === "月結" && o.disposition === "cash") || (o.billing !== "月結" && o.disposition.startsWith("monthly"))) && !o.note) errors.push(prefix + `舊單 ${o.id} 排除或調整須填寫原因`);
      if (!o.completed && o.disposition !== "exclude") errors.push(prefix + `舊單 ${o.id} 未完成配送，請作待辦訂單移交`);
      if (o.disposition === "monthly_pending" && o.received !== 0) errors.push(prefix + `舊單 ${o.id} 已有部分收款，請先完成舊系統結帳，以已出帳餘額承接`);
      if (o.disposition !== "exclude" && o.finalAmount <= 0) errors.push(prefix + `舊單 ${o.id} 金額為零，請選擇排除並註明原因`);
    }
  }
  return errors;
}

export async function saveHandover(target: PrismaClient, revision: number, snapshot: HandoverSnapshot, userId: bigint) {
  return target.$transaction(async tx => {
    const current = await readHandover(tx, true);
    if (current.status === "applied") throw new Error("交接已啟用，不能覆寫或重新產生");
    if (current.revision !== revision) throw new Error("交接草稿已被其他人更新，請重新載入");
    await tx.$executeRaw`UPDATE cutover_handover SET revision=revision+1, status='draft', snapshot=${JSON.stringify(snapshot)}, created_by=${userId}, updated_at=UTC_TIMESTAMP(3) WHERE id=1`;
    return readHandover(tx);
  });
}

export async function applyHandover(legacy: PrismaClient, target: PrismaClient, revision: number, userId: bigint) {
  const stored = await readHandover(target);
  if (stored.status === "applied") return stored;
  if (stored.revision !== revision || !stored.snapshot) throw new Error("草稿版本已變更，請重新載入");
  const s = stored.snapshot;
  const errors = validationErrors(s);
  if (errors.length) throw new Error(errors.slice(0, 12).join("\n"));
  if (hash(await sourceState(legacy, s.startDate)) !== s.sourceHash) throw new Error("舊資料自建立草稿後已變動，請重新產生及核對草稿");
  return target.$transaction(async tx => {
    const current = await readHandover(tx, true);
    if (current.status === "applied") return current;
    if (current.revision !== revision) throw new Error("草稿已被更新，請重新載入");
    // Lock customer and address rows before checking the target snapshot and writing balances.
    await tx.$queryRaw`SELECT id FROM customers ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM delivery_addresses ORDER BY id FOR UPDATE`;
    if (hash(await targetState(tx)) !== s.targetHash) throw new Error("新系統主檔或交易已變動，請重新產生草稿；不會覆蓋目前餘額");
    for (const r of s.rows.filter(r => r.included)) {
      const customerId = BigInt(r.customerId!);
      for (const o of r.orders) {
        if (o.disposition === "exclude") continue;
        const amount = new Prisma.Decimal(o.finalAmount.toFixed(2));
        if (o.disposition === "monthly_pending") {
          const note = JSON.stringify({ invoiceMode: o.invoiceMode, note: o.note });
          await tx.$executeRaw`INSERT INTO cutover_monthly_items(source_key, customer_id, order_day, amount, note) VALUES (${o.id}, ${customerId}, ${o.day}, ${amount}, ${note})`;
          continue;
        }
        const dueDate = new Date(`${o.dueDate}T00:00:00Z`);
        const ar = await tx.arDocument.create({ data: { arNo: `AROB${randomUUID().replace(/-/g, "")}`, customerId,
          documentType: "opening_balance", billingType: o.disposition === "monthly_billed" ? "monthly" : "cash", documentAmount: amount,
          dueDate, postedAt: new Date(`${s.startDate}T00:00:00+08:00`), createdByUserId: userId } });
        o.arDocumentId = ar.id.toString(); o.arNo = ar.arNo;
        await tx.arOpenItem.create({ data: { arDocumentId: ar.id, customerId, originalAmount: amount, outstandingAmount: amount, dueDate, expectedCollectDate: dueDate } });
        await tx.customerLedgerEntry.create({ data: { customerId, entryType: "cutover_opening", amount, sourceType: "cutover", sourceId: 1n,
          note: `舊單 ${o.id}／到期 ${o.dueDate}／${o.note}`.slice(0, 500), createdByUserId: userId } });
      }
      const prepayment = new Prisma.Decimal(r.prepayment!.toFixed(2));
      if (prepayment.greaterThan(0)) {
        await tx.customerPrepaymentWallet.upsert({ where: { customerId }, create: { customerId, balanceAmount: prepayment }, update: { balanceAmount: prepayment } });
        await tx.prepaymentTxn.create({ data: { customerId, txnType: "opening_balance", amount: prepayment, balanceAfter: prepayment, note: `上線交接 ${s.startDate}；${r.note}`.slice(0, 500) } });
        await tx.customerLedgerEntry.create({ data: { customerId, entryType: "cutover_prepayment", amount: prepayment.negated(), sourceType: "cutover", sourceId: 1n, note: "金額預收期初（不自動抵銷欠款）", createdByUserId: userId } });
      }
      await tx.customer.update({ where: { id: customerId }, data: { prepaidBarrelBalance: r.prepaidBarrels } });
      await tx.customerLedgerEntry.create({ data: { customerId, entryType: "cutover_prepaid_barrels", barrelDelta: r.prepaidBarrels, sourceType: "cutover", sourceId: 1n, note: `預付桶期初；${r.note}`.slice(0, 500), createdByUserId: userId } });
      for (const a of r.addresses) {
        await tx.deliveryAddress.update({ where: { id: BigInt(a.id) }, data: { barrelsOnSite: a.barrels } });
        await tx.customerLedgerEntry.create({ data: { customerId, entryType: "cutover_site_barrels", sourceType: "cutover", sourceId: 1n, note: `地址 ${a.id} 空桶期初 ${a.barrels}（主檔原值 ${a.original}）`, createdByUserId: userId } });
      }
    }
    await tx.$executeRaw`UPDATE cutover_handover SET status='applied', revision=revision+1, snapshot=${JSON.stringify(s)}, applied_by=${userId}, applied_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE id=1`;
    return readHandover(tx);
  }, { timeout: 120000, maxWait: 10000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type CutoverMonthly = { id: string; sourceKey: string; day: string; amount: string; invoiceMode: string; note: string };
export async function pendingCutoverMonthly(db: DB, customerId: bigint, cutoff?: string): Promise<CutoverMonthly[]> {
  const rows = cutoff
    ? await db.$queryRaw<any[]>`SELECT * FROM cutover_monthly_items WHERE customer_id=${customerId} AND billing_statement_id IS NULL AND order_day <= ${cutoff} ORDER BY id`
    : await db.$queryRaw<any[]>`SELECT * FROM cutover_monthly_items WHERE customer_id=${customerId} AND billing_statement_id IS NULL ORDER BY id`;
  return rows.map(r => { const meta = JSON.parse(r.note); return { id: r.id.toString(), sourceKey: r.source_key, day: day(r.order_day), amount: String(r.amount), invoiceMode: meta.invoiceMode, note: meta.note }; });
}

export async function claimCutoverMonthly(tx: Prisma.TransactionClient, items: CutoverMonthly[], statementId: bigint) {
  for (const item of items) {
    const changed = await tx.$executeRaw`UPDATE cutover_monthly_items SET billing_statement_id=${statementId} WHERE id=${BigInt(item.id)} AND billing_statement_id IS NULL`;
    if (changed !== 1) throw new Error("舊月結已由其他人結帳，請重新產生對帳清單");
  }
}
