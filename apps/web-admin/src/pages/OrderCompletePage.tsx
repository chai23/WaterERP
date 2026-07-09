import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  settlementBadgeClass,
  settlementOutcomeLabel,
} from "../adminUtils";

type SettlementRow = {
  id: string;
  status: string;
  completedAt?: string | null;
  driverReportedAt?: string | null;
  officeSettledAt?: string | null;
  settlementOutcome?: string | null;
  failureReason?: string | null;
  expectedAmount?: unknown;
  cashVariance?: unknown;
  cashReceived?: unknown;
  emptyBarrelsReturned?: number;
  settlementNote?: string | null;
  salesOrder?: { orderNo?: string; customer?: { name?: string }; totalAmount?: unknown; cashSubtotal?: unknown };
  driver?: { user?: { employeeCode?: string; name?: string } };
  vehicle?: { plateNo?: string };
};

const PIPELINE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部流程" },
  { value: "pending_settlement", label: "待辦公室核銷" },
  { value: "settled", label: "已核銷結案" },
];

const OUTCOME_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部結果" },
  { value: "not_delivered", label: "未送達" },
  { value: "delivered_cash_exact", label: "已送達·足額" },
  { value: "delivered_cash_short", label: "已送達·少收" },
  { value: "delivered_cash_over", label: "已送達·多收" },
  { value: "delivered_no_cash", label: "已送達·未收款" },
  { value: "legacy", label: "舊資料（無分類）" },
];

