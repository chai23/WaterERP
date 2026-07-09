import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import {
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  driverEmployeeCode,
  driverIsActive,
  settlementOutcomeLabel,
  todayLocalYmd,
} from "../adminUtils";

type JobFormState = {
  delivered: boolean;
  failureReason: string;
  emptyBarrelsReturned: number;
  cashReceived: number;
  note: string;
  /** 各明細實際配送桶數（lineId → qty） */
  lineQtyDelivered: Record<string, number>;
};

type OrderLineRow = {
  id: string;
  qtyOrdered?: number;
  qtyDelivered?: number;
  linePurpose?: string | null;
  product?: { name?: string; code?: string };
};

type DriverBillingHints = {
  billingType?: string;
  orderTotal?: string | number;
  cashDue?: string | number;
  cashPriorBalance?: string | number;
  cashSubtotal?: string | number;
  monthlySubtotal?: string | number;
  prepaidLineTotal?: string | number;
  prepaidBarrelBalance?: number;
  allowPrepaidOverdraft?: boolean;
  accountBalance?: string | number;
  lastCompletedDelivery?: {
    orderNo?: string;
    expectedAmount?: string | number | null;
    cashReceived?: string | number;
    cashVariance?: string | number | null;
    settlementOutcome?: string | null;
  } | null;
};

type AssignmentJob = {
  id: string;
  status: string;
  settlementOutcome?: string | null;
  failureReason?: string | null;
  emptyBarrelsReturned?: number;
  cashReceived?: unknown;
  settlementNote?: string | null;
  expectedAmount?: unknown;
  cashVariance?: unknown;
  driverReportedAt?: string | null;
  salesOrder?: {
    orderNo?: string;
    totalAmount?: unknown;
    customer?: { name?: string };
    deliveryAddress?: { addressLine?: string; barrelsOnSite?: number };
    lines?: OrderLineRow[];
  };
  vehicle?: { plateNo?: string };
  driverBillingHints?: DriverBillingHints;
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "reportable", label: "可回報（已分派／配送中／待核銷）" },
  { value: "pending_report", label: "僅待回報（已分派／配送中）" },
  { value: "pending_settlement", label: "僅待辦公室核銷（可修正）" },
  { value: "all", label: "全部（含已結案）" },
];

function deliveryLinesFromJob(job: AssignmentJob): OrderLineRow[] {
  return (job.salesOrder?.lines ?? []).filter((l) => (l.linePurpose ?? "delivery") === "delivery");
}

function buildLineQtyFromJob(job: AssignmentJob): Record<string, number> {
  const map: Record<string, number> = {};
  for (const line of deliveryLinesFromJob(job)) {
    const id = String(line.id);
    if (job.status === "pending_settlement" && line.qtyDelivered != null && line.qtyDelivered > 0) {
      map[id] = line.qtyDelivered;
    } else if (line.qtyOrdered != null && line.qtyOrdered > 0) {
      map[id] = line.qtyOrdered;
    } else {
      map[id] = 0;
    }
  }
  return map;
}

function defaultJobForm(job?: AssignmentJob): JobFormState {
  return {
    delivered: true,
    failureReason: "",
    emptyBarrelsReturned: 0,
    cashReceived: 0,
    note: "",
    lineQtyDelivered: job ? buildLineQtyFromJob(job) : {},
  };
}

function isLineQtyConfirmedOnServer(job: AssignmentJob): boolean {
  const lines = deliveryLinesFromJob(job);
  if (lines.length === 0) return true;
  return lines.every((l) => (l.qtyDelivered ?? 0) > 0);
}

function jobFormFromServer(job: AssignmentJob): JobFormState {
  if (job.status === "pending_settlement") {
    const notDelivered = job.settlementOutcome === "not_delivered";
    return {
      delivered: !notDelivered,
      failureReason: notDelivered ? String(job.failureReason ?? "") : "",
      emptyBarrelsReturned: Math.max(0, Math.floor(Number(job.emptyBarrelsReturned ?? 0))),
      cashReceived: Number(job.cashReceived ?? 0) || 0,
      note: String(job.settlementNote ?? ""),
      lineQtyDelivered: buildLineQtyFromJob(job),
    };
  }
  return defaultJobForm(job);
}

