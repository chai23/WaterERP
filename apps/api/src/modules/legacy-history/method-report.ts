import { isMonthlyStatementAmount, isUnpaidPrepaidInvoice, legacyMonthlyKind } from "./monthly-kind.js";
import { Prisma, type PrismaClient } from "@prisma/client";

const SKIP = new Set(["000", "130", "201", "202", "205", "206", "207", "222", "223", "224", "300", "301", "302", "303", "304", "305", "306", "307", "308", "309", "387", "388", "389", "399", "400"]);
const SAME: Record<string, string> = { "120": "160", "121": "161", "123": "190", "124": "191", "125": "150", "126": "198", "166": "165", "185": "183", "186": "184" };
const REASON_ORDER = ["混合結帳", "預付商品一種以上", "查不到預付商品", "預付桶為負數", "月結單夾有其他商品", "已送達但這張單要排除", "分店預付桶和主檔不同"];
const OVERDRAFT = "並勾選預付桶不足時仍允許核銷送達（透支）";

export type MethodRow = {
  code: string; name: string; mode: "自動交接" | "人工處理"; method: string; text: string;
  reasons: string; overShort: number; prepaidBarrels: number; emptyBarrels: number; productText: string;
  productCandidates?: string[]; productCode?: string; excludedDeliveryIds?: string[]; churn: boolean; cashCount: number; cashAmount: number; monthlyCount: number; monthlyAmount: number;
  billedCount: number; billedAmount: number; excludeCount: number; laterNote: string;
};
export type MethodReport = {
  generatedAt: string; cutoffDate: string;
  summary: {
    customers: number; auto: number; manual: number; churn: number; registered: number;
    autoCash: number; autoMonthly: number; autoBilled: number;
    manualCash: number; manualMonthly: number; manualBilled: number;
    methods: { name: string; count: number; cash: number; monthly: number; billed: number }[];
    reasons: { name: string; count: number }[];
  };
  rows: MethodRow[];
};

type Customer = { id: string; mark: string; name: string; bucket: number; remain: number };
type Line = { orderId: string; customerId: string; completed: boolean; collected: boolean; billing: string; subtotal: number; productName: string };
type Source = {
  customers: Customer[];
  names: Map<string, string>;
  products: Map<string, string>;
  lines: Line[];
  received: Map<string, number>;
  overShort: Map<string, number>;
  prepaidProducts: Map<string, string[]>;
  hasOrders: Set<string>;
  laterUnpaid: Map<string, number>;
};

const round = (v: number) => Math.round(v * 100) / 100;
const money = (v: number) => { const n = round(v); return Number.isInteger(n) ? String(n) : n.toFixed(2); };
const ownerCode = (value: unknown) => {
  const match = String(value ?? "").trim().match(/^(\d{1,6})(?:-\d+)?$/);
  return match ? match[1]!.padStart(6, "0") : null;
};
const aliasKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,6})(-\d+)?$/);
  return match ? `${match[1]!.padStart(6, "0")}${match[2] ?? ""}` : text;
};
const isBranch = (c: Customer) => /-\d+$/.test((c.mark || c.id).trim());

