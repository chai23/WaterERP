import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { moneyText, todayLocalYmd } from "../adminUtils";

type Order = { id: string; day: string; outstanding: number; received: number; completed: boolean; billing: string;
  disposition: string; finalAmount: number; dueDate: string; invoiceMode: string; note: string; arNo?: string };
type Row = { startDate?: string; cutoffDate?: string; key: string; code: string; name: string; customerId: string | null; included: boolean; warnings: string[];
  reviewed: boolean; note: string; prepayment: number | null; sourceOverShort?: number; prepaidBarrels: number; sourcePrepaidBarrels: number; legacyBarrels: number;
  addresses: { id: string; label: string; barrels: number; original: number }[]; orders: Order[]; handedOver?: boolean };
type Snapshot = { startDate: string; cutoffDate: string; capturedAt: string; sourceFrozen: boolean; totalsConfirmed: boolean; rows: Row[]; blockers: string[] };
type State = { revision: number; status: string; snapshot: Snapshot | null; appliedAt: string | null; errors: string[] };
const labels: Record<string, string> = { cash: "一般未收款", monthly_billed: "月結已出帳未收", monthly_pending: "月結尚未出帳", exclude: "排除／待辦移交" };

export default function LegacyCutoverPage() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [startDate, setStartDate] = useState(todayLocalYmd);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [singleCode, setSingleCode] = useState("");
  const [pendingCode, setPendingCode] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"regenerate" | "refresh" | "review" | "customer" | null>(null);
  const [page, setPage] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirmation) dialogRef.current?.showModal(); }, [confirmation]);
  const applied = state?.status === "applied";
  const accept = (s: State) => { setState(s); setDraft(s.snapshot); setDirty(false); };
  const request = async (path = "", method = "GET", body?: unknown): Promise<State> => {
    const res = await fetch(`/api/legacy-cutover/handover${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (res.status === 413) throw new Error("交接資料超過伺服器接收上限，尚未儲存。請保留此頁，聯絡管理員確認前後端版本及 Nginx 設定已更新。");
    if (text.trimStart().startsWith("<")) throw new Error(`伺服器回應異常（${res.status}），請再試一次。`);
    const data = JSON.parse(text);
    if (!res.ok || !data.ok) throw new Error(data.message ?? "操作失敗");
    return data.data;
  };
  useEffect(() => { let live = true; setBusy(true); request().then(s => { if (live) { accept(s); setStep(s.snapshot ? 2 : 1); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, []);
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
  const save = async () => {
    if (!draft || !state?.snapshot) throw new Error("尚未載入交接草稿");
    const editable = (r: Row) => ({
      key: r.key, included: r.included, note: r.note, reviewed: r.reviewed,
      prepayment: r.prepayment, prepaidBarrels: r.prepaidBarrels,
      addresses: r.addresses.map(a => ({ id: a.id, barrels: a.barrels })),
      orders: r.orders.map(o => ({ id: o.id, disposition: o.disposition, finalAmount: o.finalAmount,
        dueDate: o.dueDate, invoiceMode: o.invoiceMode, note: o.note })),
    });
    const previous = new Map(state.snapshot.rows.map(r => [r.key, JSON.stringify(editable(r))]));
    const rows = draft.rows.filter(r => !r.handedOver).map(editable)
      .filter(r => JSON.stringify(r) !== previous.get(r.key));
    const s = await request("/draft", "PUT", { revision: state.revision, partial: true,
      snapshot: { sourceFrozen: draft.sourceFrozen, totalsConfirmed: draft.totalsConfirmed, rows } });
    accept(s); return s;
  };
  const generate = () => run(async () => { accept(await request("/draft", "POST", { startDate, revision: state?.revision })); setStep(2); setMessage("全部客戶的交接草稿已保存，尚未寫入任何帳務餘額。請逐戶按「完成此客戶交接」。"); });
  const generateOne = () => run(async () => {
    const customerCode = singleCode.trim();
    if (!/^\d{1,6}$/.test(customerCode)) { setError("客戶編號須為 6 碼以內數字"); return; }
    accept(await request("/draft", "POST", { startDate, revision: state?.revision, customerCode }));
    const padded = customerCode.padStart(6, "0");
    setSearch(padded); setExpanded(padded); setStep(2);
    setMessage(`已準備客戶 ${padded} 的交接資料，尚未寫入帳務。核對後按「完成此客戶交接」。`);
  });
  const rows = useMemo(() => draft?.rows.filter(r => (!onlyPending || !r.reviewed || !r.included) && (!onlyExceptions || (r.included && !r.reviewed && !r.handedOver && r.warnings.length > 0)) && (!onlyOpen || !r.handedOver) && `${r.code} ${r.name}`.includes(search.trim())) ?? [], [draft, search, onlyPending, onlyExceptions, onlyOpen]);
  const pageCount = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * 100, currentPage * 100);
  const bulkRows = pageRows.filter(r => !r.handedOver && r.included && r.customerId && !r.reviewed && !r.warnings.length && !r.orders.length && (r.prepayment === null || r.prepayment === 0));
  const finished = draft?.rows.filter(r => r.handedOver).length ?? 0;
  useEffect(() => { setPage(1); }, [search, onlyPending, onlyExceptions, onlyOpen]);
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
    const lines: unknown[][] = [["最近產生啟用日", draft.startDate, "最近產生截止日", draft.cutoffDate, "狀態", applied ? "已啟用" : "草稿"], ["客戶代號", "客戶", "承接", "項目", "來源", "金額或桶數", "到期日", "處理說明"]];
    for (const r of draft.rows) {
      lines.push(["客戶交接日期", r.code, r.name, "啟用日", r.startDate ?? draft.startDate, "截止日", r.cutoffDate ?? draft.cutoffDate]);
      for (const o of r.orders) lines.push([r.code, r.name, r.included ? "是" : "否", labels[o.disposition], o.arNo ? `${o.id} → ${o.arNo}` : o.id, o.finalAmount, o.dueDate, o.note || r.note]);
      for (const [label, value] of [["短溢收", r.prepayment], ["預付桶", r.prepaidBarrels]]) lines.push([r.code, r.name, r.included ? "是" : "否", label, "交接核對", value, "", r.note]);
      for (const a of r.addresses) lines.push([r.code, r.name, r.included ? "是" : "否", "地址空桶", a.label, a.barrels, "", r.note]);
    }
    const url = URL.createObjectURL(new Blob(["\uFEFF" + lines.map(l => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `上線交接-${draft.startDate}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return <section className="handover-page">
    <header className="handover-header"><div><span className="handover-eyebrow">舊系統 → 新系統</span><h2>上線交接</h2><p>一次只完成一位客戶。由舊系統轉入、尚未完成交接的客戶，不能在新系統新增訂單。</p></div><Link className="btn btn--ghost" to="/reports/billing-ar">前往帳務作業台</Link></header>
    <nav className="handover-steps" aria-label="交接步驟">{["設定啟用日", "核對並完成單戶", "查看進度"].map((label, i) => <button key={label} className={step === i + 1 ? "is-active" : ""} disabled={busy || (!draft && i > 0)} onClick={() => setStep(i + 1)}><span>{i + 1}</span>{label}</button>)}</nav>
    {error && <div className="alert alert--error handover-message" role="alert">{error}</div>}
    {message && <div className="alert handover-message" role="status">{message}</div>}
    {confirmation && <dialog ref={dialogRef} className="handover-confirm-box" onCancel={() => setConfirmation(null)} aria-labelledby="handover-confirm-title"><h3 id="handover-confirm-title">{confirmation === "regenerate" ? "重新產生全部客戶草稿？" : confirmation === "refresh" ? "更新這位客戶的交接資料？" : confirmation === "review" ? "批次確認本頁正常客戶？" : `完成客戶 ${pendingCode} 的交接？`}</h3><p>{confirmation === "regenerate" ? "這會替換尚未完成交接的客戶草稿。已完成的客戶會保留，不會重複入帳。" : confirmation === "refresh" ? "依本次選擇的啟用日更新這位客戶，包含當天的舊資料；此客戶尚未完成的核對內容會被清掉。其他客戶不變。" : confirmation === "review" ? `本頁 ${bulkRows.length} 位客戶沒有待處理舊單或異常。確認後短溢收維持 0，保留畫面的預付桶及地址空桶並標記已核對。這只是核對，還沒有入帳。` : `只會寫入客戶 ${pendingCode} 的期初餘額，並開放該客戶新增訂單。其他客戶維持未交接，未完成前不能新增訂單。`}</p><div className="handover-footer"><button className="btn" onClick={() => setConfirmation(null)}>取消</button><button className="btn btn--primary" onClick={() => { const action = confirmation; const code = pendingCode; setConfirmation(null); if (action === "regenerate") void generate(); else if (action === "refresh") void generateOne(); else if (action === "review") { const keys = new Set(bulkRows.map(r => r.key)); mutate(d => { for (const r of d.rows) if (keys.has(r.key)) { r.prepayment = 0; r.reviewed = true; } }); } else void run(async () => { const saved = dirty ? await save() : state!; const s = await request("/apply-customer", "POST", { revision: saved.revision, customerCode: code }); accept(s); setMessage(`客戶 ${code} 已完成交接，可以新增訂單。其他未完成的客戶仍不能開新訂單。`); }); }}>{confirmation === "regenerate" ? "確認重新產生" : confirmation === "refresh" ? "確認更新此客戶" : confirmation === "review" ? "確認短溢收為 0 並核對" : "完成此客戶交接"}</button></div></dialog>}
    {applied && <div className="handover-success"><strong>交接已啟用，餘額與來源紀錄已鎖定。</strong><p>{state?.appliedAt && new Date(state.appliedAt).toLocaleString("zh-TW")} 完成。後續收款請在新系統處理；差異以帳務調整保留紀錄。</p></div>}
    {step === 1 && <div className="card handover-panel"><h3>新系統從哪一天開始？</h3><p>承接截至啟用日當天的舊訂單與收款（包含當天）。建議選擇月結邊界，先完成舊系統結帳，再移交尚未收清的餘額。</p>
      <label className="handover-field">新系統啟用日<input type="date" value={startDate} disabled={busy || applied} onInput={e => setStartDate(e.currentTarget.value)} onChange={e => setStartDate(e.target.value)} /></label>
      <p>本次選擇啟用日：<strong>{startDate || "尚未選擇"}</strong></p>
      <div className="handover-note">舊庫必須是截止日的凍結資料或備份。歷史現金收款與桶數不能靠修改日期還原。產生草稿時會帶入舊系統短溢收總和：正數是公司欠客戶，負數是客戶欠公司，沒有則為 0。完成交接是一戶一戶寫入，不會一次入帳全部客戶。</div>
      <label className="handover-field">客戶編號（只準備這一位）<input inputMode="numeric" maxLength={6} placeholder="例如 000123" value={singleCode} disabled={busy || applied} onChange={e => setSingleCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
      <div className="handover-footer"><button className="btn btn--primary" disabled={busy || applied || !state || !startDate || !singleCode.trim()} onClick={() => {
        const padded = singleCode.trim().padStart(6, "0");
        if (draft?.rows.some(r => r.code === padded && !r.handedOver)) setConfirmation("refresh"); else void generateOne();
      }}>{busy ? "讀取中…" : "產生此客戶交接草稿"}</button><button className="btn" disabled={busy || applied || !state || !startDate} onClick={() => {
        if (draft) setConfirmation("regenerate"); else void generate();
      }}>{draft ? "重新產生全部客戶草稿" : "產生全部客戶草稿"}</button></div></div>}
    {draft && <>
      <div className="handover-meta"><span>最近產生：啟用 {draft.startDate} · 承接截至 {draft.cutoffDate}（各戶日期見下方）</span><span>快照 {new Date(draft.capturedAt).toLocaleString("zh-TW")} · 版本 {state?.revision}{dirty ? " · 有未儲存變更" : " · 已保存"}</span></div>
      {!!draft.blockers.length && <div className="alert alert--error"><strong>這些來源問題會擋住相關客戶交接</strong><ul>{draft.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {step === 2 && <div className="card handover-panel">
        <div className="handover-toolbar"><label className="handover-field">搜尋客戶<input placeholder="客戶代號或名稱" value={search} onChange={e => setSearch(e.target.value)} /></label><label><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} /> 只看未完成交接</label><label><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} /> 只看待確認／排除</label><label><input type="checkbox" checked={onlyExceptions} onChange={e => setOnlyExceptions(e.target.checked)} /> 只看待處理異常</label><span>已完成交接 {finished} 位 · 已確認 {totals.reviewed} / {totals.included} 位 · 待處理異常 {draft.rows.filter(r => r.included && !r.reviewed && !r.handedOver && r.warnings.length > 0).length} 位 · 排除 {totals.excluded} 位</span></div>
        <p>展開一位客戶，核對後按「完成此客戶交接」。未完成的舊系統客戶不能新增訂單。</p>
        <div className="handover-toolbar handover-pagination"><span>符合 {rows.length} 位 · 第 {currentPage} / {pageCount} 頁（每頁 100 位）</span><button className="btn" disabled={currentPage === 1 || busy} onClick={() => setPage(currentPage - 1)}>上一頁</button><button className="btn" disabled={currentPage === pageCount || busy} onClick={() => setPage(currentPage + 1)}>下一頁</button>{!applied && <button className="btn" disabled={busy || !bulkRows.length} onClick={() => setConfirmation("review")}>批次確認本頁正常客戶（{bulkRows.length}）</button>}</div>
        <div className="handover-customers">{!rows.length && <p>沒有符合條件的客戶。</p>}{pageRows.map(r => <article key={r.key} className={`handover-customer ${!r.included ? "is-excluded" : ""}`}>
          <button className="handover-customer-head" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}><span><b>{r.code} · {r.name}</b><small>{r.orders.length} 筆待處理舊單 · 舊預付 {r.sourcePrepaidBarrels} 桶 · 舊空桶 {r.legacyBarrels} 桶</small></span><span className={`handover-status ${r.handedOver || r.reviewed ? "is-done" : ""}`}>{r.handedOver ? "已完成交接" : !r.included ? "已排除" : r.reviewed ? "已確認" : r.warnings.length ? "待處理異常" : "待核對"}</span><span>{expanded === r.key ? "收合 −" : "展開 ＋"}</span></button>
          {expanded === r.key && <fieldset disabled={busy || applied || Boolean(r.handedOver)} className="handover-customer-body">
            <p>此客戶啟用日：{r.startDate ?? draft.startDate} · 承接截至 {r.cutoffDate ?? draft.cutoffDate}（含當天）</p><label><input type="checkbox" checked={r.included} onChange={e => editRow(r.key, r => { r.included = e.target.checked; })} /> 納入本次交接</label>
            {!!r.warnings.length && <ul className="handover-warnings">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            {r.included && <><div className="handover-balance-fields"><label className="handover-field">短溢收總和<input type="number" step="0.01" value={r.prepayment ?? ""} onChange={e => editRow(r.key, r => { r.prepayment = e.target.value === "" ? null : Number(e.target.value); })} /></label><label className="handover-field">預付桶數<input type="number" step="1" value={r.prepaidBarrels} onChange={e => editRow(r.key, r => { r.prepaidBarrels = Number(e.target.value); })} /></label></div>
            <p className="handover-note">正數是公司欠客戶，完成交接後進入金額預收。負數是客戶欠公司，完成交接後成為未清應收。產生草稿時帶入舊系統加總{typeof r.sourceOverShort === "number" ? `（目前舊系統總和 ${moneyText(r.sourceOverShort)}）` : ""}。與總和不同時請填寫原因。</p>
            <h4>各配送地址空桶</h4><div className="handover-addresses">{r.addresses.map(a => <label className="handover-field" key={a.id}>{a.label}<input type="number" step="1" value={a.barrels} onChange={e => editRow(r.key, r => { r.addresses.find(x => x.id === a.id)!.barrels = Number(e.target.value); })} /></label>)}{!r.addresses.length && <p>尚無配送地址</p>}</div>
            <h4>舊單逐筆交接</h4>{r.orders.map(o => <div className="handover-order" key={o.id}><strong>舊單 {o.id}</strong><small>{o.day} · {o.billing} · {o.completed ? "配送完成" : "未完成配送"} · 已收 {moneyText(o.received)}／餘額 {moneyText(o.outstanding)}</small><div className="handover-order-fields">
              <label className="handover-field">交接方式<select value={o.disposition} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.disposition = e.target.value; })}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="handover-field">交接金額<input type="number" min="0" step="0.01" value={o.finalAmount} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.finalAmount = Number(e.target.value); })} /></label>
              {o.disposition !== "monthly_pending" && o.disposition !== "exclude" && <label className="handover-field">到期日<input type="date" value={o.dueDate} onInput={e => { const value = e.currentTarget.value; editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.dueDate = value; }); }} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.dueDate = e.target.value; })} /></label>}
              {o.disposition === "monthly_pending" && <label className="handover-field">待結金額口徑<select value={o.invoiceMode} onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.invoiceMode = e.target.value; })}><option value="none">不開發票</option><option value="tax_inclusive">含稅</option><option value="tax_exclusive">未稅（結帳外加稅）</option></select></label>}
              <label className="handover-field handover-field--wide">舊單調整／排除原因<input value={o.note} maxLength={400} placeholder="未配送請記錄由哪個系統接續處理" onChange={e => editRow(r.key, r => { r.orders.find(x => x.id === o.id)!.note = e.target.value; })} /></label>
            </div>{o.disposition === "monthly_pending" && <p className="handover-note">開立月結時才產生應收，請選擇與後續月結相同的稅額口徑。已有部分收款者，請先在舊系統結帳，以已出帳餘額承接。</p>}</div>)}</>}
            <label className="handover-field">客戶核對說明／排除後處理方式<textarea maxLength={400} value={r.note} onChange={e => editRow(r.key, r => { r.note = e.target.value; })} placeholder="有異常、調整桶數或排除客戶時必填" /></label>
            {r.included && <label className="handover-review"><input type="checkbox" checked={r.reviewed} onChange={e => editRow(r.key, r => { r.reviewed = e.target.checked; }, true)} /> 已逐項核對此客戶的欠款、月結、短溢收與桶數</label>}
            {r.handedOver ? <p className="handover-note">此客戶已完成交接，可以在新系統新增訂單。</p> : !applied && <div className="handover-footer"><button type="button" className="btn btn--primary" onClick={() => { setPendingCode(r.code); setConfirmation("customer"); }}>完成此客戶交接</button></div>}
          </fieldset>}
        </article>)}</div>
        <div className="handover-footer"><button className="btn" disabled={busy || applied || !dirty} onClick={() => void run(async () => { await save(); setMessage("草稿已保存，尚未入帳。完成單一客戶後才會寫入該客戶的餘額。"); })}>儲存草稿</button><button className="btn" disabled={busy} onClick={() => void run(async () => { if (dirty) await save(); setStep(3); })}>查看進度</button></div>
      </div>}
      {step === 3 && <div className="card handover-panel"><h3>單戶交接進度</h3><div className="handover-totals">{[["已完成交接", `${finished} 位`], ["尚未完成", `${draft.rows.filter(r => !r.handedOver).length} 位`], ["短溢收淨額", moneyText(totals.prepayment)], ["預付桶", `${totals.prepaid} 桶`], ["各地址空桶", `${totals.barrels} 桶`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <p>已完成的客戶可以新增訂單。尚未完成交接的舊系統客戶，開新訂單時會被拒絕。請回到客戶清單，一次完成一位。</p>
        <div className="handover-footer"><button className="btn" onClick={exportReport}>下載交接清單 CSV</button><button className="btn" disabled={busy} onClick={() => setStep(2)}>返回客戶核對</button></div>
      </div>}
    </>}
  </section>;
}