function billingTypeLabel(code: string | undefined): string {
  switch (code) {
    case "monthly":
      return "月結";
    case "prepaid":
      return "預付桶";
    case "mixed":
      return "混用";
    case "cash":
    default:
      return "現金";
  }
}

function isReportableStatus(status: string): boolean {
  return status === "assigned" || status === "delivering" || status === "pending_settlement";
}

function isLockedStatus(status: string): boolean {
  return status === "completed" || status === "not_delivered" || status === "cancelled";
}

export default function OrderProxyReportPage() {
  const { drivers } = useDashboard();
  const activeDrivers = useMemo(() => drivers.filter((d) => driverIsActive(d)), [drivers]);

  const [driverId, setDriverId] = useState("");
  const [assignmentDate, setAssignmentDate] = useState(todayLocalYmd);
  const [driverReportDate, setDriverReportDate] = useState(todayLocalYmd);
  const [filterStatus, setFilterStatus] = useState("reportable");
  const [jobs, setJobs] = useState<AssignmentJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [message, setMessage] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmingLineId, setConfirmingLineId] = useState<string | null>(null);
  const [lineQtyConfirmedByJob, setLineQtyConfirmedByJob] = useState<Record<string, boolean>>({});
  const [formByJob, setFormByJob] = useState<Record<string, JobFormState>>({});

  const selectedDriver = useMemo(
    () => activeDrivers.find((d) => String(d.id) === driverId) ?? null,
    [activeDrivers, driverId],
  );

  useEffect(() => {
    if (!driverId && activeDrivers.length === 1) {
      setDriverId(String(activeDrivers[0]!.id));
    }
  }, [activeDrivers, driverId]);

  useEffect(() => {
    setDriverReportDate(assignmentDate);
  }, [assignmentDate]);

  const loadJobs = useCallback(async () => {
    const employeeCode = selectedDriver ? driverEmployeeCode(selectedDriver).trim() : "";
    if (!employeeCode) {
      setJobs([]);
      setErr("請先選擇司機。");
      return;
    }
    setLoading(true);
    setErr("");
    setMessage("");
    try {
      const qs = new URLSearchParams({
        date: assignmentDate,
        employeeCode,
      });
      const res = await fetch(`/api/driver/today?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setErr(typeof data?.message === "string" ? data.message : "讀取任務失敗");
        setJobs([]);
        return;
      }
      const list: AssignmentJob[] = Array.isArray(data)
        ? (data as Record<string, unknown>[]).map((row) => ({
            ...(row as Omit<AssignmentJob, "id">),
            id: String(row.id),
          }))
        : [];
      setJobs(list);
      setFormByJob((prev) => {
        const next = { ...prev };
        const confirmedNext: Record<string, boolean> = {};
        for (const job of list) {
          const id = String(job.id);
          if (job.status === "pending_settlement") {
            next[id] = jobFormFromServer(job);
          } else if (!next[id] && isReportableStatus(job.status)) {
            next[id] = defaultJobForm(job);
          }
          if (isLineQtyConfirmedOnServer(job)) {
            confirmedNext[id] = true;
          }
        }
        setLineQtyConfirmedByJob((prevConfirmed) => ({ ...prevConfirmed, ...confirmedNext }));
        return next;
      });
    } catch {
      setErr("無法連線 API，請確認服務已啟動。");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [assignmentDate, selectedDriver]);

  useEffect(() => {
    if (selectedDriver) void loadJobs();
    else setJobs([]);
  }, [loadJobs, selectedDriver]);

  const filteredJobs = useMemo(() => {
    let list = jobs;
    if (filterStatus === "reportable") {
      list = list.filter((j) => isReportableStatus(j.status));
    } else if (filterStatus === "pending_report") {
      list = list.filter((j) => j.status === "assigned" || j.status === "delivering");
    } else if (filterStatus === "pending_settlement") {
      list = list.filter((j) => j.status === "pending_settlement");
    }
    return list;
  }, [jobs, filterStatus]);

  const pendingReportCount = useMemo(
    () => jobs.filter((j) => j.status === "assigned" || j.status === "delivering").length,
    [jobs],
  );
  const pendingSettlementCount = useMemo(
    () => jobs.filter((j) => j.status === "pending_settlement").length,
    [jobs],
  );

  const updateForm = (assignmentId: string, patch: Partial<JobFormState>) => {
    if (patch.lineQtyDelivered) {
      setLineQtyConfirmedByJob((prev) => ({ ...prev, [assignmentId]: false }));
    }
    setFormByJob((prev) => ({
      ...prev,
      [assignmentId]: { ...(prev[assignmentId] ?? defaultJobForm()), ...patch },
    }));
  };

  const confirmLineQty = async (assignmentId: string) => {
    const form = formByJob[assignmentId] ?? defaultJobForm();
    const jobBefore = jobs.find((j) => String(j.id) === assignmentId);
    const deliveryLines = jobBefore ? deliveryLinesFromJob(jobBefore) : [];
    if (deliveryLines.length === 0) {
      setLineQtyConfirmedByJob((prev) => ({ ...prev, [assignmentId]: true }));
      return;
    }
    const hasTbdQty = deliveryLines.some((l) => (l.qtyOrdered ?? 0) === 0);
    if (hasTbdQty) {
      const missing = deliveryLines.filter(
        (l) => (l.qtyOrdered ?? 0) === 0 && (form.lineQtyDelivered[String(l.id)] ?? 0) <= 0,
      );
      if (missing.length > 0) {
        setMessage("開單數量為 0（待定）的品項，請填寫實際配送桶數後再確認。");
        return;
      }
    }
    setMessage("");
    setConfirmingLineId(assignmentId);
    try {
      const res = await fetch("/api/driver/confirm-line-deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId,
          lines: deliveryLines.map((l) => ({
            lineId: String(l.id),
            qtyDelivered: Math.max(0, Math.floor(form.lineQtyDelivered[String(l.id)] ?? l.qtyOrdered ?? 0)),
          })),
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "確認配送數量失敗");
        return;
      }
      setLineQtyConfirmedByJob((prev) => ({ ...prev, [assignmentId]: true }));
      const no = payload.data?.assignment?.salesOrder?.orderNo ?? assignmentId;
      const total = payload.data?.assignment?.salesOrder?.totalAmount;
      const cashDue = payload.data?.driverBillingHints?.cashDue;
      setMessage(
        `已確認配送數量：${no}（訂單總額 $${total ?? "—"}，建議收款 $${cashDue ?? "—"}）`,
      );
      await loadJobs();
    } catch {
      setMessage("確認配送數量時發生錯誤。");
    } finally {
      setConfirmingLineId(null);
    }
  };

  const submitReport = async (assignmentId: string) => {
    const form = formByJob[assignmentId] ?? defaultJobForm();
    const jobBefore = jobs.find((j) => String(j.id) === assignmentId);
    const isAmendPending = jobBefore?.status === "pending_settlement";
    if (!form.delivered && !form.failureReason.trim()) {
      setMessage("未送達時請填寫原因。");
      return;
    }
    const deliveryLines = jobBefore ? deliveryLinesFromJob(jobBefore) : [];
    if (form.delivered && deliveryLines.length > 0 && !lineQtyConfirmedByJob[assignmentId]) {
      setMessage("請先按「確認配送數量」，再提交代登回報。");
      return;
    }
    const noteTrim = form.note.trim();
    const noteBody = noteTrim ? noteTrim : isAmendPending ? "" : "辦公室代登司機回報";
    setMessage("");
    setSavingId(assignmentId);
    try {
      const res = await fetch("/api/driver/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId,
          delivered: form.delivered,
          failureReason: form.delivered ? "" : form.failureReason.trim(),
          emptyBarrelsReturned: form.delivered ? form.emptyBarrelsReturned : 0,
          cashReceived: form.delivered ? form.cashReceived : 0,
          note: noteBody,
          reportedAtYmd: driverReportDate,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "提交回報失敗");
        return;
      }
      const no = payload.data?.salesOrder?.orderNo ?? assignmentId;
      setMessage(
        isAmendPending
          ? `已更新代登回報：${no}（仍待辦公室核銷）`
          : `已提交代登回報：${no}（請至「核銷訂單」確認核銷）`,
      );
      await loadJobs();
    } catch {
      setMessage("提交時發生錯誤，請稍後重試。");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <>
      <section className="card">
        <h2 className="card__title">代登配送回報</h2>
        <p className="card__hint">
          <strong>用途：</strong>司機暫不使用司機端時，辦公室可依<strong>紙本訂貨單</strong>在此代為登錄「是否送達、空桶回收、實收現金」。
          提交後任務進入<strong>待辦公室核銷</strong>，請再到 <Link to="/orders/complete">核銷訂單</Link> 按下確認核銷，系統才會出庫與入帳。
          <br />
          <strong>注意：</strong>本頁僅代登司機回報（第一段）；與司機端使用相同 API，核銷流程不變。
        </p>
        {(pendingReportCount > 0 || pendingSettlementCount > 0) && selectedDriver ? (
          <p className="feedback feedback--warn" style={{ marginTop: "0.5rem" }}>
            {selectedDriver.user?.name ?? "司機"} · {assignmentDate}：
            {pendingReportCount > 0 ? (
              <>
                {" "}
                <strong>{pendingReportCount}</strong> 筆尚待回報
              </>
            ) : null}
            {pendingReportCount > 0 && pendingSettlementCount > 0 ? "；" : null}
            {pendingSettlementCount > 0 ? (
              <>
                {" "}
                <strong>{pendingSettlementCount}</strong> 筆待核銷
              </>
            ) : null}
            。
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card__title">篩選條件</h2>
        <div className="toolbar toolbar--filters" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" }}>
          <div className="field field--md">
            <span>司機</span>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">— 請選擇 —</option>
              {activeDrivers.map((d) => (
                <option key={String(d.id)} value={String(d.id)}>
                  {driverEmployeeCode(d)} / {d.user?.name ?? "—"}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--sm">
            <span>配送日</span>
            <input type="date" value={assignmentDate} onChange={(e) => setAssignmentDate(e.target.value)} />
          </div>
          <div className="field field--sm">
            <span>回報日期</span>
            <input type="date" value={driverReportDate} onChange={(e) => setDriverReportDate(e.target.value)} />
          </div>
          <div className="field field--md">
            <span>清單篩選</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              {STATUS_FILTERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadJobs()} disabled={loading || !driverId}>
            {loading ? "載入中…" : "重新載入"}
          </button>
        </div>
        <p className="card__hint" style={{ marginTop: "0.35rem" }}>
          「配送日」用於載入該司機當日任務；「回報日期」寫入司機回報時間（可與配送日不同，例如補登昨日配送）。
        </p>
        {err ? <div className="alert alert--error" style={{ marginTop: "0.75rem" }}>{err}</div> : null}
        {message ? (
          <div
            className={
              message.includes("已提交") || message.includes("已更新")
                ? "feedback feedback--ok"
                : "feedback feedback--err"
            }
            style={{ marginTop: "0.75rem" }}
          >
            {message}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card__title">
          配送任務清單{" "}
          <span className="card__title-count">
            {loading ? "…" : `${filteredJobs.length} / ${jobs.length} 筆`}
          </span>
        </h2>
        {!driverId ? (
          <p className="card__hint">請先選擇司機以載入任務。</p>
        ) : filteredJobs.length === 0 && !loading ? (
          <p className="card__hint">此條件下沒有配送任務。請確認已於「分配訂單」分派，或調整配送日／篩選條件。</p>
        ) : (
          <div className="proxy-report-list">
            {filteredJobs.map((job) => {
              const id = String(job.id);
              const form = formByJob[id] ?? defaultJobForm();
              const locked = isLockedStatus(job.status);
              const pendingOffice = job.status === "pending_settlement";
              const canReport = isReportableStatus(job.status);
              const hints = job.driverBillingHints;
              const cashDue = hints ? Number(hints.cashDue ?? 0) : null;
              const barrelsOnSite = job.salesOrder?.deliveryAddress?.barrelsOnSite ?? null;

              return (
                <article
                  key={id}
                  className={`proxy-report-card${pendingOffice ? " proxy-report-card--pending" : ""}`}
                >
                  <div className="proxy-report-card__head">
                    <code className="proxy-report-card__order-no">{job.salesOrder?.orderNo ?? "—"}</code>
                    <span>{job.salesOrder?.customer?.name ?? "—"}</span>
                    <span className={deliveryAssignmentStatusBadgeClass(job.status)}>
                      {deliveryAssignmentStatusLabel(job.status)}
                    </span>
                    {job.settlementOutcome ? (
                      <span className="pill pill--subtle">{settlementOutcomeLabel(job.settlementOutcome)}</span>
                    ) : null}
                  </div>
                  <p className="proxy-report-card__meta">
                    {job.salesOrder?.deliveryAddress?.addressLine ?? "—"}
                    {job.vehicle?.plateNo ? ` · 車輛 ${job.vehicle.plateNo}` : ""}
                    {barrelsOnSite != null ? ` · 送貨點在場空桶 ${barrelsOnSite}` : ""}
                  </p>

                  {hints ? (
                    <div className="proxy-report-card__billing">
                      <div>
                        <strong>結帳</strong>：{billingTypeLabel(hints.billingType)} · 訂單總額{" "}
                        <strong>${String(hints.orderTotal ?? job.salesOrder?.totalAmount ?? "—")}</strong>
                      </div>
                      {cashDue != null && cashDue > 0 ? (
                        <div style={{ marginTop: "0.2rem" }}>
                          <strong className="proxy-report-card__cash-due">本趟建議收款 ${cashDue}</strong>
                          {Number(hints.cashPriorBalance ?? 0) > 0 ? (
                            <span className="proxy-report-card__cash-muted">
                              {" "}
                              （含前期未清 ${hints.cashPriorBalance}）
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="proxy-report-card__cash-muted" style={{ marginTop: "0.2rem" }}>
                          本趟應收現金 $0（月結或無現金列；若客戶臨付請照實填寫實收）
                        </div>
                      )}
                    </div>
                  ) : null}

                  {locked ? (
                    <p className="card__hint" style={{ margin: 0 }}>
                      此筆已結案，無法再修改回報。
                      {job.driverReportedAt ? ` 司機回報：${String(job.driverReportedAt).slice(0, 19).replace("T", " ")}` : ""}
                    </p>
                  ) : canReport ? (
                    <>
                      {pendingOffice ? (
                        <p className="feedback feedback--warn" style={{ margin: "0 0 0.65rem", fontSize: "0.84rem" }}>
                          已代登回報、待核銷。若與紙本不符可修正後重新提交；核銷後即鎖定。
                        </p>
                      ) : null}
                      <fieldset disabled={savingId === id} style={{ margin: 0, padding: 0, border: "none" }}>
                        <div className="proxy-report-card__form-row proxy-report-card__radio-row">
                          <label>
                            <input
                              type="radio"
                              name={`del-${id}`}
                              checked={form.delivered}
                              onChange={() => updateForm(id, { delivered: true })}
                            />
                            已送達
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={`del-${id}`}
                              checked={!form.delivered}
                              onChange={() => updateForm(id, { delivered: false })}
                            />
                            未送達
                          </label>
                        </div>

                        {!form.delivered ? (
                          <div className="field proxy-report-card__field-spaced">
                            <span>未送達原因</span>
                            <textarea
                              rows={2}
                              value={form.failureReason}
                              onChange={(e) => updateForm(id, { failureReason: e.target.value })}
                              placeholder="例如：客戶不在、地址錯誤、拒收…"
                            />
                          </div>
                        ) : (
                          <>
                            {deliveryLinesFromJob(job).length > 0 ? (
                              <div className="proxy-report-card__lines" style={{ marginBottom: "0.65rem" }}>
                                <div className="proxy-report-card__lines-title" style={{ fontSize: "0.84rem", marginBottom: "0.35rem" }}>
                                  <strong>實際配送桶數</strong>
                                  <span className="proxy-report-card__cash-muted" style={{ marginLeft: "0.35rem" }}>
                                    （開單 0 表示待定，請填實際數量）
                                  </span>
                                </div>
                                <div className="proxy-report-card__lines-grid" style={{ display: "grid", gap: "0.4rem" }}>
                                  {deliveryLinesFromJob(job).map((line) => {
                                    const lineId = String(line.id);
                                    const ordered = line.qtyOrdered ?? 0;
                                    return (
                                      <div
                                        key={lineId}
                                        className="proxy-report-card__line-row"
                                        style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
                                      >
                                        <span style={{ flex: "1 1 8rem", fontSize: "0.84rem" }}>
                                          {line.product?.name ?? line.product?.code ?? "商品"}
                                          {ordered > 0 ? (
                                            <span className="proxy-report-card__cash-muted">（開單 {ordered}）</span>
                                          ) : (
                                            <span className="proxy-report-card__cash-muted">（開單待定）</span>
                                          )}
                                        </span>
                                        <input
                                          type="number"
                                          min={0}
                                          step={1}
                                          className="field field--sm"
                                          style={{ width: "4.5rem" }}
                                          value={form.lineQtyDelivered[lineId] ?? ordered}
                                          onChange={(e) =>
                                            updateForm(id, {
                                              lineQtyDelivered: {
                                                ...form.lineQtyDelivered,
                                                [lineId]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                                              },
                                            })
                                          }
                                          aria-label={`${line.product?.name ?? "商品"} 實際配送桶數`}
                                        />
                                        <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>桶</span>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ marginTop: "0.45rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                  <button
                                    type="button"
                                    className="btn btn--secondary btn--sm"
                                    disabled={confirmingLineId === id || savingId === id}
                                    onClick={() => void confirmLineQty(id)}
                                  >
                                    {confirmingLineId === id ? "確認中…" : "確認配送數量"}
                                  </button>
                                  {lineQtyConfirmedByJob[id] ? (
                                    <span className="feedback feedback--ok" style={{ margin: 0, padding: "0.2rem 0.5rem", fontSize: "0.8rem" }}>
                                      已確認（訂單金額／應收已更新）
                                    </span>
                                  ) : (
                                    <span className="proxy-report-card__cash-muted" style={{ fontSize: "0.8rem" }}>
                                      修改桶數後請先確認，再填收款並提交回報
                                    </span>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          <div className="proxy-report-card__form-row proxy-report-card__form-row--cash">
                            <div className="field field--sm">
                              <span>空桶回收</span>
                              <input
                                type="number"
                                min={0}
                                value={form.emptyBarrelsReturned}
                                onChange={(e) =>
                                  updateForm(id, { emptyBarrelsReturned: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                                }
                              />
                            </div>
                            <div className="field field--sm">
                              <span>實收現金</span>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={form.cashReceived}
                                onChange={(e) => updateForm(id, { cashReceived: Number(e.target.value) || 0 })}
                              />
                            </div>
                            {cashDue != null && form.delivered ? (
                              <div className="field field--sm" style={{ alignSelf: "flex-end" }}>
                                <span>與建議收款差額</span>
                                <div className="proxy-report-card__variance">
                                  {(form.cashReceived - cashDue).toFixed(2)}
                                </div>
                              </div>
                            ) : null}
                          </div>
                          </>
                        )}

                        <div className="field proxy-report-card__field-spaced">
                          <span>備註（選填）</span>
                          <input
                            type="text"
                            value={form.note}
                            onChange={(e) => updateForm(id, { note: e.target.value })}
                            placeholder="特殊狀況說明"
                          />
                        </div>

                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={
                            savingId === id ||
                            (form.delivered &&
                              deliveryLinesFromJob(job).length > 0 &&
                              !lineQtyConfirmedByJob[id])
                          }
                          onClick={() => void submitReport(id)}
                        >
                          {savingId === id
                            ? "提交中…"
                            : pendingOffice
                              ? "更新代登回報"
                              : "提交代登回報"}
                        </button>
                      </fieldset>
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
