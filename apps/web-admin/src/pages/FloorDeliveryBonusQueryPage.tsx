import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { moneyText } from "../adminUtils";
import { formatDeliveryFloor } from "../floorBonusUtils";
import { useDashboard } from "../DashboardContext";

type PageTab = "payroll" | "floor" | "rates";

type PayrollDriver = {
  driverId: string;
  employeeCode: string;
  name: string;
  baseSalary: string;
  deliveryQty: number;
  deliveryAmount: string;
  deliveryProducts: Array<{
    productId: string;
    productName: string;
    unit: string;
    qty: number;
    wagePerUnit: string;
    amount: string;
  }>;
  emptyBarrelQty: number;
  emptyBarrelWage: string;
  emptyBarrelAmount: string;
  floorBonusQty: number;
  floorBonusAmount: string;
  floorByLevel: Array<{ floor: number; qty: number; wagePerUnit: string; amount: string }>;
  totalPay: string;
};

type FloorRateRow = { floor: string; wage: string };
type CustomerFeeRateRow = { floor: string; unitPrice: string };

type PayrollData = {
  yearMonth: string;
  settings: {
    emptyBarrelWage: string;
    floorBonusRates: Array<{ floor: number; wage: string }>;
    customerFloorFeeRates?: Array<{ floor: number; unitPrice: string }>;
  };
  products: Array<{ id: string; productCode?: string | null; name: string; unit: string; driverDeliveryWage: string }>;
  drivers: PayrollDriver[];
  totals: {
    baseSalary: string;
    deliveryQty: number;
    deliveryAmount: string;
    emptyBarrelQty: number;
    emptyBarrelAmount: string;
    floorBonusQty: number;
    floorBonusAmount: string;
    totalPay: string;
  };
};

