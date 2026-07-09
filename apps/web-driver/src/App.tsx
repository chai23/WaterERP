import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import "./driver-ui.css";
import BarrelPickupTab from "./BarrelPickupTab";

function todayYmd(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type AuthUser = {
  id: string;
  employeeCode: string;
  name: string;
  role: string;
  driverId: string | null;
};

const DRIVER_TOKEN_KEY = "watererp.driver.token";
const DRIVER_USER_KEY = "watererp.driver.user";

function readDriverUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(DRIVER_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function getDriverToken(): string {
  return localStorage.getItem(DRIVER_TOKEN_KEY) ?? "";
}

function jobBadgeClass(status: string): string {
  switch (status) {
    case "assigned":
      return "d-badge d-badge--assigned";
    case "delivering":
      return "d-badge d-badge--delivering";
    case "pending_settlement":
      return "d-badge d-badge--pending";
    case "completed":
      return "d-badge d-badge--completed";
    case "not_delivered":
      return "d-badge d-badge--notdelivered";
    default:
      return "d-badge d-badge--assigned";
  }
}

function cashInvoiceModeShort(mode: string | undefined): string {
  switch (mode) {
    case "tax_exclusive":
      return "稅外加";
    case "tax_inclusive":
      return "含稅";
    default:
      return mode ?? "—";
  }
}

function billingTypeLabel(code: string | undefined): string {
  switch (code) {
    case "monthly":
      return "月結";
    case "prepaid":
      return "預付桶";
    case "mixed":
      return "混用（依明細）";
    case "cash":
    default:
      return "現金";
  }
}

function settlementOutcomeShort(code: string | null | undefined): string {
  switch (code) {
    case "delivered_cash_exact":
      return "足額";
    case "delivered_cash_short":
      return "少收";
    case "delivered_cash_over":
      return "多收";
    case "delivered_no_cash":
      return "未收款";
    default:
      return code ?? "—";
  }
}

function jobStatusLabel(status: string): string {
  switch (status) {
    case "pending_settlement":
      return "待辦公室核銷";
    case "not_delivered":
      return "未送達";
    case "completed":
      return "已結案";
    case "delivering":
      return "配送中";
    case "assigned":
      return "已分派";
    default:
      return status;
  }
}

type JobFormState = {
  delivered: boolean;
  failureReason: string;
  emptyBarrelsReturned: number;
  cashReceived: number;
  note: string;
  lineQtyDelivered: Record<string, number>;
};

type OrderLineRow = {
  id: string;
  qtyOrdered?: number;
  qtyDelivered?: number;
  linePurpose?: string | null;
  product?: { name?: string; code?: string };
};

type DriverJob = {
  id: string;
  status: string;
  settlementOutcome?: string | null;
  failureReason?: string | null;
  emptyBarrelsReturned?: number;
  cashReceived?: unknown;
  settlementNote?: string | null;
  salesOrder?: {
    orderNo?: string;
    totalAmount?: unknown;
    customer?: { name?: string };
    deliveryAddress?: { addressLine?: string };
    lines?: OrderLineRow[];
  };
  vehicle?: { plateNo?: string };
  driverBillingHints?: Record<string, unknown>;
};

function deliveryLinesFromJob(job: DriverJob): OrderLineRow[] {
  return (job.salesOrder?.lines ?? []).filter((l) => (l.linePurpose ?? "delivery") === "delivery");
}

function buildLineQtyFromJob(job: DriverJob): Record<string, number> {
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

const defaultJobForm = (job?: DriverJob): JobFormState => ({
  delivered: true,
  failureReason: "",
  emptyBarrelsReturned: 0,
  cashReceived: 0,
  note: "",
  lineQtyDelivered: job ? buildLineQtyFromJob(job) : {},
});

/** 從伺服器任務帶入表單（待核銷時可修正回報） */
function jobFormFromServer(job: DriverJob): JobFormState {
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

function isLineQtyConfirmedOnServer(job: DriverJob): boolean {
  const lines = deliveryLinesFromJob(job);
  if (lines.length === 0) return true;
  return lines.every((l) => (l.qtyDelivered ?? 0) > 0);
}

export default function App() {
  const [health, setHealth] = useState<string>("…");
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => readDriverUser());
  const [loginCode, setLoginCode] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [assignmentDate, setAssignmentDate] = useState(todayYmd);
  /** 寫入 driver_reported_at 的日期（預設跟配送日；可改為測試日） */
  const [driverReportDate, setDriverReportDate] = useState(todayYmd);
  const [jobs, setJobs] = useState<any[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string>("");
  const [confirmingLineId, setConfirmingLineId] = useState<string>("");
  const [lineQtyConfirmedByJob, setLineQtyConfirmedByJob] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string>("");
  const [formByJob, setFormByJob] = useState<Record<string, JobFormState>>({});
  const [cashClose, setCashClose] = useState<{
    expectedCash: number;
    driverCollectedCash: number;
    cashierRecordedCash: number;
    varianceDriverVsExpected: number;
    varianceCashierVsDriver: number;
  } | null>(null);
  const [mainTab, setMainTab] = useState<"delivery" | "barrel">("delivery");

  const authHeaders = useCallback((): Record<string, string> => {
    const token = getDriverToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(DRIVER_TOKEN_KEY);
    localStorage.removeItem(DRIVER_USER_KEY);
    setAuthUser(null);
    setJobs([]);
    setFormByJob({});
  }, []);

  useEffect(() => {
    const token = getDriverToken();
    if (!token) return;
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload?.ok || payload.user?.role !== "driver") throw new Error("invalid");
        localStorage.setItem(DRIVER_USER_KEY, JSON.stringify(payload.user));
        setAuthUser(payload.user);
      })
      .catch(() => logout());
  }, [logout]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setLoginMessage("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeCode: loginCode.trim().toUpperCase(), password: loginPassword }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.message ?? "登入失敗");
      if (payload.user?.role !== "driver") throw new Error("此帳號不是司機帳號");
      localStorage.setItem(DRIVER_TOKEN_KEY, payload.token);
      localStorage.setItem(DRIVER_USER_KEY, JSON.stringify(payload.user));
      setAuthUser(payload.user);
      setLoginPassword("");
    } catch (err) {
      setLoginMessage(err instanceof Error ? err.message : "登入失敗");
    }
  };

  const loadJobs = useCallback(async () => {
    if (!authUser) {
      setJobs([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [h, listRes] = await Promise.all([
        fetch("/api/health").then((r) => r.json()),
        fetch(`/api/driver/today?date=${encodeURIComponent(assignmentDate)}`, { headers: authHeaders() }).then((r) => r.json()),
      ]);
      setHealth(JSON.stringify(h));
      const list = Array.isArray(listRes) ? listRes : [];
      if (!Array.isArray(listRes) && listRes?.ok === false) {
        setError(listRes.message ?? "讀取任務失敗");
        setJobs([]);
        return;
      }
      setJobs(list);
      setCashClose(null);
      setFormByJob((prev) => {
        const next = { ...prev };
        const confirmedNext: Record<string, boolean> = {};
        for (const job of list) {
          const id = String(job.id);
          if (job.status === "pending_settlement") {
            next[id] = jobFormFromServer(job);
          } else if (!next[id]) {
            next[id] = defaultJobForm(job as DriverJob);
          }
          if (isLineQtyConfirmedOnServer(job as DriverJob)) {
            confirmedNext[id] = true;
          }
        }
        setLineQtyConfirmedByJob((prevConfirmed) => ({ ...prevConfirmed, ...confirmedNext }));
        return next;
      });
    } catch {
      setHealth("無法連線 API");
      setError("讀取司機任務失敗");
      setJobs([]);
      setCashClose(null);
    } finally {
      setLoading(false);
    }
  }, [authUser, assignmentDate, authHeaders]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    setDriverReportDate(assignmentDate);
  }, [assignmentDate]);

  const confirmLineQty = async (assignmentId: string) => {
    const jobBefore = jobs.find((j) => String(j.id) === assignmentId) as DriverJob | undefined;
    const form = formByJob[assignmentId] ?? defaultJobForm(jobBefore);
    const deliveryLines = jobBefore ? deliveryLinesFromJob(jobBefore) : [];
    if (deliveryLines.length === 0) {
      setLineQtyConfirmedByJob((prev) => ({ ...prev, [assignmentId]: true }));
      return;
    }
    setMessage("");
    setConfirmingLineId(assignmentId);
    try {
      const res = await fetch("/api/driver/confirm-line-deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
      setMessage(`已確認配送數量：${no}（訂單總額 $${total ?? "—"}，建議收款 $${cashDue ?? "—"}）`);
      await loadJobs();
    } catch {
      setMessage("確認配送數量時發生錯誤。");
    } finally {
      setConfirmingLineId("");
    }
  };

  const completeJob = async (assignmentId: string) => {
    const jobBefore = jobs.find((j) => String(j.id) === assignmentId) as DriverJob | undefined;
    const form = formByJob[assignmentId] ?? defaultJobForm(jobBefore);
    const isAmendPending = jobBefore?.status === "pending_settlement";
    const deliveryLines = jobBefore ? deliveryLinesFromJob(jobBefore) : [];
    if (form.delivered && deliveryLines.length > 0 && !lineQtyConfirmedByJob[assignmentId]) {
      setMessage("請先按「確認配送數量」，再提交配送回報。");
      return;
    }
    if (!form.delivered && !form.failureReason.trim()) {
      setMessage("未送達時請填寫原因。");
      return;
    }
    setMessage("");
    setSavingId(assignmentId);
    try {
      const res = await fetch("/api/driver/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          assignmentId,
          delivered: form.delivered,
          failureReason: form.delivered ? "" : form.failureReason,
          emptyBarrelsReturned: form.delivered ? form.emptyBarrelsReturned : 0,
          cashReceived: form.delivered ? form.cashReceived : 0,
          note: form.note,
          reportedAtYmd: driverReportDate,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "核銷失敗");
        return;
      }
      const no = payload.data?.salesOrder?.orderNo ?? assignmentId;
      setMessage(
        isAmendPending
          ? `已更新配送回報：${no}（仍待辦公室核銷；請通知內勤以最新數值核銷）`
          : `已提交回報：${no}（待辦公室核銷後始完成）`,
      );
      await loadJobs();
    } catch {
      setMessage("提交時發生錯誤，請稍後重試。");
    } finally {
      setSavingId("");
    }
  };

  const updateForm = (assignmentId: string, patch: Partial<JobFormState>) => {
    if (patch.lineQtyDelivered) {
      setLineQtyConfirmedByJob((prev) => ({ ...prev, [assignmentId]: false }));
    }
    setFormByJob((prev) => ({
      ...prev,
      [assignmentId]: { ...(prev[assignmentId] ?? defaultJobForm()), ...patch },
    }));
  };

  if (!authUser) {
    return (
      <div className="driver-app">
        <main className="driver-login">
          <section className="driver-panel driver-login__panel">
            <h1 className="driver-header__title">WaterERP · 司機登入</h1>
            <form className="driver-login__form" onSubmit={login}>
              <div className="d-field">
                <span>員編</span>
                <input value={loginCode} onChange={(e) => setLoginCode(e.target.value.toUpperCase())} autoComplete="username" required />
              </div>
              <div className="d-field">
                <span>密碼</span>
                <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              {loginMessage ? <div className="d-alert d-alert--err">{loginMessage}</div> : null}
              <button type="submit" className="d-btn">登入司機端</button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="driver-app">
      <header className="driver-header">
        <h1 className="driver-header__title">WaterERP · 司機任務</h1>
        <div className="driver-header__tabs" role="tablist" style={{ display: "flex", gap: "0.5rem", margin: "0.5rem 0" }}>
          <button
            type="button"
            role="tab"
            className={`d-btn${mainTab === "delivery" ? "" : " d-btn--ghost"}`}
            aria-selected={mainTab === "delivery"}
            onClick={() => setMainTab("delivery")}
          >
            配送任務
          </button>
          <button
            type="button"
            role="tab"
            className={`d-btn${mainTab === "barrel" ? "" : " d-btn--ghost"}`}
            aria-selected={mainTab === "barrel"}
            onClick={() => setMainTab("barrel")}
          >
            收空桶
          </button>
        </div>
        <div className="driver-header__user">
          <span>{authUser.name}（{authUser.employeeCode}）</span>
          <button type="button" className="d-btn d-btn--ghost" onClick={logout}>登出</button>
        </div>
        <p className="driver-header__sub">
          {mainTab === "delivery" ? (
            <>
              選擇<strong>員編</strong>與<strong>配送日</strong>（須與後台分派日一致）。送達後請填寫回桶與收款並提交；提交後為<strong>待辦公室核銷</strong>，訂單須經後台確認後才完成。<strong>未送達</strong>時亦同，由辦公室確認後訂單才退回後台。
              <br />
              <strong>填錯可改：</strong>在辦公室按下「確認核銷」<strong>之前</strong>，司機可於同一筆任務修改空桶回收、現場收款、是否送達等，按下「更新配送回報」即可覆寫（系統會保留修正紀錄供內勤查核）。
              <br />
              <strong>實際送達／回報日</strong>預設與配送日相同；測試時可改成指定日期，系統會以此寫入司機回報時間（非一律用現在時間）。
            </>
          ) : (
            <>
              <strong>收空桶</strong>分頁：僅收空桶、不送貨的任務。須與後台「預定收桶日」一致；回報後待辦公室核銷，核銷後才減少送貨點在場空桶數。
            </>
          )}
        </p>
      </header>

      {mainTab === "barrel" ? (
        <BarrelPickupTab authHeaders={authHeaders} />
      ) : (
        <>
      <section className="driver-panel">
        <h2 className="driver-panel__title">篩選條件</h2>
        <div className="d-field">
          <span>配送日</span>
          <input type="date" value={assignmentDate} onChange={(e) => setAssignmentDate(e.target.value)} />
        </div>
        <div className="d-field">
          <span>實際送達／回報日</span>
          <input type="date" value={driverReportDate} onChange={(e) => setDriverReportDate(e.target.value)} />
        </div>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.78rem", color: "var(--d-muted)" }}>
          提交回報時會傳送此日期；與「配送日」不同時以本欄為準（例如測試 3/24 送達）。
        </p>
        <div className="d-actions">
          <button type="button" className="d-btn" onClick={() => void loadJobs()} disabled={loading}>
            {loading ? "載入中…" : "重新載入清單"}
          </button>
        </div>
      </section>

      {cashClose ? (
        <section className="driver-panel">
          <h2 className="driver-panel__title">日終收現核對</h2>
          <p style={{ margin: "0 0 0.45rem" }}>
            應收 {cashClose.expectedCash.toFixed(2)} ／ 司機實收 {cashClose.driverCollectedCash.toFixed(2)} ／ 出納入帳 {cashClose.cashierRecordedCash.toFixed(2)}
          </p>
          <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--d-muted)" }}>
            司機差額 {cashClose.varianceDriverVsExpected.toFixed(2)}，出納差額 {cashClose.varianceCashierVsDriver.toFixed(2)}
          </p>
        </section>
      ) : null}

      <section className="driver-panel">
        <h2 className="driver-panel__title">連線狀態</h2>
        <pre
          style={{
            margin: 0,
            fontSize: "0.75rem",
            padding: "0.5rem 0.65rem",
            background: "#f8fafc",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            overflow: "auto",
            maxHeight: "4rem",
          }}
        >
          {health}
        </pre>
      </section>

      {error ? <div className="d-alert d-alert--err">{error}</div> : null}
      {message ? <div className={message.includes("已提交") || message.includes("已更新") ? "d-alert d-alert--ok" : "d-alert d-alert--err"}>{message}</div> : null}

      <h2 className="driver-panel__title" style={{ marginBottom: "0.5rem" }}>
        配送清單 · {assignmentDate}
        {authUser ? ` · ${authUser.employeeCode}` : ""}
      </h2>

      <div className="d-job-list">
        {jobs.map((job) => {
          const id = String(job.id);
          const form = formByJob[id] ?? defaultJobForm(job as DriverJob);
          const lockedAfterOffice = job.status === "completed" || job.status === "not_delivered";
          const pendingOffice = job.status === "pending_settlement";
          const jobClass =
            job.status === "completed"
              ? "d-job d-job--done"
              : job.status === "not_delivered"
                ? "d-job d-job--fail"
                : job.status === "pending_settlement"
                  ? "d-job d-job--pending"
                  : "d-job";
          return (
            <article key={id} className={jobClass}>
              <div className="d-job__no">{job.salesOrder?.orderNo}</div>
              <div className="d-job__customer">{job.salesOrder?.customer?.name ?? "—"}</div>
              <div className="d-job__addr">{job.salesOrder?.deliveryAddress?.addressLine ?? "—"}</div>
              <div className="d-job__meta">
                <span className={jobBadgeClass(job.status)}>{jobStatusLabel(job.status)}</span>
                <span>車輛 {job.vehicle?.plateNo ?? "未指定"}</span>
              </div>
              {job.driverBillingHints ? (
                <div className="d-job-billing" style={{ marginTop: "0.5rem", fontSize: "0.82rem", lineHeight: 1.45 }}>
                  <div>
                    <strong>結帳</strong>：{billingTypeLabel(job.driverBillingHints.billingType)}
                  </div>
                  <div style={{ marginTop: "0.2rem" }}>
                    訂單總額 <strong>${job.driverBillingHints.orderTotal}</strong>
                  </div>
                  {(() => {
                    const due = Number(job.driverBillingHints.cashDue);
                    const cashCol = Number(job.driverBillingHints.cashSubtotal);
                    const otherDue = Number(job.driverBillingHints.cashPriorBalance);
                    const showCollect = due > 0 || cashCol > 0 || otherDue > 0;
                    if (!showCollect) {
                      return (
                        <div style={{ marginTop: "0.2rem" }}>
                          <strong style={{ color: "var(--d-accent, #0f766e)" }}>本趟應收現金 $0</strong>
                          <span style={{ color: "var(--d-muted)" }}>（無未清應收或本單無現金列；若客戶臨付現金請照實填寫）</span>
                        </div>
                      );
                    }
                    return (
                      <>
                        {job.driverBillingHints.cashTaxInvoice ? (
                          <div
                            style={{
                              marginTop: "0.2rem",
                              padding: "0.35rem 0.45rem",
                              background: "#fefce8",
                              borderRadius: 6,
                              border: "1px solid #fde68a",
                              fontSize: "0.8rem",
                              lineHeight: 1.45,
                            }}
                          >
                            <strong>本單現金發票試算</strong>
                            <span style={{ color: "var(--d-muted)", marginLeft: "0.35rem" }}>
                              （{cashInvoiceModeShort(job.driverBillingHints.cashTaxInvoice.mode)} · 稅率{" "}
                              {(Number(job.driverBillingHints.cashTaxInvoice.taxRate) * 100).toFixed(0)}%）
                            </span>
                            <br />
                            未稅 <strong>${job.driverBillingHints.cashTaxInvoice.untaxedAmount}</strong>
                            {" · "}
                            營業稅 <strong>${job.driverBillingHints.cashTaxInvoice.taxAmount}</strong>
                            {" · "}
                            含稅 <strong>${job.driverBillingHints.cashTaxInvoice.totalWithTax}</strong>
                          </div>
                        ) : null}
                        <div style={{ marginTop: "0.2rem", padding: "0.35rem 0.45rem", background: "#ecfeff", borderRadius: 6 }}>
                          <strong style={{ color: "var(--d-accent, #0f766e)" }}>本趟請收 ${job.driverBillingHints.cashDue}</strong>
                          <span style={{ color: "var(--d-muted)" }}>（含本單以外欠款／月結未清等，已扣預收錢包）</span>
                        </div>
                        {otherDue > 0 ? (
                          <div style={{ marginTop: "0.15rem" }}>
                            其他未清應收（本單以外） <strong>${job.driverBillingHints.cashPriorBalance}</strong>
                          </div>
                        ) : null}
                        {cashCol > 0 ? (
                          <div style={{ marginTop: "0.15rem" }}>
                            本單現金列（未稅參考） <strong>${job.driverBillingHints.cashSubtotal}</strong>
                          </div>
                        ) : null}
                        <div style={{ marginTop: "0.15rem", fontSize: "0.78rem", color: "var(--d-muted)", lineHeight: 1.45 }}>
                          建議收款＝客戶名下<strong>全部未沖銷應收</strong>（現金／月結）合計 − <strong>預收錢包</strong>；實收後後台依<strong>到期日先後 FIFO</strong>沖帳。
                        </div>
                        <div style={{ marginTop: "0.2rem" }}>
                          <strong>差額</strong> 由「實收 − 本趟請收」計算（後台核銷時入帳）
                        </div>
                      </>
                    );
                  })()}
                  {Number(job.driverBillingHints.monthlySubtotal) > 0 ? (
                    <div style={{ marginTop: "0.15rem" }}>
                      月結列貨款 <strong>${job.driverBillingHints.monthlySubtotal}</strong>
                      <span style={{ color: "var(--d-muted)" }}>（辦公室核銷後入月結應收）</span>
                    </div>
                  ) : null}
                  {Number(job.driverBillingHints.prepaidLineTotal) > 0 ? (
                    <div style={{ marginTop: "0.15rem" }}>
                      預付列貨款 <strong>${job.driverBillingHints.prepaidLineTotal}</strong>
                      <span style={{ color: "var(--d-muted)" }}>（送達核銷時扣桶）</span>
                    </div>
                  ) : null}
                  {job.driverBillingHints.billingType === "prepaid" || Number(job.driverBillingHints.prepaidLineTotal) > 0 ? (
                    <div style={{ marginTop: "0.15rem" }}>
                      預付桶餘額：<strong>{job.driverBillingHints.prepaidBarrelBalance}</strong> 桶
                      {job.driverBillingHints.allowPrepaidOverdraft ? "（可透支）" : ""}
                    </div>
                  ) : null}
                  <div style={{ marginTop: "0.25rem", padding: "0.35rem 0.45rem", background: "#f1f5f9", borderRadius: 6 }}>
                    客戶往來餘額（全帳）：<strong>{Number(job.driverBillingHints.accountBalance).toLocaleString()}</strong>
                    <span style={{ color: "var(--d-muted)", fontSize: "0.78rem" }}>
                      {" "}
                      （正＝客戶欠公司；負＝多收／預收；含月結等非現金項目）
                    </span>
                  </div>
                  {job.driverBillingHints.lastCompletedDelivery ? (
                    <div style={{ marginTop: "0.35rem", padding: "0.35rem 0.45rem", border: "1px dashed var(--d-border-strong)", borderRadius: 6 }}>
                      <strong>上一筆已結案配送</strong>（同客戶）單號 {job.driverBillingHints.lastCompletedDelivery.orderNo}
                      <br />
                      應收現金 {job.driverBillingHints.lastCompletedDelivery.expectedAmount ?? "—"} · 實收{" "}
                      {job.driverBillingHints.lastCompletedDelivery.cashReceived} · 差額{" "}
                      {job.driverBillingHints.lastCompletedDelivery.cashVariance ?? "—"} ·
                      {settlementOutcomeShort(job.driverBillingHints.lastCompletedDelivery.settlementOutcome)}
                    </div>
                  ) : (
                    <div style={{ marginTop: "0.25rem", fontSize: "0.78rem", color: "var(--d-muted)" }}>尚無更早的同客戶已結案配送紀錄。</div>
                  )}
                </div>
              ) : (
                <div className="d-job__meta" style={{ marginTop: "0.35rem" }}>
                  <span>訂單總額 ${job.salesOrder?.totalAmount ?? "—"}</span>
                </div>
              )}
              {pendingOffice ? (
                <div className="d-alert d-alert--warn" style={{ marginTop: "0.45rem", fontSize: "0.82rem" }}>
                  此筆已回報、<strong>待辦公室核銷</strong>。若空桶／收款填錯，請直接修改欄位後按「更新配送回報」（核銷後即無法再改）。
                </div>
              ) : null}
              <div className="d-job-form">
                <fieldset disabled={lockedAfterOffice} style={{ margin: 0, padding: 0, border: "none" }}>
                  <legend className="d-field" style={{ marginBottom: "0.5rem" }}>
                    <span>是否送達</span>
                  </legend>
                  <label className="d-check" style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.5rem" }}>
                    <input
                      type="radio"
                      name={`del-${id}`}
                      checked={form.delivered}
                      onChange={() => updateForm(id, { delivered: true })}
                    />
                    已送達（填回桶／收款）
                  </label>
                  <label className="d-check" style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.65rem" }}>
                    <input
                      type="radio"
                      name={`del-${id}`}
                      checked={!form.delivered}
                      onChange={() => updateForm(id, { delivered: false })}
                    />
                    未送達（提交後待辦公室確認，必填原因）
                  </label>

                  {!form.delivered ? (
                    <div className="d-field">
                      <span>未送達原因</span>
                      <textarea
                        rows={3}
                        value={form.failureReason}
                        onChange={(e) => updateForm(id, { failureReason: e.target.value })}
                        placeholder="例如：客戶不在、地址錯誤、拒收…"
                        style={{ fontFamily: "inherit", fontSize: "0.9rem", padding: "0.5rem", borderRadius: 8, border: "1px solid var(--d-border-strong)" }}
                      />
                    </div>
                  ) : (
                    <>
                      {deliveryLinesFromJob(job as DriverJob).length > 0 ? (
                        <div style={{ marginBottom: "0.65rem" }}>
                          <div style={{ fontSize: "0.84rem", marginBottom: "0.35rem" }}>
                            <strong>實際配送桶數</strong>
                            <span style={{ color: "var(--d-muted)", marginLeft: "0.35rem", fontSize: "0.78rem" }}>
                              （開單 0＝待定）
                            </span>
                          </div>
                          {deliveryLinesFromJob(job as DriverJob).map((line) => {
                            const lineId = String(line.id);
                            const ordered = line.qtyOrdered ?? 0;
                            return (
                              <label key={lineId} className="d-inline" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                                <span style={{ flex: 1, fontSize: "0.84rem" }}>
                                  {line.product?.name ?? "商品"}
                                  {ordered > 0 ? `（開單 ${ordered}）` : "（待定）"}
                                </span>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  style={{ width: "4rem" }}
                                  value={form.lineQtyDelivered[lineId] ?? ordered}
                                  onChange={(e) =>
                                    updateForm(id, {
                                      lineQtyDelivered: {
                                        ...form.lineQtyDelivered,
                                        [lineId]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                                      },
                                    })
                                  }
                                />
                                <span style={{ fontSize: "0.78rem", color: "var(--d-muted)" }}>桶</span>
                              </label>
                            );
                          })}
                          <div style={{ marginTop: "0.45rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="d-btn d-btn--ghost"
                              disabled={confirmingLineId === id || savingId === id}
                              onClick={() => void confirmLineQty(id)}
                            >
                              {confirmingLineId === id ? "確認中…" : "確認配送數量"}
                            </button>
                            {lineQtyConfirmedByJob[id] ? (
                              <span style={{ fontSize: "0.78rem", color: "var(--d-accent, #0f766e)" }}>已確認（金額／應收已更新）</span>
                            ) : (
                              <span style={{ fontSize: "0.78rem", color: "var(--d-muted)" }}>修改桶數後請先確認</span>
                            )}
                          </div>
                        </div>
                      ) : null}
                      <label className="d-inline">
                        空桶回收
                        <input
                          type="number"
                          min={0}
                          value={form.emptyBarrelsReturned}
                          onChange={(e) => updateForm(id, { emptyBarrelsReturned: Number(e.target.value) || 0 })}
                        />
                      </label>
                      <label className="d-inline">
                        現場收款
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={form.cashReceived}
                          onChange={(e) => updateForm(id, { cashReceived: Number(e.target.value) || 0 })}
                        />
                      </label>
                    <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--d-muted)" }}>
                      請以<strong>建議收款總額</strong>與<strong>現場收款</strong>比對；系統會自動分類少收／多收／足額。實際沖帳以辦公室核銷為準。
                      {pendingOffice ? (
                        <>
                          {" "}
                          <strong>注意：</strong>左欄為<strong>空桶回收（桶數）</strong>、右欄為<strong>現金金額</strong>，請勿對調。
                        </>
                      ) : null}
                    </p>
                    </>
                  )}
                  <label className="d-inline">
                    備註
                    <input type="text" value={form.note} onChange={(e) => updateForm(id, { note: e.target.value })} />
                  </label>
                </fieldset>
                <div className="d-actions" style={{ marginTop: "0.25rem" }}>
                  <button
                    type="button"
                    className="d-btn"
                    onClick={() => completeJob(id)}
                    disabled={
                      savingId === id ||
                      lockedAfterOffice ||
                      (!form.delivered && !form.failureReason.trim()) ||
                      (form.delivered &&
                        deliveryLinesFromJob(job as DriverJob).length > 0 &&
                        !lineQtyConfirmedByJob[id])
                    }
                  >
                    {savingId === id ? "提交中…" : lockedAfterOffice ? "已結案" : pendingOffice ? "更新配送回報" : "提交配送回報"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {!loading && jobs.length === 0 && !error ? (
        <p className="d-empty">
          此司機在 <strong>{assignmentDate}</strong> 沒有可顯示的派單。
          <br />
          請確認後台「分派司機」的配送日與員編是否一致。
        </p>
      ) : null}
        </>
      )}
    </div>
  );
}
