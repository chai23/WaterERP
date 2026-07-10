import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboard } from "../DashboardContext";
import { formatDeliveryFloor } from "../floorBonusUtils";

type BonusRow = {
  id: string;
  orderNo: string;
  deliveryDate: string;
  productName: string;
  qty: number;
  floor: number;
  driver?: { user?: { employeeCode?: string; name?: string } };
};

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function FloorDeliveryBonusQueryPage() {
  const { drivers } = useDashboard();
  const [rows, setRows] = useState<BonusRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [driverId, setDriverId] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (driverId) params.set("driverId", driverId);
      if (q.trim()) params.set("q", q.trim());
      const r = await fetch(`/api/floor-delivery-bonuses?${params.toString()}`);
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
  }, [dateFrom, dateTo, driverId, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const driverSummary = useMemo(() => {
    const map = new Map<string, { label: string; qty: number }>();
    for (const row of rows) {
      const key = String(row.driver?.user?.employeeCode ?? row.driver?.user?.name ?? "未知");
      const label = [row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "未知";
      const hit = map.get(key) ?? { label, qty: 0 };
      hit.qty += row.qty;
      map.set(key, hit);
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [rows]);

  const totalQty = useMemo(() => rows.reduce((sum, row) => sum + row.qty, 0), [rows]);

  const exportCsv = () => {
    const headers = ["配送日", "訂單編號", "司機員編", "司機姓名", "商品", "上樓桶數", "樓層"];
    const lines = rows.map((row) => [
      fmtDate(row.deliveryDate),
      row.orderNo,
      row.driver?.user?.employeeCode ?? "",
      row.driver?.user?.name ?? "",
      row.productName,
      row.qty,
      formatDeliveryFloor(row.floor),
    ]);
    const bom = "\uFEFF";
    const body = [headers, ...lines].map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([bom + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `floor-delivery-bonus-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="card">
        <h2 className="card__title">搬運獎金查詢</h2>
        <p className="card__hint">
          記錄辦公室核銷時填寫的「預付扣桶」商品上樓搬運（二樓以上或地下樓）。日期為<strong>實際配送日</strong>（分派配送日）。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">
          紀錄清單 <span className="card__title-count">{loading ? "…" : `${rows.length} 筆 · 合計 ${totalQty} 桶`}</span>
        </h2>
        <div className="toolbar toolbar--filters" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" }}>
          <div className="field field--sm">
            <span>配送日起</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="field field--sm">
            <span>配送日迄</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div className="field field--sm">
            <span>司機</span>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">全部</option>
              {drivers.map((d) => (
                <option key={String(d.id)} value={String(d.id)}>
                  {[d.user?.employeeCode, d.user?.name].filter(Boolean).join(" / ")}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: "1 1 12rem" }}>
            <span>關鍵字</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、商品、司機" />
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? "載入中…" : "重新載入"}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={!rows.length}>
            匯出 CSV
          </button>
        </div>

        {driverSummary.length > 0 ? (
          <div className="card__hint" style={{ marginTop: "0.75rem" }}>
            <strong>司機合計（篩選結果）：</strong>
            {driverSummary.map((item) => (
              <span key={item.label} style={{ marginRight: "0.75rem" }}>
                {item.label} {item.qty} 桶
              </span>
            ))}
          </div>
        ) : null}

        {err ? <div className="alert alert--error" style={{ marginTop: "0.75rem" }}>{err}</div> : null}

        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>配送日</th>
                <th>訂單編號</th>
                <th>司機</th>
                <th>商品</th>
                <th className="num">上樓桶數</th>
                <th>樓層</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.id)}>
                  <td>{fmtDate(row.deliveryDate)}</td>
                  <td>{row.orderNo}</td>
                  <td>{[row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "—"}</td>
                  <td>{row.productName}</td>
                  <td className="num">{row.qty}</td>
                  <td>{formatDeliveryFloor(row.floor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 ? <p className="card__hint">沒有符合條件的紀錄。</p> : null}
      </section>
    </>
  );
}
