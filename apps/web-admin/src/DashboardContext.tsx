import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Customer, CustomerMasterOption, Driver, Product, Vehicle } from "./adminUtils";
import { driverEmployeeCode, todayLocalYmd } from "./adminUtils";
import type { OrderSlipSource } from "./orderPrint";
import { loadOrderPrintLayout, openOrderPrintWindow, slipFromDashboardOrderWithAnnouncement } from "./orderPrint";

type SummaryState = {
  range: string;
  startDate: string;
  endDate: string;
  periodRevenue: number;
  periodCollected: number;
  periodCollectedCash: number;
  periodCollectedTransfer: number;
  periodCollectedOther: number;
  todayCompletedCount: number;
  periodOrderOutstanding: number;
  periodPendingMonthly: number;
  periodPendingMonthlyCount: number;
  periodReceivableTotal: number;
  revenueCash: number;
  revenueMonthly: number;
  revenuePrepaidTopup: number;
  revenuePrepaidConsume: number;
  prepaidConsumeBarrels: number;
  arOpening: number;
  arPeriodAccrual: number;
  arPeriodCollected: number;
  arClosing: number;
};

const defaultSummaryState = (today = todayLocalYmd()): SummaryState => ({
  range: "today",
  startDate: today,
  endDate: today,
  periodRevenue: 0,
  periodCollected: 0,
  periodCollectedCash: 0,
  periodCollectedTransfer: 0,
  periodCollectedOther: 0,
  todayCompletedCount: 0,
  periodOrderOutstanding: 0,
  periodPendingMonthly: 0,
  periodPendingMonthlyCount: 0,
  periodReceivableTotal: 0,
  revenueCash: 0,
  revenueMonthly: 0,
  revenuePrepaidTopup: 0,
  revenuePrepaidConsume: 0,
  prepaidConsumeBarrels: 0,
  arOpening: 0,
  arPeriodAccrual: 0,
  arPeriodCollected: 0,
  arClosing: 0,
});

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const asSummaryState = (value: unknown, today: string): SummaryState => {
  if (!value || typeof value !== "object") return defaultSummaryState(today);
  const row = value as Partial<SummaryState> & {
    todayRevenue?: unknown;
    todayCashReceived?: unknown;
    unpaidAmount?: unknown;
  };
  const periodCollectedCash = Number(row.periodCollectedCash ?? row.todayCashReceived ?? 0);
  const periodCollectedTransfer = Number(row.periodCollectedTransfer ?? 0);
  const periodCollectedOther = Number(row.periodCollectedOther ?? 0);
  const periodCollected = Number(
    row.periodCollected ?? periodCollectedCash + periodCollectedTransfer + periodCollectedOther,
  );
  const periodOrderOutstanding = Number(row.periodOrderOutstanding ?? 0);
  const periodPendingMonthly = Number(row.periodPendingMonthly ?? 0);
  const periodReceivableTotal = Number(
    row.periodReceivableTotal ??
      (row.unpaidAmount != null && periodPendingMonthly === 0
        ? row.unpaidAmount
        : periodOrderOutstanding + periodPendingMonthly),
  );
  return {
    ...defaultSummaryState(today),
    range: typeof row.range === "string" ? row.range : "today",
    startDate: typeof row.startDate === "string" ? row.startDate : today,
    endDate: typeof row.endDate === "string" ? row.endDate : today,
    periodRevenue: Number(row.periodRevenue ?? row.todayRevenue ?? 0),
    periodCollected,
    periodCollectedCash,
    periodCollectedTransfer,
    periodCollectedOther,
    todayCompletedCount: Number(row.todayCompletedCount ?? 0),
    periodOrderOutstanding,
    periodPendingMonthly,
    periodPendingMonthlyCount: Number(row.periodPendingMonthlyCount ?? 0),
    periodReceivableTotal,
    revenueCash: Number(row.revenueCash ?? 0),
    revenueMonthly: Number(row.revenueMonthly ?? 0),
    revenuePrepaidTopup: Number(row.revenuePrepaidTopup ?? 0),
    revenuePrepaidConsume: Number(row.revenuePrepaidConsume ?? 0),
    prepaidConsumeBarrels: Number(row.prepaidConsumeBarrels ?? 0),
    arOpening: Number(row.arOpening ?? 0),
    arPeriodAccrual: Number(row.arPeriodAccrual ?? 0),
    arPeriodCollected: Number(row.arPeriodCollected ?? 0),
    arClosing: Number(row.arClosing ?? 0),
  };
};

