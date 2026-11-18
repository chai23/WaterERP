import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ManualHandoverPage from "./ManualHandoverPage";

import { moneyText, todayLocalYmd } from "../adminUtils";
import "./handover-workspace.css";

type Row = {
  eligibility: string; version: string; code: string; name: string; mode: string; method: string; text: string; reasons: string;
  overShort: number; prepaidBarrels: number; emptyBarrels: number; productText: string; churn: boolean;
  cashCount: number; cashAmount: number; monthlyCount: number; monthlyAmount: number;
  billedCount: number; billedAmount: number; excludeCount: number; laterNote: string;
};
type Report = {
  generatedAt: string; cutoffDate: string;
  summary: {
    customers: number; auto: number; manual: number; churn: number; registered: number;
    autoCash: number; autoMonthly: number; autoBilled: number;
    manualCash: number; manualMonthly: number; manualBilled: number;
    methods: { name: string; count: number; cash: number; monthly: number; billed: number }[];
    reasons: { name: string; count: number }[];
  };
  rows: Row[];
};

export default function HandoverMethodReportPage() {
  const [params] = useSearchParams();
  const code = params.get("manual");
  const date = params.get("date");
  const manual = code && /^\d{6}$/.test(code) && date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? {code,date,reason:params.get("reason") ?? ""} : null;
  const manualOpen = manual !== null;
  const previewScroll = useRef(0);
  useLayoutEffect(()=>{
    window.scrollTo(0,manualOpen ? 0 : previewScroll.current);
  },[manualOpen]);
  const [startDate, setStartDate] = useState(todayLocalYmd());
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  type Job = {total:number; processed:number; succeeded:number; running:boolean; errors:{code:string;reason:string}[]};
  const [job,setJob] = useState<Job|null>(null);
  const [group,setGroup] = useState("");
  useEffect(()=>{
    let live=true;
    const poll=async()=>{try {
      const res=await fetch("/api/legacy-cutover/batch",{cache:"no-store"});
      if(res.ok){const data=await res.json(); if(live)setJob(data.data);}
    } catch { /* Next poll reconnects. */ }};
    void poll();
    const timer=setInterval(()=>void poll(),3000);
    return ()=>{live=false;clearInterval(timer);};
  },[]);
  const pending = report?.rows.filter(row=>row.eligibility && row.eligibility !== "已完成") ?? [];
  const selectStatus = (status: string) => { setGroup(status); setReason(""); setSearch(""); setPage(1); };
  const eligible = report?.rows.filter(r=>!r.eligibility) ?? [];
  const start=async()=>{
    if(!report || !window.confirm("確認依 "+report.cutoffDate+" 預覽正式入帳全部 "+eligible.length+" 位客戶？其中 "+eligible.filter(r=>r.churn).length+" 位將標記流失。"))return;
    setBusy(true);setError("");
    try {
      const res=await fetch("/api/legacy-cutover/batch/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:report.cutoffDate,versions:eligible.map(r=>r.version)})});
      const result=await res.json();if(!result.ok)throw new Error(result.message);
      setJob(result.data);setReport(null);
    } catch(e){setError(e instanceof Error?e.message:"開始失敗");} finally{setBusy(false);}
  };
  const generate = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/legacy-cutover/batch/preview", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message ?? "產生失敗");
      setReport(data.data); setPage(1); setSearch(""); setReason("");
    } catch (e) { setError(e instanceof Error ? e.message : "產生失敗"); }
    finally { setBusy(false); }
  };
  const sendBatchAction = async (action: "stop" | "reset") => {
    if (action === "reset" && !window.confirm("還原全部已交接客戶的交接帳務、桶數和完成狀態，並重新產生預覽？")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/legacy-cutover/batch/" + action, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({startDate, confirmReset: action === "reset"}),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.message ?? "交接操作失敗");
      if (action === "reset") {
        setJob(null);
        setReport(null);
        await generate();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "交接操作失敗");
    } finally {
      setBusy(false);
    }
  };
  const rows = useMemo(() => (report?.rows ?? []).filter(r => {
    if (group && group !== (r.eligibility === "已完成" ? "已完成" : r.eligibility ? "人工待辦" : "可自動交接")) return false;
    if (reason && !r.reasons.split("、").includes(reason)) return false;
    const q = search.trim();
    return !q || r.code.includes(q) || r.name.includes(q);
  }), [report, reason, search, group]);
  const pageCount = Math.max(1, Math.ceil(rows.length / 100));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * 100, current * 100);
  const download = () => {
    if (!report) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
    const header = ["客戶代號", "客戶名稱", "處理方式", "方法", "交接方法", "人工原因", "短溢收", "預付桶", "空桶", "預付商品", "是否標記流失", "未沖帳應收張數", "未沖帳應收金額", "月結承接張數", "月結承接金額", "月結應收張數", "月結應收金額", "排除張數", "啟用日後單據"];
    const lines = report.rows.map(r => [r.code, r.name, r.mode, r.method, r.text, r.reasons, r.overShort, r.prepaidBarrels, r.emptyBarrels, r.productText, r.churn ? "是" : "否", r.cashCount, r.cashAmount, r.monthlyCount, r.monthlyAmount, r.billedCount, r.billedAmount, r.excludeCount, r.laterNote]);
    const url = URL.createObjectURL(new Blob(["\uFEFF" + [header, ...lines].map(l => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `交接方法-${report.cutoffDate}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const s = report?.summary;
  const markCompleted = (code:string) => {
    setReport(previous=>previous ? {...previous,rows:previous.rows.map(row=>row.code===code ? {...row,eligibility:"已完成"} : row)} : previous);
  };
  return <>
    {manual && <ManualHandoverPage key={manual.code + manual.date} {...manual} onCompleted={markCompleted} />}
    <section className="handover-page cutover-workspace" hidden={manualOpen}>
    <header className="cutover-title">
      <div><h2>上線交接</h2><p>先預覽舊系統資料，再處理自動交接與人工待辦。</p></div>
      {report && <button type="button" className="btn" disabled={busy} onClick={download}>下載預覽 CSV</button>}
    </header>
    {error && <div className="alert alert--error" role="alert">{error}</div>}
    <section className="card cutover-card cutover-preview-settings" aria-labelledby="cutover-preview-title">
      <div><h3 id="cutover-preview-title">交接預覽</h3>
        <p>{report ? `快照更新於 ${new Date(report.generatedAt).toLocaleString("zh-TW")}` : "讀取舊系統截至指定日期的客戶與帳務資料，包含截止日當天。"}</p>
      </div>
      <div className="cutover-settings-actions">
        <label className="handover-field">承接截止日<input type="date" value={startDate} disabled={busy} onChange={e=>{setStartDate(e.target.value);setReport(null);}} /></label>
        <button type="button" className="btn btn--primary" disabled={busy || !startDate} onClick={()=>void generate()}>{busy ? "處理中…" : report ? "更新預覽" : "產生交接預覽"}</button>
      </div>
    </section>
    {job && <section className="card handover-panel handover-progress" aria-labelledby="handover-progress-title">
      <div className="handover-progress-heading">
        <div>
          <h3 id="handover-progress-title">交接進度</h3>
          <p role="status">{job.running ? "交接執行中" : job.processed < job.total ? "交接已結束，仍有未處理客戶" : "本批已處理完畢"} · 已處理 {job.processed} / {job.total} 位</p>
        </div>
        {job.running && <button type="button" className="btn" disabled={busy} onClick={() => void sendBatchAction("stop")}>停止交接</button>}
      </div>
      <div className="handover-progress-track">
        <progress aria-label="已處理客戶比例" value={job.processed} max={Math.max(1, job.total)} />
        <strong>{job.total ? Math.floor(100 * job.processed / job.total) : 0}%</strong>
      </div>
      <dl className="handover-progress-counts">
        <div><dt>本批總數</dt><dd>{job.total}</dd></div>
        <div><dt>成功交接</dt><dd>{job.succeeded}</dd></div>
        <div><dt>已處理未入帳</dt><dd>{job.processed - job.succeeded}</dd></div>
        <div><dt>尚未處理</dt><dd>{job.total - job.processed}</dd></div>
      </dl>
      {job.errors.length > 0 && <details>
        <summary>查看交接訊息（{job.errors.length} 則）</summary>
        <div className="method-report-table-wrap">
          <table className="method-report-table">
            <thead><tr><th scope="col">客戶代號</th><th scope="col">原因</th></tr></thead>
            <tbody>{job.errors.map((entry, index) => <tr key={index}><td>{entry.code || "整批"}</td><td>{entry.reason}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </section>}
    {report && s && <>
      <section className="card cutover-card cutover-execute" aria-labelledby="cutover-execute-title">
        <div>
          <h3 id="cutover-execute-title">執行交接</h3>
          <p>{eligible.length.toLocaleString()} 位可自動入帳，包含 {eligible.filter(r=>r.churn).length.toLocaleString()} 位將標記流失。</p>
        </div>
        {report.rows.some(r=>r.eligibility==="已完成")
          ? <button type="button" className="btn cutover-reset" disabled={busy || job?.running} onClick={()=>void sendBatchAction("reset")}>歸零並重新交接</button>
          : <button type="button" className="btn btn--primary" disabled={busy || job?.running || !eligible.length} onClick={()=>void start()}>開始自動交接 {eligible.length.toLocaleString()} 位</button>}
      </section>
      <section className="card cutover-card cutover-customers" aria-labelledby="cutover-customers-title">
        <div className="cutover-list-heading">
          <div><h3 id="cutover-customers-title">客戶交接清單</h3><p>承接截至 {report.cutoffDate}（含當天）</p></div>
          <label className="handover-field">搜尋客戶<input placeholder="輸入客戶代號或名稱" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} /></label>
        </div>
        <div className="cutover-status-tabs" role="group" aria-label="篩選交接狀態">
          {[["","全部客戶",s.customers],["可自動交接","可自動交接",eligible.length],["人工待辦","人工待辦",pending.length],["已完成","已完成",s.customers-eligible.length-pending.length]].map(([status,label,count])=>
            <button key={status} type="button" aria-pressed={group===status} onClick={()=>selectStatus(String(status))}>
              <span>{label}</span><strong>{Number(count).toLocaleString()}</strong>
            </button>)}
        </div>
        {group==="人工待辦" && <div className="method-report-reasons" aria-label="人工待辦原因">
          {s.reasons.map(r=>({name:r.name,count:pending.filter(row=>row.reasons.split("、").includes(r.name)).length})).filter(r=>r.count>0).map(r=>
            <button type="button" key={r.name} aria-pressed={reason===r.name} className={reason===r.name?"is-active":""} onClick={()=>{setReason(reason===r.name?"":r.name);setPage(1);}}>{r.name} · {r.count}</button>)}
        </div>}
        <details className="cutover-amounts">
          <summary>查看報表建議金額</summary>
          <div className="method-report-table-wrap"><table className="method-report-table">
            <thead><tr><th>報表分類</th><th>未沖帳應收</th><th>月結承接</th><th>月結應收</th></tr></thead>
            <tbody><tr><td>建議自動</td><td>{moneyText(s.autoCash)}</td><td>{moneyText(s.autoMonthly)}</td><td>{moneyText(s.autoBilled)}</td></tr>
              <tr><td>建議人工</td><td>{moneyText(s.manualCash)}</td><td>{moneyText(s.manualMonthly)}</td><td>{moneyText(s.manualBilled)}</td></tr></tbody>
          </table></div>
        </details>
        <div className="method-report-table-wrap"><table className="method-report-table cutover-table">
          <thead><tr><th scope="col">客戶</th><th scope="col">交接狀態</th><th scope="col">承接內容</th><th scope="col">操作</th></tr></thead>
          <tbody>
            {pageRows.map(r=>{
              const status = !r.eligibility ? "可自動交接" : r.eligibility==="已完成" ? "已完成" : "人工待辦";
              return <tr key={r.code}>
                <td><strong>{r.code}</strong><div>{r.name}</div></td>
                <td><span className="cutover-status-pill" data-status={status}>{status}</span>{status==="人工待辦" && <small className="cutover-reason">{r.eligibility}</small>}</td>
                <td><details><summary>{r.method==="人工處理" ? "查看承接明細" : r.method}</summary>
                  <p>{r.text}</p><small>短溢收 {moneyText(r.overShort)} · 預付桶 {r.prepaidBarrels} · 空桶 {r.emptyBarrels}</small>
                </details></td>
                <td>{status==="人工待辦" && <Link className="btn btn--sm" onClick={()=>{previewScroll.current=window.scrollY;}} to={"?" + new URLSearchParams({manual:r.code,date:report.cutoffDate,reason:r.eligibility})}>處理此客戶</Link>}</td>
              </tr>;
            })}
            {!pageRows.length && <tr><td colSpan={4}>沒有符合的客戶。</td></tr>}
          </tbody>
        </table></div>
        <div className="cutover-list-footer">
          <span>符合 {rows.length.toLocaleString()} 位 · 第 {current} / {pageCount} 頁</span>
          <div><button type="button" className="btn" disabled={current===1} onClick={()=>setPage(current-1)}>上一頁</button><button type="button" className="btn" disabled={current===pageCount} onClick={()=>setPage(current+1)}>下一頁</button></div>
        </div>
      </section>
    </>}
    </section>
  </>;
}
