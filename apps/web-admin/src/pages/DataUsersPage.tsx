import { canAccessPath } from "../rolePermissions";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useAuth, type AuthUser } from "../AuthContext";

const roleLabel: Record<string, string> = {
  admin: "管理員",
  accounting: "會計",
  dispatcher: "調度/後台",
  warehouse: "倉管",
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) throw new Error(payload?.message ?? `HTTP ${res.status}`);
  return payload as T;
}

export default function DataUsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", employeeCode: "", phone: "", role: "dispatcher", password: "" });
  const [roleByUser, setRoleByUser] = useState<Record<string, string>>({});
  const [updating, setUpdating] = useState(false);
  const [passwordByUser, setPasswordByUser] = useState<Record<string, string>>({});

  const loadUsers = async () => {
    try {
      const payload = await apiJson<{ ok: boolean; data: AuthUser[] }>("/api/users");
      setUsers((payload.data ?? []).filter((u) => u.role !== "driver"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "讀取使用者失敗");
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  const createUser = async (e: FormEvent) => {
    e.preventDefault();
    setMessage("");
    setSaving(true);
    try {
      await apiJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({ name: "", employeeCode: "", phone: "", role: "dispatcher", password: "" });
      setMessage("已新增使用者");
      await loadUsers();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "新增失敗");
    } finally {
      setSaving(false);
    }
  };

  const patchUser = async (id: string, patch: Record<string, unknown>) => {
    setMessage("");
    setUpdating(true);
    try {
      await apiJson(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setMessage("已更新使用者");
      await loadUsers();
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "更新失敗");
      return false;
    } finally {
      setUpdating(false);
    }
  };

  const saveRole = async (u: AuthUser) => {
    const role = roleByUser[u.id] ?? u.role;
    if (role === u.role) return;
    if (await patchUser(u.id, { role })) {
      setRoleByUser(prev => { const next = { ...prev }; delete next[u.id]; return next; });
      setMessage(`已儲存 ${u.name} 的角色：${roleLabel[role]}`);
    }
  };

  const resetPassword = async (u: AuthUser) => {
    const password = passwordByUser[u.id] ?? "";
    if (!password) {
      setMessage("請輸入新密碼");
      return;
    }
    if (!await patchUser(u.id, { password })) return;
    setPasswordByUser((prev) => ({ ...prev, [u.id]: "" }));
  };

  return (
    <section className="page-card">
      <div className="page-card__header">
        <div>
          <h2>使用者資料</h2>
          <p>維護後台登入帳號、角色、啟用狀態與密碼。司機帳號請至「司機資料」頁面管理。</p>
        </div>
      </div>

      {!canAccessPath(currentUser?.role, "/data/users") ? (
        <div className="alert alert--error">沒有維護使用者的權限。</div>
      ) : (
        <>
          <form className="form-grid" onSubmit={createUser}>
            <label className="field">
              <span>姓名</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span>帳號 / 員編</span>
              <input value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value.toUpperCase() })} required />
            </label>
            <label className="field">
              <span>手機</span>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <label className="field">
              <span>角色</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="dispatcher">調度/後台</option>
                <option value="warehouse">倉管</option>
                <option value="accounting">會計</option>
                <option value="admin">管理員</option>
              </select>
            </label>
            <label className="field">
              <span>初始密碼</span>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </label>
            <div className="field field--actions">
              <button type="submit" className="btn btn--primary" disabled={saving || updating}>
                {saving ? "新增中…" : "新增使用者"}
              </button>
            </div>
          </form>

          {message ? <div className={message.includes("失敗") || message.includes("錯") ? "alert alert--error" : "alert alert--success"}>{message}</div> : null}

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>帳號</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>狀態</th>
                  <th>手機</th>
                  <th>重設密碼</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><code>{u.employeeCode}</code></td>
                    <td>{u.name}</td>
                    <td>
                      <div className="inline-actions">
                        <select aria-label={`${u.name}的角色`} value={roleByUser[u.id] ?? u.role}
                          disabled={updating || saving || u.id === currentUser?.id}
                          onChange={e => setRoleByUser(prev => ({ ...prev, [u.id]: e.target.value }))}>
                          {Object.entries(roleLabel).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
                        </select>
                        <button type="button" className="btn btn--primary btn--sm"
                          disabled={updating || saving || u.id === currentUser?.id || (roleByUser[u.id] ?? u.role) === u.role}
                          onClick={() => void saveRole(u)}>儲存角色</button>
                      </div>
                      {u.id === currentUser?.id && <small>目前登入帳號的角色請由其他管理員修改</small>}
                    </td>
                    <td>{u.isActive ? <span className="badge badge--completed">啟用</span> : <span className="badge badge--cancelled">停用</span>}</td>
                    <td>{u.phone || "—"}</td>
                    <td>
                      <div className="inline-actions">
                        <input
                          className="table-input"
                          type="password"
                          value={passwordByUser[u.id] ?? ""}
                          onChange={(e) => setPasswordByUser((prev) => ({ ...prev, [u.id]: e.target.value }))}
                          placeholder="新密碼"
                        />
                        <button type="button" className="btn btn--secondary btn--sm" disabled={updating || saving} onClick={() => void resetPassword(u)}>
                          套用
                        </button>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={u.isActive ? "btn btn--danger btn--sm" : "btn btn--secondary btn--sm"}
                        disabled={updating || saving || u.id === currentUser?.id}
                        onClick={() => void patchUser(u.id, { isActive: !u.isActive })}
                      >
                        {u.isActive ? "停用" : "啟用"}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={7}>尚無使用者資料</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
