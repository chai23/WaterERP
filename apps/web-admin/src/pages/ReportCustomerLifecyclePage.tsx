import { useCallback, useEffect, useMemo, useState } from "react";
import { billingTypeLabel, todayLocalYm } from "../adminUtils";
import { useDashboard } from "../DashboardContext";

type LifecycleReport = {
  yearMonth: string;
  summary: {
    newCount: number;
    churnedCount: number;
    churnedCustomerCount: number;
    reactivatedCount: number;
    netNewMinusChurn: number;
  };
  newCustomers: Array<{
    id: string;
    customerCode: string | null;
    name: string;
    billingType: string;
    createdAt: string;
    addressZone?: { name: string } | null;
    affiliatedCompany?: { name: string } | null;
  }>;
  churnedCustomers: Array<{
    eventId: string;
    id: string;
    customerCode: string | null;
    name: string;
    billingType: string;
    lifecycleStatus: string;
    churnedAt: string;
    reasonLabel: string;
    reasonNote: string | null;
    addressZone?: { name: string } | null;
    affiliatedCompany?: { name: string } | null;
    lastDeliveryDate: string | null;
    lastOrderNo: string | null;
    totalChurnCount: number;
    totalReactivatedCount: number;
  }>;
  reactivatedCustomers: Array<{
    eventId: string;
    id: string;
    customerCode: string | null;
    name: string;
    reactivatedAt: string;
    note: string | null;
    addressZone?: { name: string } | null;
    affiliatedCompany?: { name: string } | null;
  }>;
  byReason: Array<{ reasonId: string; reasonLabel: string; count: number }>;
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("zh-TW");
  } catch {
    return iso.slice(0, 10);
  }
}

