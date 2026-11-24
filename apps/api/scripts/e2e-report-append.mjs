import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Run against a local API using the same disposable test database.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const base = new URL(process.env.REPORT_TEST_API ?? "http://127.0.0.1:13398");
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.match(databaseUrl.pathname, /_test$/);
assert.equal(base.hostname, "127.0.0.1");

const prisma = new PrismaClient();
const tag = randomUUID().slice(0, 8);
const password = randomUUID();
async function request(path, { token, body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  const passwordHash = await bcrypt.hash(password, 4);
  async function user(role, prefix) {
    const employeeCode = `${prefix}-${tag}`;
    const account = await prisma.user.create({ data: { employeeCode, passwordHash, name: employeeCode, role } });
    const driver = role === "driver" ? await prisma.driver.create({
      data: { userId: account.id, employeeCode },
    }) : null;
    const { token } = await request("/api/auth/login", { body: { employeeCode, password } });
    return { token, driver, employeeCode };
  }

  const office = await user("admin", "Office");
  const operator = await user("driver", "Driver");
  const unrelated = await user("driver", "Other");
  const customer = await prisma.customer.create({ data: {
    name: `Report Test ${tag}`, billingType: "cash", prepaidBarrelBalance: 4,
  } });
  const address = await prisma.deliveryAddress.create({ data: { customerId: customer.id, addressLine: "Test address" } });
  async function product(name, salePrice, barrels = false) {
    return prisma.product.create({ data: {
      name: `${name} ${tag}`, salePrice,
      countsDepositBarrel: barrels, consumesPrepaidBarrel: barrels,
      inventory: { create: { qtyOnHand: 20 } },
    } });
  }
  const cash = await product("Cash", 100);
  const monthly = await product("Monthly", 80);
  const prepaid = await product("Prepaid", 50, true);
  await prisma.customerPrepaidProductBalance.create({
    data: { customerId: customer.id, productId: prepaid.id, balanceBarrels: 4 },
  });

  const order = await prisma.salesOrder.create({ data: {
    orderNo: `REPORT-${tag}`, customerId: customer.id, deliveryAddressId: address.id,
    status: "assigned", billingTypeAtOrder: "cash", cashInvoiceMode: "none",
    subtotal: 100, totalAmount: 100, cashSubtotal: 100,
    lines: { create: { productId: cash.id, qtyOrdered: 1, unitPrice: 100, lineAmount: 100 } },
  }, include: { lines: true } });
  const ymd = new Date().toISOString().slice(0, 10);
  const assignment = await prisma.deliveryAssignment.create({ data: {
    salesOrderId: order.id, driverId: operator.driver.id, assignmentDate: new Date(ymd), status: "assigned",
  } });
  const assignmentId = String(assignment.id);
  const readonlyCatalog = await request("/api/driver/report-products", { token: operator.token });
  assert(readonlyCatalog.some((item) => item.id === String(prepaid.id) && item.consumesPrepaidBarrel));
  const endpoint = "/api/driver/confirm-line-deliveries";
  const originalLineId = String(order.lines[0].id);
  const quantities = (lines) => lines.map((line) => ({
    lineId: line.id, qtyDelivered: line.qtyDelivered,
  }));
  const monthlyRequest = {
    assignmentId, orderVersion: order.lockVersion,
    lines: [{ lineId: originalLineId, qtyDelivered: 1 }],
    append: { productId: String(monthly.id), qty: 2, billingType: "monthly" },
  };
  await request(endpoint, { token: unrelated.token, body: monthlyRequest, status: 403 });
  const races = await Promise.all([
    fetch(new URL(endpoint, base), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${operator.token}` },
      body: JSON.stringify(monthlyRequest),
    }),
    fetch(new URL(endpoint, base), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${office.token}` },
      body: JSON.stringify(monthlyRequest),
    }),
  ]);
  assert.deepEqual(races.map((response) => response.status).sort(), [200, 409]);
  let data = (await races.find((response) => response.ok).json()).data;
  let current = data.assignment.salesOrder;
  assert.equal(current.lines.length, 2);
  assert.equal(current.billingTypeAtOrder, "mixed");
  assert.equal(Number(current.cashSubtotal), 100);
  assert.equal(Number(current.monthlySubtotal), 160);
  assert.equal(Number(data.driverBillingHints.cashDue), 100);
  await request(endpoint, { token: operator.token, body: monthlyRequest, status: 409 });

  async function confirm(lines, append, status = 200) {
    const response = await request(endpoint, {
      token: office.token, status, body: { assignmentId, orderVersion: current.lockVersion, lines, append },
    });
    if (status === 200) {
      data = response.data;
      current = data.assignment.salesOrder;
    }
  }

  await confirm(quantities(current.lines).map((line) => ({
    ...line, qtyDelivered: line.lineId === originalLineId ? 1 : 0,
  })));
  assert.equal(current.lines.length, 1);
  assert.equal(current.billingTypeAtOrder, "cash");
  assert.equal(Number(current.monthlySubtotal), 0);

  await confirm(quantities(current.lines), { productId: String(prepaid.id), qty: 5, billingType: "prepaid" }, 400);
  assert.equal(await prisma.salesOrderLine.count({ where: { salesOrderId: order.id } }), 1);
  await confirm(quantities(current.lines), { productId: String(prepaid.id), qty: 2, billingType: "prepaid" });
  const prepaidLine = current.lines.find((line) => line.productId === String(prepaid.id));
  const adjusted = quantities(current.lines).map((line) => ({
    ...line, qtyDelivered: line.lineId === prepaidLine.id ? 3 : line.qtyDelivered,
  }));
  await confirm(adjusted, { productId: String(monthly.id), qty: 1, billingType: "monthly" });
  assert.equal(Number(current.monthlySubtotal), 80);
  assert.equal(Number(data.driverBillingHints.cashDue), 100);
  assert.equal(current.lines.find((line) => line.id === prepaidLine.id).qtyDelivered, 3);
  await confirm(quantities(current.lines), { productId: String(cash.id), qty: 1, billingType: "cash" });
  assert.equal(Number(current.cashSubtotal), 200);
  assert.equal(Number(data.driverBillingHints.cashDue), 200);

  await request("/api/driver/complete", {
    token: operator.token, status: 409,
    body: { assignmentId, orderVersion: order.lockVersion, delivered: true, cashReceived: 200 },
  });
  const report = await request("/api/driver/complete", {
    token: operator.token,
    body: { assignmentId, orderVersion: current.lockVersion, delivered: true, cashReceived: 200, emptyBarrelsReturned: 1 },
  });
  assert.equal(report.data.status, "pending_settlement");
  assert.equal(Number(report.data.cashVariance), 0);
  await request(endpoint, {
    token: office.token, status: 409,
    body: { ...monthlyRequest, orderVersion: report.data.salesOrder.lockVersion },
  });
  await request("/api/settlements/approve", { token: office.token, body: { assignmentId } });
  await request("/api/settlements/approve", { token: office.token, status: 400, body: { assignmentId } });
  assert.equal((await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status, "completed");
  assert.equal((await prisma.customerPrepaidProductBalance.findUniqueOrThrow({
    where: { customerId_productId: { customerId: customer.id, productId: prepaid.id } },
  })).balanceBarrels, 1);
  assert.equal((await prisma.deliveryAddress.findUniqueOrThrow({ where: { id: address.id } })).barrelsOnSite, 2);
  for (const [item, expected] of [[cash, 18], [monthly, 19], [prepaid, 17]]) {
    assert.equal((await prisma.inventoryBalance.findUniqueOrThrow({ where: { productId: item.id } })).qtyOnHand, expected);
  }
  await request(endpoint, { token: operator.token, status: 400, body: monthlyRequest });
  console.log("Passed ownership, concurrent append/replay, mixed totals, removal, prepaid rollback, report and settlement.");
} finally {
  await prisma.$disconnect();
}
