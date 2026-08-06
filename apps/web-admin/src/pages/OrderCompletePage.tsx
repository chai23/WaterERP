import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  deliveryAssignmentStatusBadgeClass,
  deliveryAssignmentStatusLabel,
  driverEmployeeCode,
  driverIsActive,
  fmtLocalDateTimeShort,
  formatOrderNoTail,
  moneyText,
  settlementBadgeClass,
  settlementOutcomeLabel,
} from "../adminUtils";
import { DateTimeCell } from "../components/DateTimeCell";
import { useDashboard } from "../DashboardContext";
import { formatDeliveryFloor } from "../floorBonusUtils";

type SettlementOrderLine = {
  id: string | number;
  linePurpose?: string | null;
  billingTypeAtLine?: string | null;
  lineAmount?: string | number | null;
  qtyOrdered?: number | null;
  qtyDelivered?: number | null;
  product?: { name?: string; consumesPrepaidBarrel?: boolean } | null;
};

type SettlementRow = {
  id: string;
  status: string;
  assignmentDate?: string | null;
  completedAt?: string | null;
  driverReportedAt?: string | null;
  officeSettledAt?: string | null;
  settlementOutcome?: string | null;
  failureReason?: string | null;
  expectedAmount?: unknown;
  cashVariance?: unknown;
  cashReceived?: unknown;
  checkReceived?: unknown;
  emptyBarrelsReturned?: number;
  settlementNote?: string | null;
  orderBillableAmount?: unknown;
  salesOrder?: {
    orderNo?: string;
    billingTypeAtOrder?: string | null;
    customer?: { name?: string };
    totalAmount?: unknown;
    cashSubtotal?: unknown;
    lines?: SettlementOrderLine[];
    deliveryAddress?: { deliveryFloor?: number | null };
  };
  driverId?: string | number;
  driver?: { id?: string | number; user?: { employeeCode?: string; name?: string } };
  vehicle?: { plateNo?: string };
  floorBonusRecords?: Array<{
    id?: string;
    productName?: string;
    floor?: number;
    qty?: number;
  }>;
};

const PIPELINE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部流程" },
  { value: "pending_settlement", label: "待辦公室核銷" },
  { value: "settled", label: "已核銷結案" },
];

/** 供 datetime-local 使用（本地時間） */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function collectedTotal(row: SettlementRow): number {
  return Number(row.cashReceived ?? 0) + Number(row.checkReceived ?? 0);
}

/** 差額＝回報合計（現金＋支票）− 應收現金 */
function collectionVariance(row: SettlementRow): number | null {
  if (row.expectedAmount == null) return null;
  return collectedTotal(row) - Number(row.expectedAmount);
}