export type LineBillingType = "cash" | "monthly" | "prepaid";

/** delivery：一般出貨；prepaid_barrel_topup：預付桶儲值（不出庫，核銷收款後入桶數） */
export type LinePurpose = "delivery" | "prepaid_barrel_topup";

export type MasterKind = "customers" | "products" | "drivers" | "vehicles" | "zones";

const MASTER_TTL_MS = 2 * 60 * 1000;

function defaultLineBillingForCustomer(c: Customer | undefined): LineBillingType {
  const t = c?.billingType;
  if (t === "monthly" || t === "prepaid" || t === "cash") return t;
  return "cash";
}

export type OrderFormLine = {
  id: string;
  productId: string;
  qty: number;
  unitPrice: string;
  /** 此列結帳方式（現金／月結／預付桶） */
  billingType: LineBillingType;
  linePurpose: LinePurpose;
  /** 補送（破桶補水）；預設單價 $0，仍計未收回空桶 */
  isReplenishment: boolean;
};

export function newOrderFormLine(defaultBilling: LineBillingType = "cash"): OrderFormLine {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `L${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    productId: "",
    qty: 1,
    unitPrice: "",
    billingType: defaultBilling,
    linePurpose: "delivery",
    isReplenishment: false,
  };
}

export type DashboardContextValue = {
  health: string;
  customers: Customer[];
  addressZones: CustomerMasterOption[];
  affiliatedCompanies: CustomerMasterOption[];
  products: Product[];
  drivers: Driver[];
  vehicles: Vehicle[];
  orders: any[];
  completedDeliveries: any[];
  payments: any[];
  summary: SummaryState;
  summaryStatus: "loading" | "ready" | "error";
  summaryFilter: {
    range: string;
    startDate: string;
    endDate: string;
    customerId: string;
    driverId: string;
    billingType: string;
  };
  setSummaryFilter: React.Dispatch<
    React.SetStateAction<{
      range: string;
      startDate: string;
      endDate: string;
      customerId: string;
      driverId: string;
      billingType: string;
    }>
  >;
  error: string;
  loadDashboard: (opts?: { forceMasters?: boolean }) => Promise<void>;
  /** 僅刷新訂單列表（查詢訂單／分派後） */
  loadOrders: () => Promise<void>;
  /** 僅刷新會計摘要與健康檢查（總覽／報表篩選） */
  loadSummary: () => Promise<void>;
  /** 主檔短效快取：預設 2 分鐘內不重抓；force 強制更新 */
  refreshMasters: (kinds?: MasterKind[], force?: boolean) => Promise<void>;
  selectedCustomer: Customer | undefined;
  saving: boolean;
  formMessage: string;
  form: {
    customerId: string;
    deliveryAddressId: string;
    lines: OrderFormLine[];
    scheduledDeliveryDate: string;
    remark: string;
    /** none | tax_exclusive | tax_inclusive — 現金／儲值列未稅金額；月結另於結帳批次 */
    cashInvoiceMode: string;
  };
  setForm: React.Dispatch<
    React.SetStateAction<{
      customerId: string;
      deliveryAddressId: string;
      lines: OrderFormLine[];
      scheduledDeliveryDate: string;
      remark: string;
      cashInvoiceMode: string;
    }>
  >;
  onSubmitCreateOrder: (e: React.FormEvent) => Promise<void>;
  /** 最近一次建立成功的訂單（供補印套印） */
  lastOrderSlipForPrint: OrderSlipSource | null;
  clearLastOrderSlipForPrint: () => void;
  assigning: boolean;
  assignMessage: string;
  assignForm: {
    salesOrderId: string;
    driverId: string;
    vehicleId: string;
    assignmentDate: string;
    estimatedDeliverySlot: string;
  };
  setAssignForm: React.Dispatch<
    React.SetStateAction<{
      salesOrderId: string;
      driverId: string;
      vehicleId: string;
      assignmentDate: string;
      estimatedDeliverySlot: string;
    }>
  >;
  onSubmitAssign: (e: React.FormEvent) => Promise<boolean>;
  driverSaving: boolean;
  driverMessage: string;
  driverForm: { name: string; employeeCode: string; phone: string; password: string; vehicleId: string; maxOrderCount: string; maxBarrelQty: string };
  setDriverForm: React.Dispatch<
    React.SetStateAction<{
      name: string;
      employeeCode: string;
      phone: string;
      password: string;
      vehicleId: string;
      maxOrderCount: string;
      maxBarrelQty: string;
    }>
  >;
  onSubmitNewDriver: (e: React.FormEvent) => Promise<void>;
  vehicleSaving: boolean;
  vehicleMessage: string;
  vehicleForm: { plateNo: string; description: string };
  setVehicleForm: React.Dispatch<React.SetStateAction<{ plateNo: string; description: string }>>;
  onSubmitNewVehicle: (e: React.FormEvent) => Promise<void>;
  productSaving: boolean;
  productMessage: string;
  productForm: {
    productCode: string;
    name: string;
    sku: string;
    unit: string;
    countsDepositBarrel: boolean;
    consumesPrepaidBarrel: boolean;
    availableOnLiff: boolean;
    salePrice: string;
    costPrice: string;
    driverDeliveryWage: string;
    initialQty: string;
  };
  setProductForm: React.Dispatch<
    React.SetStateAction<{
      productCode: string;
      name: string;
      sku: string;
      unit: string;
      countsDepositBarrel: boolean;
      consumesPrepaidBarrel: boolean;
      availableOnLiff: boolean;
      salePrice: string;
      costPrice: string;
      driverDeliveryWage: string;
      initialQty: string;
    }>
  >;
  onSubmitNewProduct: (e: React.FormEvent) => Promise<void>;
  onCancelOrder: (salesOrderId: string) => Promise<void>;
  exportCompletedDeliveriesCsv: () => void;
  exportPaymentsCsv: () => void;
  driverEmployeeCode: typeof driverEmployeeCode;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard 須在 DashboardProvider 內使用");
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const today = todayLocalYmd();
  const [health, setHealth] = useState<string>("…");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addressZones, setAddressZones] = useState<CustomerMasterOption[]>([]);
  const [affiliatedCompanies, setAffiliatedCompanies] = useState<CustomerMasterOption[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [completedDeliveries, setCompletedDeliveries] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [summary, setSummary] = useState<SummaryState>(() => defaultSummaryState(today));
  const [summaryStatus, setSummaryStatus] = useState<"loading" | "ready" | "error">("loading");
  const summaryRequestRef = useRef(0);
  const [summaryFilter, setSummaryFilter] = useState({
    range: "today",
    startDate: today,
    endDate: today,
    customerId: "",
    driverId: "",
    billingType: "",
  });
  const masterFetchedAtRef = useRef<Partial<Record<MasterKind, number>>>({});
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [formMessage, setFormMessage] = useState<string>("");
  const [lastOrderSlipForPrint, setLastOrderSlipForPrint] = useState<OrderSlipSource | null>(null);
  const [form, setForm] = useState({
    customerId: "",
    deliveryAddressId: "",
    lines: [newOrderFormLine()],
    scheduledDeliveryDate: todayLocalYmd(),
    remark: "",
    cashInvoiceMode: "none",
  });
  const [assigning, setAssigning] = useState<boolean>(false);
  const [assignMessage, setAssignMessage] = useState<string>("");
  const [assignForm, setAssignForm] = useState({
    salesOrderId: "",
    driverId: "",
    vehicleId: "",
    assignmentDate: todayLocalYmd(),
    estimatedDeliverySlot: "",
  });
  const [driverSaving, setDriverSaving] = useState(false);
  const [driverMessage, setDriverMessage] = useState("");
  const [driverForm, setDriverForm] = useState({
    name: "",
    employeeCode: "",
    phone: "",
    password: "",
    vehicleId: "",
    maxOrderCount: "20",
    maxBarrelQty: "150",
  });
  const [vehicleSaving, setVehicleSaving] = useState(false);
  const [vehicleMessage, setVehicleMessage] = useState("");
  const [vehicleForm, setVehicleForm] = useState({ plateNo: "", description: "" });
  const [productSaving, setProductSaving] = useState(false);
  const [productMessage, setProductMessage] = useState("");
  const [productForm, setProductForm] = useState({
    productCode: "",
    name: "",
    sku: "",
    unit: "桶",
    countsDepositBarrel: false,
    consumesPrepaidBarrel: false,
    availableOnLiff: false,
    salePrice: "0",
    costPrice: "0",
    driverDeliveryWage: "0",
    initialQty: "0",
  });

  const loadDashboard = useCallback(
    async (opts?: { forceMasters?: boolean }): Promise<void> => {
      setError("");
      const params = new URLSearchParams();
      params.set("range", summaryFilter.range);
      if (summaryFilter.range === "custom") {
        params.set("startDate", summaryFilter.startDate);
        params.set("endDate", summaryFilter.endDate);
      } else if (summaryFilter.range === "today" || summaryFilter.range === "day") {
        if (summaryFilter.startDate) params.set("startDate", summaryFilter.startDate);
      } else if (summaryFilter.range === "month") {
        if (summaryFilter.startDate) {
          params.set("startDate", summaryFilter.startDate);
          params.set("ym", summaryFilter.startDate.slice(0, 7));
        }
      }
      if (summaryFilter.customerId) params.set("customerId", summaryFilter.customerId);
      if (summaryFilter.driverId) params.set("driverId", summaryFilter.driverId);
      if (summaryFilter.billingType) params.set("billingType", summaryFilter.billingType);
      const summaryUrl = `/api/accounting/summary?${params.toString()}`;

      const normMasters = (arr: unknown[]): CustomerMasterOption[] =>
        arr.map((x) => {
          const r = x as Record<string, unknown>;
          return {
            id: String(r.id),
            name: String(r.name ?? ""),
            sortOrder: Number(r.sortOrder ?? 0),
            isActive: r.isActive !== false,
          };
        });

      const fetchJson = async (url: string): Promise<unknown> => {
        const r = await fetch(url);
        if (!r.ok) {
          throw new Error(`${url} ${r.status}`);
        }
        return r.json();
      };

      const fetchJsonOrEmpty = async (url: string): Promise<unknown[]> => {
        try {
          const data = await fetchJson(url);
          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      };

      const forceMasters = opts?.forceMasters === true;
      const now = Date.now();
      const masterKinds: MasterKind[] = ["customers", "products", "drivers", "vehicles", "zones"];
      const needMasters = forceMasters
        ? masterKinds
        : masterKinds.filter((k) => {
            const at = masterFetchedAtRef.current[k];
            return at == null || now - at > MASTER_TTL_MS;
          });

      const masterFetches: Promise<void>[] = [];
      if (needMasters.includes("customers")) {
        masterFetches.push(
          fetchJson("/api/customers").then((c) => {
            setCustomers(Array.isArray(c) ? (c as Customer[]) : []);
            masterFetchedAtRef.current.customers = Date.now();
          }),
        );
      }
      if (needMasters.includes("zones")) {
        masterFetches.push(
          Promise.all([fetchJsonOrEmpty("/api/address-zones"), fetchJsonOrEmpty("/api/affiliated-companies")]).then(
            ([zones, companies]) => {
              setAddressZones(normMasters(zones));
              setAffiliatedCompanies(normMasters(companies));
              masterFetchedAtRef.current.zones = Date.now();
            },
          ),
        );
      }
      if (needMasters.includes("products")) {
        masterFetches.push(
          fetchJson("/api/products").then((p) => {
            setProducts(asArray<Product>(p));
            masterFetchedAtRef.current.products = Date.now();
          }),
        );
      }
      if (needMasters.includes("drivers")) {
        masterFetches.push(
          fetchJson("/api/drivers").then((d) => {
            setDrivers(asArray<Driver>(d));
            masterFetchedAtRef.current.drivers = Date.now();
          }),
        );
      }
      if (needMasters.includes("vehicles")) {
        masterFetches.push(
          fetchJson("/api/vehicles").then((v) => {
            setVehicles(asArray<Vehicle>(v));
            masterFetchedAtRef.current.vehicles = Date.now();
          }),
        );
      }

      await Promise.all([
        fetchJson("/api/health").then((h) => setHealth(JSON.stringify(h))),
        ...masterFetches,
        fetchJson("/api/sales-orders").then((o) => setOrders(asArray(o))),
        fetchJson("/api/completed-deliveries").then((cd) => setCompletedDeliveries(asArray(cd))),
        fetchJson("/api/payments").then((pay) => setPayments(asArray(pay))),
        fetchJson(summaryUrl).then((s) => setSummary(asSummaryState(s, today))),
      ]).catch(() => {
        setHealth("無法連線 API（請確認 apps/api 已啟動）");
        setError("資料讀取失敗，請檢查 API 是否正常或資料庫是否有資料。");
      });
    },
    [
      summaryFilter.range,
      summaryFilter.startDate,
      summaryFilter.endDate,
      summaryFilter.customerId,
      summaryFilter.driverId,
      summaryFilter.billingType,
      today,
    ],
  );

  const loadOrders = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch("/api/sales-orders");
      if (!r.ok) throw new Error(`sales-orders ${r.status}`);
      const o = await r.json();
      setOrders(asArray(o));
    } catch {
      setError("訂單資料讀取失敗");
    }
  }, []);

  const loadSummary = useCallback(async (): Promise<void> => {
    const request = ++summaryRequestRef.current;
    setSummaryStatus("loading");
    try {
      const params = new URLSearchParams();
      params.set("range", summaryFilter.range);
      if (summaryFilter.range === "custom") {
        params.set("startDate", summaryFilter.startDate);
        params.set("endDate", summaryFilter.endDate);
      } else if (summaryFilter.range === "today" || summaryFilter.range === "day") {
        if (summaryFilter.startDate) params.set("startDate", summaryFilter.startDate);
      } else if (summaryFilter.range === "month") {
        if (summaryFilter.startDate) {
          params.set("startDate", summaryFilter.startDate);
          params.set("ym", summaryFilter.startDate.slice(0, 7));
        }
      }
      if (summaryFilter.customerId) params.set("customerId", summaryFilter.customerId);
      if (summaryFilter.driverId) params.set("driverId", summaryFilter.driverId);
      if (summaryFilter.billingType) params.set("billingType", summaryFilter.billingType);
      const [h, s] = await Promise.all([
        fetch("/api/health").then(async (r) => {
          if (!r.ok) throw new Error("連線失敗");
          return r.json();
        }),
        fetch(`/api/accounting/summary?${params.toString()}`).then(async (r) => {
          if (!r.ok) throw new Error("摘要載入失敗");
          return r.json();
        }),
      ]);
      if (request !== summaryRequestRef.current) return;
      if (!s || typeof s !== "object" || s.ok === false) throw new Error("摘要載入失敗");
      setHealth(JSON.stringify(h));
      setSummary(asSummaryState(s, today));
      setSummaryStatus("ready");
    } catch {
      if (request !== summaryRequestRef.current) return;
      setHealth("營運資料連線異常，請稍後重試");
      setSummaryStatus("error");
    }
  }, [
    summaryFilter.range,
    summaryFilter.startDate,
    summaryFilter.endDate,
    summaryFilter.customerId,
    summaryFilter.driverId,
    summaryFilter.billingType,
    today,
  ]);

  const refreshMasters = useCallback(async (kinds?: MasterKind[], force = false): Promise<void> => {
    const want = kinds ?? (["customers", "products", "drivers", "vehicles", "zones"] as MasterKind[]);
    const now = Date.now();
    const need = force
      ? want
      : want.filter((k) => {
          const at = masterFetchedAtRef.current[k];
          return at == null || now - at > MASTER_TTL_MS;
        });
    if (need.length === 0) return;

    const normMasters = (arr: unknown[]): CustomerMasterOption[] =>
      arr.map((x) => {
        const r = x as Record<string, unknown>;
        return {
          id: String(r.id),
          name: String(r.name ?? ""),
          sortOrder: Number(r.sortOrder ?? 0),
          isActive: r.isActive !== false,
        };
      });

    const tasks: Promise<void>[] = [];
    if (need.includes("customers")) {
      tasks.push(
        fetch("/api/customers")
          .then((r) => r.json())
          .then((c) => {
            setCustomers(Array.isArray(c) ? (c as Customer[]) : []);
            masterFetchedAtRef.current.customers = Date.now();
          }),
      );
    }
    if (need.includes("zones")) {
      tasks.push(
        Promise.all([
          fetch("/api/address-zones").then((r) => (r.ok ? r.json() : [])),
          fetch("/api/affiliated-companies").then((r) => (r.ok ? r.json() : [])),
        ]).then(([zones, companies]) => {
          setAddressZones(normMasters(Array.isArray(zones) ? zones : []));
          setAffiliatedCompanies(normMasters(Array.isArray(companies) ? companies : []));
          masterFetchedAtRef.current.zones = Date.now();
        }),
      );
    }
    if (need.includes("products")) {
      tasks.push(
        fetch("/api/products")
          .then((r) => r.json())
          .then((p) => {
            setProducts(asArray<Product>(p));
            masterFetchedAtRef.current.products = Date.now();
          }),
      );
    }
    if (need.includes("drivers")) {
      tasks.push(
        fetch("/api/drivers")
          .then((r) => r.json())
          .then((d) => {
            setDrivers(asArray<Driver>(d));
            masterFetchedAtRef.current.drivers = Date.now();
          }),
      );
    }
    if (need.includes("vehicles")) {
      tasks.push(
        fetch("/api/vehicles")
          .then((r) => r.json())
          .then((v) => {
            setVehicles(asArray<Vehicle>(v));
            masterFetchedAtRef.current.vehicles = Date.now();
          }),
      );
    }
    await Promise.all(tasks);
  }, []);

  // 初次載入：主檔（TTL）＋訂單＋明細＋摘要
  useEffect(() => {
    void loadDashboard({ forceMasters: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 僅掛載一次；摘要篩選變更改由 loadSummary
  }, []);

  // 摘要篩選變更：只刷新摘要，不重抓客戶／商品等主檔
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const selectedCustomer = customers.find((c) => String(c.id) === form.customerId);

  const onSubmitCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormMessage("");

    if (!form.customerId || !form.deliveryAddressId) {
      setFormMessage("請選擇客戶與送貨地址。");
      return;
    }

    const filled = form.lines.filter((l) => l.productId.trim() !== "");
    if (filled.length === 0) {
      setFormMessage("請至少新增一筆商品明細（輸入 3 碼商品編號）。");
      return;
    }
    if (!filled.every((l) => Number.isInteger(l.qty) && l.qty >= 0)) {
      setFormMessage("數量須為非負整數（0 表示數量待定，配送回報時再填實際桶數）。");
      return;
    }
    if (filled.length > 30) {
      setFormMessage("單筆訂單最多 30 項商品明細。");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/sales-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: form.customerId,
          deliveryAddressId: form.deliveryAddressId,
          scheduledDeliveryDate: form.scheduledDeliveryDate || undefined,
          remark: form.remark,
          cashInvoiceMode: form.cashInvoiceMode,
          lines: filled.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice.trim() === "" ? undefined : Number(l.unitPrice),
            billingType: l.billingType,
            linePurpose: l.linePurpose,
            isReplenishment: Boolean(l.isReplenishment),
          })),
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setFormMessage(payload.message ?? "建立訂單失敗");
        return;
      }
      const slip = await slipFromDashboardOrderWithAnnouncement(payload.data as Record<string, unknown>);
      setLastOrderSlipForPrint(slip);
      setFormMessage(`建立成功：${payload.data.orderNo}`);
      const layout = loadOrderPrintLayout();
      if (layout.autoPrintAfterCreate) {
        const ok = openOrderPrintWindow(slip, layout);
        if (!ok) {
          setFormMessage(
            `建立成功：${payload.data.orderNo}（瀏覽器阻擋列印視窗，請允許彈出視窗後點「列印上一筆訂單」補印）`,
          );
        }
      }
      setForm((prev) => ({
        ...prev,
        lines: [newOrderFormLine(defaultLineBillingForCustomer(selectedCustomer))],
        scheduledDeliveryDate: todayLocalYmd(),
        remark: "",
        cashInvoiceMode: "none",
      }));
      await loadOrders();
      await loadSummary();
    } catch {
      setFormMessage("建立訂單時發生錯誤，請稍後重試。");
    } finally {
      setSaving(false);
    }
  };

  const onSubmitAssign = async (e: React.FormEvent): Promise<boolean> => {
    e.preventDefault();
    setAssignMessage("");
    if (!assignForm.salesOrderId || !assignForm.driverId || !assignForm.assignmentDate) {
      setAssignMessage("請完整填寫：訂單、司機、配送日。（車輛為選填）");
      return false;
    }

    setAssigning(true);
    try {
      const res = await fetch("/api/delivery-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesOrderId: assignForm.salesOrderId,
          driverId: assignForm.driverId,
          vehicleId: assignForm.vehicleId || undefined,
          assignmentDate: assignForm.assignmentDate,
          estimatedDeliverySlot: assignForm.estimatedDeliverySlot.trim() || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setAssignMessage(payload.message ?? "分派失敗");
        return false;
      }
      const warnings = Array.isArray(payload.warnings) ? (payload.warnings as string[]) : [];
      const warnText = warnings.length > 0 ? `（注意：${warnings.join("；")}）` : "";
      setAssignMessage(`分派成功：${payload.data.salesOrder?.orderNo ?? ""}${warnText}`);
      setAssignForm((prev) => ({ ...prev, estimatedDeliverySlot: "" }));
      await loadOrders();
      return true;
    } catch {
      setAssignMessage("分派時發生錯誤，請稍後重試。");
      return false;
    } finally {
      setAssigning(false);
    }
  };

  const onSubmitNewProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setProductMessage("");
    if (!productForm.name.trim()) {
      setProductMessage("請填寫商品名稱。");
      return;
    }
    const pc = productForm.productCode.trim();
    if (!/^\d{3}$/.test(pc)) {
      setProductMessage("請填寫 3 碼數字的商品編號。");
      return;
    }
    setProductSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productCode: pc,
          name: productForm.name.trim(),
          sku: productForm.sku.trim() || undefined,
          unit: productForm.unit.trim() || "桶",
          countsDepositBarrel: productForm.countsDepositBarrel,
          consumesPrepaidBarrel: productForm.consumesPrepaidBarrel,
          availableOnLiff: productForm.availableOnLiff,
          salePrice: Number(productForm.salePrice),
          costPrice: Number(productForm.costPrice),
          driverDeliveryWage: Number(productForm.driverDeliveryWage),
          initialQty: Number(productForm.initialQty),
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setProductMessage(payload.message ?? "新增商品失敗");
        return;
      }
      setProductMessage("新增商品成功");
      setProductForm({
        productCode: "",
        name: "",
        sku: "",
        unit: "桶",
        countsDepositBarrel: false,
        consumesPrepaidBarrel: false,
        availableOnLiff: false,
        salePrice: "0",
        costPrice: "0",
        driverDeliveryWage: "0",
        initialQty: "0",
      });
      await refreshMasters(["products"], true);
    } catch {
      setProductMessage("新增商品時發生錯誤，請稍後重試。");
    } finally {
      setProductSaving(false);
    }
  };

  const onSubmitNewVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    setVehicleMessage("");
    if (!vehicleForm.plateNo.trim()) {
      setVehicleMessage("請填寫車牌。");
      return;
    }
    setVehicleSaving(true);
    try {
      const res = await fetch("/api/vehicles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plateNo: vehicleForm.plateNo.trim(),
          description: vehicleForm.description.trim() || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setVehicleMessage(payload.message ?? "新增車輛失敗");
        return;
      }
      setVehicleMessage("新增車輛成功");
      setVehicleForm({ plateNo: "", description: "" });
      await refreshMasters(["vehicles"], true);
    } catch {
      setVehicleMessage("新增車輛時發生錯誤，請稍後重試。");
    } finally {
      setVehicleSaving(false);
    }
  };

  const onSubmitNewDriver = async (e: React.FormEvent) => {
    e.preventDefault();
    setDriverMessage("");
    if (!driverForm.name.trim() || !driverForm.employeeCode.trim() || !driverForm.password) {
      setDriverMessage("請填寫姓名、員編、密碼。");
      return;
    }
    setDriverSaving(true);
    try {
      const res = await fetch("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: driverForm.name.trim(),
          employeeCode: driverForm.employeeCode.trim(),
          phone: driverForm.phone.trim() || undefined,
          password: driverForm.password,
          vehicleId: driverForm.vehicleId || undefined,
          maxOrderCount: Math.floor(Number(driverForm.maxOrderCount)),
          maxBarrelQty: Math.floor(Number(driverForm.maxBarrelQty)),
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setDriverMessage(payload.message ?? "新增司機失敗");
        return;
      }
      setDriverMessage("新增司機成功");
      setDriverForm((prev) => ({ ...prev, name: "", employeeCode: "", phone: "", password: "", vehicleId: "", maxOrderCount: "20", maxBarrelQty: "150" }));
      await refreshMasters(["drivers", "vehicles"], true);
    } catch {
      setDriverMessage("新增司機時發生錯誤，請稍後重試。");
    } finally {
      setDriverSaving(false);
    }
  };

  const onCancelOrder = async (salesOrderId: string) => {
    const ok = window.confirm(
      "確定要取消此訂單嗎？（已分派司機、已核銷或已有收款／沖帳者不可取消；取消後將作廢帳務立帳）",
    );
    if (!ok) return;

    try {
      const res = await fetch(`/api/sales-orders/${salesOrderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "系統取消" }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        alert(payload.message ?? "取消失敗");
        return;
      }
      await loadOrders();
    } catch {
      alert("取消時發生錯誤，請稍後重試。");
    }
  };

  const toCsvCell = (value: unknown): string => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, "\"\"")}"`;
  };

  const downloadCsv = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const lines = [headers.map(toCsvCell).join(","), ...rows.map((r) => r.map(toCsvCell).join(","))];
    const csv = `\uFEFF${lines.join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportCompletedDeliveriesCsv = () => {
    const rows = completedDeliveries.map((row) => [
      row.completedAt ? String(row.completedAt).slice(0, 19).replace("T", " ") : "",
      row.salesOrder?.orderNo ?? "",
      row.salesOrder?.customer?.name ?? "",
      [row.driver?.user?.employeeCode, row.driver?.user?.name].filter(Boolean).join(" / ") || "",
      row.vehicle?.plateNo ?? "",
      row.emptyBarrelsReturned ?? 0,
      row.cashReceived ?? 0,
    ]);
    downloadCsv(`completed-deliveries-${summary.startDate}-to-${summary.endDate}.csv`, ["完成時間", "單號", "客戶", "司機", "車輛", "空桶回收", "現收"], rows);
  };

  const exportPaymentsCsv = () => {
    const rows = payments.map((p) => [
      p.paidAt ? String(p.paidAt).slice(0, 19).replace("T", " ") : "",
      p.customer?.name ?? "",
      p.salesOrder?.orderNo ?? "",
      p.paymentMethod ?? "",
      p.amount ?? 0,
      p.note ?? "",
    ]);
    downloadCsv(`payments-${summary.startDate}-to-${summary.endDate}.csv`, ["收款時間", "客戶", "訂單", "方式", "金額", "備註"], rows);
  };

  const value: DashboardContextValue = {
    health,
    customers,
    addressZones,
    affiliatedCompanies,
    products,
    drivers,
    vehicles,
    orders,
    completedDeliveries,
    payments,
    summary,
    summaryStatus,
    summaryFilter,
    setSummaryFilter,
    error,
    loadDashboard,
    loadOrders,
    loadSummary,
    refreshMasters,
    selectedCustomer,
    saving,
    formMessage,
    form,
    setForm,
    onSubmitCreateOrder,
    lastOrderSlipForPrint,
    clearLastOrderSlipForPrint: () => setLastOrderSlipForPrint(null),
    assigning,
    assignMessage,
    assignForm,
    setAssignForm,
    onSubmitAssign,
    driverSaving,
    driverMessage,
    driverForm,
    setDriverForm,
    onSubmitNewDriver,
    vehicleSaving,
    vehicleMessage,
    vehicleForm,
    setVehicleForm,
    onSubmitNewVehicle,
    productSaving,
    productMessage,
    productForm,
    setProductForm,
    onSubmitNewProduct,
    onCancelOrder,
    exportCompletedDeliveriesCsv,
    exportPaymentsCsv,
    driverEmployeeCode,
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
