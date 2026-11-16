import { useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "../adminUtils";
import "./OrderProductPicker.css";

export function OrderProductPicker({ products, onSelect, onClose }: {
  products: Product[];
  onSelect: (product: Product) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return products.filter((p) => p.isActive !== false && /^\d{3}$/.test((p.productCode ?? "").trim()))
      .filter((p) => !q || `${p.productCode} ${p.name}`.toLocaleLowerCase().includes(q))
      .sort((a, b) => (a.productCode ?? "").localeCompare(b.productCode ?? ""));
  }, [products, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="order-product-picker" aria-labelledby="order-product-picker-title"
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) {
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
      } }}>
      <header className="order-product-picker__header">
        <h3 id="order-product-picker-title">選擇商品</h3>
        <button type="button" className="btn" onClick={onClose} aria-label="關閉商品選擇視窗">關閉</button>
      </header>
      <label className="order-product-picker__search">
        搜尋商品編號或名稱
        <input autoFocus type="search" value={query} placeholder="輸入商品編號或名稱"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (matches.length === 1) onSelect(matches[0]);
            }
          }} />
      </label>
      <p className="text-muted">共 {matches.length} 項商品，點選商品即可帶入。</p>
      <div className="order-product-picker__list">
        {matches.map((p) => (
          <button type="button" key={p.id} className="order-product-picker__item" onClick={() => onSelect(p)}>
            <span className="mono-text">{p.productCode}</span>
            <strong>{p.name}</strong>
            <span>$ {p.salePrice}{p.unit ? `／${p.unit}` : ""}</span>
          </button>
        ))}
        {matches.length === 0 && <p className="text-muted">沒有符合的商品，請嘗試其他編號或名稱。</p>}
      </div>
    </dialog>
  );
}
