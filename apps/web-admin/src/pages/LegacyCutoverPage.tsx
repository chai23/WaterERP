import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { moneyText, todayLocalYmd } from "../adminUtils";
import { rebaseHandover } from "../handoverSync";
import { handoverChanges, mergeHandoverSave } from "../handoverAutosave";
import { NoOrderReviewDialog, type NoOrderReviewCustomer } from "../components/NoOrderReviewDialog";

type Order = { id: string; day: string; outstanding: number; received: number; completed: boolean; billing: string;
  disposition: string; finalAmount: number; dueDate: string; invoiceMode: string; note: string; arNo?: string };
type Row = { version: string; noLegacyOrders?: boolean; startDate?: string; cutoffDate?: string; key: string; code: string; name: string; customerId: string | null; included: boolean; warnings: string[];
  reviewed: boolean; note: string; prepayment: number | null; sourceOverShort?: number; prepaidBarrels: number; sourcePrepaidBarrels: number; legacyBarrels: number;
  addresses: { id: string; label: string; barrels: number; original: number }[]; orders: Order[]; handedOver?: boolean };
type Snapshot = { startDate: string; cutoffDate: string; capturedAt: string; sourceFrozen: boolean; totalsConfirmed: boolean; rows: Row[]; blockers: string[] };
type State = { revision: number; status: string; snapshot: Snapshot | null; appliedAt: string | null; errors: string[] };
type NoOrderPreview = { checkedAt: string; rows: NoOrderReviewCustomer[] };
const labels: Record<string, string> = { cash: "一般未收款", monthly_billed: "月結已出帳未收", monthly_pending: "月結尚未出帳", exclude: "排除／待辦移交" };

