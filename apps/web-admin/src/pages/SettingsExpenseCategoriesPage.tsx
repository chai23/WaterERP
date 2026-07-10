import { useCallback, useEffect, useState } from "react";
import type { ExpenseCategory } from "../expenseUtils";

async function readJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string }> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (Array.isArray(body)) return { ok: res.ok, data: body as T };
  return { ok: res.ok && body?.ok !== false, data: body?.data as T, message: body?.message };
}

export default function SettingsExpenseCategoriesPage() {
  const [rows, setRows] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [newName, setNewName] = useState("");
  const [newSort, setNewSort] = useState("0");
  const [newRequiresCustomer, setNewRequiresCustomer] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSort, setEditSort] = useState("0");
  const [editRequiresCustomer, setEditRequiresCustomer] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await readJson<ExpenseCategory[]>("/api/expense-categories?all=1");
    setRows(
      (r.data ?? []).map((x) => ({
        ...x,
        id: String((x as ExpenseCategory & { id: string | number }).id),
      })),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const name = newName.trim();
    if (!name) {
      setMsg("請輸入類別名稱");
      return;
    }
    setSaving(true);
    const sortOrder = Math.floor(Number(newSort));
    const r = await readJson<ExpenseCategory>("/api/expense-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        requiresCustomer: newRequiresCustomer,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "新增失敗");
      return;
    }
    setNewName("");
    setNewSort("0");
    setNewRequiresCustomer(false);
    setMsg("已新增");
    await reload();
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editId) return;
    setSaving(true);
    const sortOrder = Math.floor(Number(editSort));
    const r = await readJson(`/api/expense-categories/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName.trim(),
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        requiresCustomer: editRequiresCustomer,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "儲存失敗");
      return;
    }
    setEditId(null);
    setMsg("已儲存");
    await reload();
  };

  const toggleActive = async (row: ExpenseCategory) => {
    await readJson(`/api/expense-categories/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    await reload();
  };

  const remove = async (row: ExpenseCategory) => {
    if (!window.confirm(`確定刪除「${row.name}」？`)) return;
    const r = await readJson(`/api/expense-categories/${row.id}`, { method: "DELETE" });
    if (!r.ok) setMsg(r.message ?? "刪除失敗");
    else {
      setMsg("已刪除");
      await reload();
    }
  };

  return (
    <section className="settings-stack">
      <div className="page-card">
        <div className="page-card__header">
          <div>
            <h2>支出類別設定</h2>
            <p>維護公司支出類別；「須選客戶」用於退押金等需關聯客戶的項目。</p>
          </div>
        </div>

        <form onSubmit={create} className="form-grid form-grid--wide" style={{ marginBottom: "1rem" }}>
          <label className="field">
            <span>類別名稱</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} disabled={saving} />
          </label>
          <label className="field">
            <span>排序</span>
            <input type="number" value={newSort} onChange={(e) => setNewSort(e.target.value)} disabled={saving} />
          </label>
          <label className="field">
            <span>須選客戶</span>
            <input type="checkbox" checked={newRequiresCustomer} onChange={(e) => setNewRequiresCustomer(e.target.checked)} disabled={saving} />
          </label>
          <div className="field field--actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>新增</button>
          </div>
        </form>

        {msg ? <div className={`alert ${msg.includes("失敗") ? "alert--error" : "alert--success"}`}>{msg}</div> : null}
        {loading ? <p className="text-muted">讀取中…</p> : null}

        <div className="table-wrap">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>名稱</th>
                <th>排序</th>
                <th>須選客戶</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                editId === row.id ? (
                  <tr key={row.id}>
                    <td colSpan={5}>
                      <form onSubmit={saveEdit} className="inline-actions">
                        <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                        <input type="number" value={editSort} onChange={(e) => setEditSort(e.target.value)} style={{ width: "4rem" }} />
                        <label>
                          <input type="checkbox" checked={editRequiresCustomer} onChange={(e) => setEditRequiresCustomer(e.target.checked)} />
                          須選客戶
                        </label>
                        <button type="submit" className="btn btn--primary btn--sm">儲存</button>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditId(null)}>取消</button>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.sortOrder ?? 0}</td>
                    <td>{row.requiresCustomer ? "是" : "—"}</td>
                    <td>{row.isActive !== false ? "啟用" : "停用"}</td>
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setEditId(row.id);
                            setEditName(row.name);
                            setEditSort(String(row.sortOrder ?? 0));
                            setEditRequiresCustomer(Boolean(row.requiresCustomer));
                          }}
                        >
                          編輯
                        </button>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void toggleActive(row)}>
                          {row.isActive !== false ? "停用" : "啟用"}
                        </button>
                        <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove(row)}>
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
