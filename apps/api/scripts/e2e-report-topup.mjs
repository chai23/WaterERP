import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const url = new URL(process.env.DATABASE_URL ?? "");
assert.equal(url.hostname, "127.0.0.1"); assert.match(url.pathname, /_test$/);
const base = new URL(process.env.REPORT_TEST_API ?? "");
assert.equal(base.hostname, "127.0.0.1");
const db = new PrismaClient();
const tag = randomUUID().slice(0, 8);
let count = 0;
const pass = text => console.log(`PASS topup ${++count}: ${text}`);
async function api(route, token, body, status = 200) {
  const response = await fetch(new URL(`/api${route}`, base), {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
  return data;
}
try {
  const password = randomUUID();
  const passwordHash = await bcrypt.hash(password, 4);
  async function account(role) {
    const employeeCode = `${role}-${tag}`;
    const row = await db.user.create({ data: { employeeCode, name: employeeCode, role, passwordHash } });
    const driver = role === "driver" ? await db.driver.create({ data: { userId: row.id, employeeCode } }) : null;
    return { token: (await api("/auth/login", "", { employeeCode, password })).token, driver };
  }
  const office = await account("admin"), driver = await account("driver");
  await db.promotionRule.upsert({ where: { ruleKey: "prepaid_topup_bonus" },
    create: { ruleKey: "prepaid_topup_bonus", displayName: "Test", isEnabled: true, config: { minBarrels: 3, bonusBarrels: 1 } },
    update: { isEnabled: true, config: { minBarrels: 3, bonusBarrels: 1 } } });
  async function fixture(label, delivery = true) {
    const customer = await db.customer.create({ data: { name: `${tag}-${label}`, billingType: "cash" } });
    const address = await db.deliveryAddress.create({ data: { customerId: customer.id, addressLine: "Isolated test" } });
    const water = await db.product.create({ data: { name: `Water-${label}-${tag}`, salePrice: 50, consumesPrepaidBarrel: true, countsDepositBarrel: true, inventory: { create: { qtyOnHand: 20 } } } });
    const other = await db.product.create({ data: { name: `Other-${label}-${tag}`, salePrice: 100, inventory: { create: { qtyOnHand: 20 } } } });
    let order = await db.salesOrder.create({ data: {
      orderNo: `TU-${label}-${tag}`, customerId: customer.id, deliveryAddressId: address.id, status: "assigned", billingTypeAtOrder: "cash", cashInvoiceMode: "none",
      subtotal: delivery ? 100 : 0, totalAmount: delivery ? 100 : 0, cashSubtotal: delivery ? 100 : 0,
      ...(delivery ? { lines: { create: { productId: other.id, qtyOrdered: 1, unitPrice: 100, lineAmount: 100 } } } : {}),
    }, include: { lines: true } });
    const assignment = await db.deliveryAssignment.create({ data: { salesOrderId: order.id, driverId: driver.driver.id, assignmentDate: new Date(), status: "assigned" } });
    const assignmentId = String(assignment.id);
    const reload = async () => { order = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } }); return order; };
    const payload = (append, topups) => ({ assignmentId, orderVersion: order.lockVersion, append, topups,
      lines: order.lines.filter(l => l.linePurpose === "delivery").map(l => ({ lineId: String(l.id), qtyDelivered: l.qtyDelivered || l.qtyOrdered })) });
    const confirm = async (append, topups, status = 200, token = driver.token) => {
      const result = await api("/driver/confirm-line-deliveries", token, payload(append, topups), status);
      if (status === 200) { await reload(); assert(result.data.assignment.events?.length > 0); }
      return result;
    };
    const topup = qty => ({ productId: String(water.id), qty, billingType: "cash", linePurpose: "prepaid_barrel_topup" });
    const report = async cashReceived => { await reload(); const result = await api("/driver/complete", driver.token, { assignmentId, orderVersion: order.lockVersion, delivered: true, cashReceived }); await reload(); return result; };
    const approve = (status = 200) => api("/settlements/approve", office.token, { assignmentId }, status);
    const balance = async () => (await db.customerPrepaidProductBalance.findUnique({ where: { customerId_productId: { customerId: customer.id, productId: water.id } } }))?.balanceBarrels ?? 0;
    return { customer, address, water, other, assignment, assignmentId, reload, payload, confirm, topup, report, approve, balance };
  }
  const f = await fixture("mixed");
  await f.confirm({ ...f.topup(3), billingType: "monthly" }, undefined, 400);
  await f.confirm({ ...f.topup(3), productId: String(f.other.id) }, undefined, 400);
  await f.confirm({ ...f.topup(3), linePurpose: "invalid" }, undefined, 400);
  await f.confirm(f.topup(3));
  let order = await f.reload();
  assert.equal(order.pendingPrepaidTopupBarrels, 4); assert.equal(Number(order.cashSubtotal), 250); assert.equal(await f.balance(), 0);
  assert.equal(order.lines.find(l => l.linePurpose === "prepaid_barrel_topup" && !l.isPromotionGift).qtyDelivered, 0);
  pass("topup validation, pricing, gift barrels and no premature credit");
  let paid = order.lines.find(l => l.linePurpose === "prepaid_barrel_topup" && !l.isPromotionGift);
  const gift = order.lines.find(l => l.isPromotionGift);
  await f.confirm(undefined, [{ lineId: String(gift.id), qty: 99 }], 400);
  await f.confirm(undefined, [{ lineId: String(paid.id), qty: null }], 400);
  await f.confirm(undefined, [{ lineId: String(paid.id), qty: 6 }]);
  order = await f.reload(); assert.equal(order.pendingPrepaidTopupBarrels, 8); assert.equal(Number(order.cashSubtotal), 400);
  await f.confirm(undefined, [{ lineId: String(paid.id), qty: 0 }]);
  order = await f.reload(); assert.equal(order.pendingPrepaidTopupBarrels, 0); assert.equal(order.lines.length, 1); assert.equal(Number(order.cashSubtotal), 100);
  pass("edit/removal recalculates gifts, totals and pending barrels; gift cannot be edited");

  const body = f.payload(f.topup(3));
  const responses = await Promise.all([driver.token, office.token].map(token => fetch(new URL("/api/driver/confirm-line-deliveries", base), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await api("/driver/confirm-line-deliveries", driver.token, body, 409);
  order = await f.reload(); assert.equal(order.pendingPrepaidTopupBarrels, 4);
  const parallelOrder = await fixture("pending-credit");
  const parallelRow = await parallelOrder.reload();
  await db.salesOrder.update({ where: { id: parallelRow.id }, data: { customerId: f.customer.id, deliveryAddressId: f.address.id } });
  await parallelOrder.reload();
  await parallelOrder.confirm({ productId: String(f.water.id), qty: 1, billingType: "prepaid" }, undefined, 400);
  await f.confirm({ productId: String(f.water.id), qty: 4, billingType: "prepaid" });
  await f.confirm({ productId: String(f.other.id), qty: 1, billingType: "monthly" });
  assert.equal(Number((await f.reload()).monthlySubtotal), 100);
  order = await f.reload(); paid = order.lines.find(l => l.linePurpose === "prepaid_barrel_topup" && !l.isPromotionGift);
  await f.confirm(undefined, [{ lineId: String(paid.id), qty: 0 }], 400);
  assert.equal((await f.reload()).pendingPrepaidTopupBarrels, 4);
  const different = await db.product.create({ data: { name: `Different-${tag}`, salePrice: 50, consumesPrepaidBarrel: true } });
  await f.confirm({ productId: String(different.id), qty: 1, billingType: "prepaid" }, undefined, 400);
  pass("concurrent append/replay, same-product credit and dependent removal rollback");

  await f.report(249);
  await f.confirm(f.topup(1), undefined, 409);
  await f.confirm(undefined, [{ lineId: String(paid.id), qty: 6 }], 409);
  await f.approve(400);
  assert.equal((await db.deliveryAssignment.findUniqueOrThrow({ where: { id: f.assignment.id } })).status, "pending_settlement");
  assert.equal((await db.inventoryBalance.findUniqueOrThrow({ where: { productId: f.water.id } })).qtyOnHand, 20);
  assert.equal(await db.customerLedgerEntry.count({ where: { salesOrderId: order.id } }), 0);
  assert.equal(await db.stockMovement.count({ where: { refType: "sales_order", refId: order.id } }), 0);
  assert.equal(await db.receiptVoucher.count({ where: { customerId: f.customer.id } }), 0);
  assert.equal(await f.balance(), 0);
  pass("insufficient payment rolls back settlement, receipts, stock and credit; pending topups locked");
  await f.report(250); await f.approve(); await f.approve(400);
  assert.equal(await f.balance(), 0);
  assert.equal((await f.reload()).pendingPrepaidTopupBarrels, 0);
  assert.equal((await db.inventoryBalance.findUniqueOrThrow({ where: { productId: f.water.id } })).qtyOnHand, 16);
  assert.equal((await db.inventoryBalance.findUniqueOrThrow({ where: { productId: f.other.id } })).qtyOnHand, 18);
  assert.equal((await db.deliveryAddress.findUniqueOrThrow({ where: { id: f.address.id } })).barrelsOnSite, 4);
  assert.equal(await db.customerLedgerEntry.count({ where: { salesOrderId: order.id, entryType: "prepaid_topup" } }), 1);
  assert.equal(await db.customerLedgerEntry.count({ where: { salesOrderId: order.id, entryType: "prepaid_consumption" } }), 1);
  pass("paid mixed order posts exactly one topup/consumption and only delivery changes inventory/barrels");

  const only = await fixture("only", false);
  await only.confirm(only.topup(6)); await only.report(300); await only.approve();
  assert.equal(await only.balance(), 8);
  assert.equal((await db.inventoryBalance.findUniqueOrThrow({ where: { productId: only.water.id } })).qtyOnHand, 20);
  assert.equal((await db.deliveryAddress.findUniqueOrThrow({ where: { id: only.address.id } })).barrelsOnSite, 0);
  pass("topup-only report without delivery lines credits paid + gift barrels without inventory movement");

  const prepaid = await fixture("paid-before", false);
  await prepaid.confirm(prepaid.topup(3)); await prepaid.report(0);
  await api("/ar/receipt-vouchers", office.token, { customerId: String(prepaid.customer.id), paymentMethod: "transfer", amount: 150 }, 201);
  assert.equal(await prepaid.balance(), 0);
  const approvals = await Promise.all([1, 2].map(() => fetch(new URL("/api/settlements/approve", base), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${office.token}` },
    body: JSON.stringify({ assignmentId: prepaid.assignmentId }),
  })));
  const statuses = approvals.map(r => r.status).sort();
  assert.equal(statuses[0], 200); assert([400, 409].includes(statuses[1]));
  assert.equal(await prepaid.balance(), 4);
  const prepaidOrder = await prepaid.reload();
  assert.equal(await db.customerLedgerEntry.count({ where: { salesOrderId: prepaidOrder.id, entryType: "prepaid_topup" } }), 1);
  pass("payment before settlement stays pending; concurrent settlement credits once");

  const late = await fixture("paid-after", false);
  await late.confirm(late.topup(3)); await late.report(50); await late.approve();
  assert.equal(await late.balance(), 0); assert.equal((await late.reload()).pendingPrepaidTopupBarrels, 4);
  await api("/ar/receipt-vouchers", office.token, { customerId: String(late.customer.id), paymentMethod: "transfer", amount: 100 }, 201);
  assert.equal(await late.balance(), 4); assert.equal((await late.reload()).pendingPrepaidTopupBarrels, 0);
  pass("topup without dependent delivery remains pending until later receipt clears the cash AR");
} finally { await db.$disconnect(); }
