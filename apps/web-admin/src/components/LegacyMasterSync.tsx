import { useState } from "react";
export function LegacyMasterSync({ onSynced }: { onSynced: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const sync = async () => {
    if (busy) return;
    setBusy(true); setMessage(""); setIssues([]);
    try {
      const res = await fetch('/api/legacy-history/sync-masters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.message || '同步失敗');
      const d = payload.data;
      setIssues(d.issues ?? []);
      setMessage(`同步完成：新增 ${d.customersCreated} 位客戶、更新 ${d.customersUpdated} 位客戶；新增 ${d.addressesCreated} 個地址、更新 ${d.addressesUpdated} 個地址；略過 ${d.skipped} 筆。訂單與帳務已保留。`);
      try { await onSynced(); } catch { setMessage(m => m + ' 清單重新載入失敗，請手動重新整理。'); }
    } catch (e) { setMessage(e instanceof Error ? e.message : '連線中斷，請重新載入確認結果；可重試同步，不會重複新增。'); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="btn btn--secondary" onClick={() => { setOpen(true); setMessage(''); }}>同步舊系統客戶</button>
    {open && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="master-sync-title" style={{ maxWidth: 580 }}>
      <h2 id="master-sync-title">同步最新客戶與送貨地址</h2>
      <p>更新舊系統轉入的姓名、聯絡方式、統編、備註與送貨地址，新增尚未轉入的客戶。</p>
      <p>保留新系統訂單、收款、帳務餘額、桶數、結帳及巡查設定。舊系統已刪除的資料會保留；同編號但未建立舊新對照的客戶會略過。</p>
      <p>新增客戶的期初欠款、預收與桶數，請至「上線交接」核對。資料以目前連線的舊資料庫為準。</p>
      {message && <p role="status">{message}</p>}
      {issues.length > 0 && <details><summary>查看略過原因（{issues.length} 筆）</summary><ul style={{ maxHeight: 180, overflow: 'auto' }}>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setOpen(false)}>關閉</button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void sync()}>{busy ? '同步中，請稍候…' : '同步最新資料'}</button>
      </div>
    </section></div>}
  </>;
}
