import { useCallback, useEffect, useState } from "react";
import type { CustomerMasterOption } from "../adminUtils";

type MasterRow = CustomerMasterOption;

async function readJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string }> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (Array.isArray(body)) return { ok: res.ok, data: body as T };
  return { ok: res.ok && body?.ok !== false, data: body?.data as T, message: body?.message };
}

function MasterSection({
  title,
  hint,
  rows,
  loading,
  nameLabel,
  onReload,
  onCreate,
  onPatch,
  onDelete,
}: {
  title: string;
  hint: string;
  rows: MasterRow[];
  loading: boolean;
  nameLabel: string;
  onReload: () => void;
  onCreate: (name: string, sortOrder: number) => Promise<string | null>;
  onPatch: (id: string, patch: { name?: string; sortOrder?: number; isActive?: boolean }) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [newName, setNewName] = useState("");
  const [newSort, setNewSort] = useState("0");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSort, setEditSort] = useState("0");

  const startEdit = (r: MasterRow) => {
    setEditId(String(r.id));
    setEditName(r.name);
    setEditSort(String(r.sortOrder ?? 0));
    setMsg("");
  };

  const onSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const name = newName.trim();
    if (!name) {
      setMsg("請輸入名稱");
      return;
    }
    const sortOrder = Math.floor(Number(newSort));
    setSaving(true);
    const err = await onCreate(name, Number.isFinite(sortOrder) ? sortOrder : 0);
    setSaving(false);
    if (err) {
      setMsg(err);
      return;
    }
    setNewName("");
    setNewSort("0");
    setMsg("已新增");
    onReload();
  };

  const onSubmitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editId) return;
    setMsg("");
    const name = editName.trim();
    if (!name) {
      setMsg("名稱不可為空");
      return;
    }
    const sortOrder = Math.floor(Number(editSort));
    setSaving(true);
    const err = await onPatch(editId, {
      name,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    });
    setSaving(false);
    if (err) {
      setMsg(err);
      return;
    }
    setEditId(null);
    setMsg("已儲存");
    onReload();
  };

  return (
    <section className="card">
      <h2 className="card__title">{title}</h2>
      <p className="card__hint">{hint}</p>

      <form onSubmit={onSubmitCreate} className="form-grid form-grid--wide" style={{ marginBottom: "1rem" }}>
        <div className="field">
          <span>{nameLabel}（必填）</span>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={saving} />
        </div>
        <div className="field">
          <span>排序（數字越小越前面）</span>
          <input type="number" step={1} value={newSort} onChange={(e) => setNewSort(e.target.value)} disabled={saving} />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
            {saving ? "新增中…" : "新增"}
          </button>
        </div>
      </form>

      {loading ? <p className="card__hint">讀取中…</p> : null}

      <div className="table-wrap master-table-wrap">
        <table className="data-table data-table--compact data-table--no-card master-table">
          <thead>
            <tr>
              <th>排序</th>
              <th>名稱</th>
              <th>狀態</th>
              <th className="master-table__actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={r.isActive === false ? "text-muted" : undefined}>
                <td className="num">{r.sortOrder ?? 0}</td>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td>{r.isActive === false ? "已停用" : "使用中"}</td>
                <td className="master-table__actions-col">
                  <div className="master-table__actions">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => startEdit(r)}>
                      編輯
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={saving}
                      onClick={() => {
                        void (async () => {
                          const next = !(r.isActive !== false);
                          setSaving(true);
                          const err = await onPatch(String(r.id), { isActive: next });
                          setSaving(false);
                          if (err) window.alert(err);
                          else onReload();
                        })();
                      }}
                    >
                      {r.isActive === false ? "啟用" : "停用"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={saving}
                      onClick={() => {
                        if (!window.confirm(`確定刪除「${r.name}」？\n\n若仍有客戶使用將無法刪除。`)) return;
                        void (async () => {
                          setSaving(true);
                          const err = await onDelete(String(r.id));
                          setSaving(false);
                          if (err) window.alert(err);
                          else onReload();
                        })();
                      }}
                    >
                      刪除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !loading ? <p className="card__hint">尚無資料，請先新增。</p> : null}

      {editId ? (
        <form onSubmit={onSubmitEdit} className="form-grid form-grid--wide customer-address-edit-panel" style={{ marginTop: "1rem" }}>
          <h4 className="customer-address-edit-panel__title">編輯</h4>
          <div className="form-row-2">
            <div className="field">
              <span>{nameLabel}</span>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </div>
            <div className="field">
              <span>排序</span>
              <input type="number" step={1} value={editSort} onChange={(e) => setEditSort(e.target.value)} />
            </div>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
              儲存
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditId(null)} disabled={saving}>
              取消
            </button>
          </div>
        </form>
      ) : null}

      {msg ? (
        <p className={msg.includes("已") ? "feedback feedback--ok" : "feedback feedback--err"} style={{ marginTop: "0.75rem" }}>
          {msg}
        </p>
      ) : null}
    </section>
  );
}

