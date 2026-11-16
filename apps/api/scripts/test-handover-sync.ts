import assert from "node:assert/strict";
import { rebaseHandover } from "../../web-admin/src/handoverSync.js";

const base = {
  startDate: "2026-11-16", cutoffDate: "2026-11-16", capturedAt: "2026-11-16T00:00:00Z",
  sourceFrozen: false, totalsConfirmed: false,
  rows: [{ key: "A", prepayment: 0, handedOver: false }, { key: "B", prepayment: 0, handedOver: false }],
};
const local = structuredClone(base);
local.rows[0]!.prepayment = 100;
const remote = structuredClone(base);
remote.rows[1]!.handedOver = true;
const merged = rebaseHandover(base, local, remote)!;
assert.equal(merged.rows[0]!.prepayment, 100);
assert.equal(merged.rows[1]!.handedOver, true);
assert.equal(base.rows[0]!.prepayment, 0);
assert.equal(remote.rows[0]!.prepayment, 0);
assert.equal(merged.totalsConfirmed, false);
const conflict = structuredClone(remote);
conflict.rows[0]!.handedOver = true;
assert.equal(rebaseHandover(base, local, conflict), null);
conflict.rows[0]!.handedOver = false;
conflict.rows[0]!.prepayment = 200;
assert.equal(rebaseHandover(base, local, conflict), null);
assert.equal(rebaseHandover(base, local, { ...remote, rows: remote.rows.slice(1) }), null);
assert.equal(rebaseHandover(base, local, { ...remote, capturedAt: "new capture" }), null);
const added = rebaseHandover(base, local, { ...remote, rows: [...remote.rows, { key: "C", prepayment: 0, handedOver: false }] })!;
assert.equal(added.rows.length, 3);
assert.equal(added.rows[0]!.prepayment, 100);
console.log("Multi-computer handover merge regression checks passed");
