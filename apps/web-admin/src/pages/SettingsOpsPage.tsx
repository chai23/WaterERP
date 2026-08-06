import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtLocalYmd } from "../adminUtils";

function todayYmd(): string {
  return fmtLocalYmd(new Date()) || new Date().toISOString().slice(0, 10);
}

type Checklist = {
  pendingSettlement: number;
  cashShort: number;
  deliveredUnpaid: number;
  assignedUnreported: number;
};

export default function SettingsOpsPage() {
  const [date, setDate] = useState(todayYmd);
  const [note, setNote] = useState("");
  const [locked, setLocked] = useState(false);
  const [lockInfo, setLockInfo] = useState("");
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setMsg("");
    try {
      const res = await fetch(`/api/admin/day-close?date=${encodeURIComponent(date)}`);
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        setMsg(payload?.message ?? "讀取關帳狀態失敗");
        return;
      }
      setLocked(Boolean(payload.data?.locked));
      setChecklist((payload.data?.checklist as Checklist | null) ?? null);
      const lock = payload.data?.lock;
      const currentlyLocked = Boolean(payload.data?.locked);
      if (lock?.lockedAt) {
        const fmt = (iso: string) => String(iso).replace("T", " ").slice(0, 19);
        const lockedBy = lock.lockedBy?.name ?? lock.lockedByUserId ?? "";
        const lockedPart = `${fmt(lock.lockedAt)}${lockedBy ? `（${lockedBy}）` : ""}`;
        if (currentlyLocked) {
          setLockInfo(`鎖定於 ${lockedPart}`);
        } else {
          const unlockedAt = lock.unlockedAt ? fmt(lock.unlockedAt) : "";
          const unlockedBy = lock.unlockedBy?.name ?? lock.unlockedByUserId ?? "";
          const unlockedPart = unlockedAt
            ? ` · 解鎖於 ${unlockedAt}${unlockedBy ? `（${unlockedBy}）` : ""}`
            : "";
          setLockInfo(`上次鎖定於 ${lockedPart}${unlockedPart}`);
        }
      } else {
        setLockInfo("");
      }
    } catch {
      setMsg("無法連線 API");
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const checklistTotal = checklist
    ? checklist.pendingSettlement + checklist.assignedUnreported
    : 0;

  const lockDay = async (force = false) => {
    if (!force && checklistTotal > 0) {
      const ok = window.confirm(
        `${date} 尚有未核銷／未回報 ${checklistTotal} 筆（待核銷 ${checklist?.pendingSettlement ?? 0}、未回報 ${checklist?.assignedUnreported ?? 0}；短收 ${checklist?.cashShort ?? 0}、未收款 ${checklist?.deliveredUnpaid ?? 0}）。\n\n仍要強制關帳嗎？`,
      );
      if (!ok) return;
      force = true;
    } else if (!window.confirm(`確定關帳 ${date}？關帳後該日核銷將被阻擋。`)) {
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/day-close/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, note: note.trim() || undefined, force: force ? 1 : undefined }),
      });
      const payload = await res.json();
      if (res.status === 409 && payload?.code === "DAY_CLOSE_HAS_EXCEPTIONS") {
        const ok = window.confirm(`${payload.message}\n\n確定強制關帳？`);
        if (ok) {
          setBusy(false);
          await lockDay(true);
          return;
        }
        setMsg(payload.message ?? "關帳已取消");
        return;
      }
      if (!res.ok || !payload?.ok) {
        setMsg(payload?.message ?? "關帳失敗");
        return;
      }
      setMsg("已關帳。");
      await load();
    } catch {
      setMsg("關帳時發生錯誤");
    } finally {
      setBusy(false);
    }
  };

  const unlockDay = async () => {
    if (!window.confirm(`確定解鎖 ${date}？`)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/day-close/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, note: note.trim() || undefined }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        setMsg(payload?.message ?? "解鎖失敗");
        return;
      }
      setMsg("已解鎖。");
      await load();
    } catch {
      setMsg("解鎖時發生錯誤");
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async () => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/backup-export");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setMsg(payload?.message ?? "備份匯出失敗");
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] ?? `watererp-backup-${todayYmd()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg("已下載摘要 JSON（非完整可還原備份）。");
    } catch {
      setMsg("備份匯出時發生錯誤");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-stack">
      <div className="page-card">
        <div className="page-card__header">
          <div>
            <h2>每日關帳</h2>
            <p>鎖定營業日後，以該日為辦公室核銷時間的核銷會被拒絕；僅管理員可解鎖。</p>
          </div>
        </div>
        <div className="toolbar toolbar--filters" style={{ flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
          <div className="field field--sm">
            <span>營業日</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 14rem" }}>
            <span>備註（選填）</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="關帳／解鎖備註" />
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={busy}>
            重新整理
          </button>
          {locked ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void unlockDay()} disabled={busy}>
              解鎖
            </button>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void lockDay(false)} disabled={busy}>
              關帳鎖定
            </button>
          )}
        </div>
        <p style={{ marginTop: "0.75rem" }}>
          狀態：{locked ? <strong>已關帳</strong> : "未鎖定"}
          {lockInfo ? <span className="text-muted"> · {lockInfo}</span> : null}
        </p>
        {checklist ? (
          <div className="card" style={{ marginTop: "0.75rem", padding: "0.75rem 1rem" }}>
            <strong>關帳前檢查</strong>
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
              <li>待核銷配送：{checklist.pendingSettlement}</li>
              <li>現金短收（待核銷）：{checklist.cashShort}</li>
              <li>已送達未收款（待核銷）：{checklist.deliveredUnpaid}</li>
              <li>已分派未回報：{checklist.assignedUnreported}</li>
            </ul>
            {checklistTotal > 0 ? (
              <p className="card__hint" style={{ marginTop: "0.5rem" }}>
                有未結案件時關帳需管理員二次確認。亦可至{" "}
                <Link to="/reports/exceptions">異常中心</Link> 查看。
              </p>
            ) : (
              <p className="card__hint" style={{ marginTop: "0.5rem" }}>
                檢查清單無未結案件。
              </p>
            )}
          </div>
        ) : null}
        {msg ? (
          <div
            className={msg.includes("失敗") || msg.includes("錯誤") ? "feedback feedback--err" : "feedback feedback--ok"}
            style={{ marginTop: "0.75rem" }}
          >
            {msg}
          </div>
        ) : null}
      </div>

      <div className="page-card">
        <div className="page-card__header">
          <div>
            <h2>備份匯出（摘要）</h2>
            <p>
              下載主檔計數與近 30 日訂單摘要 JSON。
              <strong> 此檔不可還原系統</strong>；完整備份請使用資料庫 mysqldump／雲端自動備份，並另記錄最近完整備份與還原演練時間。
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => void downloadBackup()} disabled={busy}>
            下載摘要 JSON
          </button>
        </div>
      </div>
    </section>
  );
}
