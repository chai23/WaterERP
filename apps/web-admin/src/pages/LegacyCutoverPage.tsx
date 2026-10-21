import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { moneyText, todayLocalYmd } from "../adminUtils";

type Order = { id: string; day: string; outstanding: number; received: number; completed: boolean; billing: string;
  disposition: string; finalAmount: number; dueDate: string; invoiceMode: string; note: string; arNo?: string };
type Row = { key: string; code: string; name: string; customerId: string | null; included: boolean; warnings: string[];
  reviewed: boolean; note: string; prepayment: number | null; prepaidBarrels: number; sourcePrepaidBarrels: number; legacyBarrels: number;
  addresses: { id: string; label: string; barrels: number; original: number }[]; orders: Order[] };
type Snapshot = { startDate: string; cutoffDate: string; capturedAt: string; sourceFrozen: boolean; totalsConfirmed: boolean; rows: Row[]; blockers: string[] };
type State = { revision: number; status: string; snapshot: Snapshot | null; appliedAt: string | null; errors: string[] };
const labels: Record<string, string> = { cash: "一般未收款", monthly_billed: "月結已出帳未收", monthly_pending: "月結尚未出帳", exclude: "排除／待辦移交" };

export default function LegacyCutoverPage() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [startDate, setStartDate] = useState(todayLocalYmd());
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"regenerate" | "activate" | "review" | null>(null);
  const [page, setPage] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirmation) dialogRef.current?.showModal(); }, [confirmation]);
  const applied = state?.status === "applied";
  const accept = (s: State) => { setState(s); setDraft(s.snapshot); setDirty(false); if (s.snapshot) setStartDate(s.snapshot.startDate); };
  const request = async (path = "", method = "GET", body?: unknown): Promise<State> => {
    const res = await fetch(`/api/legacy-cutover/handover${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message ?? "操作失敗");
    return data.data;
  };
  useEffect(() => { let live = true; setBusy(true); request().then(s => { if (live) { accept(s); setStep(s.status === "applied" ? 4 : s.snapshot ? 2 : 1); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const mutate = (change: (d: Snapshot) => void) => {
    if (!draft || applied || busy) return;
    const d = structuredClone(draft); change(d); d.totalsConfirmed = false; setDraft(d); setDirty(true); setMessage("");
  };
  const editRow = (key: string, change: (r: Row) => void, preserveReview = false) => mutate(d => {
    const r = d.rows.find(r => r.key === key)!; change(r); if (!preserveReview) r.reviewed = false;
  });
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); setMessage(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失敗"); } finally { setBusy(false); } };
  const save = async () => { const s = await request("/draft", "PUT", { revision: state?.revision, snapshot: draft }); accept(s); return s; };
  const generate = () => run(async () => { accept(await request("/draft", "POST", { startDate, revision: state?.revision })); setStep(2); setMessage("交接草稿已保存，尚未寫入任何帳務餘額。"); });
  const rows = useMemo(() => draft?.rows.filter(r => (!onlyPending || !r.reviewed || !r.included) && `${r.code} ${r.name}`.includes(search.trim())) ?? [], [draft, search, onlyPending]);
  const pageCount = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * 100, currentPage * 100);
  const bulkRows = pageRows.filter(r => r.included && r.customerId && !r.reviewed && !r.warnings.length && !r.orders.length && (r.prepayment === null || r.prepayment === 0));
  useEffect(() => { setPage(1); }, [search, onlyPending]);
  const totals = useMemo(() => {
    const t: Record<string, number> = { cash: 0, monthly_billed: 0, monthly_pending: 0, prepayment: 0, prepaid: 0, barrels: 0, included: 0, reviewed: 0, excluded: 0 };
    for (const r of draft?.rows ?? []) {
      if (!r.included) { t.excluded++; continue; } t.included++; if (r.reviewed) t.reviewed++;
      t.prepayment += r.prepayment ?? 0; t.prepaid += r.prepaidBarrels; t.barrels += r.addresses.reduce((s, a) => s + a.barrels, 0);
      for (const o of r.orders) if (o.disposition !== "exclude") t[o.disposition] += o.finalAmount;
    } return t;
  }, [draft]);
  const exportReport = () => {
    if (!draft) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
    const lines: unknown[][] = [["啟用日", draft.startDate, "截止日", draft.cutoffDate, "狀態", applied ? "已啟用" : "草稿"], ["客戶代號", "客戶", "承接", "項目", "來源", "金額或桶數", "到期日", "處理說明"]];
    for (const r of draft.rows) {
      for (const o of r.orders) lines.push([r.code, r.name, r.included ? "是" : "否", labels[o.disposition], o.arNo ? `${o.id} → ${o.arNo}` : o.id, o.finalAmount, o.dueDate, o.note || r.note]);
      for (const [label, value] of [["金額預收", r.prepayment], ["預付桶", r.prepaidBarrels]]) lines.push([r.code, r.name, r.included ? "是" : "否", label, "交接核對", value, "", r.note]);
      for (const a of r.addresses) lines.push([r.code, r.name, r.included ? "是" : "否", "地址空桶", a.label, a.barrels, "", r.note]);
    }
    const url = URL.createObjectURL(new Blob(["\uFEFF" + lines.map(l => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `上線交接-${draft.startDate}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return <section className="handover-page">
    <header className="handover-header"><div><span className="handover-eyebrow">舊系統 → 新系統</span><h2>上線交接</h2><p>把尚未完成的帳務與桶數核對清楚，再一次啟用。</p></div><Link className="btn btn--ghost" to="/reports/billing-ar">前往帳務作業台</Link></header>
    <nav className="handover-steps" aria-label="交接步驟">{["設定啟用日", "核對客戶交接表", "核對總額", "正式啟用"].map((label, i) => <button key={label} className={step === i + 1 ? "is-active" : ""} disabled={busy || (!draft && i > 0)} onClick={() => setStep(i + 1)}><span>{i + 1}</span>{label}</button>)}</nav>
    {error && <div className="alert alert--error handover-message" role="alert">{error}</div>}
    {message && <div className="alert handover-message" role="status">{message}</div>}
    {confirmation && <dialog ref={dialogRef} className="handover-confirm-box" onCancel={() => setConfirmation(null)} aria-labelledby="handover-confirm-title"><h3 id="handover-confirm-title">{confirmation === "regenerate" ? "重新產生交接草稿？" : confirmation === "review" ? "批次確認本頁正常客戶？" : "確認正式啟用交接？"}</h3><p>{confirmation === "regenerate" ? "這會替換尚未啟用的草稿與人工核對內容。" : confirmation === "review" ? `本頁 ${bulkRows.length} 位客戶沒有待處理舊單或異常。確認後金額預收設為 0，保留畫面的預付桶及地址空桶並標記已核對。請先確認這些客戶確實沒有金額預收。` : `將啟用 ${draft?.startDate} 的交接，共 ${totals.included} 位客戶。成功後鎖定，不能再覆寫餘額。`}</p><div className="handover-footer"><button className="btn" onClick={() => setConfirmation(null)}>取消</button><button className="btn btn--primary" onClick={() => { const action = confirmation; setConfirmation(null); if (action === "regenerate") void generate(); else if (action === "review") { const keys = new Set(bulkRows.map(r => r.key)); mutate(d => { for (const r of d.rows) if (keys.has(r.key)) { r.prepayment = 0; r.reviewed = true; } }); } else void run(async () => { accept(await request("/apply", "POST", { revision: state?.revision })); setMessage("交接已成功啟用，所有帳務一次完成。"); }); }}>{confirmation === "regenerate" ? "確認重新產生" : confirmation === "review" ? "確認無金額預收並核對" : "確認啟用"}</button></div></dialog>}
    {applied && <div className="handover-success"><strong>交接已啟用，餘額與來源紀錄已鎖定。</strong><p>{state?.appliedAt && new Date(state.appliedAt).toLocaleString("zh-TW")} 完成。後續收款請在新系統處理；差異以帳務調整保留紀錄。</p></div>}
    {step === 1 && <div className="card handover-panel"><h3>新系統從哪一天開始？</h3><p>自動承接前一天營業結束的資料。建議選擇月結邊界，先完成舊系統結帳，再移交尚未收清的餘額。</p>
      <label className="handover-field">新系統啟用日<input type="date" value={startDate} disabled={busy || applied} onInput={e => setStartDate(e.currentTarget.value)} onChange={e => setStartDate(e.target.value)} /></label>
      <p>本次選擇啟用日：<strong>{startDate || "尚未選擇"}</strong></p>
      <div className="handover-note">舊庫必須是截止日的凍結資料或備份。歷史現金收款與桶數不能靠修改日期還原。預收金額需依舊帳人工填入，沒有預收也請明確填 0。</div>
      <button className="btn btn--primary" disabled={busy || applied || !state || !startDate} onClick={() => {
        if (draft) setConfirmation("regenerate"); else void generate();
      }}>{busy ? "讀取中…" : draft ? "重新產生交接草稿" : "產生交接草稿"}</button></div>}
    {draft && <>
      <div className="handover-meta"><span>啟用 {draft.startDate} · 承接截至 {draft.cutoffDate}</span><span>快照 {new Date(draft.capturedAt).toLocaleString("zh-TW")} · 版本 {state?.revision}{dirty ? " · 有未儲存變更" : " · 已保存"}</span></div>
      {!!draft.blockers.length && <div className="alert alert--error"><strong>正式啟用前必須處理</strong><ul>{draft.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {step === 2 && <div className="card handover-panel">
        <div className="handover-toolbar"><label className="handover-field">搜尋客戶<input placeholder="客戶代號或名稱" value={search} onChange={e => setSearch(e.target.value)} /></label><label><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} /> 只看待確認／排除</label><span>已確認 {totals.reviewed} / {totals.included} 位 · 排除 {totals.excluded} 位</span></div>
        <p>展開客戶逐項核對。月結請區分已出帳與尚未出帳；未配送單留作待辦移交。</p>
        <div className="handover-toolbar handover-pagination"><span>符合 {rows.length} 位 · 第 {currentPage} / {pageCount} 頁（每頁 100 位）</span><button className="btn" disabled={currentPage === 1 || busy} onClick={() => setPage(currentPage - 1)}>上一頁</button><button className="btn" disabled={currentPage === pageCount || busy} onClick={() => setPage(currentPage + 1)}>下一頁</button>{!applied && <button className="btn" disabled={busy || !bulkRows.length} onClick={() => setConfirmation("review")}>批次確認本頁正常客戶（{bulkRows.length}）</button>}</div>
        <div className="handover-customers">{!rows.length && <p>沒有符合條件的客戶。</p>}{pageRows.map(r => <article key={r.key} className={`handover-customer ${!r.included ? "is-excluded" : ""}`}>
          <button className="handover-customer-head" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}><span><b>{r.code} · {r.name}</b><small>{r.orders.length} 筆待處理舊單 · 舊預付 {r.sourcePrepaidBarrels} 桶 · 舊空桶 {r.legacyBarrels} 桶</small></span><span className={`handover-status ${r.reviewed ? "is-done" : ""}`}>{!r.included ? "已排除" : r.reviewed ? "已確認" : r.warnings.length ? "待處理異常" : "待核對"}</span><span>{expanded === r.key ? "收合 −" : "展開 ＋"}</span></button>
          {expanded === r.key && <fieldset disabled={busy || applied} className="handover-customer-body">
            <label><input type="checkbox" checked={r.included} onChange={e => editRow(r.key, r => { r.included = e.target.checked; })} /> 納入本次交接</label>
            {!!r.warnings.length && <ul className="handover-warnings">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            {r.included && <><div className="handover-balance-fields"><label className="handover-field">金額預收（元，無則填 0）<input type="number" min="0" step="0.01" value={r.prepayment ?? ""} onChange={e => editRow(r.key, r => { r.prepayment = e.target.value === "" ? null : Number(e.target.value); })} /></label><label className="handover-field">預付桶數<input type="number" step="1" value={r.prepaidBarrels} onChange={e => editRow(r.key, r => { r.prepaidBarrels = Number(e.target.value); })} /></label></div>
            <h4>各配送地址空桶</h4><div className="handover-addresses">{r.addresses.map(a => <label className="handover-field" key={a.id}>{a.label}<input type="number" min="0" step="1" value={a.barrels} onChange={e => editRow(r.key, r => { r.addresses.find(x => x.id === a.id)!.barrels = Number(e.target.value); })} /></label>)}{!r.addresses.length && <p>尚無配送地址</p>}</div>
            <h4>舊單逐筆交接</h4>{r.orders.map(o => <div className="handover-order" key={o.id}><strong>舊單 {o.id}</strong><small>{o.day} · {o.billing} · {o.completed ? "配送完成" : "未完成配送"} · 已收 {moneyText(o.received)}／餘額 {moneyText(o.outstanding)}</small><div className="handover-order-fields">
              <label className="handover-field">交接方式<select value={o.disposition} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.disposition = e.target.value; })}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="handover-field">交接金額<input type="number" min="0" step="0.01" value={o.finalAmount} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.finalAmount = Number(e.target.value); })} /></label>
              {o.disposition !== "monthly_pending" && o.disposition !== "exclude" && <label className="handover-field">到期日<input type="date" value={o.dueDate} onInput={e => { const value = e.currentTarget.value; editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.dueDate = value; }); }} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.dueDate = e.target.value; })} /></label>}
              {o.disposition === "monthly_pending" && <label className="handover-field">待結金額口徑<select value={o.invoiceMode} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.invoiceMode = e.target.value; })}><option value="none">不開發票</option><option value="tax_inclusive">含稅</option><option value="tax_exclusive">未稅（結帳外加稅）</option></select></label>}
              <label className="handover-field handover-field--wide">舊單調整／排除原因<input value={o.note} maxLength={400} placeholder="未配送請記錄由哪個系統接續處理" onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.note = e.target.value; })} /></label>
            </div>{o.disposition === "monthly_pending" && <p className="handover-note">開立月結時才產生應收，請選擇與後續月結相同的稅額口徑。已有部分收款者，請先在舊系統結帳，以已出帳餘額承接。</p>}</div>)}</>}
            <label className="handover-field">客戶核對說明／排除後處理方式<textarea maxLength={400} value={r.note} onChange={e => editRow(r.key, r => { r.note = e.target.value; })} placeholder="有異常、調整桶數或排除客戶時必填" /></label>
            {r.included && <label className="handover-review"><input type="checkbox" checked={r.reviewed} onChange={e => editRow(r.key, r => { r.reviewed = e.target.checked; }, true)} /> 已逐項核對此客戶的欠款、月結、預收與桶數</label>}
          </fieldset>}
        </article>)}</div>
        <div className="handover-footer"><button className="btn" disabled={busy || applied || !dirty} onClick={() => void run(async () => { await save(); setMessage("草稿已保存，尚未正式入帳。"); })}>儲存草稿</button><button className="btn btn--primary" disabled={busy} onClick={() => void run(async () => { if (dirty) await save(); setStep(3); })}>下一步：核對總額</button></div>
      </div>}
      {(step === 3 || step === 4) && <div className="card handover-panel"><h3>{step === 3 ? "核對各類交接總額" : applied ? "交接完成" : "正式啟用前確認"}</h3><div className="handover-totals">{[["一般未收款", moneyText(totals.cash)], ["月結已出帳未收", moneyText(totals.monthly_billed)], ["月結尚未出帳", moneyText(totals.monthly_pending)], ["金額預收", moneyText(totals.prepayment)], ["預付桶", `${totals.prepaid} 桶`], ["各地址空桶", `${totals.barrels} 桶`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <p>交接 {totals.included} 位客戶，已確認 {totals.reviewed} 位，排除 {totals.excluded} 位。待結月結與預收分開保留，不在此互相抵銷。</p>
        {!applied && <fieldset disabled={busy} className="handover-confirmations"><label><input type="checkbox" checked={draft.sourceFrozen} onChange={e => mutate(d => { d.sourceFrozen = e.target.checked; })} /> 舊系統已停止新增帳務；資料為 {draft.cutoffDate} 營業結束的凍結資料，收款與桶數已核對。</label><label><input type="checkbox" checked={draft.totalsConfirmed} onChange={e => { setDraft({ ...draft, totalsConfirmed: e.target.checked }); setDirty(true); }} /> 各類總額已與舊系統核對，排除項目已有後續處理安排。</label></fieldset>}
        {!applied && state && !dirty && !!state.errors.length && <div className="handover-warnings"><strong>尚有 {state.errors.length} 項待處理</strong><ul>{state.errors.slice(0, 15).map((e, i) => <li key={i}>{e}</li>)}</ul>{state.errors.length > 15 && <p>其餘請回客戶交接表逐戶核對。</p>}</div>}
        <div className="handover-footer"><button className="btn" onClick={exportReport}>下載交接清單 CSV</button>{!applied && <><button className="btn" disabled={busy} onClick={() => setStep(2)}>返回客戶核對</button><button className="btn btn--primary" disabled={busy} onClick={() => void run(async () => { const s = dirty ? await save() : state!; if (s.errors.length) { setMessage("已保存，請處理待確認項目。"); return; } setStep(4); setMessage("核對通過，可正式啟用。"); })}>儲存並檢查</button></>}</div>
        {step === 4 && !applied && <div className="handover-activate"><p>正式啟用會一次寫入期初應收、待結月結、預收及桶數，成功後鎖定；重複提交不會重複開帳。</p><button className="btn btn--primary" disabled={busy || dirty || !state || state.errors.length > 0} onClick={() => setConfirmation("activate")}>{busy ? "啟用中…" : "正式啟用交接"}</button></div>}
      </div>}
    </>}
  </section>;
}
