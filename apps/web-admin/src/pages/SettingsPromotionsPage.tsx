import { useCallback, useEffect, useState } from "react";
import type { Product } from "../adminUtils";

type PromotionRule = {
  id: string;
  ruleKey: string;
  displayName: string;
  description?: string | null;
  isEnabled: boolean;
  config: { minBarrels?: number; bonusBarrels?: number };
  sortOrder?: number;
};

type DispenserGiftRule = {
  id: string;
  triggerProductId: string;
  giftProductId: string;
  giftQtyPerUnit: number;
  isActive: boolean;
  sortOrder?: number;
  triggerProduct?: { id: string; name: string; productCode?: string | null } | null;
  giftProduct?: { id: string; name: string; productCode?: string | null } | null;
};

async function readJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string }> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (Array.isArray(body)) return { ok: res.ok, data: body as T };
  return { ok: res.ok && body?.ok !== false, data: body?.data as T, message: body?.message };
}

function productOptionLabel(p: Product): string {
  const code = p.productCode?.trim() || p.sku?.trim() || p.id;
  return `${code} · ${p.name}`;
}

export default function SettingsPromotionsPage() {
  const [rules, setRules] = useState<PromotionRule[]>([]);
  const [dispenserRules, setDispenserRules] = useState<DispenserGiftRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const [prepaidMin, setPrepaidMin] = useState("10");
  const [prepaidBonus, setPrepaidBonus] = useState("2");
  const [prepaidEnabled, setPrepaidEnabled] = useState(false);

  const [dispenserEnabled, setDispenserEnabled] = useState(false);
  const [newTriggerId, setNewTriggerId] = useState("");
  const [newGiftId, setNewGiftId] = useState("");
  const [newGiftQty, setNewGiftQty] = useState("1");
  const [editDispenserId, setEditDispenserId] = useState<string | null>(null);
  const [editTriggerId, setEditTriggerId] = useState("");
  const [editGiftId, setEditGiftId] = useState("");
  const [editGiftQty, setEditGiftQty] = useState("1");

  const activeProducts = products.filter((p) => p.isActive !== false);

  const reload = useCallback(async () => {
    setLoading(true);
    const [rulesRes, dispenserRes, productsRes] = await Promise.all([
      readJson<PromotionRule[]>("/api/promotion-rules"),
      readJson<DispenserGiftRule[]>("/api/promotion-dispenser-gift-rules?all=1"),
      readJson<Product[]>("/api/products"),
    ]);
    const ruleRows = (rulesRes.data ?? []).map((r) => ({
      ...r,
      id: String(r.id),
      isEnabled: Boolean(r.isEnabled),
    }));
    setRules(ruleRows);
    setDispenserRules(
      (dispenserRes.data ?? []).map((r) => ({
        ...r,
        id: String(r.id),
        triggerProductId: String(r.triggerProductId),
        giftProductId: String(r.giftProductId),
      })),
    );
    setProducts(
      (productsRes.data ?? []).map((p) => ({
        ...p,
        id: String((p as Product & { id: string | number }).id),
      })),
    );

    const prepaid = ruleRows.find((r) => r.ruleKey === "prepaid_topup_bonus");
    if (prepaid) {
      setPrepaidEnabled(Boolean(prepaid.isEnabled));
      setPrepaidMin(String(prepaid.config?.minBarrels ?? 10));
      setPrepaidBonus(String(prepaid.config?.bonusBarrels ?? 2));
    }
    const dispenser = ruleRows.find((r) => r.ruleKey === "dispenser_purchase_gift");
    if (dispenser) {
      setDispenserEnabled(Boolean(dispenser.isEnabled));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const savePrepaidRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const minBarrels = Math.floor(Number(prepaidMin));
    const bonusBarrels = Math.floor(Number(prepaidBonus));
    if (!Number.isFinite(minBarrels) || minBarrels <= 0) {
      setMsg("滿額桶數 N 須為正整數");
      return;
    }
    if (!Number.isFinite(bonusBarrels) || bonusBarrels <= 0) {
      setMsg("贈送桶數 M 須為正整數");
      return;
    }
    setSaving(true);
    const r = await readJson<PromotionRule>("/api/promotion-rules/prepaid_topup_bonus", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isEnabled: prepaidEnabled,
        config: { minBarrels, bonusBarrels },
      }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "儲存失敗");
      return;
    }
    setMsg("已儲存「預收滿額贈桶」設定");
    await reload();
  };

  const saveDispenserMaster = async (enabled: boolean) => {
    setMsg("");
    setSaving(true);
    const r = await readJson("/api/promotion-rules/dispenser_purchase_gift", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled: enabled }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "更新失敗");
      return;
    }
    setDispenserEnabled(enabled);
    setMsg(enabled ? "已啟用「購買飲水機贈商品」" : "已停用「購買飲水機贈商品」");
    await reload();
  };

  const createDispenserRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    if (!newTriggerId || !newGiftId) {
      setMsg("請選擇飲水機商品與贈送商品");
      return;
    }
    const giftQtyPerUnit = Math.floor(Number(newGiftQty));
    if (!Number.isFinite(giftQtyPerUnit) || giftQtyPerUnit <= 0) {
      setMsg("每台贈送桶數須為正整數");
      return;
    }
    setSaving(true);
    const r = await readJson<DispenserGiftRule>("/api/promotion-dispenser-gift-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggerProductId: newTriggerId,
        giftProductId: newGiftId,
        giftQtyPerUnit,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "新增失敗");
      return;
    }
    setNewTriggerId("");
    setNewGiftId("");
    setNewGiftQty("1");
    setMsg("已新增飲水機贈品規則");
    await reload();
  };

  const saveDispenserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDispenserId) return;
    setMsg("");
    const giftQtyPerUnit = Math.floor(Number(editGiftQty));
    if (!editTriggerId || !editGiftId) {
      setMsg("請選擇飲水機商品與贈送商品");
      return;
    }
    if (!Number.isFinite(giftQtyPerUnit) || giftQtyPerUnit <= 0) {
      setMsg("每台贈送桶數須為正整數");
      return;
    }
    setSaving(true);
    const r = await readJson(`/api/promotion-dispenser-gift-rules/${editDispenserId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggerProductId: editTriggerId,
        giftProductId: editGiftId,
        giftQtyPerUnit,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "儲存失敗");
      return;
    }
    setEditDispenserId(null);
    setMsg("已更新飲水機贈品規則");
    await reload();
  };

  const toggleDispenserRule = async (row: DispenserGiftRule) => {
    setSaving(true);
    const r = await readJson(`/api/promotion-dispenser-gift-rules/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "更新失敗");
      return;
    }
    await reload();
  };

  const removeDispenserRule = async (row: DispenserGiftRule) => {
    if (!window.confirm(`確定刪除「${row.triggerProduct?.name ?? "飲水機"}」的贈品規則？`)) return;
    setSaving(true);
    const r = await readJson(`/api/promotion-dispenser-gift-rules/${row.id}`, { method: "DELETE" });
    setSaving(false);
    if (!r.ok) {
      setMsg(r.message ?? "刪除失敗");
      return;
    }
    setMsg("已刪除規則");
    await reload();
  };

  return (
    <section className="settings-stack">
      <div className="page-card">
        <h2 className="page-card__title">優惠活動設定</h2>
        <p className="text-muted page-card__lead">
          設定預收滿額贈桶與購買飲水機贈商品。開單時系統會自動加入贈品明細（單價 $0、標示贈品）。
        </p>

        {msg ? <div className={`alert ${msg.includes("失敗") ? "alert--error" : "alert--success"}`}>{msg}</div> : null}
        {loading ? <p className="text-muted">讀取中…</p> : null}

        <form onSubmit={savePrepaidRule} className="page-card page-card--nested">
          <div className="page-card__header-row">
            <h3 className="page-card__subtitle">預收滿額贈桶</h3>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={prepaidEnabled}
                onChange={(e) => setPrepaidEnabled(e.target.checked)}
                disabled={saving}
              />
              啟用
            </label>
          </div>
          <p className="text-muted">
            預付桶儲值滿 N 桶，贈送同商品 M 桶（可累計）。例：滿 10 贈 2，儲值 25 桶贈 4 桶。
          </p>
          <div className="form-grid form-grid--3">
            <label className="field">
              <span>滿 N 桶</span>
              <input
                type="number"
                min={1}
                value={prepaidMin}
                onChange={(e) => setPrepaidMin(e.target.value)}
                disabled={saving}
              />
            </label>
            <label className="field">
              <span>贈 M 桶</span>
              <input
                type="number"
                min={1}
                value={prepaidBonus}
                onChange={(e) => setPrepaidBonus(e.target.value)}
                disabled={saving}
              />
            </label>
            <div className="field field--actions">
              <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                儲存
              </button>
            </div>
          </div>
        </form>

        <div className="page-card page-card--nested">
          <div className="page-card__header-row">
            <h3 className="page-card__subtitle">購買飲水機贈商品</h3>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={dispenserEnabled}
                onChange={(e) => void saveDispenserMaster(e.target.checked)}
                disabled={saving}
              />
              啟用
            </label>
          </div>
          <p className="text-muted">每種飲水機可設定贈送的商品與每台贈送桶數；購買幾台就贈送幾倍。</p>

          <form onSubmit={createDispenserRule} className="form-grid form-grid--4">
            <label className="field">
              <span>飲水機商品</span>
              <select value={newTriggerId} onChange={(e) => setNewTriggerId(e.target.value)} disabled={saving}>
                <option value="">請選擇</option>
                {activeProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {productOptionLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>贈送商品</span>
              <select value={newGiftId} onChange={(e) => setNewGiftId(e.target.value)} disabled={saving}>
                <option value="">請選擇</option>
                {activeProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {productOptionLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>每台贈送（桶）</span>
              <input
                type="number"
                min={1}
                value={newGiftQty}
                onChange={(e) => setNewGiftQty(e.target.value)}
                disabled={saving}
              />
            </label>
            <div className="field field--actions">
              <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                新增規則
              </button>
            </div>
          </form>

          <div className="table-wrap">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>飲水機商品</th>
                  <th>贈送商品</th>
                  <th className="num">每台贈送</th>
                  <th>狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {dispenserRules.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      尚未設定飲水機贈品規則
                    </td>
                  </tr>
                ) : (
                  dispenserRules.map((row) =>
                    editDispenserId === row.id ? (
                      <tr key={row.id}>
                        <td colSpan={5}>
                          <form onSubmit={saveDispenserEdit} className="inline-actions form-grid form-grid--4">
                            <select value={editTriggerId} onChange={(e) => setEditTriggerId(e.target.value)}>
                              {activeProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {productOptionLabel(p)}
                                </option>
                              ))}
                            </select>
                            <select value={editGiftId} onChange={(e) => setEditGiftId(e.target.value)}>
                              {activeProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {productOptionLabel(p)}
                                </option>
                              ))}
                            </select>
                            <input
                              type="number"
                              min={1}
                              value={editGiftQty}
                              onChange={(e) => setEditGiftQty(e.target.value)}
                              style={{ width: "5rem" }}
                            />
                            <div className="inline-actions">
                              <button type="submit" className="btn btn--primary btn--sm">
                                儲存
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => setEditDispenserId(null)}
                              >
                                取消
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id}>
                        <td>{row.triggerProduct?.name ?? row.triggerProductId}</td>
                        <td>{row.giftProduct?.name ?? row.giftProductId}</td>
                        <td className="num">{row.giftQtyPerUnit}</td>
                        <td>{row.isActive ? "啟用" : "停用"}</td>
                        <td>
                          <div className="inline-actions">
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => {
                                setEditDispenserId(row.id);
                                setEditTriggerId(row.triggerProductId);
                                setEditGiftId(row.giftProductId);
                                setEditGiftQty(String(row.giftQtyPerUnit));
                              }}
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => void toggleDispenserRule(row)}
                            >
                              {row.isActive ? "停用" : "啟用"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              onClick={() => void removeDispenserRule(row)}
                            >
                              刪除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-card page-card--nested page-card--muted">
          <h3 className="page-card__subtitle">其他活動（預留）</h3>
          <p className="text-muted">
            之後若需新增其他優惠類型（滿額折扣、期間促銷等），可在此區擴充，不需變更整體架構。
          </p>
          {rules
            .filter((r) => r.ruleKey !== "prepaid_topup_bonus" && r.ruleKey !== "dispenser_purchase_gift")
            .map((r) => (
              <p key={r.id}>
                {r.displayName}（{r.isEnabled ? "啟用" : "停用"}）
              </p>
            ))}
        </div>
      </div>
    </section>
  );
}
