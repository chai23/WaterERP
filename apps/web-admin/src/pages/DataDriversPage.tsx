import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { driverEmployeeCode, driverIsActive, type Driver } from "../adminUtils";

type DriverEditState = {
  maxOrderCount: string;
  maxBarrelQty: string;
  baseSalary: string;
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) throw new Error(payload?.message ?? `HTTP ${res.status}`);
  return payload as T;
}

export default function DataDriversPage() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const {
    vehicles,
    driverSaving,
    driverMessage,
    driverForm,
    setDriverForm,
    onSubmitNewDriver,
    refreshMasters,
  } = useDashboard();

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [listMessage, setListMessage] = useState("");
  const [editing, setEditing] = useState<Record<string, DriverEditState>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});
  const [passwordByDriver, setPasswordByDriver] = useState<Record<string, string>>({});

  const loadDrivers = useCallback(async () => {
    try {
      const url = isAdmin ? "/api/drivers?includeInactive=1" : "/api/drivers";
      const rows = await apiJson<Driver[]>(url);
      setDrivers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setListMessage(err instanceof Error ? err.message : "讀取司機失敗");
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadDrivers();
    void refreshMasters(["vehicles", "drivers"], false);
  }, [loadDrivers, refreshMasters]);

  useEffect(() => {
    if (driverMessage.includes("成功")) void loadDrivers();
  }, [driverMessage, loadDrivers]);

  const ensureEditState = (
    driverId: string,
    maxOrderCount?: number,
    maxBarrelQty?: number,
    baseSalary?: string | number,
  ): DriverEditState => {
    if (editing[driverId]) return editing[driverId];
    return {
      maxOrderCount: String(maxOrderCount ?? 20),
      maxBarrelQty: String(maxBarrelQty ?? 150),
      baseSalary: String(baseSalary ?? 0),
    };
  };

  const patchDriver = async (driverId: string, patch: Record<string, unknown>) => {
    setListMessage("");
    await apiJson(`/api/drivers/${driverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadDrivers();
    await refreshMasters(["drivers", "vehicles"], true);
  };

  const onSaveCapacity = async (driverId: string) => {
    const state = editing[driverId] ?? ensureEditState(driverId);
    const maxOrderCount = Math.floor(Number(state.maxOrderCount));
    const maxBarrelQty = Math.floor(Number(state.maxBarrelQty));
    const baseSalary = Number(state.baseSalary);
    if (!Number.isFinite(maxOrderCount) || maxOrderCount < 0 || !Number.isFinite(maxBarrelQty) || maxBarrelQty < 0) {
      setRowMessage((prev) => ({ ...prev, [driverId]: "請輸入非負整數" }));
      return;
    }
    if (!Number.isFinite(baseSalary) || baseSalary < 0) {
      setRowMessage((prev) => ({ ...prev, [driverId]: "底薪須為非負數字" }));
      return;
    }

    setSavingId(driverId);
    setRowMessage((prev) => ({ ...prev, [driverId]: "" }));
    try {
      if (isAdmin) {
        await patchDriver(driverId, { maxOrderCount, maxBarrelQty, baseSalary });
      } else {
        await patchDriver(driverId, { baseSalary });
      }
      setRowMessage((prev) => ({ ...prev, [driverId]: "已儲存" }));
    } catch (err) {
      setRowMessage((prev) => ({ ...prev, [driverId]: err instanceof Error ? err.message : "儲存失敗" }));
    } finally {
      setSavingId(null);
    }
  };

  const resetPassword = async (d: Driver) => {
    const id = String(d.id);
    const password = passwordByDriver[id] ?? "";
    if (password.length < 6) {
      setListMessage("新密碼至少 6 字元");
      return;
    }
    try {
      await patchDriver(id, { password });
      setPasswordByDriver((prev) => ({ ...prev, [id]: "" }));
      setListMessage("已重設密碼");
    } catch (err) {
      setListMessage(err instanceof Error ? err.message : "重設密碼失敗");
    }
  };

  const toggleActive = async (d: Driver) => {
    const id = String(d.id);
    const next = !driverIsActive(d);
    try {
      await patchDriver(id, { isActive: next });
      setListMessage(next ? "已啟用司機" : "已停用司機");
    } catch (err) {
      setListMessage(err instanceof Error ? err.message : "更新狀態失敗");
    }
  };

  return (
    <>
      <section className="card">
        <h2 className="card__title">新增司機</h2>
        <p className="card__hint">
          登入帳號為<strong>員編</strong>；<strong>手機</strong>僅為聯絡用（可留空）。司機以員編＋密碼登入司機端。
        </p>
        <form onSubmit={onSubmitNewDriver} className="form-grid form-grid--wide">
          <div className="form-row-2">
            <div className="field">
              <span>姓名</span>
              <input type="text" value={driverForm.name} onChange={(e) => setDriverForm({ ...driverForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <span>員編（登入帳號）</span>
              <input
                type="text"
                value={driverForm.employeeCode}
                onChange={(e) => setDriverForm({ ...driverForm, employeeCode: e.target.value.toUpperCase() })}
                required
              />
            </div>
          </div>
          <div className="form-row-2">
            <div className="field">
              <span>聯絡手機</span>
              <input type="text" value={driverForm.phone} onChange={(e) => setDriverForm({ ...driverForm, phone: e.target.value })} placeholder="可留空" />
            </div>
            <div className="field">
              <span>初始密碼（至少 6 字元）</span>
              <input
                type="password"
                value={driverForm.password}
                onChange={(e) => setDriverForm({ ...driverForm, password: e.target.value })}
                autoComplete="new-password"
                required
              />
            </div>
          </div>
          <div className="form-row-2">
            <div className="field">
              <span>最高訂單數</span>
              <input
                type="number"
                min={0}
                step={1}
                value={driverForm.maxOrderCount}
                onChange={(e) => setDriverForm({ ...driverForm, maxOrderCount: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <span>最大運送桶數</span>
              <input
                type="number"
                min={0}
                step={1}
                value={driverForm.maxBarrelQty}
                onChange={(e) => setDriverForm({ ...driverForm, maxBarrelQty: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="field">
            <span>預設車輛（選填）</span>
            <select value={driverForm.vehicleId} onChange={(e) => setDriverForm({ ...driverForm, vehicleId: e.target.value })}>
              <option value="">不指定</option>
              {vehicles.map((v) => (
                <option key={String(v.id)} value={String(v.id)}>
                  {v.plateNo}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={driverSaving}>
              {driverSaving ? "建立中..." : "建立司機"}
            </button>
            {driverMessage ? (
              <span className={driverMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{driverMessage}</span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="card__title">
          司機列表 <span className="card__title-count">{drivers.length} 筆</span>
        </h2>
        <p className="card__hint">
          可設定每位司機的<strong>最高訂單數</strong>與<strong>最大運送桶數</strong>。
          {isAdmin ? " 管理員可重設密碼、啟用或停用司機帳號。" : null}
        </p>
        {listMessage ? (
          <div className={listMessage.includes("失敗") || listMessage.includes("錯") ? "alert alert--error" : "alert alert--success"}>{listMessage}</div>
        ) : null}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員編（登入）</th>
                <th>姓名</th>
                <th>狀態</th>
                <th>聯絡手機</th>
                <th>預設車牌</th>
                <th>最高訂單數</th>
                <th>最大運送桶數</th>
                <th>月底薪</th>
                {isAdmin ? <th>重設密碼</th> : null}
                <th>{isAdmin ? "操作" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const id = String(d.id);
                const edit = editing[id] ?? ensureEditState(id, d.maxOrderCount, d.maxBarrelQty, d.baseSalary);
                const active = driverIsActive(d);
                return (
                  <tr key={id}>
                    <td>
                      <code style={{ fontSize: "0.85em" }}>{driverEmployeeCode(d) || "—"}</code>
                    </td>
                    <td>{d.user?.name ?? "—"}</td>
                    <td>{active ? <span className="badge badge--completed">啟用</span> : <span className="badge badge--cancelled">停用</span>}</td>
                    <td>{d.user?.phone ?? "—"}</td>
                    <td>{d.vehicle?.plateNo ?? "—"}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className="input--compact"
                        style={{ width: "5rem" }}
                        value={edit.maxOrderCount}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [id]: { ...edit, maxOrderCount: e.target.value },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className="input--compact"
                        style={{ width: "5rem" }}
                        value={edit.maxBarrelQty}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [id]: { ...edit, maxBarrelQty: e.target.value },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className="input--compact"
                        style={{ width: "6rem" }}
                        value={edit.baseSalary}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [id]: { ...edit, baseSalary: e.target.value },
                          }))
                        }
                      />
                    </td>
                    {isAdmin ? (
                      <td>
                        <div className="inline-actions">
                          <input
                            className="table-input"
                            type="password"
                            value={passwordByDriver[id] ?? ""}
                            onChange={(e) => setPasswordByDriver((prev) => ({ ...prev, [id]: e.target.value }))}
                            placeholder="新密碼"
                          />
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void resetPassword(d)}>
                            套用
                          </button>
                        </div>
                      </td>
                    ) : null}
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={savingId === id}
                          onClick={() => onSaveCapacity(id)}
                        >
                          {savingId === id ? "儲存中…" : "儲存"}
                        </button>
                        {isAdmin ? (
                          <button
                            type="button"
                            className={active ? "btn btn--danger btn--sm" : "btn btn--secondary btn--sm"}
                            onClick={() => void toggleActive(d)}
                          >
                            {active ? "停用" : "啟用"}
                          </button>
                        ) : null}
                      </div>
                      {rowMessage[id] ? (
                        <span
                          className={rowMessage[id] === "已儲存" ? "feedback feedback--ok" : "feedback feedback--err"}
                          style={{ display: "block", marginTop: "0.25rem", fontSize: "0.85em" }}
                        >
                          {rowMessage[id]}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {drivers.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 7}>尚無司機資料</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