export default function ReportCustomerLifecyclePage() {
  const { addressZones, affiliatedCompanies } = useDashboard();
  const [yearMonth, setYearMonth] = useState(todayLocalYm());
  const [addressZoneId, setAddressZoneId] = useState("");
  const [affiliatedCompanyId, setAffiliatedCompanyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [report, setReport] = useState<LifecycleReport | null>(null);

  const activeZones = useMemo(() => addressZones.filter((z) => z.isActive !== false), [addressZones]);
  const activeCompanies = useMemo(
    () => affiliatedCompanies.filter((c) => c.isActive !== false),
    [affiliatedCompanies],
  );

  const loadReport = useCallback(async () => {
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ yearMonth });
      if (addressZoneId) q.set("addressZoneId", addressZoneId);
      if (affiliatedCompanyId) q.set("affiliatedCompanyId", affiliatedCompanyId);
      const res = await fetch(`/api/reports/customer-lifecycle?${q.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setReport(null);
        setMsg(payload.message ?? "載入報表失敗");
        return;
      }
      setReport(payload.data as LifecycleReport);
    } catch {
      setReport(null);
      setMsg("無法連線 API");
    } finally {
      setLoading(false);
    }
  }, [yearMonth, addressZoneId, affiliatedCompanyId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const exportCsv = () => {
    if (!report) return;
    const lines: string[] = [];
    lines.push(`客戶增減報表,${report.yearMonth}`);
    lines.push(`新增,${report.summary.newCount}`);
    lines.push(`流失事件,${report.summary.churnedCount}`);
    lines.push(`回流,${report.summary.reactivatedCount}`);
    lines.push("");
    lines.push("新增客戶,編號,名稱,結帳,建檔日,分區,公司");
    for (const c of report.newCustomers) {
      lines.push(
        [
          "",
          c.customerCode ?? "",
          c.name,
          billingTypeLabel(c.billingType),
          fmtDate(c.createdAt),
          c.addressZone?.name ?? "",
          c.affiliatedCompany?.name ?? "",
        ].join(","),
      );
    }
    lines.push("");
    lines.push("流失,編號,名稱,流失日,原因,說明,最後配送,累計流失次數,累計回流次數");
    for (const c of report.churnedCustomers) {
      lines.push(
        [
          "",
          c.customerCode ?? "",
          c.name,
          c.churnedAt,
          c.reasonLabel,
          (c.reasonNote ?? "").replace(/,/g, "，"),
          c.lastDeliveryDate ?? "",
          c.totalChurnCount,
          c.totalReactivatedCount,
        ].join(","),
      );
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `customer-lifecycle-${report.yearMonth}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page-stack">
      <div className="card">
        <h2 className="card__title">客戶增減報表</h2>
        <p className="card__hint">
          統計每月<strong>新增客戶</strong>（建檔日）與<strong>流失事件</strong>（人工標記之決定不再服務日）。同一客戶若多次流失／回流，事件與累計次數皆會列出。
        </p>
        <div className="form-grid form-grid--wide">
          <div className="form-row-2">
            <div className="field">
              <span>月份</span>
              <input type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
            </div>
            <div className="field">
              <span>地址分區</span>
              <select value={addressZoneId} onChange={(e) => setAddressZoneId(e.target.value)}>
                <option value="">全公司</option>
                {activeZones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span>隸屬公司</span>
              <select value={affiliatedCompanyId} onChange={(e) => setAffiliatedCompanyId(e.target.value)}>
                <option value="">全公司</option>
                {activeCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn--secondary" disabled={loading} onClick={() => void loadReport()}>
              {loading ? "載入中…" : "重新查詢"}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!report} onClick={exportCsv}>
              匯出 CSV
            </button>
          </div>
        </div>
        {msg ? <p className="feedback feedback--err">{msg}</p> : null}
      </div>

      {report ? (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-card__label">本月新增</div>
              <div className="stat-card__value">{report.summary.newCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">本月流失事件</div>
              <div className="stat-card__value">{report.summary.churnedCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">本月回流</div>
              <div className="stat-card__value">{report.summary.reactivatedCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">新增 − 流失</div>
              <div className="stat-card__value">{report.summary.netNewMinusChurn}</div>
            </div>
          </div>

          {report.byReason.length > 0 ? (
            <div className="card">
              <h3 className="card__title">流失原因分布</h3>
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>原因</th>
                      <th className="num">件數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byReason.map((r) => (
                      <tr key={r.reasonId || r.reasonLabel}>
                        <td>{r.reasonLabel}</td>
                        <td className="num">{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="card">
            <h3 className="card__title">新增客戶（{report.newCustomers.length}）</h3>
            <div className="table-wrap">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th>編號</th>
                    <th>名稱</th>
                    <th>結帳</th>
                    <th>建檔日</th>
                    <th>分區</th>
                    <th>公司</th>
                  </tr>
                </thead>
                <tbody>
                  {report.newCustomers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted">
                        本月無新增客戶
                      </td>
                    </tr>
                  ) : (
                    report.newCustomers.map((c) => (
                      <tr key={c.id}>
                        <td className="mono-text">{c.customerCode ?? "—"}</td>
                        <td>{c.name}</td>
                        <td>{billingTypeLabel(c.billingType)}</td>
                        <td className="cell-nowrap">{fmtDate(c.createdAt)}</td>
                        <td>{c.addressZone?.name ?? "—"}</td>
                        <td>{c.affiliatedCompany?.name ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3 className="card__title">流失客戶（{report.churnedCustomers.length}）</h3>
            <div className="table-wrap">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th>編號</th>
                    <th>名稱</th>
                    <th>流失日</th>
                    <th>原因</th>
                    <th>說明</th>
                    <th>最後配送</th>
                    <th className="num">累計流失</th>
                    <th className="num">累計回流</th>
                    <th>現況</th>
                  </tr>
                </thead>
                <tbody>
                  {report.churnedCustomers.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-muted">
                        本月無流失紀錄
                      </td>
                    </tr>
                  ) : (
                    report.churnedCustomers.map((c) => (
                      <tr key={c.eventId}>
                        <td className="mono-text">{c.customerCode ?? "—"}</td>
                        <td>{c.name}</td>
                        <td className="cell-nowrap">{c.churnedAt}</td>
                        <td>{c.reasonLabel}</td>
                        <td>
                          <small className="text-muted">{c.reasonNote ?? "—"}</small>
                        </td>
                        <td className="cell-nowrap">
                          {c.lastDeliveryDate ?? "—"}
                          {c.lastOrderNo ? (
                            <span className="mono-text" style={{ display: "block", fontSize: "0.85em" }}>
                              {c.lastOrderNo}
                            </span>
                          ) : null}
                        </td>
                        <td className="num">{c.totalChurnCount}</td>
                        <td className="num">{c.totalReactivatedCount}</td>
                        <td>{c.lifecycleStatus === "churned" ? "流失中" : "已回流"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {report.reactivatedCustomers.length > 0 ? (
            <div className="card">
              <h3 className="card__title">本月回流（{report.reactivatedCustomers.length}）</h3>
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>編號</th>
                      <th>名稱</th>
                      <th>回流日</th>
                      <th>備註</th>
                      <th>分區</th>
                      <th>公司</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.reactivatedCustomers.map((c) => (
                      <tr key={c.eventId}>
                        <td className="mono-text">{c.customerCode ?? "—"}</td>
                        <td>{c.name}</td>
                        <td className="cell-nowrap">{c.reactivatedAt}</td>
                        <td>
                          <small className="text-muted">{c.note ?? "—"}</small>
                        </td>
                        <td>{c.addressZone?.name ?? "—"}</td>
                        <td>{c.affiliatedCompany?.name ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