type BonusRow = {
  id: string;
  orderNo: string;
  deliveryDate: string;
  productName: string;
  qty: number;
  floor: number;
  driver?: { user?: { employeeCode?: string; name?: string } };
};

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, headers: string[], lines: unknown[][]) {
  const bom = "\uFEFF";
  const body = [headers, ...lines].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([bom + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function FloorDeliveryBonusQueryPage() {
  const { loadDashboard } = useDashboard();
  const [tab, setTab] = useState<PageTab>("payroll");
  const [yearMonth, setYearMonth] = useState(currentYearMonth);
  const [payroll, setPayroll] = useState<PayrollData | null>(null);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [payrollErr, setPayrollErr] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [floorRows, setFloorRows] = useState<BonusRow[]>([]);
  const [floorLoading, setFloorLoading] = useState(false);
  const [floorErr, setFloorErr] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [driverId, setDriverId] = useState("");
  const [q, setQ] = useState("");
  const { drivers } = useDashboard();

  const [emptyWage, setEmptyWage] = useState("0");
  const [floorRatesDraft, setFloorRatesDraft] = useState<FloorRateRow[]>([]);
  const [customerFeeDraft, setCustomerFeeDraft] = useState<CustomerFeeRateRow[]>([]);
  const [newFloor, setNewFloor] = useState("2");
  const [newFloorWage, setNewFloorWage] = useState("0");
  const [newCustomerFloor, setNewCustomerFloor] = useState("2");
  const [newCustomerPrice, setNewCustomerPrice] = useState("10");
  const [ratesMsg, setRatesMsg] = useState("");
  const [ratesSaving, setRatesSaving] = useState(false);
  const [baseDraft, setBaseDraft] = useState<Record<string, string>>({});
  const [wageDraft, setWageDraft] = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving] = useState<string | null>(null);

  const loadPayroll = useCallback(async () => {
    setPayrollLoading(true);
    setPayrollErr("");
    try {
      const res = await fetch(`/api/reports/driver-payroll?yearMonth=${encodeURIComponent(yearMonth)}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setPayrollErr(payload.message ?? "載入薪資統計失敗");
        setPayroll(null);
        return;
      }
      const data = payload.data as PayrollData;
      setPayroll(data);
      setEmptyWage(data.settings.emptyBarrelWage);
      setFloorRatesDraft(
        (data.settings.floorBonusRates ?? []).map((r) => ({
          floor: String(r.floor),
          wage: r.wage,
        })),
      );
      setCustomerFeeDraft(
        (data.settings.customerFloorFeeRates ?? []).map((r) => ({
          floor: String(r.floor),
          unitPrice: r.unitPrice,
        })),
      );
      const base: Record<string, string> = {};
      for (const d of data.drivers) base[d.driverId] = d.baseSalary;
      setBaseDraft(base);
      const wages: Record<string, string> = {};
      for (const p of data.products) wages[p.id] = p.driverDeliveryWage;
      setWageDraft(wages);
    } catch {
      setPayrollErr("載入薪資統計失敗");
      setPayroll(null);
    } finally {
      setPayrollLoading(false);
    }
  }, [yearMonth]);

  const loadFloor = useCallback(async () => {
    setFloorLoading(true);
    setFloorErr("");
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (driverId) params.set("driverId", driverId);
      if (q.trim()) params.set("q", q.trim());
      const r = await fetch(`/api/floor-delivery-bonuses?${params.toString()}`);
      const data = await r.json();
      if (!r.ok) {
        setFloorErr(typeof data?.message === "string" ? data.message : "讀取失敗");
        setFloorRows([]);
        return;
      }
      setFloorRows(Array.isArray(data) ? data : []);
    } catch {
      setFloorErr("讀取失敗");
      setFloorRows([]);
    } finally {
      setFloorLoading(false);
    }
  }, [dateFrom, dateTo, driverId, q]);

  useEffect(() => {
    if (tab === "payroll" || tab === "rates") void loadPayroll();
  }, [tab, loadPayroll]);

  useEffect(() => {
    if (tab === "floor") void loadFloor();
  }, [tab, loadFloor]);

  const floorTotalQty = useMemo(() => floorRows.reduce((sum, row) => sum + row.qty, 0), [floorRows]);

  const saveRates = async () => {
    setRatesSaving(true);
    setRatesMsg("");
    try {
      const floorBonusRates = floorRatesDraft.map((r) => ({
        floor: Math.trunc(Number(r.floor)),
        wage: Number(r.wage),
      }));
      const customerFloorFeeRates = customerFeeDraft.map((r) => ({
        floor: Math.trunc(Number(r.floor)),
        unitPrice: Number(r.unitPrice),
      }));
      const res = await fetch("/api/payroll-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emptyBarrelWage: Number(emptyWage), floorBonusRates, customerFloorFeeRates }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setRatesMsg(payload.message ?? "儲存失敗");
        return;
      }
      setRatesMsg("已儲存空桶、司機搬運獎金與客戶搬運費單價");
      await loadPayroll();
    } catch {
      setRatesMsg("儲存失敗");
    } finally {
      setRatesSaving(false);
    }
  };

  const addFloorRate = () => {
    const floor = Math.trunc(Number(newFloor));
    if (!Number.isFinite(floor) || floor === 0 || floor === 1) {
      setRatesMsg("樓層須為整數，且不可為 0 或 1（一樓不計搬運）");
      return;
    }
    if (floorRatesDraft.some((r) => Number(r.floor) === floor)) {
      setRatesMsg(`${formatDeliveryFloor(floor)} 已存在`);
      return;
    }
    setFloorRatesDraft((rows) => [...rows, { floor: String(floor), wage: newFloorWage || "0" }]);
    setRatesMsg("");
  };

  const addCustomerFeeRate = () => {
    const floor = Math.trunc(Number(newCustomerFloor));
    if (!Number.isFinite(floor) || floor === 0 || floor === 1) {
      setRatesMsg("客戶搬運費樓層須為整數，且不可為 0 或 1");
      return;
    }
    if (customerFeeDraft.some((r) => Number(r.floor) === floor)) {
      setRatesMsg(`客戶搬運費 ${formatDeliveryFloor(floor)} 已存在`);
      return;
    }
    setCustomerFeeDraft((rows) => [...rows, { floor: String(floor), unitPrice: newCustomerPrice || "0" }]);
    setRatesMsg("");
  };

  const saveBaseSalary = async (driverIdKey: string) => {
    setRowSaving(`d-${driverIdKey}`);
    setRatesMsg("");
    try {
      const res = await fetch(`/api/drivers/${driverIdKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseSalary: Number(baseDraft[driverIdKey] ?? 0) }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setRatesMsg(payload.message ?? "儲存底薪失敗");
        return;
      }
      setRatesMsg("已儲存底薪");
      await loadPayroll();
      loadDashboard();
    } catch {
      setRatesMsg("儲存底薪失敗");
    } finally {
      setRowSaving(null);
    }
  };

  const saveProductWage = async (productId: string) => {
    setRowSaving(`p-${productId}`);
    setRatesMsg("");
    try {
      const res = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverDeliveryWage: Number(wageDraft[productId] ?? 0) }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setRatesMsg(payload.message ?? "儲存配送單價失敗");
        return;
      }
      setRatesMsg("已儲存商品配送單價");
      await loadPayroll();
      loadDashboard();
    } catch {
      setRatesMsg("儲存配送單價失敗");
    } finally {
      setRowSaving(null);
    }
  };

  const exportPayrollCsv = () => {
    if (!payroll) return;
    downloadCsv(
      `driver-payroll-${payroll.yearMonth}.csv`,
      ["員編", "姓名", "底薪", "配送桶數", "配送薪資", "回收空桶", "空桶薪資", "上樓桶數", "搬運獎金", "合計"],
      payroll.drivers.map((d) => [
        d.employeeCode,
        d.name,
        d.baseSalary,
        d.deliveryQty,
        d.deliveryAmount,
        d.emptyBarrelQty,
        d.emptyBarrelAmount,
        d.floorBonusQty,
        d.floorBonusAmount,
        d.totalPay,
      ]),
    );
  };

  const exportFloorCsv = () => {
    downloadCsv(
      `floor-delivery-bonus-${new Date().toISOString().slice(0, 10)}.csv`,
      ["配送日", "訂單編號", "司機員編", "司機姓名", "商品", "上樓桶數", "樓層"],
      floorRows.map((row) => [
        fmtDate(row.deliveryDate),
        row.orderNo,
        row.driver?.user?.employeeCode ?? "",
        row.driver?.user?.name ?? "",
        row.productName,
        row.qty,
        formatDeliveryFloor(row.floor),
      ]),
    );
  };

  return (
    <section className="card">
      <h2 className="card__title">司機薪資統計</h2>
      <p className="card__hint">
        當月薪資＝<strong>底薪</strong>＋Σ（配送商品數量×商品單價）＋（回收空桶×固定單價）＋Σ（上樓桶數×該樓層單價）。
        僅統計已核銷完成的配送／收空桶／搬運紀錄。費率可於「費率設定」分頁調整。
      </p>

      <nav className="order-assign-tabs" role="tablist" aria-label="司機薪資分頁" style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "payroll"}
          className={`order-assign-tabs__btn${tab === "payroll" ? " order-assign-tabs__btn--active" : ""}`}
          onClick={() => setTab("payroll")}
        >
          月薪資總覽
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "floor"}
          className={`order-assign-tabs__btn${tab === "floor" ? " order-assign-tabs__btn--active" : ""}`}
          onClick={() => setTab("floor")}
        >
          搬運明細
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "rates"}
          className={`order-assign-tabs__btn${tab === "rates" ? " order-assign-tabs__btn--active" : ""}`}
          onClick={() => setTab("rates")}
        >
          費率設定
        </button>
      </nav>

      {tab === "payroll" ? (
        <>
          <div className="toolbar toolbar--filters" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" }}>
            <div className="field field--sm">
              <span>月份</span>
              <input type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
            </div>
            <button type="button" className="btn btn--secondary" onClick={() => void loadPayroll()} disabled={payrollLoading}>
              重新整理
            </button>
            <button type="button" className="btn btn--secondary" onClick={exportPayrollCsv} disabled={!payroll || payroll.drivers.length === 0}>
              匯出 CSV
            </button>
            {payrollErr ? <span className="feedback feedback--err">{payrollErr}</span> : null}
          </div>

          {payroll ? (
            <p className="text-muted" style={{ margin: "0.5rem 0 0.75rem", fontSize: "0.8125rem" }}>
              空桶單價 {moneyText(payroll.settings.emptyBarrelWage)}／桶 · 搬運依樓層單價（
              {(payroll.settings.floorBonusRates ?? []).length} 種）· 全司機合計{" "}
              <strong>{moneyText(payroll.totals.totalPay)}</strong>
            </p>
          ) : null}

          <div className="table-wrap">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>司機</th>
                  <th className="num">底薪</th>
                  <th className="num">配送桶</th>
                  <th className="num">配送薪資</th>
                  <th className="num">空桶</th>
                  <th className="num">空桶薪資</th>
                  <th className="num">上樓桶</th>
                  <th className="num">搬運獎金</th>
                  <th className="num">合計</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {payrollLoading ? (
                  <tr>
                    <td colSpan={10} className="text-muted">
                      載入中…
                    </td>
                  </tr>
                ) : !payroll || payroll.drivers.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-muted">
                      此月尚無司機資料。
                    </td>
                  </tr>
                ) : (
                  payroll.drivers.map((d) => {
                    const open = expandedId === d.driverId;
                    return (
                      <Fragment key={d.driverId}>
                        <tr>
                          <td>
                            <span className="mono-text text-muted" style={{ fontSize: "0.8em" }}>
                              {d.employeeCode || "—"}
                            </span>{" "}
                            <strong>{d.name || "—"}</strong>
                          </td>
                          <td className="num">{moneyText(d.baseSalary)}</td>
                          <td className="num">{d.deliveryQty}</td>
                          <td className="num">{moneyText(d.deliveryAmount)}</td>
                          <td className="num">{d.emptyBarrelQty}</td>
                          <td className="num">{moneyText(d.emptyBarrelAmount)}</td>
                          <td className="num">{d.floorBonusQty}</td>
                          <td className="num">{moneyText(d.floorBonusAmount)}</td>
                          <td className="num">
                            <strong>{moneyText(d.totalPay)}</strong>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => setExpandedId(open ? null : d.driverId)}
                            >
                              {open ? "收合" : "明細"}
                            </button>
                          </td>
                        </tr>
                        {open ? (
                          <tr>
                            <td colSpan={10}>
                              <div style={{ display: "grid", gap: "0.65rem" }}>
                                <div>
                                  <strong style={{ fontSize: "0.8125rem" }}>配送商品</strong>
                                  {d.deliveryProducts.length === 0 ? (
                                    <div className="text-muted">本月無配送商品明細。</div>
                                  ) : (
                                    <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                                      {d.deliveryProducts.map((p) => (
                                        <li key={p.productId}>
                                          {p.productName} × {p.qty}
                                          {p.unit ? ` ${p.unit}` : ""} × {moneyText(p.wagePerUnit)} = {moneyText(p.amount)}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <strong style={{ fontSize: "0.8125rem" }}>上樓搬運（依樓層）</strong>
                                  {(d.floorByLevel ?? []).length === 0 ? (
                                    <div className="text-muted">本月無上樓搬運。</div>
                                  ) : (
                                    <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                                      {(d.floorByLevel ?? []).map((f) => (
                                        <li key={f.floor}>
                                          {formatDeliveryFloor(f.floor)} × {f.qty} 桶 × {moneyText(f.wagePerUnit)} ={" "}
                                          {moneyText(f.amount)}
                                          {Number(f.wagePerUnit) === 0 ? (
                                            <span className="text-muted">（尚未設定該樓層單價）</span>
                                          ) : null}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              {payroll && payroll.drivers.length > 0 ? (
                <tfoot>
                  <tr>
                    <td>
                      <strong>合計</strong>
                    </td>
                    <td className="num">{moneyText(payroll.totals.baseSalary)}</td>
                    <td className="num">{payroll.totals.deliveryQty}</td>
                    <td className="num">{moneyText(payroll.totals.deliveryAmount)}</td>
                    <td className="num">{payroll.totals.emptyBarrelQty}</td>
                    <td className="num">{moneyText(payroll.totals.emptyBarrelAmount)}</td>
                    <td className="num">{payroll.totals.floorBonusQty}</td>
                    <td className="num">{moneyText(payroll.totals.floorBonusAmount)}</td>
                    <td className="num">
                      <strong>{moneyText(payroll.totals.totalPay)}</strong>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </>
      ) : null}

      {tab === "floor" ? (
        <>
          <p className="card__hint">
            上樓搬運紀錄（二樓以上或地下樓、預付扣桶商品）。日期為實際配送日。核銷完成後才列入薪資統計。
          </p>
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
                    {[d.user?.employeeCode ?? d.employeeCode, d.user?.name].filter(Boolean).join(" / ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field--sm">
              <span>關鍵字</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="單號／商品／司機" />
            </div>
            <button type="button" className="btn btn--secondary" onClick={() => void loadFloor()} disabled={floorLoading}>
              查詢
            </button>
            <button type="button" className="btn btn--secondary" onClick={exportFloorCsv} disabled={floorRows.length === 0}>
              匯出 CSV
            </button>
            {floorErr ? <span className="feedback feedback--err">{floorErr}</span> : null}
          </div>
          <h3 className="card__title" style={{ fontSize: "1rem" }}>
            紀錄清單 <span className="card__title-count">{floorLoading ? "…" : `${floorRows.length} 筆 · 合計 ${floorTotalQty} 桶`}</span>
          </h3>
          <div className="table-wrap">
            <table className="data-table data-table--compact">
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
                {floorLoading ? (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      載入中…
                    </td>
                  </tr>
                ) : floorRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      無符合條件的紀錄。
                    </td>
                  </tr>
                ) : (
                  floorRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDate(row.deliveryDate)}</td>
                      <td>
                        <code style={{ fontSize: "0.8em" }}>{row.orderNo}</code>
                      </td>
                      <td>
                        {[row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "—"}
                      </td>
                      <td>{row.productName}</td>
                      <td className="num">{row.qty}</td>
                      <td>{formatDeliveryFloor(row.floor)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "rates" ? (
        <>
          <div className="payroll-rates" style={{ marginBottom: "1.5rem" }}>
            <section className="payroll-rates__block">
              <h3 className="payroll-rates__title">回收空桶</h3>
              <div className="field" style={{ maxWidth: "14rem", marginBottom: 0 }}>
                <span>單價（元／桶）</span>
                <input type="number" min={0} step="0.01" value={emptyWage} onChange={(e) => setEmptyWage(e.target.value)} />
              </div>
            </section>

            <section className="payroll-rates__block">
              <h3 className="payroll-rates__title">司機上樓搬運獎金（依樓層）</h3>
              <p className="card__hint" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
                此為<strong>司機薪資</strong>單價，與下方「客戶搬運費」分開。預設 3／2／-1 樓；地上用正數、地下用負數（-1＝地下一樓）。一樓不計。
              </p>
              <div className="table-wrap payroll-rates__table">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>樓層</th>
                      <th className="num" style={{ width: "10rem" }}>
                        單價（元／桶）
                      </th>
                      <th style={{ width: "5rem" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {floorRatesDraft.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-muted">
                          尚未設定樓層單價，請下方新增。
                        </td>
                      </tr>
                    ) : (
                      floorRatesDraft.map((row, idx) => (
                        <tr key={`${row.floor}-${idx}`}>
                          <td>
                            <strong>{formatDeliveryFloor(Number(row.floor))}</strong>
                            <span className="text-muted" style={{ marginLeft: "0.4rem", fontSize: "0.78em" }}>
                              ({row.floor})
                            </span>
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              className="input--compact"
                              style={{ width: "7rem", textAlign: "right" }}
                              value={row.wage}
                              onChange={(e) =>
                                setFloorRatesDraft((rows) =>
                                  rows.map((r, i) => (i === idx ? { ...r, wage: e.target.value } : r)),
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              onClick={() => setFloorRatesDraft((rows) => rows.filter((_, i) => i !== idx))}
                            >
                              移除
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="payroll-rates__add">
                <div className="field" style={{ margin: 0 }}>
                  <span>樓層代碼</span>
                  <input
                    type="number"
                    step={1}
                    value={newFloor}
                    onChange={(e) => setNewFloor(e.target.value)}
                    style={{ width: "5.5rem" }}
                    title="3=三樓，2=二樓，-1=地下一樓"
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <span>單價</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={newFloorWage}
                    onChange={(e) => setNewFloorWage(e.target.value)}
                    style={{ width: "6.5rem" }}
                  />
                </div>
                <button type="button" className="btn btn--secondary" onClick={addFloorRate}>
                  加入樓層
                </button>
              </div>
            </section>

            <section className="payroll-rates__block">
              <h3 className="payroll-rates__title">客戶搬運費（向客戶收費）</h3>
              <p className="card__hint" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
                與上方「司機獎金」分開。預設二樓 $10、三樓 $20、地下一樓 $10。司機回報上樓桶數後，系統會依此單價自動加入訂單（月結併入月結；現金／預付收現金）。
              </p>
              <div className="table-wrap payroll-rates__table">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>樓層</th>
                      <th className="num" style={{ width: "10rem" }}>
                        客戶單價（元／桶）
                      </th>
                      <th style={{ width: "5rem" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerFeeDraft.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-muted">
                          尚未設定客戶搬運費，請下方新增。
                        </td>
                      </tr>
                    ) : (
                      customerFeeDraft.map((row, idx) => (
                        <tr key={`fee-${row.floor}-${idx}`}>
                          <td>
                            <strong>{formatDeliveryFloor(Number(row.floor))}</strong>
                            <span className="text-muted" style={{ marginLeft: "0.4rem", fontSize: "0.78em" }}>
                              ({row.floor})
                            </span>
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              className="input--compact"
                              style={{ width: "7rem", textAlign: "right" }}
                              value={row.unitPrice}
                              onChange={(e) =>
                                setCustomerFeeDraft((rows) =>
                                  rows.map((r, i) => (i === idx ? { ...r, unitPrice: e.target.value } : r)),
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              onClick={() => setCustomerFeeDraft((rows) => rows.filter((_, i) => i !== idx))}
                            >
                              移除
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="payroll-rates__add">
                <div className="field" style={{ margin: 0 }}>
                  <span>樓層代碼</span>
                  <input
                    type="number"
                    step={1}
                    value={newCustomerFloor}
                    onChange={(e) => setNewCustomerFloor(e.target.value)}
                    style={{ width: "5.5rem" }}
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <span>客戶單價</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={newCustomerPrice}
                    onChange={(e) => setNewCustomerPrice(e.target.value)}
                    style={{ width: "6.5rem" }}
                  />
                </div>
                <button type="button" className="btn btn--secondary" onClick={addCustomerFeeRate}>
                  加入樓層
                </button>
              </div>
            </section>

            <div className="form-actions" style={{ marginTop: "0.25rem" }}>
              <button type="button" className="btn btn--primary" disabled={ratesSaving} onClick={() => void saveRates()}>
                {ratesSaving ? "儲存中…" : "儲存空桶／司機獎金／客戶搬運費"}
              </button>
              {ratesMsg ? (
                <span
                  className={
                    ratesMsg.includes("失敗") || ratesMsg.includes("不可") || ratesMsg.includes("已存在")
                      ? "feedback feedback--err"
                      : "feedback feedback--ok"
                  }
                >
                  {ratesMsg}
                </span>
              ) : null}
            </div>
          </div>

          <h3 className="card__title" style={{ fontSize: "1rem" }}>
            司機底薪
          </h3>
          <div className="table-wrap" style={{ marginBottom: "1.25rem" }}>
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>員編</th>
                  <th>姓名</th>
                  <th className="num">月底薪</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(payroll?.drivers ?? []).map((d) => (
                  <tr key={d.driverId}>
                    <td>
                      <code style={{ fontSize: "0.8em" }}>{d.employeeCode || "—"}</code>
                    </td>
                    <td>{d.name}</td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className="input--compact"
                        style={{ width: "7rem", textAlign: "right" }}
                        value={baseDraft[d.driverId] ?? d.baseSalary}
                        onChange={(e) => setBaseDraft((m) => ({ ...m, [d.driverId]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={rowSaving === `d-${d.driverId}`}
                        onClick={() => void saveBaseSalary(d.driverId)}
                      >
                        {rowSaving === `d-${d.driverId}` ? "…" : "儲存"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="card__title" style={{ fontSize: "1rem" }}>
            商品配送單價
          </h3>
          <div className="table-wrap">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>編號</th>
                  <th>商品</th>
                  <th>單位</th>
                  <th className="num">配送薪資（元／單位）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(payroll?.products ?? []).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <code style={{ fontSize: "0.8em" }}>{p.productCode ?? "—"}</code>
                    </td>
                    <td>{p.name}</td>
                    <td>{p.unit}</td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className="input--compact"
                        style={{ width: "7rem", textAlign: "right" }}
                        value={wageDraft[p.id] ?? p.driverDeliveryWage}
                        onChange={(e) => setWageDraft((m) => ({ ...m, [p.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={rowSaving === `p-${p.id}`}
                        onClick={() => void saveProductWage(p.id)}
                      >
                        {rowSaving === `p-${p.id}` ? "…" : "儲存"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