export default function OrderCompletePage() {
  const { drivers } = useDashboard();
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filterPipeline, setFilterPipeline] = useState("");
  const [filterDriverId, setFilterDriverId] = useState("");
  const [q, setQ] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveMsg, setApproveMsg] = useState("");
  /** 辦公室核銷入帳時間（可改為測試日／補登） */
  const [officeSettledAtLocal, setOfficeSettledAtLocal] = useState(() => toDatetimeLocalValue(new Date()));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const activeDrivers = useMemo(
    () =>
      [...drivers]
        .filter(driverIsActive)
        .sort((a, b) => driverEmployeeCode(a).localeCompare(driverEmployeeCode(b), "zh-Hant")),
    [drivers],
  );

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

  const rowDriverId = (row: SettlementRow): string =>
    String(row.driverId ?? row.driver?.id ?? "");

  const filtered = useMemo(() => {
    let list = rows;
    if (filterPipeline === "pending_settlement") {
      list = list.filter((row) => row.status === "pending_settlement");
    } else if (filterPipeline === "settled") {
      list = list.filter((row) => row.status === "completed" || row.status === "not_delivered");
    }
    if (filterDriverId) {
      list = list.filter((row) => rowDriverId(row) === filterDriverId);
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
  }, [rows, filterPipeline, filterDriverId, q]);

  const approveAssignment = async (row: SettlementRow) => {
    const id = String(row.id);
    setApproveMsg("");
    const t = new Date(officeSettledAtLocal);
    if (Number.isNaN(t.getTime())) {
      setApproveMsg("請選擇有效的辦公室核銷時間。");
      return;
    }
    const bonusSummary = (row.floorBonusRecords ?? [])
      .map((r) => `${r.productName ?? "商品"} ${formatDeliveryFloor(r.floor)} ${r.qty ?? 0}桶`)
      .join("\n");
    const ok = window.confirm(
      `確認核銷此筆？\n\n辦公室核銷時間：${t.toLocaleString("zh-TW", { hour12: false })}\n` +
        `回報現金：${moneyText(row.cashReceived)}　回報支票：${moneyText(row.checkReceived)}\n` +
        `回報合計：${moneyText(collectedTotal(row))}　應收現金：${moneyText(row.expectedAmount)}\n\n${
        bonusSummary ? `司機回報搬運紀錄：\n${bonusSummary}\n\n` : ""
      }將依司機回報正式執行：送達→訂單完成、出庫、收款入帳（現金／支票分開）；未送達→訂單退回「已確認」可再分派。`,
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
      "回報現金",
      "回報支票",
      "回報合計",
      "差額(合計-應收)",
      "空桶",
      "未送達原因",
      "備註",
    ];
    const lines = filtered.map((row) => [
      deliveryAssignmentStatusLabel(row.status),
      fmtLocalDateTimeShort(row.driverReportedAt),
      fmtLocalDateTimeShort(row.officeSettledAt ?? row.completedAt),
      row.salesOrder?.orderNo ?? "",
      row.salesOrder?.customer?.name ?? "",
      [row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "",
      row.vehicle?.plateNo ?? "",
      settlementOutcomeLabel(row.settlementOutcome, {
        billingTypeAtOrder: row.salesOrder?.billingTypeAtOrder,
        expectedAmount: row.expectedAmount != null ? Number(row.expectedAmount) : null,
        cashReceived: row.cashReceived != null ? Number(row.cashReceived) : 0,
        checkReceived: row.checkReceived != null ? Number(row.checkReceived) : 0,
      }),
      row.expectedAmount != null ? String(row.expectedAmount) : "",
      row.cashReceived != null ? String(row.cashReceived) : "",
      row.checkReceived != null ? String(row.checkReceived) : "",
      String(collectedTotal(row)),
      collectionVariance(row) != null ? String(collectionVariance(row)) : "",
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
  const batchEligible = useMemo(
    () =>
      filtered.filter(
        (r) => r.status === "pending_settlement" && r.settlementOutcome === "delivered_cash_exact",
      ),
    [filtered],
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllExact = () => {
    setSelectedIds(new Set(batchEligible.map((r) => String(r.id))));
  };

  const runBatchComplete = async () => {
    const ids = [...selectedIds].filter((id) => batchEligible.some((r) => String(r.id) === id));
    if (ids.length === 0) {
      setApproveMsg("請勾選足額（無異常）待核銷單");
      return;
    }
    if (!window.confirm(`確定批次核銷 ${ids.length} 筆足額單？短收／溢收／未收款會略過。`)) return;
    setBatchBusy(true);
    setApproveMsg("");
    try {
      const officeSettledAt = new Date(officeSettledAtLocal).toISOString();
      const res = await fetch("/api/settlements/batch-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentIds: ids, officeSettledAt }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        setApproveMsg(payload?.message ?? "批次核銷失敗");
        return;
      }
      const succeeded = Array.isArray(payload.data?.succeeded) ? payload.data.succeeded : [];
      const skipped = Array.isArray(payload.data?.skipped) ? payload.data.skipped : [];
      setApproveMsg(`批次核銷完成：成功 ${succeeded.length}、略過 ${skipped.length}`);
      setSelectedIds(new Set());
      await load();
    } catch {
      setApproveMsg("批次核銷時發生錯誤");
    } finally {
      setBatchBusy(false);
    }
  };

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
          <strong>現金客戶：</strong>建議收款＝本單未清 AR＋可催收舊欠 − 預收錢包；核銷時將<strong>回報現金／支票</strong>分開入收款單，並<strong>本單優先</strong>再依到期日沖 AR。溢收轉預收錢包。
          <br />
          首次部署請執行 <code>database/migrations/006_office_settlement_gate.sql</code> 後重啟 API。
          <br />
          <strong>辦公室核銷時間</strong>可於下方自訂（預設為現在），用於測試或補登；月結之 <code>office_settled_at</code>、收款入帳時間與部分紀錄時間會與之一致。
          <br />
          <strong>搬運獎金／客戶搬運費：</strong>司機回報上樓桶數後，系統會依「客戶搬運費」單價自動加入訂單（月結併入月結；現金／預付收現金），並重算應收。核銷後不可再改搬運費。司機獎金另計，請至{" "}
          <Link to="/orders/floor-bonus">搬運獎金／費率</Link>。
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
            <span>選擇司機</span>
            <select value={filterDriverId} onChange={(e) => setFilterDriverId(e.target.value)}>
              <option value="">全部司機</option>
              {activeDrivers.map((d) => {
                const code = driverEmployeeCode(d);
                const name = d.user?.name ?? "（未命名）";
                return (
                  <option key={String(d.id)} value={String(d.id)}>
                    {code ? `${code} ${name}` : name}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="field" style={{ flex: "1 1 12rem" }}>
            <span>關鍵字</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號、客戶" />
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
          <button type="button" className="btn btn--secondary btn--sm" onClick={selectAllExact} disabled={!batchEligible.length}>
            全選足額單（{batchEligible.length}）
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => void runBatchComplete()}
          >
            {batchBusy ? "批次核銷中…" : `批次核銷（${selectedIds.size}）`}
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
          <table className="data-table data-table--order-complete">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">選取</span>
                </th>
                <th>流程狀態</th>
                <th className="col-datetime">司機回報時間</th>
                <th className="col-datetime">辦公室核銷時間</th>
                <th>客戶</th>
                <th className="num">本單應收</th>
                <th>司機</th>
                <th>司機回報結果</th>
                <th className="num">應收現金</th>
                <th className="num">回報現金</th>
                <th className="num">回報支票</th>
                <th className="num">回報合計</th>
                <th className="num">差額</th>
                <th className="num">空桶</th>
                <th>原因 / 備註</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={String(row.id)}>
                  <td>
                    {row.status === "pending_settlement" && row.settlementOutcome === "delivered_cash_exact" ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(String(row.id))}
                        onChange={() => toggleSelected(String(row.id))}
                        aria-label={`選取核銷 ${row.salesOrder?.orderNo ?? row.id}`}
                      />
                    ) : null}
                  </td>
                  <td>
                    <span className={deliveryAssignmentStatusBadgeClass(row.status)}>{deliveryAssignmentStatusLabel(row.status)}</span>
                  </td>
                  <td className="col-datetime">
                    <DateTimeCell value={row.driverReportedAt} />
                  </td>
                  <td className="col-datetime">
                    <DateTimeCell value={row.officeSettledAt ?? row.completedAt} />
                  </td>
                  <td>
                    <div>{row.salesOrder?.customer?.name ?? "—"}</div>
                    {row.salesOrder?.orderNo ? (
                      <div className="cell-order-tail" title={`單號：${row.salesOrder.orderNo}`}>
                        #{formatOrderNoTail(row.salesOrder.orderNo)}
                      </div>
                    ) : null}
                    {row.salesOrder?.deliveryAddress?.deliveryFloor != null ? (
                      <div className="text-muted" style={{ fontSize: "0.75rem" }}>
                        主檔樓層：{formatDeliveryFloor(row.salesOrder.deliveryAddress.deliveryFloor)}
                      </div>
                    ) : null}
                  </td>
                  <td className="num">
                    {row.orderBillableAmount != null
                      ? String(row.orderBillableAmount)
                      : row.salesOrder?.totalAmount != null
                        ? String(row.salesOrder.totalAmount)
                        : "—"}
                  </td>
                  <td className="cell-nowrap">{row.driver?.user?.name ?? "—"}</td>
                  <td>
                    <span className={settlementBadgeClass(row.settlementOutcome)}>
                      {settlementOutcomeLabel(row.settlementOutcome, {
                        billingTypeAtOrder: row.salesOrder?.billingTypeAtOrder,
                        expectedAmount: row.expectedAmount != null ? Number(row.expectedAmount) : null,
                        cashReceived: row.cashReceived != null ? Number(row.cashReceived) : 0,
                        checkReceived: row.checkReceived != null ? Number(row.checkReceived) : 0,
                      })}
                    </span>
                    {row.status === "pending_settlement" ? (
                      <div className="text-muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                        待辦公室確認
                      </div>
                    ) : null}
                    {(row.floorBonusRecords ?? []).length > 0 ||
                    (row.salesOrder?.lines ?? []).some((l) => (l.linePurpose ?? "") === "floor_handling_fee") ? (
                      <div style={{ fontSize: "0.75rem", marginTop: "0.35rem", lineHeight: 1.35 }}>
                        {(row.floorBonusRecords ?? []).length > 0 ? (
                          <>
                            <strong>搬運：</strong>
                            {(row.floorBonusRecords ?? []).map((r) => (
                              <div key={String(r.id ?? `${r.productName}-${r.floor}-${r.qty}`)}>
                                {r.productName ?? "商品"} · {formatDeliveryFloor(r.floor)} · {r.qty ?? 0}桶
                              </div>
                            ))}
                          </>
                        ) : null}
                        {(() => {
                          const feeLines = (row.salesOrder?.lines ?? []).filter(
                            (l) => (l.linePurpose ?? "") === "floor_handling_fee",
                          );
                          if (feeLines.length === 0) return null;
                          const amt = feeLines.reduce((s, l) => s + Number(l.lineAmount ?? 0), 0);
                          const bill = feeLines[0]?.billingTypeAtLine ?? "";
                          return (
                            <div style={{ marginTop: "0.2rem" }}>
                              <strong>客戶搬運費：</strong>${moneyText(amt)}
                              {bill === "monthly" ? "（月結）" : bill === "cash" ? "（現金）" : ""}
                            </div>
                          );
                        })()}
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{row.expectedAmount != null ? moneyText(row.expectedAmount) : "—"}</td>
                  <td className="num">{row.cashReceived != null ? moneyText(row.cashReceived) : "—"}</td>
                  <td className="num">{row.checkReceived != null ? moneyText(row.checkReceived) : "—"}</td>
                  <td className="num">{moneyText(collectedTotal(row))}</td>
                  <td className="num">
                    {collectionVariance(row) != null ? moneyText(collectionVariance(row)) : "—"}
                  </td>
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
                        onClick={() => void approveAssignment(row)}
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
