import { useCallback, useEffect, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { todayLocalYmd } from "../adminUtils";

type ServiceTicketRow = {
  id: string;
  ticketNo: string;
  serviceType: string;
  serviceTypeLabel?: string;
  status: string;
  statusLabel?: string;
  preferredDate?: string | null;
  preferredSlot?: string | null;
  problemNote?: string | null;
  createdAt?: string;
  assessDate?: string | null;
  assessSlot?: string | null;
  customer?: {
    id: string;
    customerCode?: string | null;
    name: string;
    mobile?: string | null;
    phone?: string | null;
  } | null;
  deliveryAddress?: { addressLine: string; label?: string | null } | null;
  assessDriver?: { id: string; name?: string | null; employeeCode?: string | null } | null;
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "reported", label: "待受理" },
  { value: "accepted", label: "已受理" },
  { value: "assess_assigned", label: "已派評估" },
  { value: "pending_pickup", label: "待載回" },
  { value: "pending_loaner", label: "待換臨時機" },
  { value: "in_workshop", label: "廠內處理" },
  { value: "onsite_completed", label: "現場已完工" },
];

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
  const [assessSlot, setAssessSlot] = useState("");
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteDetail, setQuoteDetail] = useState("");
  const [workshopStatus, setWorkshopStatus] = useState("diagnosing");
  const [closeBilling, setCloseBilling] = useState<"cash" | "monthly">("cash");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
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
      await load();
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
      await load();
    } catch {
      setMsg("派評估時發生錯誤");
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
      const res = await fetch(`/api/service-tickets/${selectedId}/mark-loaner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: "後台登記：客戶需要臨時機",
          swapDateYmd: assessDate || undefined,
          driverId: driverId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "標記臨時機失敗");
        return;
      }
      setMsg(`已標記需臨時機：${data.data?.ticketNo ?? ""}`);
      await load();
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
      await load();
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
      await load();
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
      await load();
    } catch {
      setMsg("開報價時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  const assignReturn = async () => {
    if (!selectedId || !driverId || !assessDate) {
      setMsg("派送回請選擇司機與日期");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`/api/service-tickets/${selectedId}/assign-return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          vehicleId: vehicleId || undefined,
          returnDateYmd: assessDate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "派送回失敗");
        return;
      }
      setMsg(`已派送回：${data.data?.ticketNo ?? ""}`);
      await load();
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
        body: JSON.stringify({ billingType: closeBilling }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "結案失敗");
        return;
      }
      setMsg(`已結案：${data.data?.ticketNo ?? ""}`);
      await load();
    } catch {
      setMsg("結案時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h2 className="page__title">飲水機服務單</h2>
        <p className="page__desc text-muted">客戶從 LINE 回報清洗／維修後，於此受理並派司機到場評估。</p>
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
        <h3 className="card__title">派評估</h3>
        <p className="text-muted" style={{ marginTop: 0 }}>
          先在下方列表點選服務單，再指定司機與日期。可從「待受理」直接派評估（會一併受理）。
        </p>
        <div className="form-grid">
          <label className="field">
            <span>已選服務單</span>
            <input readOnly value={selected ? `${selected.ticketNo}｜${selected.customer?.name ?? ""}` : "尚未選擇"} />
          </label>
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
        <div className="toolbar" style={{ marginTop: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <button type="button" className="btn btn--primary" disabled={saving || !selectedId} onClick={() => void assignAssess()}>
            {saving ? "處理中…" : "確認派評估"}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={saving || !selectedId || !["pending_pickup", "pending_loaner", "assess_assigned"].includes(selected?.status ?? "")}
            onClick={() => void markLoaner()}
          >
            標記需臨時機
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={saving || !selectedId || !["pending_pickup", "pending_loaner"].includes(selected?.status ?? "")}
            onClick={() => void confirmWorkshop()}
          >
            確認已載回入廠
          </button>
        </div>
        <div className="form-grid" style={{ marginTop: "1rem" }}>
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
          <label className="field">
            <span>報價說明</span>
            <input value={quoteDetail} onChange={(e) => setQuoteDetail(e.target.value)} placeholder="零件／工資…" />
          </label>
          <label className="field">
            <span>結案帳務</span>
            <select value={closeBilling} onChange={(e) => setCloseBilling(e.target.value as "cash" | "monthly")}>
              <option value="cash">現金</option>
              <option value="monthly">月結</option>
            </select>
          </label>
        </div>
        <div className="toolbar" style={{ marginTop: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <button type="button" className="btn btn--secondary" disabled={saving || !selectedId} onClick={() => void updateWorkshop()}>
            更新廠內進度
          </button>
          <button type="button" className="btn btn--secondary" disabled={saving || !selectedId} onClick={() => void sendQuote()}>
            送出報價
          </button>
          <button type="button" className="btn btn--secondary" disabled={saving || !selectedId} onClick={() => void assignReturn()}>
            派送回
          </button>
          <button type="button" className="btn btn--primary" disabled={saving || !selectedId} onClick={() => void closeTicket()}>
            結案入帳
          </button>
        </div>
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
                <th>希望日</th>
                <th>評估安排</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted">
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
                      {r.status === "reported" ? (
                        <button type="button" className="btn btn--secondary btn--sm" disabled={saving} onClick={() => void accept(r.id)}>
                          僅受理
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