export default function LegacyCutoverPage() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [startDate, setStartDate] = useState(todayLocalYmd);
  const [step, setStep] = useState(1);
  const [manualBusy, setBusy] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const busy = manualBusy || autoSaving;
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [onlyCompleted, setOnlyCompleted] = useState(false);
  const [onlyReviewed, setOnlyReviewed] = useState(false);
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyInactiveNote, setOnlyInactiveNote] = useState(false);
  const [onlyCollectBarrels, setOnlyCollectBarrels] = useState(false);
  const [onlyNoOrders, setOnlyNoOrders] = useState(false);
  const [noOrderPreview, setNoOrderPreview] = useState<NoOrderPreview | null>(null);
  const [noOrderReviewOpen, setNoOrderReviewOpen] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; success: number; errors: string[] } | null>(null);
  const stopBatch = useRef(false);
  const [singleCode, setSingleCode] = useState("");
  const [pendingCode, setPendingCode] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"regenerate" | "refresh" | "review" | "customer" | null>(null);
  const [page, setPage] = useState(1);
  const [syncError, setSyncError] = useState("");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState<State | null>(null);
  const [syncTick, setSyncTick] = useState(0);
  const current = useRef({ state, draft, dirty });
  current.current = { state, draft, dirty };
  const saveInFlight = useRef<Promise<State> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirmation) dialogRef.current?.showModal(); }, [confirmation]);
  const applied = state?.status === "applied";
  const accept = (s: State) => { current.current = { state: s, draft: s.snapshot, dirty: false }; setState(s); setDraft(s.snapshot); setDirty(false); setSaveError(""); setRemoteUpdate(null); setLastSynced(new Date().toLocaleTimeString("zh-TW")); };
  const request = async <T = State,>(path = "", method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`/api/legacy-cutover/handover${path}`, { method, signal, cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (res.status === 413) throw new Error("交接資料超過伺服器接收上限，尚未儲存。請保留此頁，聯絡管理員確認前後端版本及 Nginx 設定已更新。");
    if (text.trimStart().startsWith("<")) throw new Error(`伺服器回應異常（${res.status}），請再試一次。`);
    const data = JSON.parse(text);
    if (!res.ok || !data.ok) throw new Error(data.message ?? "操作失敗");
    return data.data;
  };
  useEffect(() => { let live = true; setBusy(true); request().then(s => { if (live) { accept(s); setStep(s.snapshot ? 2 : 1); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, []);
  useEffect(() => {
    if (!state || busy || confirmation || noOrderReviewOpen) return;
    let live = true, pending = false;
    const controller = new AbortController();
    const sync = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const version = await request<{ revision: number }>("/revision", "GET", undefined, controller.signal);
        if (!live) return;
        if (version.revision !== state.revision) {
          const next = remoteUpdate?.revision === version.revision ? remoteUpdate : await request("", "GET", undefined, controller.signal);
          if (!live || saveInFlight.current) return;
          const local = current.current;
          if (next.revision < (local.state?.revision ?? 0)) return;
          if (!local.dirty) accept(next);
          else {
            const merged = local.state?.snapshot && local.draft && next.snapshot && next.status !== "applied"
              ? rebaseHandover(local.state.snapshot, local.draft, next.snapshot) : null;
            if (merged) { current.current = { state: next, draft: merged, dirty: true }; setState(next); setDraft(merged); setRemoteUpdate(null); }
            else setRemoteUpdate(next);
          }
        }
        setLastSynced(new Date().toLocaleTimeString("zh-TW")); setSyncError("");
      } catch (e) {
        if (live) setSyncError(`自動同步暫時失敗，畫面可能不是最新狀態。${e instanceof Error ? e.message : ""}`);
      } finally { pending = false; }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 5000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { live = false; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [state, draft, dirty, busy, confirmation, syncTick, remoteUpdate, noOrderReviewOpen]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty || (manualBusy && batchProgress && batchProgress.done < batchProgress.total)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, manualBusy, batchProgress]);
  const mutate = (change: (d: Snapshot) => void) => {
    if (!draft || applied || manualBusy) return;
    const d = structuredClone(current.current.draft!); change(d); d.totalsConfirmed = false;
    current.current = { ...current.current, draft: d, dirty: true };
    setDraft(d); setDirty(true); setSaveError(""); setMessage("");
  };
  const editRow = (key: string, change: (r: Row) => void, preserveReview = false) => mutate(d => {
    const r = d.rows.find(r => r.key === key)!; change(r); if (!preserveReview) r.reviewed = false;
  });
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); setMessage(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失敗"); } finally { setBusy(false); } };
  const saveOnce = (): Promise<State> => {
    if (saveInFlight.current) return saveInFlight.current;
    const operation = async () => {
    if (remoteUpdate) throw new Error("其他電腦已修改相同客戶或重新產生草稿，請先處理畫面上方的同步提示。");
    const { state: base, draft: sent } = current.current;
    if (!sent || !base?.snapshot) throw new Error("尚未載入交接草稿");
    const rows = handoverChanges(base.snapshot, sent);
    if (!rows.length) { accept(base); return base; }
    setAutoSaving(true); setSaveError("");
    try {
      const s = await request("/draft", "PUT", { revision: base.revision, partial: true, customerVersions: true,
        snapshot: { sourceFrozen: sent.sourceFrozen, totalsConfirmed: sent.totalsConfirmed, rows } });
      const latest = current.current.draft;
      if (latest && latest !== sent && s.snapshot) {
        let merged: Snapshot;
        try { merged = mergeHandoverSave(sent, latest, s.snapshot, new Set(rows.map(r => r.key))); }
        catch (e) { setRemoteUpdate(s); throw e; }
        const pending = handoverChanges(s.snapshot, merged).length > 0;
        current.current = { state: s, draft: merged, dirty: pending };
        setState(s); setDraft(merged); setDirty(pending); setRemoteUpdate(null);
        setLastSynced(new Date().toLocaleTimeString("zh-TW"));
      } else accept(s);
      return s;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "儲存失敗");
      setSyncTick(t => t + 1);
      throw e;
    } finally { setAutoSaving(false); }
    };
    const promise = operation().finally(() => { saveInFlight.current = null; });
    saveInFlight.current = promise;
    return promise;
  };
  const save = async () => {
    let s = await saveOnce();
    while (current.current.dirty) s = await saveOnce();
    return s;
  };
  useEffect(() => {
    if (!dirty || busy || applied || confirmation || remoteUpdate || saveError) return;
    const timer = window.setTimeout(() => { void saveOnce().catch(() => {}); }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, state, dirty, busy, applied, confirmation, remoteUpdate, saveError]);
  const generate = () => run(async () => {
    const saved = current.current.dirty ? await save() : current.current.state;
    accept(await request("/draft", "POST", { startDate, revision: saved?.revision }));
    setStep(2); setMessage("全部客戶的交接草稿已保存，尚未寫入任何帳務餘額。請逐戶按「完成此客戶交接」。");
  });
  const generateOne = () => run(async () => {
    const customerCode = singleCode.trim();
    if (!/^\d{1,6}$/.test(customerCode)) { setError("客戶編號須為 6 碼以內數字"); return; }
    const saved = current.current.dirty ? await save() : current.current.state;
    accept(await request("/draft", "POST", { startDate, revision: saved?.revision, customerCode,
      customerVersion: saved?.snapshot?.rows.find(r => r.code === customerCode.padStart(6, "0"))?.version ?? null }));
    const padded = customerCode.padStart(6, "0");
    setSearch(padded); setExpanded(padded); setStep(2);
    setMessage(`已準備客戶 ${padded} 的交接資料，尚未寫入帳務。核對後按「完成此客戶交接」。`);
  });
  const noOrderKeys = useMemo(() => new Set(noOrderPreview?.rows.map(r => r.key)), [noOrderPreview]);
  const rows = useMemo(() => draft?.rows.filter(r => (!onlyCompleted || r.handedOver) && (!onlyReviewed || (r.included && r.reviewed && !r.handedOver)) && (!onlyExceptions || (r.included && !r.reviewed && !r.handedOver && r.warnings.length > 0)) && (!onlyOpen || !r.handedOver) && (!onlyInactiveNote || r.note.includes("久未叫水")) && (!onlyCollectBarrels || r.note.includes("收空桶")) && (!onlyNoOrders || noOrderKeys.has(r.key)) && `${r.code} ${r.name}`.includes(search.trim())) ?? [], [draft, search, onlyCompleted, onlyReviewed, onlyExceptions, onlyOpen, onlyInactiveNote, onlyCollectBarrels, onlyNoOrders, noOrderKeys]);
  const scanNoOrders = () => run(async () => {
    if (current.current.dirty) await save();
    const preview = await request<NoOrderPreview>("/no-order-candidates");
    if (preview.rows.some(r => !r.details)) throw new Error("請更新後端程式後再開啟客戶檢查視窗。");
    setNoOrderPreview(preview); setOnlyNoOrders(true); setOnlyInactiveNote(false); setOnlyCollectBarrels(false); setSearch("");
    setOnlyOpen(false); setOnlyReviewed(false); setOnlyCompleted(false); setOnlyExceptions(false);
    setBatchProgress(null);
    setNoOrderReviewOpen(true);
  });
  const autoNoOrders = (selected: NoOrderReviewCustomer[]) => {
    const candidates = selected.filter(r => !r.reason && !r.details.handedOver).map(r => ({ code: r.code, name: r.name, version: r.version }));
    if (!candidates.length || !window.confirm(`將只處理你已勾選的 ${candidates.length} 位客戶（包含其他頁）：重新查核無任何舊訂單後，承接舊系統金額、預付桶及各地址空桶，完成交接，標記「舊系統無訂單資料」；空桶非 0 會另加「收空桶」，並將客戶標記流失（原因：其他；說明：系統轉換標記流失）。未勾選及已完成交接的客戶不處理。確定執行？`)) return;
    setNoOrderReviewOpen(false);
    void run(async () => {
      stopBatch.current = false;
      let done = 0, success = 0; const errors: string[] = [];
      setBatchProgress({ done, success, total: candidates.length, errors: [] });
      for (const candidate of candidates) {
        if (stopBatch.current) break;
        try {
          await request<{ completed: boolean }>("/auto-no-orders", "POST", { customerCode: candidate.code, customerVersion: candidate.version });
          success++;
        } catch (e) { errors.push(`${candidate.code} ${candidate.name}：${e instanceof Error ? e.message : "處理失敗"}`); }
        done++;
        setBatchProgress({ done, success, total: candidates.length, errors: [...errors] });
      }
      accept(await request());
      setNoOrderPreview(null); setOnlyNoOrders(false);
      setMessage(`無歷史訂單自動交接：完成 ${success} 位，未完成 ${errors.length} 位${done < candidates.length ? `，尚未處理 ${candidates.length - done} 位` : ""}。`);
    });
  };
  const pageCount = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * 100, currentPage * 100);
  const bulkRows = pageRows.filter(r => !r.handedOver && r.included && r.customerId && !r.reviewed && !r.warnings.length && !r.orders.length && (r.prepayment === null || r.prepayment === 0));
  const finished = draft?.rows.filter(r => r.handedOver).length ?? 0;
  useEffect(() => { setPage(1); }, [search, onlyCompleted, onlyReviewed, onlyExceptions, onlyOpen, onlyInactiveNote, onlyCollectBarrels, onlyNoOrders]);
  const totals = useMemo(() => {
    const t: Record<string, number> = { cash: 0, monthly_billed: 0, monthly_pending: 0, prepayment: 0, prepaid: 0, barrels: 0, included: 0, reviewed: 0, excluded: 0 };
    for (const r of draft?.rows ?? []) {
      if (!r.included) { t.excluded++; continue; } t.included++; if (r.reviewed && !r.handedOver) t.reviewed++;
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
    {noOrderReviewOpen && noOrderPreview && <NoOrderReviewDialog rows={noOrderPreview.rows} checkedAt={noOrderPreview.checkedAt} onClose={() => setNoOrderReviewOpen(false)} onProcess={autoNoOrders} onInspect={(key, code) => {
      setNoOrderReviewOpen(false); setSearch(code); setExpanded(key); setStep(2);
      setOnlyOpen(false); setOnlyReviewed(false); setOnlyCompleted(false); setOnlyExceptions(false); setOnlyInactiveNote(false); setOnlyCollectBarrels(false); setOnlyNoOrders(false);
    }} />}
    <header className="handover-header"><div><span className="handover-eyebrow">舊系統 → 新系統</span><h2>上線交接</h2><p>一次只完成一位客戶。由舊系統轉入、尚未完成交接的客戶，不能在新系統新增訂單。</p></div><Link className="btn btn--ghost" to="/reports/billing-ar">前往帳務作業台</Link></header>
    <nav className="handover-steps" aria-label="交接步驟">{["設定啟用日", "核對並完成單戶", "查看進度"].map((label, i) => <button key={label} className={step === i + 1 ? "is-active" : ""} disabled={busy || (!draft && i > 0)} onClick={() => setStep(i + 1)}><span>{i + 1}</span>{label}</button>)}</nav>
    {error && <div className="alert alert--error handover-message" role="alert">{error}</div>}
    {message && <div className="alert handover-message" role="status">{message}</div>}
    {saveError && <div className="alert alert--error" role="alert">自動儲存失敗，修改仍保留在此頁，請勿關閉或重新整理。{saveError} <button type="button" className="btn" disabled={busy || Boolean(remoteUpdate)} onClick={() => void run(async () => { await save(); })}>重試儲存</button></div>}
    <div className="handover-meta" role="status"><span>每 5 秒自動同步交接進度{lastSynced ? ` · 最後檢查 ${lastSynced}` : " · 連線中…"}</span><button type="button" className="btn btn--sm" disabled={busy || Boolean(confirmation)} onClick={() => setSyncTick(t => t + 1)}>立即同步</button></div>
    {syncError && <div className="alert alert--error" role="alert">{syncError} 系統會自動重試。</div>}
    {remoteUpdate && <div className="alert alert--error" role="alert"><p>其他電腦已修改你正在編輯的客戶，或重新產生草稿。你的未儲存內容已保留，目前清單尚未套用新版。伺服器最新已完成 {remoteUpdate.snapshot?.rows.filter(r => r.handedOver).length ?? 0} 位。請先記下要保留的修改，再載入最新資料核對。</p><button type="button" className="btn" disabled={busy} onClick={() => { if (window.confirm("確定捨棄本機未儲存的修改，載入其他電腦更新後的資料？")) { accept(remoteUpdate); setSyncTick(t => t + 1); } }}>捨棄本機修改並載入新版</button></div>}
    {confirmation && <dialog ref={dialogRef} className="handover-confirm-box" onCancel={() => setConfirmation(null)} aria-labelledby="handover-confirm-title"><h3 id="handover-confirm-title">{confirmation === "regenerate" ? "重新產生全部客戶草稿？" : confirmation === "refresh" ? "更新這位客戶的交接資料？" : confirmation === "review" ? "批次確認本頁正常客戶？" : `完成客戶 ${pendingCode} 的交接？`}</h3><p>{confirmation === "regenerate" ? "這會替換尚未完成交接的客戶草稿。已完成的客戶會保留，不會重複入帳。" : confirmation === "refresh" ? "依本次選擇的啟用日更新這位客戶，包含當天的舊資料；此客戶尚未完成的核對內容會被清掉。其他客戶不變。" : confirmation === "review" ? `本頁 ${bulkRows.length} 位客戶沒有待處理舊單或異常。確認後短溢收維持 0，保留畫面的預付桶及地址空桶並標記已核對。這只是核對，還沒有入帳。` : `只會寫入客戶 ${pendingCode} 的期初餘額，並開放該客戶新增訂單。其他客戶維持未交接，未完成前不能新增訂單。`}</p><div className="handover-footer"><button className="btn" onClick={() => setConfirmation(null)}>取消</button><button className="btn btn--primary" onClick={() => { const action = confirmation; const code = pendingCode; setConfirmation(null); if (action === "regenerate") void generate(); else if (action === "refresh") void generateOne(); else if (action === "review") { const keys = new Set(bulkRows.map(r => r.key)); mutate(d => { for (const r of d.rows) if (keys.has(r.key)) { r.prepayment = 0; r.reviewed = true; } }); } else void run(async () => { const saved = dirty ? await save() : state!; const s = await request("/apply-customer", "POST", { revision: saved.revision, customerCode: code, customerVersion: saved.snapshot?.rows.find(r => r.code === code)?.version }); accept(s); setMessage(`客戶 ${code} 已完成交接，可以新增訂單。其他未完成的客戶仍不能開新訂單。`); }); }}>{confirmation === "regenerate" ? "確認重新產生" : confirmation === "refresh" ? "確認更新此客戶" : confirmation === "review" ? "確認短溢收為 0 並核對" : "完成此客戶交接"}</button></div></dialog>}
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
      <div className="handover-meta"><span>最近產生：啟用 {draft.startDate} · 承接截至 {draft.cutoffDate}（各戶日期見下方）</span><span>快照 {new Date(draft.capturedAt).toLocaleString("zh-TW")} · 版本 {state?.revision}{autoSaving ? " · 儲存中…" : saveError ? " · 儲存失敗，仍有未儲存變更" : dirty ? " · 等待自動儲存…" : " · 已儲存"}</span></div>
      {!!draft.blockers.length && <div className="alert alert--error"><strong>這些來源問題會擋住相關客戶交接</strong><ul>{draft.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {step === 2 && <div className="card handover-panel">
        <div className="handover-toolbar"><button type="button" className="btn" disabled={busy || applied} onClick={scanNoOrders}>篩選舊系統無歷史訂單</button>{onlyNoOrders && <button type="button" className="btn" disabled={busy} onClick={() => setOnlyNoOrders(false)}>取消無歷史訂單篩選</button>}</div>
        {onlyNoOrders && noOrderPreview && <div className="handover-note"><p>檢查時間：{new Date(noOrderPreview.checkedAt).toLocaleString("zh-TW")}。查詢所有日期、已收款及分地址的舊訂單；沒有待處理舊單，不代表沒有歷史訂單。</p><p>自動交接會保留舊系統金額、預付桶與各地址空桶，標記「舊系統無訂單資料」；空桶非 0 會加上「收空桶」，客戶狀態改為流失，原因「其他」，說明「系統轉換標記流失」。已交接者保留，新系統已有交易者需人工處理。</p><button type="button" className="btn btn--primary" disabled={busy} onClick={() => setNoOrderReviewOpen(true)}>開啟客戶檢查清單（{noOrderPreview.rows.length} 位）</button>{noOrderPreview.rows.some(r => r.reason) && <details><summary>無法自動處理／已完成交接的客戶</summary><ul>{noOrderPreview.rows.filter(r => r.reason).map(r => <li key={r.key}>{r.code} {r.name}：{r.reason}</li>)}</ul></details>}</div>}
        {batchProgress && <div className="handover-note" role="status">已處理 {batchProgress.done} / {batchProgress.total} 位，完成 {batchProgress.success} 位，未完成 {batchProgress.errors.length} 位。{manualBusy && <button type="button" className="btn" onClick={() => { stopBatch.current = true; }}>完成目前這戶後停止</button>}{batchProgress.errors.length > 0 && <details><summary>查看未完成原因</summary><ul>{batchProgress.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}</div>}
        <div className="handover-toolbar"><label className="handover-field">搜尋客戶<input placeholder="客戶代號或名稱" value={search} onChange={e => setSearch(e.target.value)} /></label><label><input type="checkbox" checked={onlyOpen} onChange={e => { setOnlyOpen(e.target.checked); if (e.target.checked) setOnlyCompleted(false); }} /> 只看未完成交接</label><label><input type="checkbox" checked={onlyReviewed} onChange={e => { setOnlyReviewed(e.target.checked); if (e.target.checked) { setOnlyCompleted(false); setOnlyExceptions(false); } }} /> 只看已確認</label><label><input type="checkbox" checked={onlyCompleted} onChange={e => { setOnlyCompleted(e.target.checked); if (e.target.checked) { setOnlyOpen(false); setOnlyReviewed(false); setOnlyExceptions(false); } }} /> 只看已完成交接</label><label><input type="checkbox" checked={onlyExceptions} onChange={e => { setOnlyExceptions(e.target.checked); if (e.target.checked) { setOnlyReviewed(false); setOnlyCompleted(false); } }} /> 只看待處理異常</label><button type="button" className={`btn btn--sm${onlyInactiveNote ? " btn--primary" : ""}`} aria-pressed={onlyInactiveNote} onClick={() => { const enabled = !onlyInactiveNote; setOnlyInactiveNote(enabled); if (enabled) { setOnlyCollectBarrels(false); setOnlyNoOrders(false); setSearch(""); setOnlyOpen(false); setOnlyReviewed(false); setOnlyCompleted(false); setOnlyExceptions(false); } }}>查看久未叫水（{draft.rows.filter(r => r.note.includes("久未叫水")).length}）</button><button type="button" className={`btn btn--sm${onlyCollectBarrels ? " btn--primary" : ""}`} aria-pressed={onlyCollectBarrels} onClick={() => { const enabled = !onlyCollectBarrels; setOnlyCollectBarrels(enabled); if (enabled) { setOnlyInactiveNote(false); setOnlyNoOrders(false); setSearch(""); setOnlyOpen(false); setOnlyReviewed(false); setOnlyCompleted(false); setOnlyExceptions(false); } }}>查看收空桶（{draft.rows.filter(r => r.note.includes("收空桶")).length}）</button><span>已完成交接 {finished} 位 · 已確認待交接 {totals.reviewed} 位 · 待處理異常 {draft.rows.filter(r => r.included && !r.reviewed && !r.handedOver && r.warnings.length > 0).length} 位 · 排除 {totals.excluded} 位</span></div>
        <p>勾選或修改核對內容後，停止輸入約 0.8 秒會自動儲存，不會入帳。展開一位客戶，核對後按「完成此客戶交接」。未完成的舊系統客戶不能新增訂單。{onlyReviewed && <span>「已確認」只顯示已核對、尚未完成交接的客戶；已完成者請使用「只看已完成交接」。</span>}</p>
        <div className="handover-toolbar handover-pagination"><span>符合 {rows.length} 位 · 第 {currentPage} / {pageCount} 頁（每頁 100 位）</span><button className="btn" disabled={currentPage === 1 || busy} onClick={() => setPage(currentPage - 1)}>上一頁</button><button className="btn" disabled={currentPage === pageCount || busy} onClick={() => setPage(currentPage + 1)}>下一頁</button>{!applied && <button className="btn" disabled={busy || !bulkRows.length} onClick={() => setConfirmation("review")}>批次確認本頁正常客戶（{bulkRows.length}）</button>}</div>
        <div className="handover-customers">{!rows.length && <p>沒有符合條件的客戶。</p>}{pageRows.map(r => <article key={r.key} className={`handover-customer ${!r.included ? "is-excluded" : ""}`}>
          <button className="handover-customer-head" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}><span><b>{r.code} · {r.name}</b><small>{r.orders.length} 筆待處理舊單 · 舊預付 {r.sourcePrepaidBarrels} 桶 · 舊空桶 {r.legacyBarrels} 桶</small></span><span className={`handover-status ${r.handedOver || r.reviewed ? "is-done" : ""}`}>{r.handedOver ? "已完成交接" : !r.included ? "已排除" : r.reviewed ? "已確認" : r.warnings.length ? "待處理異常" : "待核對"}</span><span>{expanded === r.key ? "收合 −" : "展開 ＋"}</span></button>
          {expanded === r.key && <fieldset disabled={manualBusy || applied || Boolean(r.handedOver)} className="handover-customer-body">
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
            <div className="handover-toolbar"><button type="button" className="btn btn--sm" disabled={r.note.includes("久未叫水")} onClick={() => {
              const note = r.note.trim() ? `${r.note.trim()}；久未叫水` : "久未叫水";
              if (note.length > 400) { setError("說明已接近 400 字，請先縮短內容再加入「久未叫水」。"); return; }
              editRow(r.key, row => { row.note = note; });
            }}>久未叫水</button><button type="button" className="btn btn--sm" disabled={r.note.includes("收空桶")} onClick={() => {
              const note = r.note.trim() ? `${r.note.trim()}；收空桶` : "收空桶";
              if (note.length > 400) { setError("說明已接近 400 字，請先縮短內容再加入「收空桶」。"); return; }
              editRow(r.key, row => { row.note = note; });
            }}>收空桶</button><span>加入下方說明並自動儲存，保留原有內容。</span></div>
            <label className="handover-field">客戶核對說明／排除後處理方式<textarea maxLength={400} value={r.note} onChange={e => editRow(r.key, r => { r.note = e.target.value; })} placeholder="有異常、調整桶數或排除客戶時必填" /></label>
            {r.included && <label className="handover-review"><input type="checkbox" checked={r.reviewed} onChange={e => editRow(r.key, r => { r.reviewed = e.target.checked; }, true)} /> 已逐項核對此客戶的欠款、月結、短溢收與桶數</label>}
            {r.handedOver ? <p className="handover-note">此客戶已完成交接，可以在新系統新增訂單。</p> : !applied && <div className="handover-footer"><button type="button" className="btn btn--primary" disabled={busy} onClick={() => { setPendingCode(r.code); setConfirmation("customer"); }}>完成此客戶交接</button></div>}
          </fieldset>}
        </article>)}</div>
        <div className="handover-footer"><span role="status">{autoSaving ? "儲存中…" : saveError ? "儲存失敗，請重試" : dirty ? "等待自動儲存…" : "核對內容已儲存"} · 完成交接後才會入帳</span><button className="btn" disabled={busy} onClick={() => void run(async () => { if (dirty) await save(); setStep(3); })}>查看進度</button></div>
      </div>}
      {step === 3 && <div className="card handover-panel"><h3>單戶交接進度</h3><div className="handover-totals">{[["已完成交接", `${finished} 位`], ["尚未完成", `${draft.rows.filter(r => !r.handedOver).length} 位`], ["短溢收淨額", moneyText(totals.prepayment)], ["預付桶", `${totals.prepaid} 桶`], ["各地址空桶", `${totals.barrels} 桶`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <p>已完成的客戶可以新增訂單。尚未完成交接的舊系統客戶，開新訂單時會被拒絕。請回到客戶清單，一次完成一位。</p>
        <div className="handover-footer"><button className="btn" onClick={exportReport}>下載交接清單 CSV</button><button className="btn" disabled={busy} onClick={() => setStep(2)}>返回客戶核對</button></div>
      </div>}
    </>}
  </section>;
}