export function assembleMethodReport(source: Source): MethodRow[] {
  const ordered = [...source.customers].sort((a, b) => Number(isBranch(a)) - Number(isBranch(b)) || a.id.localeCompare(b.id));
  const customerKeys = new Map<string, string>();
  const markKeys = new Map<string, string>();
  type Acc = {
    code: string; name: string; prepaidBarrels: number; emptyBarrels: number; branchMismatch: boolean;
    prepaidCashCount: number; prepaidCashAmount: number; cashCount: number; cashAmount: number;
    monthlyCount: number; monthlyAmount: number; billedCount: number; billedAmount: number;
    undelivered: number; unpaidItem: number; unpaidMonthly: number; overpay: number; statementMixed: number; mixedBilling: boolean;
  };
  const rows = new Map<string, Acc>();
  for (const c of ordered) {
    const id = c.id.trim();
    const code = ownerCode(c.mark) ?? ownerCode(id);
    const key = code ?? `unmapped:${id}`;
    customerKeys.set(id, key);
    const mark = c.mark.trim();
    if (mark) markKeys.set(mark, key);
    const existing = rows.get(key);
    if (existing) {
      existing.emptyBarrels += c.bucket;
      if (c.remain !== existing.prepaidBarrels) existing.branchMismatch = true;
      continue;
    }
    rows.set(key, {
      code: code ?? id, name: source.names.get(code ?? "") ?? c.name, prepaidBarrels: c.remain, emptyBarrels: c.bucket, branchMismatch: false,
      prepaidCashCount: 0, prepaidCashAmount: 0, cashCount: 0, cashAmount: 0, monthlyCount: 0, monthlyAmount: 0, billedCount: 0, billedAmount: 0,
      undelivered: 0, unpaidItem: 0, unpaidMonthly: 0, overpay: 0, statementMixed: 0, mixedBilling: false,
    });
  }
  const grouped = new Map<string, Line[]>();
  for (const line of source.lines) {
    const list = grouped.get(line.orderId) ?? [];
    list.push(line);
    grouped.set(line.orderId, list);
  }
  const byCode = new Map([...rows.values()].map(r => [r.code, r]));
  const rowFor = (customerId: string) => {
    const key = customerKeys.get(customerId) ?? markKeys.get(customerId);
    if (key && rows.has(key)) return rows.get(key)!;
    const code = ownerCode(customerId);
    return code ? byCode.get(code) : undefined;
  };
  const excludedDeliveries = new Map<string,string[]>();
  for (const lines of grouped.values()) {
    const row = rowFor(lines[0]!.customerId);
    if (!row) continue;
    const completed = lines.every(l => l.completed);
    const received = source.received.get(lines[0]!.orderId) ?? 0;
    const outstanding = round(lines.reduce((s, l) => s + l.subtotal, 0) - received);
    if (completed && lines.every(l => l.collected)) continue;
    const kind = legacyMonthlyKind(lines.map(line=>({name:line.productName,subtotal:line.subtotal})));
    if (outstanding === 0 && completed && kind === "ordinary") continue;
    if (kind === "ordinary" && isUnpaidPrepaidInvoice(lines.map(line=>({...line,name:line.productName,billing:line.billing.trim()})),received)) {
      row.cashCount++;
      row.cashAmount = round(row.cashAmount + outstanding);
      continue;
    }

    if (kind === "monthly_reminder") { row.unpaidMonthly++; continue; }
    if (kind === "payment_reminder") { row.unpaidItem++; continue; }
    if (kind === "mixed") { row.statementMixed++; continue; }
    if (!completed && kind === "ordinary") { row.undelivered++; const ids = excludedDeliveries.get(row.code) ?? []; ids.push(lines[0]!.orderId); excludedDeliveries.set(row.code,ids); continue; }
    if (new Set(lines.map(l => l.billing.trim()).filter(Boolean)).size > 1) row.mixedBilling = true;
    const book = (amount: number, monthlyStatement: boolean) => {
      if (amount < 0) { if (completed) row.overpay++; return; }
      if (amount <= 0) return;
      if (monthlyStatement) { row.billedCount++; row.billedAmount = round(row.billedAmount + amount); return; }
      if (lines[0]!.billing.trim() === "月結") { row.monthlyCount++; row.monthlyAmount = round(row.monthlyAmount + amount); return; }
      if (lines[0]!.billing.trim() === "預收") { row.prepaidCashCount++; row.prepaidCashAmount = round(row.prepaidCashAmount + amount); return; }
      row.cashCount++; row.cashAmount = round(row.cashAmount + amount);
    };
    if (kind === "statement") {
      const keep = lines.filter(l => isMonthlyStatementAmount(l.productName,l.subtotal) && !l.collected);
      if (!keep.length) continue;
      book(round(keep.reduce((s, l) => s + l.subtotal, 0) - received), true);
      continue;
    }
    const keep = lines.filter(l => !l.collected);
    if (!keep.length) continue;
    book(round(keep.reduce((s, l) => s + l.subtotal, 0) - received), false);
  }
  const result: MethodRow[] = [];
  for (const row of rows.values()) {
    const products = source.hasOrders.has(row.code) ? (source.prepaidProducts.get(row.code) ?? []) : [];
    const barrels = row.prepaidBarrels;
    const hasOrders = source.hasOrders.has(row.code);
    let productText = `預付桶 ${barrels}，不登入商品`;
    const reasons = new Set<string>();
    if (hasOrders && barrels > 0 && products.length === 1) productText = `預付桶 ${barrels} 登入 ${products[0]} ${source.products.get(products[0]!) ?? ""}`.trim();
    else if (hasOrders && barrels < 0 && products.length === 1) productText = `預付桶 ${barrels} 登入 ${products[0]} ${source.products.get(products[0]!) ?? ""}，${OVERDRAFT}`.trim();
    else if (hasOrders && barrels > 0 && products.length > 1) {
      productText = `預付桶 ${barrels}，商品 ${products.map(c => `${c} ${source.products.get(c) ?? ""}`.trim()).join("、")}`;
      reasons.add("預付商品一種以上");
    } else if (hasOrders && barrels > 0 && !products.length) reasons.add("查不到預付商品");
    else if (hasOrders && barrels < 0 && products.length !== 1) reasons.add("預付桶為負數");
    if (row.mixedBilling) reasons.add("混合結帳");
    if (row.statementMixed) reasons.add("月結單夾有其他商品");
    if (row.overpay) reasons.add("已送達但這張單要排除");
    if (row.branchMismatch) reasons.add("分店預付桶和主檔不同");
    const orderedReasons = REASON_ORDER.filter(r => reasons.has(r));
    const cashCount = row.cashCount + row.prepaidCashCount;
    const cashAmount = round(row.cashAmount + row.prepaidCashAmount);
    const excludeCount = row.undelivered + row.unpaidItem + row.unpaidMonthly + row.overpay;
    const later = source.laterUnpaid.get(row.code) ?? 0;
    const laterNote = later ? `啟用日後另有 ${later} 張未收款單，這次不納入。` : "";
    const bits: string[] = [];
    if (row.prepaidCashCount) bits.push(`預收儲值 ${row.prepaidCashCount} 張 ${money(row.prepaidCashAmount)} 元，傳入未沖帳應收。`);
    if (row.cashCount) bits.push(`一般未收款 ${row.cashCount} 張 ${money(row.cashAmount)} 元，傳入未沖帳應收。`);
    if (row.monthlyCount) bits.push(`月結尚未出帳 ${row.monthlyCount} 張 ${money(row.monthlyAmount)} 元，傳入月結承接，先不出應收。`);
    if (row.billedCount) bits.push(`月結已出帳未收 ${row.billedCount} 張 ${money(row.billedAmount)} 元，傳入已立帳未沖清月結應收。`);
    if (row.undelivered) bits.push(`未完成配送 ${row.undelivered} 張排除。`);
    if (row.unpaidItem) bits.push(`未收款項 ${row.unpaidItem} 張排除。`);
    if (row.unpaidMonthly) bits.push(`未收款月結單 ${row.unpaidMonthly} 張排除。`);
    if (row.overpay) bits.push(`已送達溢收 ${row.overpay} 張排除，不產生應收。`);
    if (row.statementMixed) bits.push(`月結單夾有其他商品 ${row.statementMixed} 張，整張先不入帳。`);
    const overShort = source.overShort.get(row.code) ?? 0;
    const balance = `短溢收 ${money(overShort)}、${productText}、空桶 ${row.emptyBarrels}`;
    const churn = !hasOrders && !orderedReasons.length;
    const parts: string[] = [];
    if (cashCount) parts.push("未沖帳應收");
    if (row.monthlyCount) parts.push("月結承接");
    if (row.billedCount) parts.push("月結應收");
    if (excludeCount) parts.push("排除部分舊單");
    let mode: MethodRow["mode"] = "自動交接";
    let method = "";
    let text = "";
    if (orderedReasons.length) {
      mode = "人工處理";
      method = "人工處理";
      const suggest = bits.length ? bits.join("") : "舊單都已結清，只傳三項餘額，不產生應收，不標記流失。";
      text = `整戶人工處理。原因：${orderedReasons.join("、")}。${suggest}${balance}。不標記流失。${laterNote}`;
    } else if (churn) {
      method = "無訂單，傳餘額後標記流失";
      text = `舊系統完全沒有訂單。傳入短溢收、預付桶、空桶後標記流失，原因選其他，說明寫系統轉換標記流失。${balance}。${laterNote}`;
    } else if (!parts.length) {
      method = "舊單已結清，只傳餘額";
      text = `舊單都已結清。不移交舊單，不產生應收，不標記流失。${balance}。不標記流失。${laterNote}`;
    } else {
      method = parts.join("＋");
      text = `${bits.join("")}${balance}。不標記流失。${laterNote}`;
    }
    result.push({
      productCandidates: products, productCode: products.length === 1 ? products[0] : undefined, excludedDeliveryIds: excludedDeliveries.get(row.code),
      code: row.code, name: row.name, mode, method, text: text.replace(/。+/g, "。"), reasons: orderedReasons.join("、"),
      overShort, prepaidBarrels: barrels, emptyBarrels: row.emptyBarrels, productText, churn,
      cashCount, cashAmount, monthlyCount: row.monthlyCount, monthlyAmount: row.monthlyAmount,
      billedCount: row.billedCount, billedAmount: row.billedAmount, excludeCount, laterNote,
    });
  }
  return result.sort((a, b) => a.code.localeCompare(b.code));
}

