import { useEffect, useMemo, useRef, useState } from "react";
import { moneyText } from "../adminUtils";
import "./no-order-review.css";

export type NoOrderReviewCustomer = {
  key: string; code: string; name: string; version: string; reason: string;
  details: { customerId: string | null; handedOver?: boolean; reviewed: boolean; included: boolean;
    startDate?: string; cutoffDate?: string; note: string; prepayment: number | null; sourceOverShort?: number;
    prepaidBarrels: number; sourcePrepaidBarrels: number; legacyBarrels: number; warnings: string[];
    addresses: { id: string; label: string; barrels: number; original: number }[] };
};

export function NoOrderReviewDialog({ rows, checkedAt, onClose, onInspect, onProcess }: {
  rows: NoOrderReviewCustomer[]; checkedAt: string; onClose: () => void;
  onInspect: (key: string, code: string) => void; onProcess: (rows: NoOrderReviewCustomer[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { dialog.current?.showModal(); }, []);
  const eligible = (r: NoOrderReviewCustomer) => !r.reason && !r.details.handedOver && Boolean(r.details.customerId);
  const filtered = useMemo(() => rows.filter(r => `${r.code} ${r.name} ${r.details.note}`.includes(search.trim())
    && (status === "all" || (status === "completed" ? r.details.handedOver : status === "ready" ? eligible(r) : !r.details.handedOver && !eligible(r)))), [rows, search, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * 50, currentPage * 50);
  const active = rows.find(r => r.key === activeKey);
  const selectedRows = rows.filter(r => selected.has(r.key) && eligible(r));
  const statusText = (r: NoOrderReviewCustomer) => r.details.handedOver ? "已完成交接" : r.reason ? "需人工核對" : r.details.reviewed ? "已確認待交接" : "待核對";
  const toggle = (key: string, checked: boolean) => setSelected(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next; });
  return <dialog ref={dialog} className="no-order-review" onCancel={onClose} aria-labelledby="no-order-review-title">
    <header className="no-order-review__header"><div><h2 id="no-order-review-title">無歷史訂單客戶檢查</h2><p>共 {rows.length} 位 · 查詢時間 {new Date(checkedAt).toLocaleString("zh-TW")}。開啟、搜尋與查看資料都不會執行交接。</p></div><button type="button" className="btn" onClick={onClose} aria-label="關閉客戶檢查視窗">關閉</button></header>
    <div className="no-order-review__controls"><label>搜尋客戶或說明<input value={search} placeholder="客戶代號、名稱、收空桶…" onChange={e => { setSearch(e.target.value); setPage(1); }} /></label><label>交接狀態<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">全部客戶</option><option value="ready">可選取交接</option><option value="completed">已完成交接</option><option value="attention">需人工核對</option></select></label><button type="button" className="btn" disabled={!pageRows.some(eligible)} onClick={() => setSelected(previous => new Set([...previous, ...pageRows.filter(eligible).map(r => r.key)]))}>選取本頁可處理客戶</button><button type="button" className="btn" disabled={!selected.size} onClick={() => setSelected(new Set())}>清除選取</button></div>
    <div className="no-order-review__content"><section className="no-order-review__list" aria-label="篩選客戶清單"><div className="no-order-review__table"><table><thead><tr><th>選取</th><th>客戶</th><th>交接狀態</th><th>短溢收</th><th>預付桶</th><th>空桶合計</th><th>資料</th></tr></thead><tbody>{pageRows.map(r => <tr key={r.key} className={r.key === activeKey ? "is-selected" : ""}>
      <td><input type="checkbox" aria-label={`選取 ${r.code} ${r.name}`} disabled={!eligible(r)} checked={selected.has(r.key)} onChange={e => toggle(r.key, e.target.checked)} /></td>
      <td><strong>{r.code}</strong><br />{r.name}</td><td>{statusText(r)}</td><td>{r.details.prepayment === null ? "未填" : moneyText(r.details.prepayment)}</td><td>{r.details.prepaidBarrels}</td><td>{r.details.addresses.reduce((n, a) => n + a.barrels, 0)}</td><td><button type="button" className="btn btn--sm" aria-pressed={r.key === activeKey} onClick={() => setActiveKey(r.key)}>查看資料</button></td>
    </tr>)}</tbody></table>{!filtered.length && <p>沒有符合條件的客戶。</p>}</div><div className="no-order-review__pagination"><span>符合 {filtered.length} 位 · 第 {currentPage} / {pageCount} 頁（每頁 50 位）</span><button type="button" className="btn btn--sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一頁</button><button type="button" className="btn btn--sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一頁</button></div></section>
    <aside className="no-order-review__detail" aria-label="客戶詳細資料">{active ? <>
      <h3>{active.code} · {active.name}</h3><p>{statusText(active)}{!active.details.included ? " · 草稿已排除" : ""}</p><p>以下為已保存的交接草稿，執行交接時仍會重新檢查舊資料。</p>
      <dl><dt>啟用日／截止日</dt><dd>{active.details.startDate ?? "—"}／{active.details.cutoffDate ?? "—"}</dd><dt>短溢收金額</dt><dd>{active.details.prepayment === null ? "未填" : moneyText(active.details.prepayment)}（舊來源：{active.details.sourceOverShort === undefined ? "未記錄" : moneyText(active.details.sourceOverShort)}）</dd><dt>預付桶</dt><dd>{active.details.prepaidBarrels}（舊來源：{active.details.sourcePrepaidBarrels}）</dd><dt>舊系統空桶總數</dt><dd>{active.details.legacyBarrels}</dd><dt>客戶核對說明／排除後處理方式</dt><dd className="no-order-review__note">{active.details.note || "尚未填寫"}</dd></dl>
      <p>短溢收正數是公司欠客戶，負數是客戶欠公司。</p><h4>各配送地址空桶</h4>{active.details.addresses.map(a => <div className="no-order-review__address" key={a.id}><strong>{a.label}</strong><p>交接空桶 {a.barrels} 桶 · 建立草稿時新系統 {a.original} 桶</p></div>)}{!active.details.addresses.length && <p>沒有配送地址。</p>}
      {active.reason && <p className="alert">{active.reason}</p>}{active.details.warnings.length > 0 && <ul>{active.details.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <button type="button" className="btn" onClick={() => onInspect(active.key, active.code)}>回交接頁展開此客戶</button>
    </> : <p>點選清單的「查看資料」，檢查金額、預付桶、各地址空桶與說明。已完成交接的客戶也可以查看，但不能再次選取交接。</p>}</aside></div>
    <footer className="no-order-review__footer"><div><strong>已選取 {selectedRows.length} 位（含其他頁）</strong><p>未選取的客戶不處理。執行後會承接金額與桶數，並標記流失：原因「其他」、說明「系統轉換標記流失」。</p></div><button type="button" className="btn" onClick={onClose}>先不交接，關閉</button><button type="button" className="btn btn--primary" disabled={!selectedRows.length} onClick={() => onProcess(selectedRows)}>交接已選取客戶並標記流失（{selectedRows.length}）</button></footer>
  </dialog>;
}
