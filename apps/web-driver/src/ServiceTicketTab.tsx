import { useCallback, useEffect, useState } from "react";

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type ServiceTicketJob = {
  id: string;
  ticketNo: string;
  serviceType: string;
  serviceTypeLabel?: string;
  status: string;
  statusLabel?: string;
  problemNote?: string | null;
  preferredSlot?: string | null;
  assessSlot?: string | null;
  assessOutcome?: string | null;
  assessDriverNote?: string | null;
  assessFeeAmount?: string | null;
  customer?: { name?: string; customerCode?: string | null; mobile?: string | null; phone?: string | null } | null;
  deliveryAddress?: { label?: string | null; addressLine?: string } | null;
};

type Props = {
  authHeaders: () => Record<string, string>;
};

export default function ServiceTicketTab({ authHeaders }: Props) {
  const [date, setDate] = useState(todayYmd);
  const [jobs, setJobs] = useState<ServiceTicketJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingId, setSavingId] = useState("");
  const [noteByJob, setNoteByJob] = useState<Record<string, string>>({});
  const [feeByJob, setFeeByJob] = useState<Record<string, string>>({});
  const [agreedByJob, setAgreedByJob] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/driver/service-tickets?date=${encodeURIComponent(date)}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? "讀取失敗");
        setJobs([]);
        return;
      }
      const rows = (data.data ?? []) as ServiceTicketJob[];
      setJobs(rows);
      setNoteByJob((prev) => {
        const next = { ...prev };
        for (const job of rows) {
          const id = String(job.id);
          if (job.assessDriverNote) next[id] = job.assessDriverNote;
          else if (next[id] == null) next[id] = "";
        }
        return next;
      });
      setFeeByJob((prev) => {
        const next = { ...prev };
        for (const job of rows) {
          const id = String(job.id);
          if (job.assessFeeAmount != null) next[id] = String(job.assessFeeAmount);
          else if (next[id] == null) next[id] = "";
        }
        return next;
      });
    } catch {
      setError("讀取飲水機服務任務失敗");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [date, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = async (ticketId: string, outcome: "onsite_fixed" | "bring_back" | "unable" | "cancelled" | "loaner_swapped") => {
    const id = String(ticketId);
    if (outcome === "onsite_fixed" && !agreedByJob[id]) {
      setMessage("現場維修請先勾選「已詢問客戶同意」");
      return;
    }
    setSavingId(id);
    setMessage("");
    try {
      const res = await fetch(`/api/driver/service-tickets/${id}/assess-report`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          note: (noteByJob[id] ?? "").trim() || undefined,
          feeAmount: feeByJob[id]?.trim() ? feeByJob[id].trim() : undefined,
          customerAgreed: outcome === "onsite_fixed" ? true : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(data.message ?? "回報失敗");
        return;
      }
      setMessage(`已回報 ${data.data?.ticketNo ?? ""}：${data.data?.statusLabel ?? ""}`);
      await load();
    } catch {
      setMessage("回報時發生錯誤");
    } finally {
      setSavingId("");
    }
  };

  const reportReturn = async (ticketId: string) => {
    const id = String(ticketId);
    setSavingId(id);
    setMessage("");
    try {
      const res = await fetch(`/api/driver/service-tickets/${id}/return-report`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ note: (noteByJob[id] ?? "").trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(data.message ?? "送回回報失敗");
        return;
      }
      setMessage(`已送回 ${data.data?.ticketNo ?? ""}`);
      await load();
    } catch {
      setMessage("送回回報時發生錯誤");
    } finally {
      setSavingId("");
    }
  };

  return (
    <div className="driver-panel">
      <div className="driver-toolbar" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <label>
          評估日{" "}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="button" className="d-btn d-btn--secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "載入中…" : "重新整理"}
        </button>
      </div>
      {error ? <p className="d-error">{error}</p> : null}
      {message ? <p className="d-msg">{message}</p> : null}

      {jobs.length === 0 && !loading ? <p className="d-muted">此日沒有飲水機評估任務。</p> : null}

      <div className="driver-job-list">
        {jobs.map((job) => {
          const id = String(job.id);
          const canReport = job.status === "assess_assigned";
          return (
            <article className="driver-job-card" key={id}>
              <header className="driver-job-card__head">
                <div>
                  <strong>{job.ticketNo}</strong>
                  <div className="d-muted">{job.serviceTypeLabel ?? job.serviceType}</div>
                </div>
                <span className="d-badge d-badge--assigned">{job.statusLabel ?? job.status}</span>
              </header>
              <div className="driver-job-card__body">
                <div>
                  <strong>{job.customer?.name ?? "客戶"}</strong>
                  {job.customer?.customerCode ? `（${job.customer.customerCode}）` : ""}
                </div>
                <div>{job.deliveryAddress?.addressLine ?? "—"}</div>
                <div className="d-muted">{job.customer?.mobile || job.customer?.phone || ""}</div>
                {job.assessSlot ? <div>時段：{job.assessSlot}</div> : null}
                <div style={{ marginTop: "0.35rem" }}>問題：{job.problemNote ?? "—"}</div>
                {job.assessOutcome ? (
                  <div className="d-muted" style={{ marginTop: "0.35rem" }}>
                    已回報結果：{job.assessOutcome}
                    {job.assessDriverNote ? `｜${job.assessDriverNote}` : ""}
                  </div>
                ) : null}

                {canReport ? (
                  <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
                    <label>
                      備註
                      <textarea
                        rows={2}
                        value={noteByJob[id] ?? ""}
                        onChange={(e) => setNoteByJob((p) => ({ ...p, [id]: e.target.value }))}
                        placeholder="處置說明／載回原因…"
                      />
                    </label>
                    <label>
                      現場費用（可略）
                      <input
                        type="number"
                        min={0}
                        step="1"
                        value={feeByJob[id] ?? ""}
                        onChange={(e) => setFeeByJob((p) => ({ ...p, [id]: e.target.value }))}
                        placeholder="0"
                      />
                    </label>
                    <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(agreedByJob[id])}
                        onChange={(e) => setAgreedByJob((p) => ({ ...p, [id]: e.target.checked }))}
                      />
                      現場維修：已詢問客戶同意
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      <button
                        type="button"
                        className="d-btn d-btn--primary"
                        disabled={savingId === id}
                        onClick={() => void report(id, "onsite_fixed")}
                      >
                        現場修好
                      </button>
                      <button
                        type="button"
                        className="d-btn d-btn--secondary"
                        disabled={savingId === id}
                        onClick={() => void report(id, "bring_back")}
                      >
                        需載回
                      </button>
                      <button
                        type="button"
                        className="d-btn d-btn--secondary"
                        disabled={savingId === id}
                        onClick={() => void report(id, "unable")}
                      >
                        無法處理
                      </button>
                      <button
                        type="button"
                        className="d-btn d-btn--secondary"
                        disabled={savingId === id}
                        onClick={() => void report(id, "cancelled")}
                      >
                        客戶取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {job.status === "pending_loaner" ? (
                  <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
                    <p className="d-muted" style={{ margin: 0 }}>
                      請攜帶臨時機到場換機，並載回原機。
                    </p>
                    <label>
                      備註
                      <textarea
                        rows={2}
                        value={noteByJob[id] ?? ""}
                        onChange={(e) => setNoteByJob((p) => ({ ...p, [id]: e.target.value }))}
                        placeholder="已換臨時機／載回說明…"
                      />
                    </label>
                    <button
                      type="button"
                      className="d-btn d-btn--primary"
                      disabled={savingId === id}
                      onClick={() => void report(id, "loaner_swapped")}
                    >
                      已換臨時機並載回
                    </button>
                  </div>
                ) : null}

                {job.status === "pending_return" ? (
                  <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
                    <p className="d-muted" style={{ margin: 0 }}>
                      請將維修好的飲水機送回安裝（若有臨時機請一併收回）。
                    </p>
                    <label>
                      備註
                      <textarea
                        rows={2}
                        value={noteByJob[id] ?? ""}
                        onChange={(e) => setNoteByJob((p) => ({ ...p, [id]: e.target.value }))}
                        placeholder="已安裝／簽收說明…"
                      />
                    </label>
                    <button
                      type="button"
                      className="d-btn d-btn--primary"
                      disabled={savingId === id}
                      onClick={() => void reportReturn(id)}
                    >
                      已送回安裝
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
