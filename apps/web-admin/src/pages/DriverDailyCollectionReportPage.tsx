import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deliveryAssignmentStatusLabel,
  driverEmployeeCode,
  driverIsActive,
  lineBillingTypeLabel,
  moneyText,
  settlementOutcomeLabel,
  todayLocalYmd,
} from "../adminUtils";
import { formatDeliveryFloor } from "../floorBonusUtils";
import { useDashboard } from "../DashboardContext";
import { downloadReportCsv } from "../reportUtils";

type FloorBonusRow = {
  id: string;
  productName: string;
  qty: number;
  floor: number;
  floorLabel: string;
};

type OrderLineRow = {
  id: string;
  label: string;
  billingType: string;
  lineAmount: string;
};

type DriverOrderRow = {
  assignmentId: string;
  sourceType?: "delivery" | "service_ticket";
  ticketNo?: string | null;
  orderNo: string;
  assignmentStatus: string;
  customerCode: string;
  customerName: string;
  lineSummary: string;
  lines: OrderLineRow[];
  expectedAmount: number;
  cashReceived: number;
  checkReceived: number;
  collectedTotal: number;
  collectionVariance: number;
  collectionStatus: string;
  settlementOutcome: string | null;
  billableAmount: string;
  floorBonusRecords: FloorBonusRow[];
};

type ReportData = {
  date: string;
  driver: { id: string; employeeCode: string | null; name: string; vehiclePlate: string | null };
  summary: {
    orderCount: number;
    totalExpected: number;
    totalCash: number;
    totalCheck: number;
    totalCollected: number;
    totalVariance: number;
    varianceOrderCount: number;
    deliveryOrderCount?: number;
    serviceTicketCount?: number;
  };
  orders: DriverOrderRow[];
};

function statusBadgeClass(status: string, variance: number): string {
  if (status.includes("少收") || variance < 0) return "badge badge--warn";
  if (status.includes("多收") || variance > 0) return "badge badge--info";
  if (status.includes("足額") || status.includes("已結案")) return "badge badge--completed";
  if (status.includes("未送達") || status.includes("未收款")) return "badge badge--danger";
  return "badge badge--default";
}

