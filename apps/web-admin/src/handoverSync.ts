type SyncSnapshot = {
  startDate: string; cutoffDate: string; capturedAt: string;
  sourceFrozen: boolean; totalsConfirmed: boolean;
  rows: { key: string; version?: string }[];
};

// Rebase only when every locally edited customer is unchanged on the server.
// Source data changes and completed customers must never be overwritten.
export function rebaseHandover<T extends SyncSnapshot>(base: T, local: T, remote: T): T | null {
  // Older servers have no customer versions: retain the conservative snapshot check.
  if (!base.rows.every(r => r.version) && (base.startDate !== remote.startDate || base.cutoffDate !== remote.cutoffDate || base.capturedAt !== remote.capturedAt)) return null;
  const before = new Map(base.rows.map(r => [r.key, JSON.stringify(r)]));
  const latest = new Map(remote.rows.map(r => [r.key, r]));
  const versions = new Map(base.rows.map(r => [r.key, r.version]));
  const edits = new Map(local.rows.filter(r => JSON.stringify(r) !== before.get(r.key)).map(r => [r.key, r]));
  for (const key of edits.keys()) {
    const row = latest.get(key);
    if (!row || (versions.get(key) ? row.version !== versions.get(key) : JSON.stringify(row) !== before.get(key))) return null;
  }
  return { ...remote,
    sourceFrozen: local.sourceFrozen !== base.sourceFrozen ? local.sourceFrozen : remote.sourceFrozen,
    totalsConfirmed: false,
    rows: remote.rows.map(r => edits.get(r.key) ?? r),
  };
}
