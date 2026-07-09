import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  customer?: { id?: string; name?: string; customerCode?: string | null };
  deliveryAddress?: { id?: string; label?: string | null; addressLine?: string; barrelsOnSite?: number };
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

function fmtDateOnly(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function BarrelPickupQueryPage() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<PickupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "");
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [dateFrom, setDateFrom] = useState(() => searchParams.get("dateFrom") ?? "");
  const [dateTo, setDateTo] = useState(() => searchParams.get("dateTo") ?? "");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const r = await fetch(`/api/barrel-pickups?${params.toString()}`);
      const data = await r.json();
      if (!r.ok) {
        setErr(typeof data?.message === "string" ? data.message : "讀取失敗");
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setErr("讀取失敗");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, q, dateFrom, dateTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.returned += Math.max(0, Number(row.barrelsReturned ?? 0));
        if (row.status === "completed") acc.completed += 1;
        if (row.status === "pending_settlement") acc.pending += 1;
        return acc;
      },
      { returned: 0, completed: 0, pending: 0 },
    );
  }, [rows]);

  const quickThisMonth = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    setDateFrom(`${yyyy}-${mm}-01`);
    setDateTo(todayLocalYmd());
  };

  const exportCsv = () => {
    const header = [
      "狀態",
      "收桶日",
      "單號",
      "客戶編號",
      "客戶",
      "送貨點",
      "司機",
      "車輛",
      "預估桶數",
      "回報桶數",
      "司機回報時間",
      "辦公室核銷時間",
      "備註",
    ];
    const lines = rows.map((row) => [
      barrelPickupStatusLabel(row.status),
      fmtDateOnly(row.pickupDate),
      row.pickupNo ?? "",
      row.customer?.customerCode ?? "",
      row.customer?.name ?? "",
      `${row.deliveryAddress?.label ? `${row.deliveryAddress.label} · ` : ""}${row.deliveryAddress?.addressLine ?? ""}`,
      `${row.driver?.user?.employeeCode ? `${row.driver.user.employeeCode} / ` : ""}${row.driver?.user?.name ?? ""}`,
      row.vehicle?.plateNo ?? "",
      row.barrelsExpected ?? "",
      row.barrelsReturned ?? "",
      fmtDt(row.driverReportedAt),
      fmtDt(row.officeSettledAt),
      row.driverNote || row.remark || "",
    ]);
    const csv = [header, ...lines].map((line) => line.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `barrel-pickups-${todayLocalYmd()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">查詢收空桶</h2>
        <p className="page__desc text-muted">查詢純收空桶任務歷史，可依狀態、日期區間、單號、客戶或司機搜尋。</p>
      </header>

      <section className="card">
        <div className="card__body">
          <div className="field-row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "flex-end" }}>
            <div className="field">
              <span>狀態</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value || "all"} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span>收桶日（起）</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="field">
              <span>收桶日（迄）</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div className="field" style={{ flex: "1 1 14rem" }}>
              <span>關鍵字</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、客戶、地址、司機" />
            </div>
            <button type="button" className="btn btn--secondary btn--sm" onClick={quickThisMonth}>
              本月
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? "查詢中…" : "查詢"}
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={rows.length === 0}>
              匯出 CSV
            </button>
          </div>

          <div className="card__hint" style={{ marginTop: "0.75rem" }}>
            共 {rows.length} 筆；已核銷 {totals.completed} 筆、待核銷 {totals.pending} 筆；回收桶數合計 {totals.returned} 桶。
          </div>
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
                  <th>司機</th>
                  <th>車輛</th>
                  <th className="num">預估</th>
                  <th className="num">實收</th>
                  <th>司機回報</th>
                  <th>辦公室核銷</th>
                  <th>備註</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <span className={barrelPickupStatusBadgeClass(row.status)}>{barrelPickupStatusLabel(row.status)}</span>
                    </td>
                    <td className="cell-nowrap">{fmtDateOnly(row.pickupDate)}</td>
                    <td><code style={{ fontSize: "0.8em" }}>{row.pickupNo ?? "—"}</code></td>
                    <td>
                      <span className="mono-text">{row.customer?.customerCode ?? "------"}</span>
                      {" · "}
                      {row.customer?.name ?? "—"}
                    </td>
                    <td>
                      {row.deliveryAddress?.label ? `${row.deliveryAddress.label} · ` : ""}
                      {row.deliveryAddress?.addressLine ?? "—"}
                    </td>
                    <td>
                      {row.driver?.user?.employeeCode ? `${row.driver.user.employeeCode} / ` : ""}
                      {row.driver?.user?.name ?? "—"}
                    </td>
                    <td>{row.vehicle?.plateNo ?? "—"}</td>
                    <td className="num">{row.barrelsExpected ?? "—"}</td>
                    <td className="num">{row.barrelsReturned ?? "—"}</td>
                    <td className="cell-nowrap">{fmtDt(row.driverReportedAt)}</td>
                    <td className="cell-nowrap">{fmtDt(row.officeSettledAt)}</td>
                    <td>{row.driverNote || row.remark || "—"}</td>
                  </tr>
                ))}
                {!loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="text-muted">無符合條件的收空桶紀錄</td>
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
