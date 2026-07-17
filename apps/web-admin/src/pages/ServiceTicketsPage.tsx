import { useCallback, useEffect, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";
import ServiceTicketDetailModal, { type ServiceTicketDetail } from "../components/ServiceTicketDetailModal";

type ServiceTicketRow = ServiceTicketDetail & {
  assessDriverId?: string | null;
  returnDriverId?: string | null;
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "reported", label: "待受理" },
  { value: "accepted", label: "已受理" },
  { value: "assess_assigned", label: "已派評估" },
  { value: "pending_pickup", label: "待載回" },
  { value: "pending_loaner", label: "待換臨時機" },
  { value: "in_workshop", label: "廠內處理" },
  { value: "quote_accepted", label: "報價已同意" },
  { value: "pending_return", label: "待送回" },
  { value: "returned", label: "已送回" },
  { value: "onsite_completed", label: "現場已完工" },
  { value: "closed", label: "已結案" },
];

const WORKFLOW_STEPS = [
  { no: 1, label: "受理派評估", hint: "選司機、日期，派到場評估" },
  { no: 2, label: "現場評估", hint: "司機回報或後台補登" },
  { no: 3, label: "載回入廠", hint: "確認載回、備用機換機" },
  { no: 4, label: "廠內報價", hint: "更新進度、開報價" },
  { no: 5, label: "送回結案", hint: "安排司機送回、確認送回後結案" },
] as const;

function workflowStepNo(status: string): number {
  switch (status) {
    case "reported":
    case "accepted":
      return 1;
    case "assess_assigned":
      return 2;
    case "pending_pickup":
    case "pending_loaner":
      return 3;
    case "in_workshop":
    case "quote_pending":
    case "quote_accepted":
    case "quote_rejected":
      return 4;
    case "onsite_completed":
    case "pending_return":
    case "returned":
      return 5;
    case "closed":
    case "cancelled":
      return 6;
    case "unable":
      // 舊資料或特殊流程：仍允許補登進廠內進度
      return 3;
    default:
      return 1;
  }
}

function panelState(stepNo: number, currentStep: number): "is-active" | "is-done" | "is-upcoming" {
  if (currentStep >= 6) return stepNo <= 5 ? "is-done" : "is-upcoming";
  if (stepNo < currentStep) return "is-done";
  if (stepNo === currentStep) return "is-active";
  return "is-upcoming";
}