export default function SettingsCustomerMastersPage() {
  const [zones, setZones] = useState<MasterRow[]>([]);
  const [companies, setCompanies] = useState<MasterRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [zRes, cRes] = await Promise.all([
        fetch("/api/address-zones?all=1"),
        fetch("/api/affiliated-companies?all=1"),
      ]);
      const zJson = await zRes.json();
      const cJson = await cRes.json();
      const norm = (arr: unknown[]): MasterRow[] =>
        arr.map((x) => {
          const r = x as Record<string, unknown>;
          return {
            id: String(r.id),
            name: String(r.name ?? ""),
            sortOrder: Number(r.sortOrder ?? 0),
            isActive: r.isActive !== false,
          };
        });
      setZones(Array.isArray(zJson) ? norm(zJson) : []);
      setCompanies(Array.isArray(cJson) ? norm(cJson) : []);
    } catch {
      setZones([]);
      setCompanies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <>
      <section className="card">
        <h2 className="card__title">客戶主檔選項</h2>
        <p className="card__hint">
          在此維護<strong>地址分區</strong>與<strong>隸屬公司</strong>清單；「客戶資料」頁面會以下拉選單供選取。已停用的項目不會出現在新客戶選單，但既有客戶仍會顯示原設定。
        </p>
      </section>

      <MasterSection
        title="地址分區"
        hint="例如：北區、南區、A 線。客戶可選一個分區供路線分配或報表篩選。"
        rows={zones}
        loading={loading}
        nameLabel="分區名稱"
        onReload={() => void loadAll()}
        onCreate={async (name, sortOrder) => {
          const r = await readJson<MasterRow>("/api/address-zones", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, sortOrder }),
          });
          return r.ok ? null : (r.message ?? "新增失敗");
        }}
        onPatch={async (id, patch) => {
          const r = await readJson<MasterRow>(`/api/address-zones/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          return r.ok ? null : (r.message ?? "更新失敗");
        }}
        onDelete={async (id) => {
          const res = await fetch(`/api/address-zones/${id}`, { method: "DELETE" });
          const body = await res.json();
          return res.ok && body?.ok !== false ? null : (body?.message ?? "刪除失敗");
        }}
      />

      <MasterSection
        title="隸屬公司"
        hint="客戶所屬的公司或品牌；可多筆主檔供下拉選擇。"
        rows={companies}
        loading={loading}
        nameLabel="公司名稱"
        onReload={() => void loadAll()}
        onCreate={async (name, sortOrder) => {
          const r = await readJson<MasterRow>("/api/affiliated-companies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, sortOrder }),
          });
          return r.ok ? null : (r.message ?? "新增失敗");
        }}
        onPatch={async (id, patch) => {
          const r = await readJson<MasterRow>(`/api/affiliated-companies/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          return r.ok ? null : (r.message ?? "更新失敗");
        }}
        onDelete={async (id) => {
          const res = await fetch(`/api/affiliated-companies/${id}`, { method: "DELETE" });
          const body = await res.json();
          return res.ok && body?.ok !== false ? null : (body?.message ?? "刪除失敗");
        }}
      />
    </>
  );
}
