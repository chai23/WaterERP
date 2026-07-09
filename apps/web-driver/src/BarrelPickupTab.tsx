import { useCallback, useEffect, useState } from "react";

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pickupStatusLabel(status: string): string {
  switch (status) {
    case "assigned":
      return "已分派";
    case "pending_settlement":
      return "待辦公室核銷";
    case "completed":
      return "已結案";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function pickupBadgeClass(status: string): string {
  switch (status) {
    case "pending_settlement":
      return "d-badge d-badge--pending";
    case "completed":
      return "d-badge d-badge--completed";
    case "cancelled":
      return "d-badge d-badge--notdelivered";
    default:
      return "d-badge d-badge--assigned";
  }
}

type PickupJob = {
  id: string;
  pickupNo?: string;
  status: string;
  barrelsExpected?: number | null;
  barrelsReturned?: number | null;
  driverNote?: string | null;
  remark?: string | null;
  customer?: { name?: string; customerCode?: string | null };
  deliveryAddress?: { label?: string | null; addressLine?: string; barrelsOnSite?: number };
};

type Props = {
  authHeaders: () => Record<string, string>;
};

export default function BarrelPickupTab({ authHeaders }: Props) {
  const [pickupDate, setPickupDate] = useState(todayYmd);
  const [reportDate, setReportDate] = useState(todayYmd);
  const [jobs, setJobs] = useState<PickupJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingId, setSavingId] = useState("");
  const [barrelsByJob, setBarrelsByJob] = useState<Record<string, number>>({});
  const [noteByJob, setNoteByJob] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/driver/barrel-pickups?date=${encodeURIComponent(pickupDate)}`, {
        headers: authHeaders(),
      });
      const list = await res.json();
      if (!Array.isArray(list) && list?.ok === false) {
        setError(list.message ?? "讀取失敗");
        setJobs([]);
        return;
      }
      const rows = Array.isArray(list) ? list : [];
      setJobs(rows);
      setBarrelsByJob((prev) => {
        const next = { ...prev };
        for (const job of rows) {
          const id = String(job.id);
          if (job.status === "pending_settlement" && job.barrelsReturned != null) {
            next[id] = job.barrelsReturned;
          } else if (next[id] == null) {
            next[id] = 0;
          }
        }
        return next;
      });
      setNoteByJob((prev) => {
        const next = { ...prev };
        for (const job of rows) {
          const id = String(job.id);
          if (job.status === "pending_settlement" && job.driverNote) {
            next[id] = job.driverNote;
          } else if (!next[id]) {
            next[id] = "";
          }
        }
        return next;
      });
    } catch {
      setError("讀取收空桶任務失敗");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [pickupDate, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setReportDate(pickupDate);
  }, [pickupDate]);

  const report = async (pickupId: string) => {
    const job = jobs.find((j) => String(j.id) === pickupId);
    const isAmend = job?.status === "pending_settlement";
    setMessage("");
    setSavingId(pickupId);
    try {
      const res = await fetch(`/api/driver/barrel-pickups/${pickupId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          barrelsReturned: barrelsByJob[pickupId] ?? 0,
          note: noteByJob[pickupId] ?? "",
          reportedAtYmd: reportDate,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "提交失敗");
        return;
      }
      const no = payload.data?.pickupNo ?? pickupId;
      setMessage(
        isAmend
          ? `已更新收桶回報：${no}（仍待辦公室核銷）`
          : `已提交收桶回報：${no}（待辦公室核銷）`,
      );
      await load();
    } catch {
      setMessage("提交時發生錯誤");
    } finally {
      setSavingId("");
    }
  };

  const activeJobs = jobs.filter((j) => j.status !== "cancelled");

  return (
    <>
      <section className="driver-panel">
        <h2 className="driver-panel__title">收空桶 · 篩選</h2>
        <div className="d-field">
          <span>收桶日</span>
          <input type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
        </div>
        <div className="d-field">
          <span>實際回報日</span>
          <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
        </div>
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--d-muted)" }}>
          須與後台建立任務時的「預定收桶日」一致。辦公室核銷前可修改回報桶數。
        </p>
        <button type="button" className="d-btn d-btn--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? "載入中…" : "重新載入"}
        </button>
      </section>

      {error ? <div className="d-alert d-alert--err">{error}</div> : null}
      {message ? <div className="d-alert d-alert--ok">{message}</div> : null}

      {activeJobs.length === 0 && !loading ? (
        <p className="driver-panel" style={{ color: "var(--d-muted)" }}>此日無收空桶任務</p>
      ) : null}

      {activeJobs.map((job) => {
        const id = String(job.id);
        const onSite = job.deliveryAddress?.barrelsOnSite ?? 0;
        const barrels = barrelsByJob[id] ?? 0;
        const canReport = job.status === "assigned" || job.status === "pending_settlement";
        const over = canReport && barrels > onSite;
        return (
          <article key={id} className="driver-job">
            <header className="driver-job__head">
              <span className={pickupBadgeClass(job.status)}>{pickupStatusLabel(job.status)}</span>
              <strong className="mono-text">{job.pickupNo ?? id}</strong>
            </header>
            <p className="driver-job__customer">
              <strong>{job.customer?.customerCode ?? ""}</strong> {job.customer?.name}
            </p>
            <p className="driver-job__addr">
              {job.deliveryAddress?.label ? `${job.deliveryAddress.label} · ` : ""}
              {job.deliveryAddress?.addressLine}
            </p>
            <p className="driver-job__meta">
              送貨點在場空桶：<strong>{onSite}</strong>
              {job.barrelsExpected != null ? ` · 預估收 ${job.barrelsExpected} 桶` : ""}
            </p>
            {job.remark ? <p className="driver-job__meta">備註：{job.remark}</p> : null}

            {canReport ? (
              <div className="driver-job__form">
                <label className="d-field">
                  <span>實收空桶數</span>
                  <input
                    type="number"
                    min={0}
                    value={barrels}
                    onChange={(e) => setBarrelsByJob((p) => ({ ...p, [id]: Math.max(0, Number(e.target.value) || 0) }))}
                  />
                </label>
                {over ? (
                  <p className="d-alert d-alert--warn" style={{ fontSize: "0.8rem" }}>
                    超過在場 {onSite} 桶；辦公室將無法核銷，請確認數量。
                  </p>
                ) : null}
                <label className="d-field">
                  <span>備註</span>
                  <input
                    value={noteByJob[id] ?? ""}
                    onChange={(e) => setNoteByJob((p) => ({ ...p, [id]: e.target.value }))}
                    placeholder="選填"
                  />
                </label>
                <button
                  type="button"
                  className="d-btn"
                  disabled={savingId === id}
                  onClick={() => void report(id)}
                >
                  {savingId === id ? "提交中…" : job.status === "pending_settlement" ? "更新收桶回報" : "提交收桶回報"}
                </button>
              </div>
            ) : job.status === "completed" ? (
              <p className="driver-job__meta">已收 <strong>{job.barrelsReturned ?? 0}</strong> 桶 · 辦公室已核銷</p>
            ) : null}
          </article>
        );
      })}
    </>
  );
}
