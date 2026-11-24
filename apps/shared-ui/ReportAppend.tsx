import "./report-append.css";

export type ReportAppendDraft = {
  productId: string;
  qty: number;
  billingType: string;
  linePurpose: "delivery" | "prepaid_barrel_topup";
};
export type ReportProduct = {
  id: string; name: string; unit: string; salePrice: string; consumesPrepaidBarrel: boolean;
};
type TopupLine = {
  id: string; qtyOrdered?: number; lineAmount?: string | number; linePurpose?: string | null;
  isPromotionGift?: boolean; product?: { name?: string };
};
export function reportTopupEdits(job: {
  salesOrder?: { lines?: TopupLine[] };
  events?: Array<{ payloadJson?: { appendedLineId?: string } }>;
} | undefined, quantities: Record<string, number>) {
  return (job?.salesOrder?.lines ?? []).filter(line =>
    line.linePurpose === "prepaid_barrel_topup" && !line.isPromotionGift &&
    job?.events?.some(event => event.payloadJson?.appendedLineId === String(line.id)),
  ).map(line => ({ lineId: String(line.id), qty: quantities[String(line.id)] ?? line.qtyOrdered ?? 0 }));
}

export function ReportAppend({ draft, products, disabled, driver = false, onChange, onCancel }: {
  draft: ReportAppendDraft; products: ReportProduct[] | null; disabled: boolean; driver?: boolean;
  onChange: (draft: ReportAppendDraft) => void; onCancel: () => void;
}) {
  const topup = draft.linePurpose === "prepaid_barrel_topup";
  const selected = products?.find(p => p.id === draft.productId);
  return <fieldset className={`report-append${driver ? " report-append--driver" : ""}`} disabled={disabled}>
    <legend>追加商品／預付儲值</legend>
    <div className="report-append__fields">
      <label><span>追加類型</span><select value={draft.linePurpose} onChange={e => onChange({
        ...draft, linePurpose: e.target.value as ReportAppendDraft["linePurpose"], productId: "", billingType: "cash",
      })}><option value="delivery">配送商品</option><option value="prepaid_barrel_topup">預付儲值</option></select></label>
      <label className="report-append__product"><span>商品</span><select value={draft.productId} onChange={e => onChange({ ...draft, productId: e.target.value, billingType: "cash" })}>
        <option value="">{products ? "請選擇商品" : "載入商品中…"}</option>
        {products?.filter(p => !topup || p.consumesPrepaidBarrel).map(p => <option key={p.id} value={p.id}>{p.name} · ${p.salePrice}／{topup ? "桶" : p.unit}</option>)}
      </select></label>
      <label><span>{topup ? "付費儲值桶數" : "實送數量"}</span><input type="number" min={1} max={2147483647} step={1} value={Number.isNaN(draft.qty) ? "" : draft.qty} onChange={e => onChange({ ...draft, qty: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
      <label><span>結帳方式</span><select value={draft.billingType} disabled={topup} onChange={e => onChange({ ...draft, billingType: e.target.value })}>
        <option value="cash">{topup ? "現金應收（收足後入帳）" : "現金"}</option>
        {!topup && <option value="monthly">月結</option>}
        {!topup && selected?.consumesPrepaidBarrel && <option value="prepaid">預付扣桶</option>}
      </select></label>
    </div>
    <div className="report-append__footer">
      <p>{topup ? `儲值小計 $${selected && Number.isSafeInteger(draft.qty) && draft.qty > 0 ? (Number(selected.salePrice) * draft.qty).toLocaleString() : "—"}；稅額與優惠贈桶以確認結果為準。核銷收足後才入帳，不計入配送或庫存。` : "填寫後按「確認配送數量」，更新本單金額與應收。"}</p>
      <button type="button" className={driver ? "d-btn d-btn--ghost" : "btn btn--ghost btn--sm"} onClick={onCancel}>取消追加</button>
    </div>
  </fieldset>;
}

export function ReportTopups({ lines, editableIds, quantities, disabled, driver = false, onChange }: {
  lines: TopupLine[]; editableIds: string[]; quantities: Record<string, number>; disabled: boolean; driver?: boolean;
  onChange: (lineId: string, qty: number) => void;
}) {
  const topups = lines.filter(l => l.linePurpose === "prepaid_barrel_topup");
  if (!topups.length) return null;
  return <div className={`report-topups${driver ? " report-append--driver" : ""}`}>
    <strong>預付儲值 · 待核銷入帳</strong>
    <p>不計入配送桶數。追加的付費桶數可在首次回報前修改，填 0 並確認即可撤銷；贈桶由系統重算。</p>
    {topups.map(line => <label className="report-topups__row" key={line.id}>
      <span>{line.product?.name ?? "商品"}{line.isPromotionGift ? "（贈送）" : "（儲值）"}<small>已確認金額 ${Number(line.lineAmount ?? 0).toLocaleString()}</small></span>
      <input aria-label={`${line.product?.name ?? "商品"}儲值桶數`} type="number" min={0} max={2147483647} step={1}
        disabled={disabled || line.isPromotionGift || !editableIds.includes(String(line.id))}
        value={Number.isNaN(quantities[String(line.id)]) ? "" : quantities[String(line.id)] ?? line.qtyOrdered ?? 0}
        onChange={e => onChange(String(line.id), e.target.value === "" ? NaN : Number(e.target.value))} /><span>桶</span>
    </label>)}
    <p>儲值小計 ${topups.reduce((sum, l) => sum + Number(l.lineAmount ?? 0), 0).toLocaleString()} · 預計入帳 {topups.reduce((sum, l) => sum + (l.qtyOrdered ?? 0), 0)} 桶（含贈桶，依已確認明細）</p>
  </div>;
}
