import assert from "node:assert/strict";
import { handoverChanges, mergeHandoverSave } from "../../web-admin/src/handoverAutosave.js";

const row = { key: "A", version: "v1", included: true, reviewed: false, note: "", prepayment: 0,
  prepaidBarrels: 0, handedOver: false, name: "Customer A",
  addresses: [{ id: "addr", barrels: 0, label: "Source address" }],
  orders: [{ id: "order", disposition: "cash", finalAmount: 100, dueDate: "2026-11-16", invoiceMode: "none", note: "", outstanding: 100 }],
};
const base = { rows: [row, { ...structuredClone(row), key: "B" }] };
const sent = structuredClone(base);
sent.rows[0]!.reviewed = true;
sent.rows[0]!.note = " checked ";
assert.equal(handoverChanges(base, sent).length, 1);
assert.equal(handoverChanges(base, sent)[0]!.version, "v1");
const saved = structuredClone(sent);
saved.rows[0]!.version = "v2";
saved.rows[0]!.note = "checked"; // server normalization
saved.rows[1]!.handedOver = true; // another computer's completed customer
saved.rows[1]!.version = "B2";
assert.deepEqual(handoverChanges(saved, saved), []);

// A slow response must not erase subsequent edits, checkbox reversals or another customer's edits.
const latest = structuredClone(sent);
latest.rows[0]!.reviewed = false;
latest.rows[0]!.prepayment = 80;
latest.rows[0]!.addresses[0]!.barrels = 7;
latest.rows[0]!.orders[0]!.finalAmount = 90;
const submitted = new Set(["A"]);
const merged = mergeHandoverSave(sent, latest, saved, submitted);
assert.equal(merged.rows[0]!.version, "v2");
assert.equal(merged.rows[0]!.note, "checked");
assert.equal(merged.rows[0]!.reviewed, false);
assert.equal(merged.rows[0]!.prepayment, 80);
assert.equal(merged.rows[0]!.addresses[0]!.barrels, 7);
assert.equal(merged.rows[0]!.addresses[0]!.label, "Source address");
assert.equal(merged.rows[0]!.orders[0]!.finalAmount, 90);
assert.equal(merged.rows[0]!.orders[0]!.outstanding, 100);
assert.equal(merged.rows[1]!.handedOver, true);
assert.equal(handoverChanges(saved, merged)[0]!.version, "v2");
assert.equal(handoverChanges(saved, merged).length, 1);
assert.equal(saved.rows[0]!.prepayment, 0);
assert.equal(latest.rows[0]!.version, "v1");

// No typing after submission leaves no dirty edits, even when the server trims text.
assert.deepEqual(handoverChanges(saved, mergeHandoverSave(sent, sent, saved, submitted)), []);
// A submitted value reverted during the request must be sent again with the new version.
const reverted = mergeHandoverSave(sent, base, saved, submitted);
assert.equal(reverted.rows[0]!.note, "");
assert.equal(reverted.rows[0]!.reviewed, false);
assert.equal(handoverChanges(saved, reverted).length, 1);
// Editing B while A is being saved must not silently lose B if another computer completes it.
const lateOther = structuredClone(sent);
lateOther.rows[1]!.note = "new local edit";
assert.throws(() => mergeHandoverSave(sent, lateOther, saved, submitted), /客戶 B/);
const otherUpdated = structuredClone(saved);
otherUpdated.rows[1]!.handedOver = false;
assert.throws(() => mergeHandoverSave(sent, lateOther, otherUpdated, submitted), /客戶 B/);
assert.throws(() => mergeHandoverSave(sent, lateOther, { rows: saved.rows.slice(0, 1) }, submitted), /客戶 B/);
const otherUnchanged = structuredClone(saved);
otherUnchanged.rows[1] = structuredClone(sent.rows[1]!);
const lateMerged = mergeHandoverSave(sent, lateOther, otherUnchanged, submitted);
assert.equal(lateMerged.rows[1]!.note, "new local edit");
assert.equal(handoverChanges(otherUnchanged, lateMerged)[0]!.key, "B");
console.log("Handover autosave in-flight edit regression checks passed");
