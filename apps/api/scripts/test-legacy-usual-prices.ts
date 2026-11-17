/** Run from apps/api: npx tsx scripts/test-legacy-usual-prices.ts */
import assert from "node:assert/strict";
import { assembleLegacyUsualProducts, type LegacyUsualLine } from "../src/modules/legacy-history/queries.js";
import { apiPermissions } from "../src/modules/permissions/policy.js";

function line(partial: Partial<LegacyUsualLine> & Pick<LegacyUsualLine, "orderId" | "productName">): LegacyUsualLine {
  return {
    orderDay: "2026-01-01",
    productId: "012",
    unitPrice: 0,
    qty: 2,
    gift: false,
    billingLabel: "預收",
    ...partial,
  };
}

const prepaid = assembleLegacyUsualProducts([
  line({ orderId: "9", orderDay: "2026-11-01", productName: "山泉水", unitPrice: 0, qty: 2, billingLabel: "預收" }),
  line({ orderId: "4", orderDay: "2025-06-01", productName: "山泉水", unitPrice: 190, qty: 2, billingLabel: "現金" }),
  line({ orderId: "1", orderDay: "2024-03-15", productName: "山泉水", unitPrice: 180, qty: 10, billingLabel: "預收" }),
]);
assert.equal(prepaid.products.length, 1);
assert.equal(prepaid.products[0]?.unitPrice, 190);
assert.equal(prepaid.products[0]?.qty, 2);
assert.equal(prepaid.products[0]?.priceFromOlderOrder, true);
assert.equal(prepaid.products[0]?.priceOrderDay, "2025-06-01");
assert.equal(prepaid.products[0]?.productCode, "012");

const current = assembleLegacyUsualProducts([
  line({ orderId: "3", orderDay: "2026-10-01", productName: "山泉水", unitPrice: 200, billingLabel: "現金" }),
  line({ orderId: "1", orderDay: "2024-01-01", productName: "山泉水", unitPrice: 180, billingLabel: "現金" }),
]);
assert.equal(current.products[0]?.unitPrice, 200);
assert.equal(current.products[0]?.priceFromOlderOrder, false);

const skipped = assembleLegacyUsualProducts([
  line({ orderId: "5", productId: "201", productName: "月結請款", unitPrice: 999, qty: 1 }),
  line({ orderId: "4", productId: "012", productName: "贈送山泉水", unitPrice: 0, qty: 1, gift: true }),
  line({ orderId: "2", orderDay: "2026-04-01", productId: "008", productName: "蒸餾水", unitPrice: 0, qty: 1, billingLabel: "預收" }),
  line({ orderId: "1", orderDay: "2023-01-01", productId: "008", productName: "蒸餾水", unitPrice: 90, qty: 5, billingLabel: "現金" }),
]);
assert.equal(skipped.products.length, 1);
assert.equal(skipped.products[0]?.productCode, "008");
assert.equal(skipped.products[0]?.unitPrice, 90);
assert.equal(skipped.products[0]?.priceFromOlderOrder, true);

const ordered = assembleLegacyUsualProducts([
  line({ orderId: "2", orderDay: "2026-02-01", productId: "002", productName: "乙", unitPrice: 20, qty: 1, billingLabel: "現金" }),
  line({ orderId: "1", orderDay: "2026-01-01", productId: "001", productName: "甲", unitPrice: 10, qty: 3, billingLabel: "現金" }),
]);
assert.deepEqual(ordered.products.map((p) => p.productName), ["乙", "甲"]);

const zeros = assembleLegacyUsualProducts([
  line({ orderId: "2", productName: "山泉水", unitPrice: 0, qty: 1 }),
]);
assert.equal(zeros.products[0]?.unitPrice, null);
assert.equal(zeros.products[0]?.priceFromOlderOrder, false);

const padded = assembleLegacyUsualProducts([
  line({ orderId: "2", orderDay: "2026-05-01", productId: "12", productName: "山泉水", unitPrice: 0, qty: 1 }),
  line({ orderId: "1", orderDay: "2020-01-01", productId: "012", productName: "山泉水", unitPrice: 150, qty: 4, billingLabel: "現金" }),
]);
assert.equal(padded.products.length, 1);
assert.equal(padded.products[0]?.productCode, "012");
assert.equal(padded.products[0]?.unitPrice, 150);
assert.equal(padded.products[0]?.priceFromOlderOrder, true);

const many = Array.from({ length: 10 }, (_, i) =>
  line({
    orderId: String(10 - i),
    orderDay: `2026-01-${String(10 - i).padStart(2, "0")}`,
    productId: String(i + 1).padStart(3, "0"),
    productName: `品${i}`,
    unitPrice: 10 + i,
    qty: 1,
    billingLabel: "現金",
  }),
);
const capped = assembleLegacyUsualProducts(many, 8);
assert.equal(capped.products.length, 8);
assert.equal(capped.omittedCount, 2);

const byName = assembleLegacyUsualProducts([
  line({ orderId: "9", orderDay: "2026-08-01", productId: null, productName: "山泉水", unitPrice: 0, qty: 2, billingLabel: "預收" }),
  line({ orderId: "1", orderDay: "2022-02-02", productId: "012", productName: "山泉水", unitPrice: 160, qty: 1, billingLabel: "現金" }),
]);
assert.equal(byName.products[0]?.unitPrice, 160);
assert.equal(byName.products[0]?.priceFromOlderOrder, true);

const distinct = assembleLegacyUsualProducts([
  line({ orderId: "2", orderDay: "2026-08-01", productId: "012", productName: "山泉水", unitPrice: 0, qty: 1, billingLabel: "預收" }),
  line({ orderId: "1", orderDay: "2022-02-02", productId: "015", productName: "山泉水", unitPrice: 999, qty: 1, billingLabel: "現金" }),
]);
assert.equal(distinct.products.length, 2);
assert.equal(distinct.products.find((p) => p.productCode === "012")?.unitPrice, null);
assert.equal(distinct.products.find((p) => p.productCode === "015")?.unitPrice, 999);

const perms = apiPermissions("GET", "/api/customers/1/legacy-product-prices");
assert.ok(perms?.includes("orders.new"));

console.log("PASS legacy usual prices");
