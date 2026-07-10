import { useCallback, useEffect, useMemo, useState } from "react";
import { DesktopOnlyNotice } from "../components/DesktopOnlyNotice";
import { todayLocalYmd } from "../adminUtils";

type AnnouncementKind = "standing" | "period";

type OrderAnnouncement = {
  id: string;
  title: string;
  body: string;
  kind: AnnouncementKind;
  startsOn?: string | null;
  endsOn?: string | null;
  sortOrder?: number;
  isActive?: boolean;
};

async function readJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string; text?: string }> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (Array.isArray(body)) return { ok: res.ok, data: body as T };
  return {
    ok: res.ok && body?.ok !== false,
    data: body?.data as T,
    message: body?.message,
    text: body?.text,
  };
}

function kindLabel(kind: string): string {
  return kind === "period" ? "特定期間" : "全站";
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

export default function SettingsOrderAnnouncementsPage() {
  const [rows, setRows] = useState<OrderAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewDate, setPreviewDate] = useState(todayLocalYmd);
  const [previewText, setPreviewText] = useState("");
  const [form, setForm] = useState({
    title: "",
    body: "",
    kind: "standing" as AnnouncementKind,
    startsOnYmd: "",
    endsOnYmd: "",
    sortOrder: "0",
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    title: "",
    body: "",
    kind: "standing" as AnnouncementKind,
    startsOnYmd: "",
    endsOnYmd: "",
    sortOrder: "0",
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await readJson<OrderAnnouncement[]>("/api/order-announcements?all=1");
    setRows(res.data ?? []);
    setLoading(false);
  }, []);

  const loadPreview = useCallback(async (date: string) => {
    const res = await readJson<never>(`/api/order-announcements/resolved?date=${encodeURIComponent(date)}`);
    setPreviewText(res.text?.trim() ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadPreview(previewDate);
  }, [previewDate, loadPreview, rows]);

  const activeStanding = useMemo(() => rows.filter((r) => r.kind === "standing" && r.isActive !== false), [rows]);

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
    const res = await readJson<OrderAnnouncement>("/api/order-announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        kind: form.kind,
        startsOnYmd: form.kind === "period" ? form.startsOnYmd : undefined,
        endsOnYmd: form.kind === "period" ? form.endsOnYmd : undefined,
        sortOrder: Math.floor(Number(form.sortOrder)) || 0,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setMsg(res.message ?? "新增失敗");
      return;
    }
    setForm({ title: "", body: "", kind: "standing", startsOnYmd: "", endsOnYmd: "", sortOrder: "0" });
    setMsg("已新增公告");
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
    const res = await readJson<OrderAnnouncement>(`/api/order-announcements/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        kind: editForm.kind,
        startsOnYmd: editForm.kind === "period" ? editForm.startsOnYmd : null,
        endsOnYmd: editForm.kind === "period" ? editForm.endsOnYmd : null,
        sortOrder: Math.floor(Number(editForm.sortOrder)) || 0,
      }),
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

  const toggleActive = async (row: OrderAnnouncement) => {
    setMsg("");
    const res = await readJson<OrderAnnouncement>(`/api/order-announcements/${row.id}`, {
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

  const onDelete = async (row: OrderAnnouncement) => {
    if (!window.confirm(`確定刪除「${row.title}」？`)) return;
    setMsg("");
    const res = await readJson(`/api/order-announcements/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      setMsg(res.message ?? "刪除失敗");
      return;
    }
    setMsg("已刪除");
    await load();
  };

  return (
    <section className="page-card">
      <DesktopOnlyNotice feature="訂單公告維護" />
      <div className="page-card__header">
        <div>
          <h2>訂單公告</h2>
          <p>
            設定套印在<strong>每張訂單</strong>上的公告文字（對應「訂單列印版面」的「公告」欄位）。
            <strong>全站</strong>公告長期生效；<strong>特定期間</strong>公告僅在起迄日內、且訂單配送日落在該區間時套印。
            多則公告會依排序合併（期間公告在前、全站在後）。
          </p>
        </div>
      </div>

      <div className="card card--nested" style={{ marginBottom: "1rem" }}>
        <h3 className="card__title" style={{ fontSize: "0.95rem" }}>預覽：某日套印結果</h3>
        <div className="field-row" style={{ alignItems: "flex-end", gap: "0.75rem", flexWrap: "wrap" }}>
          <div className="field">
            <span>參考配送日</span>
            <input type="date" value={previewDate} onChange={(e) => setPreviewDate(e.target.value)} />
          </div>
          <p className="card__hint" style={{ margin: 0 }}>
            目前啟用中全站公告 {activeStanding.length} 則
          </p>
        </div>
        <pre
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem",
            background: "var(--bg-soft)",
            borderRadius: "var(--radius-sm)",
            whiteSpace: "pre-wrap",
            fontSize: "0.9rem",
          }}
        >
          {previewText || "（此日無生效公告）"}
        </pre>
      </div>

      <form className="form-grid form-grid--wide" onSubmit={onCreate}>
        <div className="field">
          <span>識別名稱（僅後台顯示）</span>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} disabled={saving} required />
        </div>
        <div className="field">
          <span>類型</span>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AnnouncementKind })} disabled={saving}>
            <option value="standing">全站（長期）</option>
            <option value="period">特定期間</option>
          </select>
        </div>
        {form.kind === "period" ? (
          <>
            <div className="field">
              <span>起日（含）</span>
              <input type="date" value={form.startsOnYmd} onChange={(e) => setForm({ ...form, startsOnYmd: e.target.value })} required disabled={saving} />
            </div>
            <div className="field">
              <span>迄日（含）</span>
              <input type="date" value={form.endsOnYmd} onChange={(e) => setForm({ ...form, endsOnYmd: e.target.value })} required disabled={saving} />
            </div>
          </>
        ) : null}
        <div className="field">
          <span>排序（小者先印）</span>
          <input type="number" step={1} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} disabled={saving} />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <span>公告全文（印在訂單上）</span>
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={3} disabled={saving} required />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
            {saving ? "新增中…" : "新增公告"}
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
              <th>類型</th>
              <th>名稱</th>
              <th>期間</th>
              <th>內容</th>
              <th>狀態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{r.sortOrder ?? 0}</td>
                <td><span className="badge badge--default">{kindLabel(r.kind)}</span></td>
                <td>{r.title}</td>
                <td className="cell-nowrap">
                  {r.kind === "period" ? `${fmtDate(r.startsOn)} ~ ${fmtDate(r.endsOn)}` : "—"}
                </td>
                <td style={{ maxWidth: "24rem", whiteSpace: "pre-wrap" }}>{r.body}</td>
                <td>{r.isActive !== false ? <span className="badge badge--completed">啟用</span> : <span className="badge badge--cancelled">停用</span>}</td>
                <td>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        setEditId(String(r.id));
                        setEditForm({
                          title: r.title,
                          body: r.body,
                          kind: r.kind,
                          startsOnYmd: fmtDate(r.startsOn) === "—" ? "" : fmtDate(r.startsOn),
                          endsOnYmd: fmtDate(r.endsOn) === "—" ? "" : fmtDate(r.endsOn),
                          sortOrder: String(r.sortOrder ?? 0),
                        });
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
                <td colSpan={7}>尚無公告</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editId ? (
        <form onSubmit={onSaveEdit} className="form-grid form-grid--wide customer-address-edit-panel" style={{ marginTop: "1rem" }}>
          <h4 className="customer-address-edit-panel__title">編輯公告</h4>
          <div className="form-row-2">
            <div className="field">
              <span>識別名稱</span>
              <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="field">
              <span>類型</span>
              <select value={editForm.kind} onChange={(e) => setEditForm({ ...editForm, kind: e.target.value as AnnouncementKind })}>
                <option value="standing">全站（長期）</option>
                <option value="period">特定期間</option>
              </select>
            </div>
          </div>
          {editForm.kind === "period" ? (
            <div className="form-row-2">
              <div className="field">
                <span>起日（含）</span>
                <input type="date" value={editForm.startsOnYmd} onChange={(e) => setEditForm({ ...editForm, startsOnYmd: e.target.value })} required />
              </div>
              <div className="field">
                <span>迄日（含）</span>
                <input type="date" value={editForm.endsOnYmd} onChange={(e) => setEditForm({ ...editForm, endsOnYmd: e.target.value })} required />
              </div>
            </div>
          ) : null}
          <div className="field">
            <span>排序</span>
            <input type="number" step={1} value={editForm.sortOrder} onChange={(e) => setEditForm({ ...editForm, sortOrder: e.target.value })} />
          </div>
          <div className="field">
            <span>公告全文</span>
            <textarea value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} rows={4} required />
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
