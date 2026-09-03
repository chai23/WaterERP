import { useEffect, useMemo, useState } from "react";
import type { Product } from "../adminUtils";
import { useDashboard } from "../DashboardContext";

function normalizeProductCodeUi(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{3}$/.test(t)) return null;
  return t;
}

const DEFAULT_PRODUCT_FORM = {
  productCode: "",
  name: "",
  sku: "",
  unit: "桶",
  countsDepositBarrel: false,
  consumesPrepaidBarrel: false,
  availableOnLiff: false,
  salePrice: "0",
  costPrice: "0",
  driverDeliveryWage: "0",
  initialQty: "0",
};

export default function DataProductsPage() {
  const { products, productSaving, productMessage, productForm, setProductForm, onSubmitNewProduct, refreshMasters } = useDashboard();
  const [patchingId, setPatchingId] = useState<string | null>(null);

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState({ name: "", unit: "", salePrice: "", costPrice: "", driverDeliveryWage: "" });
  const [editSaving, setEditSaving] = useState(false);

  const [invProduct, setInvProduct] = useState<Product | null>(null);
  const [invQty, setInvQty] = useState("");
  const [invNote, setInvNote] = useState("");
  const [invSaving, setInvSaving] = useState(false);

  useEffect(() => {
    void refreshMasters(["products"], false);
  }, [refreshMasters]);

  const createHasValidCode = normalizeProductCodeUi(productForm.productCode) != null;
  const createHasName = productForm.name.trim().length > 0;
  const createFormReady = createHasValidCode && createHasName;

  const visibleProducts = useMemo(
    () => products.filter((p) => !(p.sku ?? "").startsWith("SYS-")),
    [products],
  );

  const marginPreview = useMemo(() => {
    const sale = Number(productForm.salePrice);
    const cost = Number(productForm.costPrice);
    if (!Number.isFinite(sale) || !Number.isFinite(cost) || sale <= 0) return null;
    const margin = sale - cost;
    const pct = (margin / sale) * 100;
    return { margin, pct };
  }, [productForm.salePrice, productForm.costPrice]);

  const scrollToSection = (sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetProductForm = () => {
    setProductForm(DEFAULT_PRODUCT_FORM);
  };

  const toggleConsumesPrepaidBarrel = async (productId: string, next: boolean) => {
    setPatchingId(productId);
    try {
      const res = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumesPrepaidBarrel: next }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        window.alert(payload.message ?? "更新失敗");
        return;
      }
      await refreshMasters(["products"], true);
    } catch {
      window.alert("無法連線 API");
    } finally {
      setPatchingId(null);
    }
  };

  const toggleCountsDepositBarrel = async (productId: string, next: boolean) => {
    setPatchingId(productId);
    try {
      const res = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countsDepositBarrel: next }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        window.alert(payload.message ?? "更新失敗");
        return;
      }
      await refreshMasters(["products"], true);
    } catch {
      window.alert("無法連線 API");
    } finally {
      setPatchingId(null);
    }
  };

  const openEditDialog = (p: Product) => {
    setEditingProduct(p);
    setEditForm({
      name: p.name,
      unit: p.unit ?? "",
      salePrice: p.salePrice ?? "0",
      costPrice: p.costPrice ?? "0",
      driverDeliveryWage: p.driverDeliveryWage ?? "0",
    });
  };

  const saveEditProduct = async () => {
    if (!editingProduct) return;
    const n = editForm.name.trim();
    if (!n) { window.alert("名稱不可為空"); return; }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/products/${editingProduct.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n,
          unit: editForm.unit.trim() || undefined,
          salePrice: Number(editForm.salePrice),
          costPrice: Number(editForm.costPrice),
          driverDeliveryWage: Number(editForm.driverDeliveryWage),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) { window.alert(body.message ?? "更新失敗"); return; }
      setEditingProduct(null);
      await refreshMasters(["products"], true);
    } catch { window.alert("無法連線 API"); } finally { setEditSaving(false); }
  };

  const openInvDialog = (p: Product) => {
    setInvProduct(p);
    setInvQty("");
    setInvNote("");
  };

  const saveInvAdjust = async () => {
    if (!invProduct) return;
    const delta = Number(invQty);
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
      window.alert("數量須為非零整數");
      return;
    }
    setInvSaving(true);
    try {
      const res = await fetch(`/api/products/${invProduct.id}/inventory-adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qtyDelta: delta, note: invNote.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) { window.alert(body.message ?? "調整失敗"); return; }
      setInvProduct(null);
      await refreshMasters(["products"], true);
    } catch { window.alert("無法連線 API"); } finally { setInvSaving(false); }
  };

  const toggleAvailableOnLiff = async (productId: string, next: boolean) => {
    setPatchingId(productId);
    try {
      const res = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availableOnLiff: next }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        window.alert(payload.message ?? "更新失敗");
        return;
      }
      await refreshMasters(["products"], true);
    } catch {
      window.alert("無法連線 API");
    } finally {
      setPatchingId(null);
    }
  };

  return (
    <>
      <section className="card card--detail product-create-page">
        <div className="customer-detail-head">
          <h2 className="card__title">新增商品</h2>
          <button type="button" className="btn btn--ghost" onClick={resetProductForm} disabled={productSaving}>
            清除表單
          </button>
        </div>

        <div className="customer-create-hero product-create-hero">
          <p className="customer-create-hero__lead">建立新商品前請完成必填項目；業務規則與價格可視需要調整。</p>
          <ul className="customer-create-checklist" aria-label="必填項目檢查">
            <li className={`customer-create-checklist__item${createHasValidCode ? " customer-create-checklist__item--done" : ""}`}>
              <span className="customer-create-checklist__mark" aria-hidden="true">{createHasValidCode ? "✓" : "1"}</span>
              商品編號（3 碼數字）
            </li>
            <li className={`customer-create-checklist__item${createHasName ? " customer-create-checklist__item--done" : ""}`}>
              <span className="customer-create-checklist__mark" aria-hidden="true">{createHasName ? "✓" : "2"}</span>
              商品名稱
            </li>
          </ul>
          {createFormReady ? (
            <p className="customer-create-hero__ready">必填項目已完成，可以建立商品。</p>
          ) : (
            <p className="customer-create-hero__pending">尚有必填項目未完成。</p>
          )}
        </div>

        <form onSubmit={onSubmitNewProduct} className="customer-edit-layout product-create-form">
          <nav className="customer-edit-nav" aria-label="新增商品區塊導覽">
            <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("product-identity")}>
              基本識別
            </button>
            <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("product-spec")}>
              規格單位
            </button>
            <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("product-pricing")}>
              價格與庫存
            </button>
            <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("product-rules")}>
              業務規則
            </button>
          </nav>

          <section id="product-identity" className="customer-edit-section">
            <header className="customer-edit-section__head">
              <h4 className="customer-edit-section__title">基本識別</h4>
              <p className="customer-edit-section__desc">商品編號為 3 碼數字，建立後不可於此頁直接改號。</p>
            </header>
            <div className="customer-edit-section__body form-grid form-grid--wide">
              <div className="field">
                <span>商品編號（3 碼數字，必填）</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={3}
                  className="mono-text"
                  value={productForm.productCode}
                  onChange={(e) => setProductForm({ ...productForm, productCode: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                  placeholder="例如 001"
                  required
                />
              </div>
              <div className="field">
                <span>商品名稱（必填）</span>
                <input
                  type="text"
                  value={productForm.name}
                  onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                  required
                />
              </div>
            </div>
          </section>

          <section id="product-spec" className="customer-edit-section">
            <header className="customer-edit-section__head">
              <h4 className="customer-edit-section__title">規格與單位</h4>
              <p className="customer-edit-section__desc">SKU 用於內部辨識（不可重複）；單位會顯示於訂單與報表。</p>
            </header>
            <div className="customer-edit-section__body form-grid form-grid--wide">
              <div className="form-row-2">
                <div className="field">
                  <span>SKU（選填，不可重複）</span>
                  <input type="text" value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} />
                </div>
                <div className="field">
                  <span>單位</span>
                  <input
                    type="text"
                    value={productForm.unit}
                    onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })}
                    placeholder="桶、箱…"
                  />
                </div>
              </div>
            </div>
          </section>

          <section id="product-pricing" className="customer-edit-section">
            <header className="customer-edit-section__head">
              <h4 className="customer-edit-section__title">價格與庫存</h4>
              <p className="customer-edit-section__desc">售價為開單預設參考；初始庫存建立後仍可由進出庫作業調整。</p>
            </header>
            <div className="customer-edit-section__body form-grid form-grid--wide">
              <div className="form-row-2">
                <div className="field">
                  <span>售價</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={productForm.salePrice}
                    onChange={(e) => setProductForm({ ...productForm, salePrice: e.target.value })}
                  />
                </div>
                <div className="field">
                  <span>參考成本</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={productForm.costPrice}
                    onChange={(e) => setProductForm({ ...productForm, costPrice: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="field">
                  <span>司機配送薪資（元／單位）</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={productForm.driverDeliveryWage}
                    onChange={(e) => setProductForm({ ...productForm, driverDeliveryWage: e.target.value })}
                  />
                </div>
                <div className="field">
                  <span>初始庫存數量</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={productForm.initialQty}
                    onChange={(e) => setProductForm({ ...productForm, initialQty: e.target.value })}
                  />
                </div>
              </div>
              {marginPreview ? (
                <p className="card__hint product-create-margin-hint">
                  粗估毛利：<strong>$ {marginPreview.margin.toLocaleString()}</strong>
                  （約 {marginPreview.pct.toFixed(1)}%）
                </p>
              ) : null}
            </div>
          </section>

          <section id="product-rules" className="customer-edit-section">
            <header className="customer-edit-section__head">
              <h4 className="customer-edit-section__title">業務規則</h4>
              <p className="customer-edit-section__desc">各項設定互不影響，請依商品實際配送、結帳與銷售管道勾選。</p>
            </header>
            <div className="customer-edit-section__body">
              <div className="product-option-cards">
                <label
                  className={`product-option-card${productForm.countsDepositBarrel ? " product-option-card--on" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="product-option-card__input"
                    checked={productForm.countsDepositBarrel}
                    onChange={(e) => setProductForm({ ...productForm, countsDepositBarrel: e.target.checked })}
                  />
                  <span className="product-option-card__check" aria-hidden="true" />
                  <div className="product-option-card__content">
                    <strong className="product-option-card__title">計入押桶（未收回空桶）</strong>
                    <p className="product-option-card__desc">
                      核銷送達時，此品項出貨量會納入客戶「未收回空桶」。紙箱水等不需追蹤空桶的商品請勿勾選。
                    </p>
                  </div>
                </label>
                <label
                  className={`product-option-card${productForm.consumesPrepaidBarrel ? " product-option-card--on" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="product-option-card__input"
                    checked={productForm.consumesPrepaidBarrel}
                    onChange={(e) => setProductForm({ ...productForm, consumesPrepaidBarrel: e.target.checked })}
                  />
                  <span className="product-option-card__check" aria-hidden="true" />
                  <div className="product-option-card__content">
                    <strong className="product-option-card__title">預付扣桶</strong>
                    <p className="product-option-card__desc">
                      預付客戶以「預付（桶）」結帳的明細，送達核銷時會自預付桶餘額扣減。與「計入押桶」無關。
                    </p>
                  </div>
                </label>
                <label
                  className={`product-option-card${productForm.availableOnLiff ? " product-option-card--on" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="product-option-card__input"
                    checked={productForm.availableOnLiff}
                    onChange={(e) => setProductForm({ ...productForm, availableOnLiff: e.target.checked })}
                  />
                  <span className="product-option-card__check" aria-hidden="true" />
                  <div className="product-option-card__content">
                    <strong className="product-option-card__title">LINE 訂水可下訂</strong>
                    <p className="product-option-card__desc">
                      勾選後才會出現在 LINE 客戶的訂水選單。未勾選的商品僅供後台開單使用。
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </section>

          <div className="customer-edit-save-bar customer-create-save-bar">
            <button type="submit" className="btn btn--primary" disabled={productSaving || !createFormReady}>
              {productSaving ? "建立中…" : "建立商品"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={resetProductForm} disabled={productSaving}>
              清除表單
            </button>
            {!createFormReady && !productSaving ? (
              <span className="customer-create-save-bar__hint">請完成商品編號與名稱後再建立。</span>
            ) : null}
            {productMessage ? (
              <span className={productMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{productMessage}</span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="card__title">
          商品總覽 <span className="card__title-count">{visibleProducts.length} 筆</span>
        </h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>編號</th>
                <th>名稱</th>
                <th>單位</th>
                <th>計入押桶</th>
                <th>預付扣桶</th>
                <th>LINE 訂水</th>
                <th className="num">售價</th>
                <th className="num">成本</th>
                <th className="num">配送薪資</th>
                <th className="num">庫存</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((p) => (
                <tr key={String(p.id)}>
                  <td className="mono-text">{p.productCode ?? "—"}</td>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>{p.unit ?? "—"}</td>
                  <td>
                    <label className="table-inline-check">
                      <input
                        type="checkbox"
                        checked={Boolean(p.countsDepositBarrel)}
                        disabled={patchingId === String(p.id)}
                        onChange={(e) => void toggleCountsDepositBarrel(String(p.id), e.target.checked)}
                      />
                      <span className="text-muted" style={{ fontSize: "0.8125rem" }}>
                        {patchingId === String(p.id) ? "更新中…" : p.countsDepositBarrel ? "是" : "否"}
                      </span>
                    </label>
                  </td>
                  <td>
                    <label className="table-inline-check">
                      <input
                        type="checkbox"
                        checked={Boolean(p.consumesPrepaidBarrel)}
                        disabled={patchingId === String(p.id)}
                        onChange={(e) => void toggleConsumesPrepaidBarrel(String(p.id), e.target.checked)}
                      />
                      <span className="text-muted" style={{ fontSize: "0.8125rem" }}>
                        {patchingId === String(p.id) ? "更新中…" : p.consumesPrepaidBarrel ? "是" : "否"}
                      </span>
                    </label>
                  </td>
                  <td>
                    <label className="table-inline-check">
                      <input
                        type="checkbox"
                        checked={Boolean(p.availableOnLiff)}
                        disabled={patchingId === String(p.id)}
                        onChange={(e) => void toggleAvailableOnLiff(String(p.id), e.target.checked)}
                      />
                      <span className="text-muted" style={{ fontSize: "0.8125rem" }}>
                        {patchingId === String(p.id) ? "更新中…" : p.availableOnLiff ? "可下訂" : "否"}
                      </span>
                    </label>
                  </td>
                  <td className="num">{p.salePrice}</td>
                  <td className="num">{p.costPrice ?? "0"}</td>
                  <td className="num">{p.driverDeliveryWage ?? "0"}</td>
                  <td
                    className="num"
                    style={
                      Number(p.inventory?.qtyOnHand ?? 0) < 0
                        ? { color: "var(--danger, #b42318)", fontWeight: 600 }
                        : undefined
                    }
                    title={Number(p.inventory?.qtyOnHand ?? 0) < 0 ? "負庫存異常" : undefined}
                  >
                    {p.inventory?.qtyOnHand ?? 0}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => openEditDialog(p)}>
                      編輯
                    </button>
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => openInvDialog(p)} style={{ marginLeft: 4 }}>
                      入庫
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editingProduct && (
        <div className="modal-backdrop" onClick={() => !editSaving && setEditingProduct(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-card__title">編輯商品：{editingProduct.name}</h3>
            <div className="form-grid" style={{ gap: "0.75rem" }}>
              <div className="field">
                <span>商品名稱</span>
                <input type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              </div>
              <div className="field">
                <span>單位</span>
                <input type="text" value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} />
              </div>
              <div className="form-row-2">
                <div className="field">
                  <span>售價</span>
                  <input type="number" min={0} step="0.01" value={editForm.salePrice} onChange={(e) => setEditForm({ ...editForm, salePrice: e.target.value })} />
                </div>
                <div className="field">
                  <span>參考成本</span>
                  <input type="number" min={0} step="0.01" value={editForm.costPrice} onChange={(e) => setEditForm({ ...editForm, costPrice: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <span>司機配送薪資（元／單位）</span>
                <input type="number" min={0} step="0.01" value={editForm.driverDeliveryWage} onChange={(e) => setEditForm({ ...editForm, driverDeliveryWage: e.target.value })} />
              </div>
            </div>
            <div className="modal-card__actions">
              <button type="button" className="btn btn--primary" disabled={editSaving} onClick={() => void saveEditProduct()}>
                {editSaving ? "儲存中…" : "儲存"}
              </button>
              <button type="button" className="btn btn--ghost" disabled={editSaving} onClick={() => setEditingProduct(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {invProduct && (
        <div className="modal-backdrop" onClick={() => !invSaving && setInvProduct(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-card__title">庫存調整：{invProduct.name}</h3>
            <p style={{ margin: "0 0 0.75rem", color: "var(--text-muted)" }}>
              目前庫存：<strong>{invProduct.inventory?.qtyOnHand ?? 0}</strong> {invProduct.unit ?? ""}
            </p>
            <div className="form-grid" style={{ gap: "0.75rem" }}>
              <div className="field">
                <span>調整數量（正數入庫、負數扣減）</span>
                <input
                  type="number"
                  step={1}
                  value={invQty}
                  onChange={(e) => setInvQty(e.target.value)}
                  placeholder="例如 100 或 -5"
                  style={{ fontSize: "1.125rem" }}
                />
              </div>
              <div className="field">
                <span>備註（選填）</span>
                <input type="text" value={invNote} onChange={(e) => setInvNote(e.target.value)} placeholder="例如：進貨補庫" />
              </div>
            </div>
            <div className="modal-card__actions">
              <button type="button" className="btn btn--primary" disabled={invSaving || !invQty || Number(invQty) === 0} onClick={() => void saveInvAdjust()}>
                {invSaving ? "調整中…" : "確認調整"}
              </button>
              <button type="button" className="btn btn--ghost" disabled={invSaving} onClick={() => setInvProduct(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