function summarize(rows: MethodRow[]): MethodReport["summary"] {
  const methods = new Map<string, { count: number; cash: number; monthly: number; billed: number }>();
  const reasons = new Map<string, number>();
  const summary = { customers: rows.length, auto: 0, manual: 0, churn: 0, registered: 0, autoCash: 0, autoMonthly: 0, autoBilled: 0, manualCash: 0, manualMonthly: 0, manualBilled: 0, methods: [] as MethodReport["summary"]["methods"], reasons: [] as MethodReport["summary"]["reasons"] };
  for (const r of rows) {
    if (r.mode === "人工處理") {
      summary.manual++;
      summary.manualCash = round(summary.manualCash + r.cashAmount);
      summary.manualMonthly = round(summary.manualMonthly + r.monthlyAmount);
      summary.manualBilled = round(summary.manualBilled + r.billedAmount);
      for (const reason of r.reasons ? r.reasons.split("、") : []) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else {
      summary.auto++;
      summary.autoCash = round(summary.autoCash + r.cashAmount);
      summary.autoMonthly = round(summary.autoMonthly + r.monthlyAmount);
      summary.autoBilled = round(summary.autoBilled + r.billedAmount);
      if (r.churn) summary.churn++;
      if (r.productText.includes(" 登入 ")) summary.registered++;
      const b = methods.get(r.method) ?? { count: 0, cash: 0, monthly: 0, billed: 0 };
      b.count++; b.cash = round(b.cash + r.cashAmount); b.monthly = round(b.monthly + r.monthlyAmount); b.billed = round(b.billed + r.billedAmount);
      methods.set(r.method, b);
    }
  }
  summary.methods = [...methods.entries()].sort((a, b) => b[1].count - a[1].count).map(([name, b]) => ({ name, ...b }));
  summary.reasons = REASON_ORDER.filter(name => reasons.has(name)).map(name => ({ name, count: reasons.get(name)! }));
  return summary;
}

const num = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (s && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) throw new Error(`舊資料有無法辨識的數字：${s.slice(0, 40)}`);
  return Number(s || 0);
};

