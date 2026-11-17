import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { permissionCatalog as catalog, refreshMenuPermissions } from "../rolePermissions";

type Matrix = Record<string, Record<string, boolean>>;
type Settings = { revision: number; matrix: Matrix; defaults: Matrix };
const roles = [
  { key: "admin", label: "管理員" }, { key: "accounting", label: "會計" },
  { key: "dispatcher", label: "調度／後台" }, { key: "warehouse", label: "倉管" }, { key: "driver", label: "司機" },
];
const locked = (role: string, key: string) => role === "admin" || role === "driver" || key === "settings.permissions";
async function request(init?: RequestInit): Promise<Settings> {
  const res = await fetch("/api/settings/permissions", init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? "權限設定操作失敗");
  return data;
}
export default function SettingsPermissionsPage() {
  const { user } = useAuth();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Matrix | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const dirty = Boolean(saved && draft && JSON.stringify(saved.matrix) !== JSON.stringify(draft));
  const changes = saved && draft ? roles.reduce((total, role) => total + catalog.filter(m => saved.matrix[role.key]?.[m.key] !== draft[role.key]?.[m.key]).length, 0) : 0;
  const load = async () => {
    setBusy(true); setError(""); setMessage("");
    try { const data = await request(); setSaved(data); setDraft(structuredClone(data.matrix)); }
    catch (e) { setError(e instanceof Error ? e.message : "讀取失敗"); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (user?.role === "admin") void load(); }, [user?.role]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const toggle = (role: string, key: string, checked: boolean) => {
    setDraft(prev => prev ? { ...prev, [role]: { ...prev[role], [key]: checked } } : prev);
    setMessage("");
  };
  const save = async () => {
    if (!saved || !draft) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: saved.revision, matrix: draft }) });
      setSaved({ ...saved, ...data }); setDraft(structuredClone(data.matrix));
      setMessage("已儲存權限。後端立即套用；使用者重新整理頁面或稍候，選單即會更新。");
      await refreshMenuPermissions();
    } catch (e) { setError(e instanceof Error ? e.message : "儲存失敗"); }
    finally { setBusy(false); }
  };
  if (user?.role !== "admin") return <div className="alert alert--error">僅管理員可管理角色權限。</div>;
  const groups = [...new Set(catalog.map(m => m.group))];
  return <section className="settings-stack">
    <div className="page-card">
      <div className="page-card__header"><div><h2>權限設定</h2><p>依後台 38 個選單功能設定各角色可使用的範圍，勾選後按「儲存權限」。</p></div><Link className="btn btn--secondary" to="/data/users">管理使用者</Link></div>
      <p>允許代表可進入該功能並執行其中的作業；已核銷不可修改等資料規則仍適用。功能需要的共用查詢資料也會開放讀取。</p>
      <p>管理員保留全部權限；「權限設定」限管理員使用。司機只使用司機端，不開放後台選單。</p>
      <div className="inline-actions">
        <label>搜尋功能 <input value={search} onChange={e => setSearch(e.target.value)} placeholder="輸入分類或功能名稱" /></label>
        <button type="button" className="btn btn--primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "處理中…" : `儲存權限${changes ? `（${changes} 項變更）` : ""}`}</button>
        <button type="button" className="btn btn--secondary" disabled={!dirty || busy} onClick={() => { setDraft(structuredClone(saved!.matrix)); setMessage(""); }}>取消修改</button>
        <button type="button" className="btn btn--secondary" disabled={!saved || busy} onClick={() => { setDraft(structuredClone(saved!.defaults)); setMessage("已載入預設值，按儲存權限後才會生效。"); }}>載入預設值</button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("重新載入會放棄尚未儲存的修改，是否繼續？")) void load(); }}>重新載入</button>
      </div>
      {saved && <p>版本 {saved.revision} · {dirty ? "有尚未儲存的修改" : "已與儲存設定同步"}</p>}
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      {message && <div className="alert alert--success" role="status">{message}</div>}
    </div>
    {draft && <div className="page-card"><div className="table-wrap"><table className="data-table permission-table data-table--no-card">
      <thead><tr><th>功能</th>{roles.map(role => <th key={role.key}>{role.label}</th>)}</tr></thead>
      <tbody>{groups.map(group => {
        const entries = catalog.filter(m => m.group === group && `${m.group} ${m.label}`.includes(search.trim()));
        if (!entries.length) return null;
        return <Fragment key={group}><tr><th colSpan={6}>{group}（{entries.length}）</th></tr>{entries.map(m => <tr key={m.key}>
          <td>{m.label}</td>{roles.map(role => <td key={role.key}>{locked(role.key, m.key)
            ? <span className={`perm-mark perm-mark--${draft[role.key][m.key] ? "on" : "off"}`}>{draft[role.key][m.key] ? "固定允許" : "固定限制"}</span>
            : <label><input type="checkbox" aria-label={`${role.label}：${m.label}`} checked={draft[role.key][m.key]} disabled={busy} onChange={e => toggle(role.key, m.key, e.target.checked)} /> {draft[role.key][m.key] ? "允許" : "限制"}</label>}</td>)}
        </tr>)}</Fragment>;
      })}</tbody>
    </table></div>{!catalog.some(m => `${m.group} ${m.label}`.includes(search.trim())) && <p>沒有符合的功能。</p>}</div>}
  </section>;
}
