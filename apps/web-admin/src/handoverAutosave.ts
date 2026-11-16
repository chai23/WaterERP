type EditableOrder = { id: string; disposition: string; finalAmount: number; dueDate: string; invoiceMode: string; note: string };
type EditableRow = { key: string; version: string; included: boolean; note: string; reviewed: boolean;
  prepayment: number | null; prepaidBarrels: number; handedOver?: boolean;
  addresses: { id: string; barrels: number }[]; orders: EditableOrder[] };
type EditableSnapshot = { rows: EditableRow[] };

export const editableHandoverRow = (r: EditableRow) => ({
  key: r.key, included: r.included, note: r.note, reviewed: r.reviewed,
  prepayment: r.prepayment, prepaidBarrels: r.prepaidBarrels,
  addresses: r.addresses.map(a => ({ id: a.id, barrels: a.barrels })),
  orders: r.orders.map(o => ({ id: o.id, disposition: o.disposition, finalAmount: o.finalAmount,
    dueDate: o.dueDate, invoiceMode: o.invoiceMode, note: o.note })),
});

export function handoverChanges(base: EditableSnapshot, draft: EditableSnapshot) {
  const previous = new Map(base.rows.map(r => [r.key, r]));
  return draft.rows.filter(r => !r.handedOver)
    .filter(r => JSON.stringify(editableHandoverRow(r)) !== (previous.has(r.key) ? JSON.stringify(editableHandoverRow(previous.get(r.key)!)) : undefined))
    .map(r => ({ ...editableHandoverRow(r), version: previous.get(r.key)?.version ?? r.version }));
}

// A save response acknowledges the submitted draft, not edits typed while it was in flight.
// Overlay only subsequent editable-field changes, keeping server versions and normalized values.
export function mergeHandoverSave<T extends EditableSnapshot>(sent: T, local: T, saved: T, submittedKeys: ReadonlySet<string>): T {
  const before = new Map(sent.rows.map(r => [r.key, r]));
  const current = new Map(local.rows.map(r => [r.key, r]));
  const server = new Map(saved.rows.map(r => [r.key, r]));
  for (const edit of handoverChanges(sent, local)) {
    const row = server.get(edit.key);
    if (!row || row.handedOver || (!submittedKeys.has(edit.key) && row.version !== before.get(edit.key)?.version)) {
      throw new Error(`客戶 ${edit.key} 在儲存期間被其他電腦修改或完成交接。尚未儲存的修改仍保留，請先核對同步提示。`);
    }
  }
  return { ...saved, rows: saved.rows.map(row => {
    const old = before.get(row.key), next = current.get(row.key);
    if (!old || !next || row.handedOver) return row;
    const result = { ...row };
    for (const key of ["included", "note", "reviewed", "prepayment", "prepaidBarrels"] as const) {
      if (next[key] !== old[key]) Object.assign(result, { [key]: next[key] });
    }
    const oldAddresses = new Map(old.addresses.map(a => [a.id, a]));
    const newAddresses = new Map(next.addresses.map(a => [a.id, a]));
    result.addresses = row.addresses.map(a => {
      const prev = oldAddresses.get(a.id), now = newAddresses.get(a.id);
      return prev && now && prev.barrels !== now.barrels ? { ...a, barrels: now.barrels } : a;
    });
    const oldOrders = new Map(old.orders.map(o => [o.id, o]));
    const newOrders = new Map(next.orders.map(o => [o.id, o]));
    result.orders = row.orders.map(o => {
      const prev = oldOrders.get(o.id), now = newOrders.get(o.id);
      if (!prev || !now) return o;
      const order = { ...o };
      for (const key of ["disposition", "finalAmount", "dueDate", "invoiceMode", "note"] as const) {
        if (now[key] !== prev[key]) Object.assign(order, { [key]: now[key] });
      }
      return order;
    });
    return result;
  }) };
}