export async function buildHandoverMethodReport(legacy: PrismaClient, target: PrismaClient, cutoffDate: string, customerCode?: string): Promise<MethodReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) throw new Error("請輸入有效的啟用日期");
  if (customerCode && !/^\d{6}$/.test(customerCode)) throw new Error("客戶代號錯誤");
  const owner = (column: string) => `LPAD(REGEXP_SUBSTR(TRIM(${column}), '^[0-9]{1,6}(?=-|$)'), 6, '0')`;
  const own = (column: string) => `${owner(column)} = '${customerCode}'`;
  const customerFilter = customerCode ? ` WHERE (${own("customer_id")} OR ${own("customer_id_mark")})` : "";
  const member = customerCode ? `(${own("customer_id")} OR TRIM(customer_id) IN (SELECT TRIM(c.customer_id) FROM customer c${customerFilter}) OR TRIM(customer_id) IN (SELECT TRIM(c.customer_id_mark) FROM customer c${customerFilter}))` : "1=1";
  const source = await legacy.$transaction(async tx => {
    const customers = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT customer_id, customer_id_mark, customer_name, customer_bucket, customer_remain FROM customer" + customerFilter + " ORDER BY customer_id");
    const lines = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT order_id, customer_id, TRIM(order_OK) AS order_ok, TRIM(collect_OK) AS collect_ok, TRIM(collect_money) AS collect_money, subtotal, TRIM(product_name) AS product_name FROM `order` WHERE (order_day < DATE_ADD(?, INTERVAL 1 DAY) OR order_day IS NULL) AND " + member + " ORDER BY order_id, customer_id, subtotal",
      cutoffDate,
    );
    const receipts = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT order_id, SUM(money) AS money FROM remittance_list WHERE remittance_day IS NOT NULL AND remittance_day < DATE_ADD(?, INTERVAL 1 DAY) " + (customerCode ? " AND order_id IN (SELECT order_id FROM `order` WHERE " + member + ")" : "") + " GROUP BY order_id",
      cutoffDate,
    );
    const overShort = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT customer_id, money FROM money_over_short WHERE " + member);
    const prepaid = await tx.$queryRawUnsafe<Array<{ code: string; product_code: string }>>(
      `SELECT LPAD(REGEXP_SUBSTR(TRIM(customer_id), '^[0-9]{1,6}'), 6, '0') AS code, LPAD(TRIM(product_id), 3, '0') AS product_code
       FROM \`order\` WHERE ${member} AND TRIM(collect_money)='預收' AND CAST(product_quantity AS DECIMAL(18,4)) > 0
         AND customer_id REGEXP '^[0-9]{1,6}(-[0-9]+)?$' AND product_id REGEXP '^[0-9]{1,3}$' GROUP BY code, product_code`,
    );
    const later = await tx.$queryRawUnsafe<Array<{ customer_id: string }>>(
      `SELECT customer_id FROM \`order\` WHERE ${member} AND order_day >= DATE_ADD(?, INTERVAL 1 DAY) GROUP BY customer_id, order_id
       HAVING SUM(CASE WHEN TRIM(order_OK)='True' AND TRIM(collect_OK)='True' THEN 0 ELSE 1 END) > 0`,
      cutoffDate,
    );
    const orderCustomers = await tx.$queryRawUnsafe<Array<{ customer_id: string }>>("SELECT DISTINCT customer_id FROM `order` WHERE " + member);
    return { customers, lines, receipts, overShort, prepaid, later, orderCustomers };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 180000 });
  const products = await target.product.findMany({ where: { isActive: true, consumesPrepaidBarrel: true, productCode: { not: null } }, select: { productCode: true, name: true } });
  const names = await target.customer.findMany({ where: { customerCode: customerCode ?? { not: null } }, select: { customerCode: true, name: true } });
  const productNames = new Map(products.map(p => [String(p.productCode).trim(), p.name]));
  const customerRows: Customer[] = source.customers.map(c => ({
    id: String(c.customer_id ?? "").trim(), mark: String(c.customer_id_mark ?? "").trim(), name: String(c.customer_name ?? "").trim(),
    bucket: num(c.customer_bucket), remain: num(c.customer_remain),
  }));
  const aliases = new Map<string, Set<string>>();
  for (const c of customerRows) {
    const owner = ownerCode(c.mark) ?? ownerCode(c.id);
    if (!owner) continue;
    for (const id of [c.id, c.mark]) {
      const key = aliasKey(id);
      if (!key) continue;
      const codes = aliases.get(key) ?? new Set<string>();
      codes.add(owner);
      aliases.set(key, codes);
    }
  }
  const hasOrders = new Set<string>();
  const addOwner = (id: string) => {
    for (const owner of aliases.get(aliasKey(id)) ?? []) hasOrders.add(owner);
    const code = ownerCode(id);
    if (code) hasOrders.add(code);
  };
  for (const o of source.orderCustomers) addOwner(String(o.customer_id ?? "").trim());
  const laterUnpaid = new Map<string, number>();
  for (const o of source.later) {
    const id = String(o.customer_id ?? "").trim();
    const owners = aliases.get(aliasKey(id));
    const code = owners?.values().next().value ?? ownerCode(id);
    if (!code) continue;
    laterUnpaid.set(code, (laterUnpaid.get(code) ?? 0) + 1);
  }
  const prepaidProducts = new Map<string, string[]>();
  for (const r of source.prepaid) {
    const raw = String(r.product_code).padStart(3, "0");
    if (!/^\d{3}$/.test(raw) || SKIP.has(raw) || !productNames.has(raw)) continue;
    const pc = SAME[raw] ?? raw;
    if (!productNames.has(pc)) continue;
    const list = prepaidProducts.get(r.code) ?? [];
    if (!list.includes(pc)) list.push(pc);
    prepaidProducts.set(r.code, list);
  }
  for (const list of prepaidProducts.values()) list.sort();
  const overShort = new Map<string, number>();
  for (const r of source.overShort) {
    const id = String(r.customer_id ?? "").trim();
    const owners = aliases.get(aliasKey(id));
    const code = owners?.values().next().value ?? ownerCode(id);
    if (!code) continue;
    overShort.set(code, round((overShort.get(code) ?? 0) + num(r.money)));
  }
  const received = new Map<string, number>();
  for (const r of source.receipts) received.set(String(r.order_id ?? "").trim(), round(num(r.money)));
  const rows = assembleMethodReport({
    customers: customerRows, names: new Map(names.flatMap(c => c.customerCode ? [[c.customerCode, c.name] as const] : [])), products: productNames,
    lines: source.lines.map(l => ({
      orderId: String(l.order_id ?? "").trim(), customerId: String(l.customer_id ?? "").trim(), completed: String(l.order_ok) === "True",
      collected: String(l.collect_ok) === "True", billing: String(l.collect_money ?? ""), subtotal: num(l.subtotal), productName: String(l.product_name ?? ""),
    })),
    received, overShort, prepaidProducts, hasOrders, laterUnpaid,
  });
  return { generatedAt: new Date().toISOString(), cutoffDate, summary: summarize(rows), rows };
}
