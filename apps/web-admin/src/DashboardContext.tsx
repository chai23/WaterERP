import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
    periodOrderOutstanding: Number(row.periodOrderOutstanding ?? row.unpaidAmount ?? 0),
  };
};

export type LineBillingType = "cash" | "monthly" | "prepaid";

/** delivery：一般出貨；prepaid_barrel_topup：預付桶儲值（不出庫，核銷收款後入桶數） */
export type LinePurpose = "delivery" | "prepaid_barrel_topup";

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
  summaryFilter: { range: string; startDate: string; endDate: string };
  setSummaryFilter: React.Dispatch<React.SetStateAction<{ range: string; startDate: string; endDate: string }>>;
  error: string;
  loadDashboard: () => Promise<void>;
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
  const [summaryFilter, setSummaryFilter] = useState({
    range: "today",
    startDate: today,
    endDate: today,
  });
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

  const loadDashboard = useCallback((): Promise<void> => {
    setError("");
    const params = new URLSearchParams();
    params.set("range", summaryFilter.range);
    if (summaryFilter.range === "custom") {
      params.set("startDate", summaryFilter.startDate);
      params.set("endDate", summaryFilter.endDate);
    }
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

    return Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/customers"),
      fetchJsonOrEmpty("/api/address-zones"),
      fetchJsonOrEmpty("/api/affiliated-companies"),
      fetchJson("/api/products"),
      fetchJson("/api/drivers"),
      fetchJson("/api/vehicles"),
      fetchJson("/api/sales-orders"),
      fetchJson("/api/completed-deliveries"),
      fetchJson("/api/payments"),
      fetchJson(summaryUrl),
    ])
      .then(([h, c, zones, companies, p, d, v, o, cd, pay, s]) => {
        setHealth(JSON.stringify(h));
        setCustomers(Array.isArray(c) ? (c as Customer[]) : []);
        setAddressZones(normMasters(zones as unknown[]));
        setAffiliatedCompanies(normMasters(companies as unknown[]));
        setProducts(asArray<Product>(p));
        setDrivers(asArray<Driver>(d));
        setVehicles(asArray<Vehicle>(v));
        setOrders(asArray(o));
        setCompletedDeliveries(asArray(cd));
        setPayments(asArray(pay));
        setSummary(asSummaryState(s, today));
      })
      .catch(() => {
        setHealth("無法連線 API（請確認 apps/api 已啟動）");
        setError("資料讀取失敗，請檢查 API 是否正常或資料庫是否有資料。");
      });
  }, [summaryFilter.range, summaryFilter.startDate, summaryFilter.endDate]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

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
      loadDashboard();
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
      loadDashboard();
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
      loadDashboard();
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
      loadDashboard();
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
      loadDashboard();
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
      loadDashboard();
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
    summaryFilter,
    setSummaryFilter,
    error,
    loadDashboard,
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
