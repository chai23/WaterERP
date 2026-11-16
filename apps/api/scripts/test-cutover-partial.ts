import assert from "node:assert/strict";
import { mergeDraft, type HandoverSnapshot, type HandoverRow } from "../src/modules/legacy-history/handover.js";

const row: HandoverRow = {
  key: "000001", code: "000001", name: "Test", customerId: "1", included: true,
  warnings: [], reviewed: false, note: "", prepayment: 0, prepaidBarrels: 0,
  sourcePrepaidBarrels: 0, legacyBarrels: 0,
  addresses: [{ id: "1", label: "Source address", barrels: 0, original: 0 }],
  orders: [{ id: "1", day: "2026-11-16", amount: 100, received: 0, outstanding: 100,
    completed: true, billing: "cash", disposition: "cash", finalAmount: 100,
    dueDate: "2026-11-16", invoiceMode: "none", note: "" }],
};
const original: HandoverSnapshot = {
  startDate: "2026-11-16", cutoffDate: "2026-11-16", capturedAt: "2026-11-16",
  sourceHash: "source", targetHash: "target", sourceFrozen: true, totalsConfirmed: false,
  blockers: [], rows: [row, { ...structuredClone(row), key: "000002", code: "000002" },
    { ...structuredClone(row), key: "000003", code: "000003", handedOver: true }],
};
const edit = { ...structuredClone(row), prepayment: 50, customerId: "999", name: "forged" };
const input = { sourceFrozen: true, totalsConfirmed: false, rows: [edit] };
const merged = mergeDraft(original, input, true);
assert.equal(merged.rows[0]!.prepayment, 50);
assert.equal(merged.rows[0]!.customerId, "1");
assert.equal(merged.rows[0]!.name, "Test");
assert.deepEqual(merged.rows.slice(1), original.rows.slice(1));
assert.equal(original.rows[0]!.prepayment, 0);
assert.deepEqual(mergeDraft(original, { ...input, rows: [] }, true), original);
assert.throws(() => mergeDraft(original, input));
assert.throws(() => mergeDraft(original, { ...input, rows: [edit, edit] }, true));
assert.throws(() => mergeDraft(original, { ...input, rows: [{ ...edit, key: "unknown" }] }, true));
for (const invalid of [{ prepayment: 1.234 }, { addresses: [] }, { orders: [] }]) {
  assert.throws(() => mergeDraft(original, { ...input, rows: [{ ...edit, ...invalid }] }, true));
}
const locked = mergeDraft(original, { ...input, rows: [{ ...edit, key: "000003" }] }, true);
assert.deepEqual(locked.rows[2], original.rows[2]);
assert.deepEqual(mergeDraft(original, original), original);
console.log("Partial handover regression checks passed");
