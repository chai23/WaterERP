import { useCallback, useEffect, useMemo, useState } from "react";
import { barrelPickupStatusBadgeClass, barrelPickupStatusLabel, todayLocalYmd } from "../adminUtils";

type PickupRow = {
  id: string;
  pickupNo?: string;
  status: string;
  pickupDate?: string;
  barrelsExpected?: number | null;
  barrelsReturned?: number | null;
  driverNote?: string | null;
  remark?: string | null;
  driverReportedAt?: string | null;
  officeSettledAt?: string | null;
  customer?: { name?: string; customerCode?: string | null };
  deliveryAddress?: { label?: string | null; addressLine?: string; barrelsOnSite?: number };
  driver?: { user?: { employeeCode?: string; name?: string } };
  vehicle?: { plateNo?: string };
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部狀態" },
  { value: "assigned", label: "已分派" },
  { value: "pending_settlement", label: "待辦公室核銷" },
  { value: "completed", label: "已核銷結案" },
  { value: "cancelled", label: "已取消" },
];

function fmtDt(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 19).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateOnly(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

export default function BarrelPickupSettlePage() {
  const [rows, setRows] = useState<PickupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filterStatus, setFilterStatus] = useState("pending_settlement");
  const [q, setQ] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveMsg, setApproveMsg] = useState("");
  const [officeSettledAtLocal, setOfficeSettledAtLocal] = useState(() => toDatetimeLocalValue(new Date()));
  const [driverReportDate, setDriverReportDate] = useState(todayLocalYmd);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<{ id: string; user?: { employeeCode?: string; name?: string } }[]>([]);
  const [vehicles, setVehicles] = useState<{ id: string; plateNo: string }[]>([]);
  const [editDriverId, setEditDriverId] = useState<Record<string, string>>({});
  const [editVehicleId, setEditVehicleId] = useState<Record<string, string>>({});
  const [editBarrelsReturned, setEditBarrelsReturned] = useState<Record<string, number>>({});
  const [editDriverNote, setEditDriverNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/barrel-pickups");
      const data = await r.json();
      if (!r.ok) {
        setErr(typeof data?.message === "string" ? data.message : "讀取失敗");
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
      setEditBarrelsReturned({});
      setEditDriverNote({});
    } catch {
      setErr("讀取失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void fetch("/api/drivers")
      .then((r) => r.json())
      .then((d) => setDrivers(Array.isArray(d) ? d : []));
    void fetch("/api/vehicles")
      .then((r) => r.json())
      .then((d) => setVehicles(Array.isArray(d) ? d : []));
  }, [load]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((row) => {
      if (filterStatus && row.status !== filterStatus) return false;
      if (!qq) return true;
      const hay = [
        row.pickupNo,
        row.customer?.name,
        row.customer?.customerCode,
        row.deliveryAddress?.addressLine,
        row.driver?.user?.employeeCode,
        row.driver?.user?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(qq);
    });
  }, [rows, filterStatus, q]);

  const approve = async (pickupId: string) => {
    setApproveMsg("");
    setApprovingId(pickupId);
    try {
      const res = await fetch(`/api/barrel-pickups/${pickupId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ officeSettledAt: new Date(officeSettledAtLocal).toISOString() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setApproveMsg(data.message ?? "核銷失敗");
        return;
      }
      setApproveMsg(`已確認核銷：${data.data?.pickupNo ?? pickupId}`);
      await load();
    } catch {
      setApproveMsg("核銷時發生錯誤");
    } finally {
      setApprovingId(null);
    }
  };

  const cancelPickup = async (pickupId: string) => {
    if (!window.confirm("確定取消此收空桶任務？")) return;
    const res = await fetch(`/api/barrel-pickups/${pickupId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setApproveMsg(data.message ?? "取消失敗");
      return;
    }
    setApproveMsg("已取消任務");
    await load();
  };

  const reassign = async (pickupId: string) => {
    const driverId = editDriverId[pickupId];
    if (!driverId) {
      setApproveMsg("請選擇司機");
      return;
    }
    const res = await fetch(`/api/barrel-pickups/${pickupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driverId,
        vehicleId: editVehicleId[pickupId] || null,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setApproveMsg(data.message ?? "改派失敗");
      return;
    }
    setApproveMsg(`已改派：${data.data?.pickupNo ?? pickupId}`);
    await load();
  };

  const reportPickup = async (pickupId: string) => {
    const pickup = rows.find((r) => String(r.id) === pickupId);
    if (!pickup) return;

    const onSite = pickup.deliveryAddress?.barrelsOnSite ?? 0;
    const barrelsInput = editBarrelsReturned[pickupId] ?? (pickup.barrelsReturned ?? 0);
    const barrelsReturned = Math.max(0, Math.floor(Number(barrelsInput) || 0));
    const note = String(editDriverNote[pickupId] ?? pickup.driverNote ?? pickup.remark ?? "").trim();

    // 回報階段允許超過在場；核銷會拒絕。這裡只做輸入格式化。
    setApproveMsg("");
    setReportingId(pickupId);
    try {
      const res = await fetch(`/api/driver/barrel-pickups/${pickupId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barrelsReturned,
          note,
          reportedAtYmd: driverReportDate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setApproveMsg(data.message ?? "代登回報失敗");
        return;
      }
      setApproveMsg(`已${pickup.status === "assigned" ? "代登回報" : "更新回報"}：${data.data?.pickupNo ?? pickup.pickupNo ?? pickupId}${barrelsReturned > onSite ? "（注意：可能超過在場，核銷會被拒絕）" : ""}`);
      await load();
    } catch {
      setApproveMsg("代登回報時發生錯誤");
    } finally {
      setReportingId(null);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">核銷收空桶</h2>
        <p className="page__desc text-muted">
          司機回報或辦公室代登回報後為「待辦公室核銷」。確認後減少送貨點在場空桶；若回報桶數超過在場空桶數將拒絕核銷。
        </p>
      </header>

      <section className="card">
        <div className="card__body">
          <div className="field-row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "flex-end" }}>
            <div className="field">
              <span>狀態</span>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value || "all"} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: "1 1 12rem" }}>
              <span>關鍵字</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、客戶、司機" />
            </div>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? "載入中…" : "重新載入"}
            </button>
            <div className="field field--md">
              <span>辦公室核銷時間</span>
              <input type="datetime-local" value={officeSettledAtLocal} onChange={(e) => setOfficeSettledAtLocal(e.target.value)} />
            </div>
            <div className="field field--md">
              <span>司機回報日期</span>
              <input type="date" value={driverReportDate} onChange={(e) => setDriverReportDate(e.target.value)} />
            </div>
          </div>

          {approveMsg ? (
            <div
              className={approveMsg.includes("已確認") || approveMsg.includes("已改派") || approveMsg.includes("已取消") ? "feedback feedback--ok" : "feedback feedback--err"}
              style={{ marginTop: "0.75rem" }}
            >
              {approveMsg}
            </div>
          ) : null}
          {err ? <div className="alert alert--error" style={{ marginTop: "0.75rem" }}>{err}</div> : null}

          <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>狀態</th>
                  <th>收桶日</th>
                  <th>單號</th>
                  <th>客戶</th>
                  <th>送貨點</th>
                  <th className="num">在場桶</th>
                  <th>司機</th>
                  <th className="num">回報桶數</th>
                  <th>司機回報時間</th>
                  <th>辦公室核銷時間</th>
                  <th>備註</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const onSite = row.deliveryAddress?.barrelsOnSite ?? 0;
                  const returned = row.barrelsReturned ?? 0;
                  const over = row.status === "pending_settlement" && returned > onSite;
                  const canReassign = row.status === "assigned" && row.driverReportedAt == null && row.barrelsReturned == null;
                  return (
                    <tr key={String(row.id)}>
                      <td>
                        <span className={barrelPickupStatusBadgeClass(row.status)}>{barrelPickupStatusLabel(row.status)}</span>
                      </td>
                      <td className="cell-nowrap">{fmtDateOnly(row.pickupDate)}</td>
                      <td><code style={{ fontSize: "0.8em" }}>{row.pickupNo ?? "—"}</code></td>
                      <td>{row.customer?.name ?? "—"}</td>
                      <td>
                        {row.deliveryAddress?.label ? `${row.deliveryAddress.label} · ` : ""}
                        {row.deliveryAddress?.addressLine ?? "—"}
                      </td>
                      <td className="num">{onSite}</td>
                      <td>
                        {row.driver?.user?.employeeCode ? `${row.driver.user.employeeCode} / ` : ""}
                        {row.driver?.user?.name ?? "—"}
                      </td>
                      <td className="num">
                        {row.status === "assigned" || row.status === "pending_settlement" ? (
                          (() => {
                            const id = String(row.id);
                            const current =
                              editBarrelsReturned[id] ??
                              (row.barrelsReturned != null ? row.barrelsReturned : 0);
                            const overPreview = current > onSite;
                            return (
                              <>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={current}
                                  onChange={(e) =>
                                    setEditBarrelsReturned((p) => ({
                                      ...p,
                                      [id]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                                    }))
                                  }
                                  style={{ width: "5.5rem" }}
                                  aria-label="回報桶數"
                                />
                                {overPreview ? (
                                  <span className="text-danger" style={{ display: "block", fontSize: "0.75rem" }}>
                                    超過在場
                                  </span>
                                ) : null}
                              </>
                            );
                          })()
                        ) : (
                          <>
                            {row.barrelsReturned != null ? returned : "—"}
                            {over ? <span className="text-danger" style={{ display: "block", fontSize: "0.75rem" }}>超過在場</span> : null}
                          </>
                        )}
                      </td>
                      <td className="cell-nowrap">{fmtDt(row.driverReportedAt)}</td>
                      <td className="cell-nowrap">{fmtDt(row.officeSettledAt)}</td>
                      <td>
                        {row.status === "assigned" || row.status === "pending_settlement" ? (
                          (() => {
                            const id = String(row.id);
                            const current = editDriverNote[id] ?? row.driverNote ?? row.remark ?? "";
                            return (
                              <input
                                type="text"
                                value={current}
                                onChange={(e) => setEditDriverNote((p) => ({ ...p, [id]: e.target.value }))}
                                placeholder="備註（選填）"
                                style={{ width: "100%", maxWidth: "18rem" }}
                                aria-label="回報備註"
                              />
                            );
                          })()
                        ) : (
                          row.driverNote || row.remark || "—"
                        )}
                      </td>
                      <td>
                        {row.status === "assigned" || row.status === "pending_settlement" ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={reportingId === String(row.id) || approvingId === String(row.id)}
                            onClick={() => void reportPickup(String(row.id))}
                            title={over ? "超過在場，核銷會被拒絕" : undefined}
                          >
                            {reportingId === String(row.id)
                              ? "處理中…"
                              : row.status === "assigned"
                                ? "代登回報"
                                : "更新回報"}
                          </button>
                        ) : null}
                        {row.status === "pending_settlement" ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={approvingId === String(row.id) || over}
                            onClick={() => void approve(String(row.id))}
                            title={over ? "回報桶數超過在場空桶，無法核銷" : undefined}
                          >
                            {approvingId === String(row.id) ? "處理中…" : "確認核銷"}
                          </button>
                        ) : null}
                        {canReassign ? (
                          <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                            <select
                              value={editDriverId[String(row.id)] ?? ""}
                              onChange={(e) => setEditDriverId((p) => ({ ...p, [String(row.id)]: e.target.value }))}
                              style={{ fontSize: "0.8rem" }}
                            >
                              <option value="">改派司機…</option>
                              {drivers.map((d) => (
                                <option key={String(d.id)} value={String(d.id)}>
                                  {d.user?.employeeCode} / {d.user?.name}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editVehicleId[String(row.id)] ?? ""}
                              onChange={(e) => setEditVehicleId((p) => ({ ...p, [String(row.id)]: e.target.value }))}
                              style={{ fontSize: "0.8rem" }}
                            >
                              <option value="">車輛（選填）</option>
                              {vehicles.map((v) => (
                                <option key={String(v.id)} value={String(v.id)}>
                                  {v.plateNo}
                                </option>
                              ))}
                            </select>
                            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void reassign(String(row.id))}>
                              改派
                            </button>
                          </div>
                        ) : null}
                        {row.status === "assigned" || row.status === "pending_settlement" ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ marginTop: "0.35rem" }}
                            onClick={() => void cancelPickup(String(row.id))}
                          >
                            取消
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!loading && filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="text-muted">無符合條件的收空桶任務</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