export default function ServiceTicketsPage() {
  const { drivers, vehicles } = useDashboard();
  const [rows, setRows] = useState<ServiceTicketRow[]>([]);
  const [status, setStatus] = useState("reported");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [assessDate, setAssessDate] = useState(todayLocalYmd);
  const [returnDate, setReturnDate] = useState(todayLocalYmd);
  const [assessSlot, setAssessSlot] = useState("");
  const [onsiteFeeAmount, setOnsiteFeeAmount] = useState("");
  const [onsiteNote, setOnsiteNote] = useState("");
  const [onsiteAdminOutcome, setOnsiteAdminOutcome] = useState<"onsite_fixed" | "unable">("onsite_fixed");
  const [onsiteAdminAlreadyInWorkshop, setOnsiteAdminAlreadyInWorkshop] = useState(true);
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteDetail, setQuoteDetail] = useState("");
  const [workshopStatus, setWorkshopStatus] = useState("diagnosing");
  const [closeBilling, setCloseBilling] = useState<"cash" | "monthly">("cash");
  const [cashCollectedNow, setCashCollectedNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [ensuringBilling, setEnsuringBilling] = useState(false);

  const load = useCallback(async (opts?: { clearMsg?: boolean }) => {
    setLoading(true);
    if (opts?.clearMsg !== false) setMsg("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/service-tickets?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "載入失敗");
        setRows([]);
        return;
      }
      setRows(data.data ?? []);
    } catch {
      setMsg("載入時發生錯誤");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!driverId) return;
    const d = drivers.find((x) => String(x.id) === driverId);
    if (d?.vehicle?.id != null) setVehicleId(String(d.vehicle.id));
  }, [driverId, drivers]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const currentStep = selected ? workflowStepNo(selected.status) : 0;
  const isTerminal = currentStep >= 6;
  const hasQuote = Boolean(selected?.quoteAmount != null || selected?.quoteDetail || selected?.quoteStatus);
  const quoteLocked = selected?.status === "quote_accepted";
  const canEditQuote = Boolean(selected && ["in_workshop", "quote_pending", "quote_rejected"].includes(selected.status));

  useEffect(() => {
    if (!selected) return;
    // 第 5 步：若已有「送回」資訊，優先載入返程司機與日期
    if (selected.returnDriverId) setDriverId(selected.returnDriverId);
    else if (selected.assessDriverId) setDriverId(selected.assessDriverId);
    if (selected.quoteAmount != null) setQuoteAmount(String(selected.quoteAmount));
    else setQuoteAmount("");
    setQuoteDetail(selected.quoteDetail ?? "");
    if (selected.returnDate) setReturnDate(selected.returnDate);
    setWorkshopStatus(selected.workshopStatus ?? "diagnosing");
  }, [
    selected?.id,
    selected?.returnDriverId,
    selected?.assessDriverId,
    selected?.returnDate,
    selected?.quoteAmount,
    selected?.quoteDetail,
    selected?.workshopStatus,
  ]);

  const accept = async (ticketId: string) => {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${ticketId}/accept`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "受理失敗");
        return;
      }
      setMsg(`已受理 ${data.data?.ticketNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("受理時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const assignAssess = async () => {
    if (!selectedId) {
      setMsg("請先選擇服務單");
      return;
    }
    if (!driverId || !assessDate) {
      setMsg("請選擇司機與評估日期");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/assign-assess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          vehicleId: vehicleId || undefined,
          assessDateYmd: assessDate,
          assessSlot: assessSlot.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "派評估失敗");
        return;
      }
      setMsg(`已派評估：${data.data?.ticketNo ?? ""}`);
      setAssessSlot("");
      await load({ clearMsg: false });
    } catch {
      setMsg("派評估時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const adminOnsiteComplete = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/admin-onsite-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: onsiteAdminOutcome,
          alreadyInWorkshop: onsiteAdminOutcome === "unable" ? onsiteAdminAlreadyInWorkshop : undefined,
          feeAmount:
            onsiteAdminOutcome === "onsite_fixed" ? (onsiteFeeAmount === "" ? 0 : Number(onsiteFeeAmount)) : undefined,
          note: onsiteNote.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "補登現場結果失敗");
        return;
      }
      const ticketNo = data.data?.ticketNo ?? "";
      if (onsiteAdminOutcome === "onsite_fixed") setMsg(`已補登現場維修：${ticketNo}`);
      else if (onsiteAdminAlreadyInWorkshop) setMsg(`已補登載回廠內處理：${ticketNo}`);
      else setMsg(`已補登需載回廠內：${ticketNo}`);
      setOnsiteFeeAmount("");
      setOnsiteNote("");
      setOnsiteAdminOutcome("onsite_fixed");
      setOnsiteAdminAlreadyInWorkshop(true);
      await load({ clearMsg: false });
    } catch {
      setMsg("補登現場結果時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const markLoaner = async () => {
    if (!selectedId) {
      setMsg("請先選擇服務單");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const earlyStage = ["reported", "accepted"].includes(selected?.status ?? "");
      const res = await fetch(`/api/service-tickets/${selectedId}/mark-loaner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: earlyStage
            ? "後台補登：若需載回廠維修，請提供備用機"
            : "後台登記：客戶需要臨時機",
          swapDateYmd: earlyStage ? undefined : assessDate || undefined,
          driverId: earlyStage ? undefined : driverId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "標記臨時機失敗");
        return;
      }
      setMsg(earlyStage ? `已補登需備用機：${data.data?.ticketNo ?? ""}` : `已標記需臨時機：${data.data?.ticketNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("標記臨時機時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const confirmWorkshop = async () => {
    if (!selectedId) {
      setMsg("請先選擇服務單");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/confirm-workshop-received`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "已確認載回入廠" }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "確認入廠失敗");
        return;
      }
      setMsg(`已確認入廠：${data.data?.ticketNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("確認入廠時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const updateWorkshop = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/workshop-progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workshopStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "更新廠內進度失敗");
        return;
      }
      setMsg(`廠內進度已更新：${data.data?.ticketNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("更新廠內進度時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const sendQuote = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: quoteAmount, detail: quoteDetail.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "開報價失敗");
        return;
      }
      setMsg(`已送出報價：${data.data?.ticketNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("開報價時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const assignReturn = async () => {
    if (!selectedId || !driverId || !returnDate) {
      setMsg("派送回請選擇司機與日期");
      return;
    }
    const wasReturnAssigned = selected?.status === "pending_return" || Boolean(selected?.returnDriverId);
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/assign-return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          vehicleId: vehicleId || undefined,
          returnDateYmd: returnDate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "派送回失敗");
        return;
      }
      setMsg(
        wasReturnAssigned
          ? `已更新送回安排：${data.data?.ticketNo ?? ""}`
          : `已安排司機送回：${data.data?.ticketNo ?? ""}`,
      );
      await load({ clearMsg: false });
    } catch {
      setMsg("派送回時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const closeTicket = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingType: closeBilling,
          cashCollectedNow: closeBilling === "cash" ? cashCollectedNow : false,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "結案失敗");
        return;
      }
      const orderNo = data.data?.salesOrder?.orderNo;
      const cashHint =
        closeBilling === "cash"
          ? cashCollectedNow
            ? "，司機已帶回現金並沖帳"
            : "，僅立帳（客戶下次再收）"
          : "，月結待批次";
      setMsg(
        orderNo
          ? `已結案並入帳：${data.data?.ticketNo ?? ""}（訂單 ${orderNo}${cashHint}）`
          : `已結案：${data.data?.ticketNo ?? ""}`,
      );
      await load({ clearMsg: false });
    } catch {
      setMsg("結案時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const ensureBilling = async () => {
    if (!selectedId) return;
    setEnsuringBilling(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/ensure-billing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingType: selected?.billingType ?? closeBilling,
          chargeAmount: selected?.chargeAmount ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "補立帳失敗");
        return;
      }
      setMsg(`已補立帳：${data.data?.ticketNo ?? ""} → ${data.data?.salesOrder?.orderNo ?? ""}`);
      await load({ clearMsg: false });
    } catch {
      setMsg("補立帳時發生錯誤");
    } finally {
      setEnsuringBilling(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h2 className="page__title">飲水機服務單</h2>
        <p className="page__desc text-muted">客戶從 LINE 回報清洗／維修後，於列表選擇服務單，依流程步驟處理。</p>
      </header>

      <section className="card">
        <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
          <label className="field field--inline">
            <span>狀態</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_FILTERS.map((s) => (
                <option key={s.value || "all"} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--inline">
            <span>搜尋</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="單號／客戶／手機／問題"
            />
          </label>
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "載入中…" : "重新整理"}
          </button>
        </div>
        {msg ? <p className="form-msg">{msg}</p> : null}
      </section>

      <section className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>選</th>
                <th>單號</th>
                <th>客戶</th>
                <th>類型</th>
                <th>狀態</th>
                <th>地址</th>
                <th>問題</th>
                <th>備用機</th>
                <th>希望日</th>
                <th>評估安排</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-muted">
                    {loading ? "載入中…" : "無符合條件的服務單"}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className={selectedId === r.id ? "is-selected" : undefined}>
                    <td>
                      <input
                        type="radio"
                        name="svc-ticket"
                        checked={selectedId === r.id}
                        onChange={() => setSelectedId(r.id)}
                      />
                    </td>
                    <td>{r.ticketNo}</td>
                    <td>
                      <div>{r.customer?.name ?? "—"}</div>
                      <div className="text-muted" style={{ fontSize: "0.85em" }}>
                        {r.customer?.customerCode ?? ""} {r.customer?.mobile || r.customer?.phone || ""}
                      </div>
                    </td>
                    <td>{r.serviceTypeLabel ?? r.serviceType}</td>
                    <td>{r.statusLabel ?? r.status}</td>
                    <td>{r.deliveryAddress?.addressLine ?? "—"}</td>
                    <td style={{ maxWidth: 220 }}>{r.problemNote ?? "—"}</td>
                    <td>{r.needLoaner ? "是" : "—"}</td>
                    <td>
                      {r.preferredDate ?? "—"}
                      {r.preferredSlot ? ` ${r.preferredSlot}` : ""}
                    </td>
                    <td>
                      {r.assessDate
                        ? `${r.assessDate}${r.assessSlot ? ` ${r.assessSlot}` : ""}${r.assessDriver?.name ? `｜${r.assessDriver.name}` : ""}`
                        : "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setSelectedId(r.id);
                            setDetailOpen(true);
                          }}
                        >
                          詳情
                        </button>
                        {r.status === "reported" ? (
                          <button type="button" className="btn btn--secondary btn--sm" disabled={saving} onClick={() => void accept(r.id)}>
                            僅受理
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card svc-workspace-card">
        <h3 className="card__title">服務單處理</h3>
        <p className="card__hint">依下方流程操作：先在列表選擇服務單，再依目前步驟執行對應動作。</p>

        <div className="svc-flow" aria-label="維修服務流程">
          {WORKFLOW_STEPS.map((step, index) => {
            const state =
              !selected || isTerminal
                ? ""
                : step.no < currentStep
                  ? "is-done"
                  : step.no === currentStep
                    ? "is-active"
                    : "";
            return (
              <div key={step.no} className="svc-flow__group">
                {index > 0 ? <span className="svc-flow__arrow" aria-hidden>→</span> : null}
                <div className={`svc-flow__step ${state}`}>
                  <span className="svc-flow__no">{step.no}</span>
                  <span className="svc-flow__label">{step.label}</span>
                  <span className="svc-flow__hint">{step.hint}</span>
                </div>
              </div>
            );
          })}
        </div>

        {!selected ? (
          <p className="svc-workspace-empty text-muted">請先在上方列表選擇一筆服務單。</p>
        ) : (
          <>
            <div className="svc-selected">
              <div className="svc-selected__main">
                <strong>{selected.ticketNo}</strong>
                <span className="svc-selected__sep">｜</span>
                <span>{selected.customer?.name ?? "—"}</span>
                <span className="badge">{selected.statusLabel ?? selected.status}</span>
                <span className="text-muted">{selected.serviceTypeLabel ?? selected.serviceType}</span>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDetailOpen(true)}>
                  查看完整詳情
                </button>
              </div>
              <div className="svc-selected__meta text-muted">
                {selected.deliveryAddress?.addressLine ?? "—"}
                {selected.problemNote ? `｜${selected.problemNote}` : ""}
              </div>
              {selected.needLoaner ? (
                <div className="svc-alert svc-alert--warn">
                  <strong>需備用機</strong>
                  <span>
                    {selected.loanerNote ?? "客戶已登記：若評估後需載回廠維修，請司機攜帶備用機。"}
                  </span>
                </div>
              ) : null}
            </div>

            {msg ? <p className="form-msg svc-workspace-msg">{msg}</p> : null}

            <div className="svc-panels">
              <section className={`svc-panel ${panelState(1, currentStep)}`}>
                <header className="svc-panel__head">
                  <h4 className="svc-panel__title">① 受理與派評估</h4>
                  <p className="svc-panel__desc">可從「待受理」直接派評估（會一併受理）。</p>
                </header>
                <div className="form-grid form-grid--wide svc-panel__grid">
                  <label className="field">
                    <span>司機</span>
                    <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                      <option value="">請選擇</option>
                      {drivers
                        .filter((d) => d.isActive !== false)
                        .map((d) => (
                          <option key={String(d.id)} value={String(d.id)}>
                            {(d.user?.name ?? "司機") +
                              (d.user?.employeeCode || d.employeeCode
                                ? `（${d.user?.employeeCode || d.employeeCode}）`
                                : "")}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>車輛（可略）</span>
                    <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                      <option value="">不指定</option>
                      {vehicles.map((v) => (
                        <option key={String(v.id)} value={String(v.id)}>
                          {v.plateNo}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>評估日</span>
                    <input type="date" value={assessDate} onChange={(e) => setAssessDate(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>時段說明（可略）</span>
                    <input value={assessSlot} onChange={(e) => setAssessSlot(e.target.value)} placeholder="例如：上午" />
                  </label>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving || !["reported", "accepted", "assess_assigned"].includes(selected.status)}
                    onClick={() => void assignAssess()}
                  >
                    {saving ? "處理中…" : "確認派評估"}
                  </button>
                  {!selected.needLoaner ? (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={saving || !["reported", "accepted", "assess_assigned"].includes(selected.status)}
                      onClick={() => void markLoaner()}
                      title="若客戶未回報需備用機，可於派評估階段補登"
                    >
                      補登需備用機
                    </button>
                  ) : null}
                </div>
              </section>

              <section className={`svc-panel ${panelState(2, currentStep)}`}>
                <header className="svc-panel__head">
                  <h4 className="svc-panel__title">② 現場評估結果</h4>
                  <p className="svc-panel__desc">司機通常用手機回報；未使用手機時，依貨單備註在此補登現場維修。</p>
                </header>
                <div className="form-grid form-grid--wide svc-panel__grid">
                  <label className="field field--span2">
                    <span>現場結果</span>
                    <select value={onsiteAdminOutcome} onChange={(e) => setOnsiteAdminOutcome(e.target.value as "onsite_fixed" | "unable")}>
                      <option value="onsite_fixed">現場維修完成（可收費）</option>
                      <option value="unable">無法處理，載回廠內</option>
                    </select>
                  </label>

                  {onsiteAdminOutcome === "onsite_fixed" ? (
                    <label className="field">
                      <span>現場維修費用</span>
                      <input
                        type="number"
                        min={0}
                        step="1"
                        value={onsiteFeeAmount}
                        onChange={(e) => setOnsiteFeeAmount(e.target.value)}
                        placeholder="例如 800"
                      />
                    </label>
                  ) : null}

                  <label className={`field ${onsiteAdminOutcome === "onsite_fixed" ? "field--span2" : ""}`}>
                    <span>現場備註</span>
                    <input
                      value={onsiteNote}
                      onChange={(e) => setOnsiteNote(e.target.value)}
                      placeholder="貼上貨單備註：原因／處置…"
                    />
                  </label>
                </div>

                {onsiteAdminOutcome === "unable" ? (
                  <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: "0.25rem" }}>
                    <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={onsiteAdminAlreadyInWorkshop}
                        onChange={(e) => setOnsiteAdminAlreadyInWorkshop(e.target.checked)}
                      />
                      司機已直接載回廠內（可直接進入廠內進度/報價）
                    </label>
                  </div>
                ) : null}

                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving || !["assess_assigned", "accepted"].includes(selected.status)}
                    onClick={() => void adminOnsiteComplete()}
                  >
                    {onsiteAdminOutcome === "onsite_fixed"
                      ? "現場維修補登"
                      : onsiteAdminAlreadyInWorkshop
                        ? "補登載回廠內"
                        : "補登需載回廠內"}
                  </button>
                </div>
              </section>

              <section className={`svc-panel ${panelState(3, currentStep)}`}>
                <header className="svc-panel__head">
                  <h4 className="svc-panel__title">③ 載回與入廠</h4>
                  <p className="svc-panel__desc">評估結果為需載回時：先確認換機／載回，再登記已入廠。</p>
                </header>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving || !["pending_pickup", "pending_loaner", "unable"].includes(selected.status)}
                    onClick={() => void confirmWorkshop()}
                  >
                    確認已載回入廠
                  </button>
                </div>
              </section>

              <section className={`svc-panel ${panelState(4, currentStep)}`}>
                <header className="svc-panel__head">
                  <h4 className="svc-panel__title">④ 廠內進度與報價</h4>
                  <p className="svc-panel__desc">僅後台可更新廠內進度；完工後開報價供客戶 LINE 回覆。</p>
                </header>
                {hasQuote ? (
                  <div className="svc-alert" style={{ marginBottom: "0.75rem" }}>
                    <strong>
                      {selected?.quoteStatus === "accepted"
                        ? "客戶已同意報價"
                        : selected?.quoteStatus === "rejected"
                          ? "客戶已拒絕前次報價"
                          : "目前報價"}
                    </strong>
                    <span>
                      金額：{selected?.quoteAmount ?? "—"}
                      {selected?.quoteDetail ? `｜${selected.quoteDetail}` : ""}
                    </span>
                  </div>
                ) : null}
                <div className="form-grid form-grid--wide svc-panel__grid">
                  <label className="field">
                    <span>廠內進度</span>
                    <select value={workshopStatus} onChange={(e) => setWorkshopStatus(e.target.value)}>
                      <option value="received">已入廠</option>
                      <option value="diagnosing">診斷中</option>
                      <option value="in_progress">清洗／維修中</option>
                      <option value="done_pending_return">已完工待送回</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>報價金額</span>
                    <input value={quoteAmount} onChange={(e) => setQuoteAmount(e.target.value)} placeholder="例如 1200" />
                  </label>
                  <label className="field field--span2">
                    <span>報價說明</span>
                    <input value={quoteDetail} onChange={(e) => setQuoteDetail(e.target.value)} placeholder="零件／工資…" />
                  </label>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={saving || !["in_workshop", "quote_pending", "quote_accepted", "quote_rejected"].includes(selected.status)}
                    onClick={() => void updateWorkshop()}
                  >
                    更新廠內進度
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving || !canEditQuote || quoteLocked}
                    onClick={() => void sendQuote()}
                  >
                    {quoteLocked ? "客戶已同意報價" : hasQuote ? "重新報價" : "送出報價"}
                  </button>
                </div>
              </section>

              <section className={`svc-panel ${panelState(5, currentStep)}`}>
                <header className="svc-panel__head">
                  <h4 className="svc-panel__title">⑤ 送回與結案</h4>
                  <p className="svc-panel__desc">報價同意或現場已完工後，派司機送回並選擇現金／月結結案。</p>
                </header>
                {(selected.status === "pending_return" || selected.returnDriverId) && (
                  <div className="svc-alert svc-alert--info">
                    <strong>已安排送回</strong>
                    <span>
                      {selected.returnDriver?.name ?? "司機"}
                      {selected.returnDriver?.employeeCode ? `（${selected.returnDriver.employeeCode}）` : ""}
                      {selected.returnDate ? `｜${selected.returnDate}` : ""}
                      {selected.status === "pending_return" ? "，等司機送回後再結案" : ""}
                    </span>
                  </div>
                )}
                <div className="form-grid form-grid--wide svc-panel__grid">
                  <label className="field">
                    <span>送回司機</span>
                    <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                      <option value="">請選擇</option>
                      {drivers
                        .filter((d) => d.isActive !== false)
                        .map((d) => (
                          <option key={String(d.id)} value={String(d.id)}>
                            {(d.user?.name ?? "司機") +
                              (d.user?.employeeCode || d.employeeCode ? `（${d.user?.employeeCode || d.employeeCode}）` : "")}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>送回車輛（可略）</span>
                    <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                      <option value="">不指定</option>
                      {vehicles.map((v) => (
                        <option key={String(v.id)} value={String(v.id)}>
                          {v.plateNo}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>送回日</span>
                    <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>結案帳務</span>
                    <select value={closeBilling} onChange={(e) => setCloseBilling(e.target.value as "cash" | "monthly")}>
                      <option value="cash">現金</option>
                      <option value="monthly">月結</option>
                    </select>
                  </label>
                  {closeBilling === "cash" ? (
                    <label className="field field--span2">
                      <span>現金是否當場收回</span>
                      <select
                        value={cashCollectedNow ? "now" : "later"}
                        onChange={(e) => setCashCollectedNow(e.target.value === "now")}
                      >
                        <option value="later">客戶說下次再收（僅立 AR，司機日核對顯示應收未收）</option>
                        <option value="now">司機已帶回現金（當場沖帳，列入該司機當日回報）</option>
                      </select>
                    </label>
                  ) : null}
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={saving || !["quote_accepted", "in_workshop", "pending_return"].includes(selected.status)}
                    onClick={() => void assignReturn()}
                  >
                    {selected.status === "pending_return" || selected.returnDriverId
                      ? "更新送回安排"
                      : "安排司機送回"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={
                      saving ||
                      !["onsite_completed", "pending_return", "returned"].includes(selected.status)
                    }
                    onClick={() => void closeTicket()}
                  >
                    {selected.status === "pending_return" ? "確認已送回並結案" : "確認送回後結案"}
                  </button>
                </div>
              </section>
            </div>
          </>
        )}
      </section>

      {detailOpen && selected ? (
        <ServiceTicketDetailModal
          ticket={selected}
          onClose={() => setDetailOpen(false)}
          ensuringBilling={ensuringBilling}
          onEnsureBilling={() => void ensureBilling()}
        />
      ) : null}
    </div>
  );
}