function fmtDt(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 19).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 供 datetime-local 使用（本地時間） */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function OrderCompletePage() {
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filterPipeline, setFilterPipeline] = useState("");
  const [filterOutcome, setFilterOutcome] = useState("");
  const [q, setQ] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveMsg, setApproveMsg] = useState("");
  /** 辦公室核銷入帳時間（可改為測試日／補登） */
  const [officeSettledAtLocal, setOfficeSettledAtLocal] = useState(() => toDatetimeLocalValue(new Date()));

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/settlements");
      const data = await r.json();
      if (!r.ok) {
        setErr(typeof data?.message === "string" ? data.message : "讀取失敗");
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setErr("無法載入核銷紀錄，請確認 API 已啟動且已執行資料庫 migration（含 006_office_settlement_gate.sql）。");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    let list = rows;
    if (filterPipeline === "pending_settlement") {
      list = list.filter((row) => row.status === "pending_settlement");
    } else if (filterPipeline === "settled") {
      list = list.filter((row) => row.status === "completed" || row.status === "not_delivered");
    }
    if (filterOutcome === "legacy") {
      list = list.filter((row) => row.settlementOutcome == null && row.status === "completed");
    } else if (filterOutcome) {
      list = list.filter((row) => row.settlementOutcome === filterOutcome);
    }
    const s = q.trim().toLowerCase();
    if (s) {
      list = list.filter((row) => {
        const no = String(row.salesOrder?.orderNo ?? "").toLowerCase();
        const cust = String(row.salesOrder?.customer?.name ?? "").toLowerCase();
        const driver = String(row.driver?.user?.employeeCode ?? row.driver?.user?.name ?? "").toLowerCase();
        return no.includes(s) || cust.includes(s) || driver.includes(s);
      });
    }
    return list;
  }, [rows, filterPipeline, filterOutcome, q]);

  const approveAssignment = async (id: string) => {
    setApproveMsg("");
    const t = new Date(officeSettledAtLocal);
    if (Number.isNaN(t.getTime())) {
      setApproveMsg("請選擇有效的辦公室核銷時間。");
      return;
    }
    const ok = window.confirm(
      `確認核銷此筆？\n\n辦公室核銷時間：${t.toLocaleString("zh-TW", { hour12: false })}\n\n將依司機回報正式執行：送達→訂單完成、出庫、現金入帳；未送達→訂單退回「已確認」可再分派。`,
    );
    if (!ok) return;
    setApprovingId(id);
    try {
      const res = await fetch("/api/settlements/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId: id,
          officeSettledAt: t.toISOString(),
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setApproveMsg(payload.message ?? "核銷失敗");
        return;
      }
      setApproveMsg("已確認核銷。");
      await load();
    } catch {
      setApproveMsg("無法連線 API");
    } finally {
      setApprovingId(null);
    }
  };

  const exportSettlementsCsv = () => {
    const headers = [
      "任務狀態",
      "司機回報時間",
      "辦公室核銷時間",
      "單號",
      "客戶",
      "司機",
      "車牌",
      "核銷結果（司機回報）",
      "應收現金",
      "實收現金",
      "差額(實收-應收)",
      "空桶",
      "未送達原因",
      "備註",
    ];
    const lines = filtered.map((row) => [
      deliveryAssignmentStatusLabel(row.status),
      fmtDt(row.driverReportedAt),
      fmtDt(row.officeSettledAt ?? row.completedAt),
      row.salesOrder?.orderNo ?? "",
      row.salesOrder?.customer?.name ?? "",
      [row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "",
      row.vehicle?.plateNo ?? "",
      settlementOutcomeLabel(row.settlementOutcome),
      row.expectedAmount != null ? String(row.expectedAmount) : "",
      row.cashReceived != null ? String(row.cashReceived) : "",
      row.cashVariance != null ? String(row.cashVariance) : "",
      row.emptyBarrelsReturned ?? "",
      row.failureReason ?? "",
      row.settlementNote ?? "",
    ]);
    const bom = "\uFEFF";
    const esc = (c: unknown) => {
      const t = String(c ?? "");
      if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
      return t;
    };
    const body = [headers, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([bom + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `delivery-settlements-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const pendingCount = useMemo(() => rows.filter((r) => r.status === "pending_settlement").length, [rows]);

  return (
    <>
      <section className="card">
        <h2 className="card__title">核銷訂單</h2>
        <p className="card__hint">
          <strong>流程說明：</strong>司機於司機端提交「是否送達、回桶、收款」後，任務會進入<strong>待辦公室核銷</strong>；若司機暫不使用司機端，請先至{" "}
          <Link to="/orders/proxy-report">代登配送回報</Link>
          依紙本代登。訂單<strong>尚未完成</strong>、亦<strong>不會出庫／入帳</strong>。
          辦公室在此頁檢視司機回報並按下<strong>確認核銷</strong>後，系統才會完成訂單（送達）或將訂單退回（未送達）、並<strong>扣減商品庫存</strong>、寫入出庫紀錄與收款；送達時亦會依訂單中<strong>已勾選「計入押桶」</strong>的商品出貨量與司機<strong>空桶回收</strong>數更新該訂單<strong>送貨地址</strong>的<strong>未收回空桶</strong>。
          <br />
          <strong>配送數量：</strong>若司機／代登有修改實際配送桶數，須先按<strong>「確認配送數量」</strong>，系統才會重算訂單總額、應收與發票；下方「應收現金」欄會依最新立帳即時顯示。
          <br />
          <strong>司機更正：</strong>任務為「待辦公室核銷」時，司機可於司機端再次送出以<strong>修改</strong>空桶／收款／是否送達（辦公室核銷後即鎖定）；系統會記錄修正事件供查核。
          <br />
          <strong>現金客戶：</strong>應收現金＝<strong>前期未清現金欠款＋本單訂單總額</strong>；核銷時先為本單<strong>立帳</strong>，再將實收依<strong>FIFO</strong>沖最舊未結清應收。司機僅填實收，無須手動拆沖帳。
          <br />
          首次部署請執行 <code>database/migrations/006_office_settlement_gate.sql</code> 後重啟 API。
          <br />
          <strong>辦公室核銷時間</strong>可於下方自訂（預設為現在），用於測試或補登；月結之 <code>office_settled_at</code>、現金入帳時間與部分流水時間會與之一致。
        </p>
        {pendingCount > 0 ? (
          <p className="feedback feedback--warn" style={{ marginTop: "0.5rem" }}>
            目前有 <strong>{pendingCount}</strong> 筆待辦公室核銷。
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card__title">
          核銷清單 <span className="card__title-count">{loading ? "…" : `${filtered.length} / ${rows.length} 筆`}</span>
        </h2>
        <div className="toolbar toolbar--filters" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" }}>
          <div className="field field--sm">
            <span>流程</span>
            <select value={filterPipeline} onChange={(e) => setFilterPipeline(e.target.value)}>
              {PIPELINE_FILTERS.map((o) => (
                <option key={o.value || "pipe-all"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--sm">
            <span>司機回報結果</span>
            <select value={filterOutcome} onChange={(e) => setFilterOutcome(e.target.value)}>
              {OUTCOME_FILTERS.map((o) => (
                <option key={o.value || "all"} value={o.value}>
                  {o.label}
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
          <button type="button" className="btn btn--secondary btn--sm" onClick={exportSettlementsCsv} disabled={!filtered.length}>
            匯出篩選結果 CSV
          </button>
          <div className="field field--md">
            <span>辦公室核銷時間</span>
            <input
              type="datetime-local"
              value={officeSettledAtLocal}
              onChange={(e) => setOfficeSettledAtLocal(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setOfficeSettledAtLocal(toDatetimeLocalValue(new Date()))}
            title="重設為目前時間"
          >
            核銷時間設為現在
          </button>
        </div>
        <p className="card__hint" style={{ marginTop: "0.35rem" }}>
          按下「確認核銷」時會傳送上方時間；與司機回報日不同時，以本欄為準（例如月結截止日篩選）。
        </p>
        {approveMsg ? (
          <div
            className={approveMsg.includes("已確認") || approveMsg.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}
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
                <th>流程狀態</th>
                <th>司機回報時間</th>
                <th>辦公室核銷時間</th>
                <th>單號</th>
                <th>客戶</th>
                <th className="num">訂單總額</th>
                <th>司機</th>
                <th>司機回報結果</th>
                <th className="num">應收現金</th>
                <th className="num">實收</th>
                <th className="num">差額(實−應)</th>
                <th className="num">空桶</th>
                <th>原因 / 備註</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={String(row.id)}>
                  <td>
                    <span className={deliveryAssignmentStatusBadgeClass(row.status)}>{deliveryAssignmentStatusLabel(row.status)}</span>
                  </td>
                  <td className="cell-nowrap">{fmtDt(row.driverReportedAt)}</td>
                  <td className="cell-nowrap">{fmtDt(row.officeSettledAt ?? row.completedAt)}</td>
                  <td>
                    <code style={{ fontSize: "0.8em" }}>{row.salesOrder?.orderNo ?? "—"}</code>
                  </td>
                  <td>{row.salesOrder?.customer?.name ?? "—"}</td>
                  <td className="num">{row.salesOrder?.totalAmount != null ? String(row.salesOrder.totalAmount) : "—"}</td>
                  <td>
                    {row.driver?.user?.employeeCode ? `${row.driver.user.employeeCode} / ` : ""}
                    {row.driver?.user?.name ?? "—"}
                  </td>
                  <td>
                    <span className={settlementBadgeClass(row.settlementOutcome)}>{settlementOutcomeLabel(row.settlementOutcome)}</span>
                    {row.status === "pending_settlement" ? (
                      <div className="text-muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                        待辦公室確認
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{row.expectedAmount != null ? String(row.expectedAmount) : "—"}</td>
                  <td className="num">{row.cashReceived != null ? String(row.cashReceived) : "—"}</td>
                  <td className="num">{row.cashVariance != null ? String(row.cashVariance) : "—"}</td>
                  <td className="num">{row.emptyBarrelsReturned ?? "—"}</td>
                  <td style={{ maxWidth: "12rem", fontSize: "0.8125rem" }}>
                    {row.failureReason ? (
                      <span title={row.failureReason}>
                        <strong>原因：</strong>
                        {row.failureReason}
                      </span>
                    ) : null}
                    {row.settlementNote ? (
                      <div style={{ marginTop: row.failureReason ? "0.25rem" : 0 }} title={row.settlementNote}>
                        {row.failureReason ? <strong>備註：</strong> : null}
                        {row.settlementNote}
                      </div>
                    ) : !row.failureReason ? (
                      "—"
                    ) : null}
                  </td>
                  <td>
                    {row.status === "pending_settlement" ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={approvingId === String(row.id)}
                        onClick={() => void approveAssignment(String(row.id))}
                      >
                        {approvingId === String(row.id) ? "處理中…" : "確認核銷"}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && filtered.length === 0 ? <p className="card__hint">沒有符合條件的紀錄。</p> : null}
      </section>
    </>
  );
}