export default function DriverDailyCollectionReportPage() {
  const { drivers } = useDashboard();
  const [driverId, setDriverId] = useState("");
  const [date, setDate] = useState(todayLocalYmd());
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const activeDrivers = useMemo(
    () => drivers.filter((d) => driverIsActive(d)).sort((a, b) => driverEmployeeCode(a).localeCompare(driverEmployeeCode(b), "zh-Hant")),
    [drivers],
  );

  const load = useCallback(async () => {
    if (!driverId) {
      setData(null);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ driverId, date });
      const r = await fetch(`/api/reports/driver-daily-collection?${params.toString()}`);
      const body = await r.json();
      if (!r.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${r.status}`);
      setData(body.data as ReportData);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "讀取失敗");
    } finally {
      setLoading(false);
    }
  }, [driverId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    if (!data) return;
    downloadReportCsv(
      `driver-collection-${data.date}-${data.driver.employeeCode ?? data.driver.id}.csv`,
      [
        "客戶編號",
        "客戶名稱",
        "訂單編號",
        "明細",
        "應收現金",
        "回報現金",
        "回報支票",
        "回報合計",
        "差額",
        "收款狀態",
        "搬運紀錄",
      ],
      data.orders.map((row) => [
        row.customerCode,
        row.customerName,
        row.orderNo,
        row.lineSummary,
        row.expectedAmount,
        row.cashReceived,
        row.checkReceived,
        row.collectedTotal,
        row.collectionVariance,
        row.collectionStatus,
        row.floorBonusRecords.map((f) => `${f.productName} ${f.qty}桶 ${formatDeliveryFloor(f.floor)}`).join(" / "),
      ]),
    );
  };

  return (
    <>
      <header className="report-page-head">
        <h1 className="report-page-head__title">司機日收款核對</h1>
        <p className="report-page-head__desc">
          列出司機指定日的配送訂單與飲水機服務費，核對現金／支票回報是否與應收一致。服務費：現場修好算評估司機當天；載回廠後送回算送回司機當天。差額 ≠ 0 的列請特別留意。
        </p>
      </header>

      <section className="card">
        <h2 className="card__title">查詢條件</h2>
        <div className="form-grid form-grid--wide driver-report-filters">
          <label className="field">
            <span>司機</span>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">請選擇司機</option>
              {activeDrivers.map((d) => (
                <option key={String(d.id)} value={String(d.id)}>
                  {driverEmployeeCode(d)} {d.user?.name ?? ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>配送日</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="form-actions driver-report-filters__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()} disabled={!driverId || loading}>
              重新查詢
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={!data?.orders.length}>
              匯出 CSV
            </button>
          </div>
        </div>
      </section>

      {loading ? <section className="card"><p className="card__hint">載入中…</p></section> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}

      {data ? (
        <>
          <section className="card report-flow-card">
            <h2 className="card__title card__title--stacked">
              {data.driver.employeeCode} {data.driver.name}
              <span className="card__title-count">
                {data.date} · {data.summary.orderCount} 筆
                {data.summary.serviceTicketCount
                  ? `（配送 ${data.summary.deliveryOrderCount ?? 0}＋服務 ${data.summary.serviceTicketCount}）`
                  : ""}
              </span>
            </h2>
            <div className="report-flow-notes report-flow-notes--summary">
              <div className="report-flow-note">
                <span className="report-flow-note__label">應收現金合計</span>
                <span className="report-flow-note__value">{moneyText(data.summary.totalExpected)}</span>
              </div>
              <div className="report-flow-note">
                <span className="report-flow-note__label">回報現金</span>
                <span className="report-flow-note__value">{moneyText(data.summary.totalCash)}</span>
              </div>
              <div className="report-flow-note">
                <span className="report-flow-note__label">回報支票</span>
                <span className="report-flow-note__value">{moneyText(data.summary.totalCheck)}</span>
              </div>
              <div className="report-flow-note">
                <span className="report-flow-note__label">回報合計</span>
                <span className="report-flow-note__value">{moneyText(data.summary.totalCollected)}</span>
              </div>
              <div className="report-flow-note report-flow-note--net">
                <span className="report-flow-note__label">與應收差額</span>
                <div className="report-flow-note__net-body">
                  <span
                    className={`report-flow-note__value report-flow-note__value--net ${
                      data.summary.totalVariance === 0 ? "text-success" : data.summary.totalVariance < 0 ? "text-danger" : "text-warn"
                    }`}
                  >
                    {moneyText(data.summary.totalVariance)}
                    {data.summary.totalVariance === 0 ? "（相符）" : data.summary.totalVariance < 0 ? "（少收）" : "（多收）"}
                  </span>
                  {data.summary.varianceOrderCount > 0 ? (
                    <span className="report-flow-note__hint">{data.summary.varianceOrderCount} 筆訂單有差額</span>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          {data.orders.length === 0 ? (
            <section className="card">
              <p className="card__hint">此司機在 {data.date} 沒有配送任務或服務費歸屬（或皆已取消）。</p>
            </section>
          ) : (
            <div className="driver-report-orders">
              {data.orders.map((row) => (
                <article
                  key={row.assignmentId}
                  className={`driver-report-order${row.collectionVariance !== 0 && row.expectedAmount > 0 ? " driver-report-order--warn" : ""}`}
                >
                  <header className="driver-report-order__head">
                    <div>
                      <span className="driver-report-order__customer-code">{row.customerCode || "—"}</span>
                      <strong className="driver-report-order__customer-name">{row.customerName}</strong>
                      <span className="driver-report-order__order-no">{row.orderNo}</span>
                      {row.sourceType === "service_ticket" ? (
                        <span className="badge badge--info" style={{ marginLeft: "0.4rem" }}>
                          服務費{row.ticketNo ? ` ${row.ticketNo}` : ""}
                        </span>
                      ) : null}
                    </div>
                    <span className={statusBadgeClass(row.collectionStatus, row.collectionVariance)}>
                      {row.collectionStatus}
                    </span>
                  </header>

                  <div className="driver-report-order__grid">
                    <div className="driver-report-order__block">
                      <h3 className="driver-report-order__label">訂單明細</h3>
                      <ul className="driver-report-order__lines">
                        {row.lines.map((ln) => (
                          <li key={ln.id}>
                            {ln.label}
                            <span className="driver-report-order__line-meta">
                              {lineBillingTypeLabel(ln.billingType)} · {moneyText(ln.lineAmount)}
                            </span>
                          </li>
                        ))}
                        {row.lines.length === 0 ? <li>—</li> : null}
                      </ul>
                      <p className="card__hint">本單應收（含稅）：{moneyText(row.billableAmount)}</p>
                    </div>

                    <div className="driver-report-order__block">
                      <h3 className="driver-report-order__label">收款核對</h3>
                      <dl className="driver-report-order__amounts">
                        <div>
                          <dt>應收現金</dt>
                          <dd>{moneyText(row.expectedAmount)}</dd>
                        </div>
                        <div>
                          <dt>回報現金</dt>
                          <dd>{moneyText(row.cashReceived)}</dd>
                        </div>
                        <div>
                          <dt>回報支票</dt>
                          <dd>{moneyText(row.checkReceived)}</dd>
                        </div>
                        <div>
                          <dt>回報合計</dt>
                          <dd>{moneyText(row.collectedTotal)}</dd>
                        </div>
                        <div className={row.collectionVariance !== 0 ? "driver-report-order__variance" : ""}>
                          <dt>差額</dt>
                          <dd>{moneyText(row.collectionVariance)}</dd>
                        </div>
                      </dl>
                      <p className="card__hint">
                        {row.sourceType === "service_ticket"
                          ? "來源：飲水機服務單"
                          : `流程：${deliveryAssignmentStatusLabel(row.assignmentStatus)}`}
                        {row.settlementOutcome ? ` · ${settlementOutcomeLabel(row.settlementOutcome)}` : ""}
                      </p>
                    </div>

                    <div className="driver-report-order__block">
                      <h3 className="driver-report-order__label">搬運紀錄</h3>
                      {row.floorBonusRecords.length > 0 ? (
                        <ul className="driver-report-order__lines">
                          {row.floorBonusRecords.map((f) => (
                            <li key={f.id}>
                              {f.productName} × {f.qty} 桶 · {formatDeliveryFloor(f.floor)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="card__hint">無搬運紀錄</p>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}

      {!driverId && !loading ? (
        <section className="card">
          <p className="card__hint">請先選擇司機與配送日。</p>
        </section>
      ) : null}
    </>
  );
}
