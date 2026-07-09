import { useCallback, useEffect, useState } from "react";
import type { PrintSlogan } from "../components/RemarkSloganPicker";

async function readJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string }> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (Array.isArray(body)) return { ok: res.ok, data: body as T };
  return { ok: res.ok && body?.ok !== false, data: body?.data as T, message: body?.message };
}

export default function SettingsPrintSlogansPage() {
  const [rows, setRows] = useState<PrintSlogan[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", sortOrder: "0" });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", body: "", sortOrder: "0" });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await readJson<PrintSlogan[]>("/api/print-slogans?all=1");
    setRows(res.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const title = form.title.trim();
    const body = form.body.trim();
    if (!title || !body) {
      setMsg("請填寫名稱與內容");
      return;
    }
    setSaving(true);
    const res = await readJson<PrintSlogan>("/api/print-slogans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, sortOrder: Math.floor(Number(form.sortOrder)) || 0 }),
    });
    setSaving(false);
    if (!res.ok) {
      setMsg(res.message ?? "新增失敗");
      return;
    }
    setForm({ title: "", body: "", sortOrder: "0" });
    setMsg("已新增標語");
    await load();
  };

  const onSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editId) return;
    setMsg("");
    const title = editForm.title.trim();
    const body = editForm.body.trim();
    if (!title || !body) {
      setMsg("請填寫名稱與內容");
      return;
    }
    setSaving(true);
    const res = await readJson<PrintSlogan>(`/api/print-slogans/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, sortOrder: Math.floor(Number(editForm.sortOrder)) || 0 }),
    });
    setSaving(false);
    if (!res.ok) {
      setMsg(res.message ?? "儲存失敗");
      return;
    }
    setEditId(null);
    setMsg("已儲存");
    await load();
  };

  const toggleActive = async (row: PrintSlogan) => {
    setMsg("");
    const res = await readJson<PrintSlogan>(`/api/print-slogans/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    if (!res.ok) {
      setMsg(res.message ?? "更新失敗");
      return;
    }
    await load();
  };

  const onDelete = async (row: PrintSlogan) => {
    if (!window.confirm(`確定刪除「${row.title}」？`)) return;
    setMsg("");
    const res = await readJson(`/api/print-slogans/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      setMsg(res.message ?? "刪除失敗");
      return;
    }
    setMsg("已刪除");
    await load();
  };

  return (
    <section className="page-card">
      <div className="page-card__header">
        <div>
          <h2>套印標語</h2>
          <p>
            維護新增訂單時可快速選取的備註片語（原舊系統以虛擬商品列印的文字，如保管提醒、調漲通知等）。
            選取後會寫入訂單備註，並可隨訂單列印。
          </p>
        </div>
      </div>

      <form className="form-grid form-grid--wide" onSubmit={onCreate}>
        <div className="field">
          <span>顯示名稱（按鈕文字）</span>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} disabled={saving} required />
        </div>
        <div className="field">
          <span>排序</span>
          <input type="number" step={1} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} disabled={saving} />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <span>完整內容（寫入訂單備註）</span>
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={2} disabled={saving} required />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
            {saving ? "新增中…" : "新增標語"}
          </button>
        </div>
      </form>

      {msg ? <div className={msg.includes("失敗") ? "alert alert--error" : "alert alert--success"}>{msg}</div> : null}

      {loading ? <p className="card__hint">讀取中…</p> : null}

      <div className="table-wrap">
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              <th>排序</th>
              <th>名稱</th>
              <th>內容</th>
              <th>狀態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{r.sortOrder ?? 0}</td>
                <td>{r.title}</td>
                <td style={{ maxWidth: "28rem", whiteSpace: "pre-wrap" }}>{r.body}</td>
                <td>{r.isActive !== false ? <span className="badge badge--completed">啟用</span> : <span className="badge badge--cancelled">停用</span>}</td>
                <td>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        setEditId(String(r.id));
                        setEditForm({ title: r.title, body: r.body, sortOrder: String(r.sortOrder ?? 0) });
                      }}
                    >
                      編輯
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => void toggleActive(r)}>
                      {r.isActive !== false ? "停用" : "啟用"}
                    </button>
                    <button type="button" className="btn btn--danger btn--sm" onClick={() => void onDelete(r)}>
                      刪除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={5}>尚無標語</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editId ? (
        <form onSubmit={onSaveEdit} className="form-grid form-grid--wide customer-address-edit-panel" style={{ marginTop: "1rem" }}>
          <h4 className="customer-address-edit-panel__title">編輯標語</h4>
          <div className="form-row-2">
            <div className="field">
              <span>顯示名稱</span>
              <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="field">
              <span>排序</span>
              <input type="number" step={1} value={editForm.sortOrder} onChange={(e) => setEditForm({ ...editForm, sortOrder: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <span>完整內容</span>
            <textarea value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} rows={3} required />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
              儲存
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditId(null)}>
              取消
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
