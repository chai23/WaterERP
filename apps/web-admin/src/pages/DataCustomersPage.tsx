import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LegacyMasterSync } from "../components/LegacyMasterSync";
import type {
  Address,
  Customer,
  CustomerBillingLedgerData,
  CustomerBillingSummary,
  CustomerChurnReason,
  CustomerDetail,
  CustomerLifecycleEventRow,
  CustomerMasterOption,
  CustomerPaymentRow,
} from "../adminUtils";
import {
  barrelCollectionSourceBadgeClass,
  barrelCollectionSourceLabel,
  barrelPickupStatusBadgeClass,
  barrelPickupStatusLabel,
  billingTypeLabel,
  emptyPatrolForm,
  fmtLocalYmd,
  formatBarrelSiteChangeSummary,
  geocodeStatusMeta,
  ledgerEntryTypeLabel,
  moneyText,
  orderStatusBadgeClass,
  PATROL_INTERVAL_OPTIONS,
  PATROL_WEEKDAY_OPTIONS,
  patrolFormFromAddress,
  patrolFormToApi,
  patrolScheduleLabel,
  mondayOfWeekYmd,
  sumCustomerBarrelsOnSite,
  todayLocalYmd,
  withPatrolInterval,
  withPatrolWeekdayToggle,
  type PatrolFormValue,
} from "../adminUtils";
import AddressGeocodePanel from "../components/AddressGeocodePanel";
import { OrderDetailModal, type OrderRecord } from "../components/OrderDetailModal";
import { cashInvoiceModeLabel } from "../taxDisplay";
import { formatDeliveryFloor } from "../floorBonusUtils";

function parseBillingType(raw: string | undefined): "cash" | "monthly" | "prepaid" {
  if (raw === "monthly" || raw === "prepaid") return raw;
  return "cash";
}

function orderStatusLabel(status: string | undefined): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "confirmed":
      return "已確認";
    case "assigned":
      return "已分派";
    case "delivering":
      return "配送中";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return status ?? "—";
  }
}
import { useDashboard } from "../DashboardContext";
import { useAuth } from "../AuthContext";
import { useMediaQuery } from "../useMediaQuery";

type WorkspaceTab = "summary" | "orders" | "billing" | "edit";
type PageMode = "browse" | "create";
type BillingFilter = "all" | "cash" | "monthly" | "prepaid";
type LifecycleFilter = "all" | "active" | "churned";

type AddressFormRow = {
  key: string;
  label: string;
  addressLine: string;
  contactName: string;
  contactPhone: string;
  contactMobile: string;
  isDefault: boolean;
  barrelsOnSite: string;
  patrol: PatrolFormValue;
  targetWaterLevel: string;
  patrolProductId: string;
};

function emptyAddressRow(isDefault: boolean): AddressFormRow {
  return {
    key: newRowKey(),
    label: "",
    addressLine: "",
    contactName: "",
    contactPhone: "",
    contactMobile: "",
    isDefault,
    barrelsOnSite: "0",
    patrol: emptyPatrolForm(),
    targetWaterLevel: "",
    patrolProductId: "",
  };
}

function PatrolScheduleFields({
  value,
  onChange,
  idPrefix,
}: {
  value: PatrolFormValue;
  onChange: (next: PatrolFormValue) => void;
  idPrefix: string;
}) {
  const intervalNum = Math.floor(Number(value.intervalWeeks)) || 0;
  const multiAllowed = intervalNum <= 1;
  return (
    <>
      <label className="customer-address-field">
        <span>巡查頻率</span>
        <select
          id={`${idPrefix}-interval`}
          value={value.intervalWeeks}
          onChange={(e) => onChange(withPatrolInterval(value, e.target.value, todayLocalYmd()))}
        >
          <option value="">不參加週期巡查</option>
          {PATROL_INTERVAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {value.intervalWeeks ? (
        <div className="customer-address-field customer-address-field--wide">
          <span>{multiAllowed ? "巡查星期（可複選）" : "巡查星期（僅能選一天）"}</span>
          <div className="patrol-weekday-picks" role="group" aria-label="巡查星期">
            {PATROL_WEEKDAY_OPTIONS.map((o) => {
              const on = value.weekdays.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  className={`patrol-weekday-pick${on ? " patrol-weekday-pick--on" : ""}`}
                  aria-pressed={on}
                  onClick={() => onChange(withPatrolWeekdayToggle(value, o.value))}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {intervalNum >= 2 ? (
        <label className="customer-address-field">
          <span>起始週（週一）</span>
          <input
            id={`${idPrefix}-anchor`}
            type="date"
            value={value.cycleAnchor}
            onChange={(e) => onChange({ ...value, cycleAnchor: mondayOfWeekYmd(e.target.value) })}
          />
        </label>
      ) : null}
    </>
  );
}

type CustomerBarrelCollectionRow = {
  id: string;
  sourceType: "pickup" | "delivery";
  refNo?: string;
  refId?: string;
  status: string;
  collectionDate?: string | null;
  pickupDate?: string | null;
  barrelsExpected?: number | null;
  barrelsReturned?: number | null;
  barrelsDelivered?: number | null;
  barrelNet?: number | null;
  barrelsOnSiteBefore?: number | null;
  barrelsOnSiteAfter?: number | null;
  barrelSiteChangeSummary?: string | null;
  barrelSitePreview?: boolean;
  driverNote?: string | null;
  remark?: string | null;
  note?: string | null;
  driverReportedAt?: string | null;
  officeSettledAt?: string | null;
  deliveryAddress?: { id?: string; label?: string | null; addressLine?: string };
  driver?: { user?: { employeeCode?: string; name?: string } };
};

type DefaultInvoiceMode = "none" | "tax_inclusive" | "tax_exclusive";

function parseDefaultInvoice(raw: string | null | undefined): DefaultInvoiceMode {
  if (raw === "tax_inclusive" || raw === "tax_exclusive") return raw;
  return "none";
}

function mergeMasterOptions(
  active: CustomerMasterOption[],
  current?: { id: string; name: string; isActive?: boolean } | null,
): CustomerMasterOption[] {
  if (!current?.id) return active;
  const id = String(current.id);
  if (active.some((o) => String(o.id) === id)) return active;
  return [...active, { id, name: current.name, isActive: current.isActive }];
}

function newRowKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `a-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeCustomerCode(raw: string): string | null {
  const code = raw.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code;
}

function matchCustomerOverviewQuery(c: Customer, q: string): boolean {
  const haystacks = [
    c.customerCode,
    c.name,
    c.contactName,
    c.phone,
    c.mobile,
    c.taxId,
    c.addressZone?.name,
    c.affiliatedCompany?.name,
    c.standingRemark,
    c.notes,
    String(c.id),
    ...(c.addresses ?? []).flatMap((a) => [
      a.label,
      a.addressLine,
      a.contactName,
      a.contactPhone,
      a.contactMobile,
    ]),
  ];
  return haystacks.some((v) => (v ?? "").toLowerCase().includes(q));
}

function defaultCustomerAddress(c: Customer): Address | null {
  const addrs = c.addresses ?? [];
  if (addrs.length === 0) return null;
  return addrs.find((a) => a.isDefault) ?? addrs[0];
}

function fmtMoney(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function billingTypeBadgeClass(code: string | null | undefined): string {
  switch (code) {
    case "monthly":
      return "badge badge--assigned";
    case "prepaid":
      return "badge badge--delivering";
    case "cash":
    default:
      return "badge badge--default";
  }
}

function lifecycleEventLabel(type: string): string {
  switch (type) {
    case "created":
      return "建檔";
    case "churned":
      return "流失";
    case "reactivated":
      return "回流";
    default:
      return type;
  }
}

export default function DataCustomersPage() {
  const { customers, addressZones, affiliatedCompanies, products, refreshMasters } = useDashboard();
  const { user } = useAuth();
  const canIssueLineBind = user?.role === "admin" || user?.role === "accounting" || user?.role === "dispatcher";
  const canUnbindLine = user?.role === "admin";
  const activeProducts = useMemo(() => products.filter((p) => p.isActive !== false), [products]);
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [lineBindIssued, setLineBindIssued] = useState<{
    customerCode: string;
    bindCode: string;
    expiresAt: string;
  } | null>(null);
  const [issuingBindCode, setIssuingBindCode] = useState(false);

  useEffect(() => {
    void refreshMasters(["customers", "zones", "products"], false);
  }, [refreshMasters]);

  const [pageMode, setPageMode] = useState<PageMode>("browse");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("summary");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  useEffect(() => {
    setLineBindIssued(null);
  }, [detailId]);
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("all");
  const [churnReasons, setChurnReasons] = useState<CustomerChurnReason[]>([]);
  const [lifecycleEvents, setLifecycleEvents] = useState<CustomerLifecycleEventRow[]>([]);
  const [lifecycleEventsLoading, setLifecycleEventsLoading] = useState(false);
  const [churnReasonId, setChurnReasonId] = useState("");
  const [churnReasonNote, setChurnReasonNote] = useState("");
  const [churnedAtYmd, setChurnedAtYmd] = useState(() => todayLocalYmd());
  const [reactivateNote, setReactivateNote] = useState("");
  const [reactivatedAtYmd, setReactivatedAtYmd] = useState(() => todayLocalYmd());
  const [lifecycleActionMsg, setLifecycleActionMsg] = useState("");
  const [lifecycleActionLoading, setLifecycleActionLoading] = useState(false);
  const [lifecyclePanelOpen, setLifecyclePanelOpen] = useState(false);
  const [barrelCollections, setBarrelCollections] = useState<CustomerBarrelCollectionRow[]>([]);
  const [barrelCollectionsLoading, setBarrelCollectionsLoading] = useState(false);
  const [barrelCollectionsErr, setBarrelCollectionsErr] = useState("");
  const [barrelOrderDetail, setBarrelOrderDetail] = useState<OrderRecord | null>(null);
  const [barrelOrderDetailLoading, setBarrelOrderDetailLoading] = useState(false);

  const displayedCustomers = useMemo(() => {
    let list = customers;
    if (billingFilter !== "all") {
      list = list.filter((c) => c.billingType === billingFilter);
    }
    if (lifecycleFilter === "active") {
      list = list.filter((c) => (c.lifecycleStatus ?? "active") !== "churned");
    } else if (lifecycleFilter === "churned") {
      list = list.filter((c) => c.lifecycleStatus === "churned");
    }
    const q = customerSearch.trim().toLowerCase();
    if (q) list = list.filter((c) => matchCustomerOverviewQuery(c, q));
    return list;
  }, [customers, customerSearch, billingFilter, lifecycleFilter]);

  const selectedListCustomer = useMemo(() => {
    if (!detailId) return null;
    return customers.find((c) => String(c.id) === detailId) ?? null;
  }, [customers, detailId]);

  useEffect(() => {
    if (pageMode !== "browse") return;
    if (displayedCustomers.length === 0) {
      setDetailId(null);
      return;
    }
    setDetailId((prev) => {
      if (prev && displayedCustomers.some((c) => String(c.id) === prev)) return prev;
      return String(displayedCustomers[0].id);
    });
  }, [displayedCustomers, pageMode]);

  const loadBarrelCollections = useCallback(async (customerId: string) => {
    setBarrelCollectionsLoading(true);
    setBarrelCollectionsErr("");
    try {
      const params = new URLSearchParams({ customerId, source: "all" });
      const res = await fetch(`/api/barrel-collections?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setBarrelCollections([]);
        setBarrelCollectionsErr(typeof data?.message === "string" ? data.message : "讀取空桶回收紀錄失敗");
        return;
      }
      setBarrelCollections(Array.isArray(data) ? data : []);
    } catch {
      setBarrelCollections([]);
      setBarrelCollectionsErr("讀取空桶回收紀錄失敗");
    } finally {
      setBarrelCollectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pageMode !== "browse" || !detailId) {
      setBarrelCollections([]);
      setBarrelCollectionsErr("");
      return;
    }
    void loadBarrelCollections(detailId);
  }, [pageMode, detailId, loadBarrelCollections]);

  const openBarrelCollectionOrder = async (row: CustomerBarrelCollectionRow) => {
    if (row.sourceType !== "delivery" || !row.refId) return;
    setBarrelOrderDetailLoading(true);
    try {
      const res = await fetch(`/api/sales-orders/${encodeURIComponent(row.refId)}`);
      const data = await res.json();
      if (!res.ok) {
        window.alert(typeof data?.message === "string" ? data.message : "讀取訂單失敗");
        return;
      }
      setBarrelOrderDetail(data as OrderRecord);
    } catch {
      window.alert("讀取訂單失敗");
    } finally {
      setBarrelOrderDetailLoading(false);
    }
  };

  const clearCustomerSearch = () => {
    setCustomerSearch("");
    setBillingFilter("all");
    setLifecycleFilter("all");
  };

  useEffect(() => {
    void fetch("/api/customer-churn-reasons")
      .then((r) => r.json())
      .then((payload) => {
        if (payload?.ok && Array.isArray(payload.data)) {
          setChurnReasons(payload.data as CustomerChurnReason[]);
        }
      })
      .catch(() => {});
  }, []);

  const loadLifecycleEvents = useCallback(async (id: string) => {
    setLifecycleEventsLoading(true);
    try {
      const res = await fetch(`/api/customers/${id}/lifecycle-events`);
      const payload = await res.json();
      setLifecycleEvents(payload?.ok && Array.isArray(payload.data) ? (payload.data as CustomerLifecycleEventRow[]) : []);
    } catch {
      setLifecycleEvents([]);
    } finally {
      setLifecycleEventsLoading(false);
    }
  }, []);

  const markCustomerChurn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailId || !churnReasonId) {
      setLifecycleActionMsg("請選擇流失原因");
      return;
    }
    const reason = churnReasons.find((r) => r.id === churnReasonId);
    if (reason?.code === "other" && !churnReasonNote.trim()) {
      setLifecycleActionMsg("原因為「其他」時請填寫說明");
      return;
    }
    if (!window.confirm("確定標記此客戶為流失？之後無法為其開新訂單，巡查亦會略過。")) return;
    setLifecycleActionLoading(true);
    setLifecycleActionMsg("");
    try {
      const res = await fetch(`/api/customers/${detailId}/churn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          churnReasonId,
          churnReasonNote: churnReasonNote.trim() || undefined,
          churnedAtYmd,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setLifecycleActionMsg(payload.message ?? "標記流失失敗");
        return;
      }
      const warnings = Array.isArray(payload.warnings) ? (payload.warnings as string[]) : [];
      setLifecycleActionMsg(
        warnings.length > 0 ? `已標記流失（提醒：${warnings.join("；")}）` : "已標記流失",
      );
      setLifecyclePanelOpen(true);
      await refreshMasters(["customers"], true);
      await fetchDetail(detailId);
      await loadLifecycleEvents(detailId);
    } catch {
      setLifecycleActionMsg("無法連線 API");
    } finally {
      setLifecycleActionLoading(false);
    }
  };

  const reactivateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailId) return;
    if (!window.confirm("確定將此客戶標記為回流（恢復使用中）？")) return;
    setLifecycleActionLoading(true);
    setLifecycleActionMsg("");
    try {
      const res = await fetch(`/api/customers/${detailId}/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: reactivateNote.trim() || undefined,
          reactivatedAtYmd,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setLifecycleActionMsg(payload.message ?? "標記回流失敗");
        return;
      }
      setLifecycleActionMsg("已標記回流，客戶恢復使用中");
      await refreshMasters(["customers"], true);
      await fetchDetail(detailId);
      await loadLifecycleEvents(detailId);
    } catch {
      setLifecycleActionMsg("無法連線 API");
    } finally {
      setLifecycleActionLoading(false);
    }
  };

  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState("");

  const [name, setName] = useState("");
  const [customerCode, setCustomerCode] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [mobile, setMobile] = useState("");
  const [taxId, setTaxId] = useState("");
  const [defaultCashInvoiceMode, setDefaultCashInvoiceMode] = useState<DefaultInvoiceMode>("none");
  const [addressZoneId, setAddressZoneId] = useState("");
  const [affiliatedCompanyId, setAffiliatedCompanyId] = useState("");
  const [standingRemark, setStandingRemark] = useState("");
  const [billingType, setBillingType] = useState<"cash" | "monthly" | "prepaid">("cash");
  const [createMonthlyDay, setCreateMonthlyDay] = useState("");
  const [createAllowOverdraft, setCreateAllowOverdraft] = useState(false);
  const [creditLimit, setCreditLimit] = useState("0");
  const [notes, setNotes] = useState("");
  const [addressRows, setAddressRows] = useState<AddressFormRow[]>(() => [emptyAddressRow(true)]);

  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const editZoneOptions = useMemo(
    () => mergeMasterOptions(addressZones, detail?.addressZone ?? null),
    [addressZones, detail?.addressZone],
  );
  const editCompanyOptions = useMemo(
    () => mergeMasterOptions(affiliatedCompanies, detail?.affiliatedCompany ?? null),
    [affiliatedCompanies, detail?.affiliatedCompany],
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState("");

  const [newAddrLabel, setNewAddrLabel] = useState("");
  const [newAddrLine, setNewAddrLine] = useState("");
  const [newAddrContactName, setNewAddrContactName] = useState("");
  const [newAddrContactPhone, setNewAddrContactPhone] = useState("");
  const [newAddrContactMobile, setNewAddrContactMobile] = useState("");
  const [newAddrDefault, setNewAddrDefault] = useState(false);
  const [newAddrFloor, setNewAddrFloor] = useState("");
  const [newAddrPatrol, setNewAddrPatrol] = useState<PatrolFormValue>(() => emptyPatrolForm());
  const [newAddrTargetWaterLevel, setNewAddrTargetWaterLevel] = useState("");
  const [newAddrPatrolProductId, setNewAddrPatrolProductId] = useState("");
  const [addingAddr, setAddingAddr] = useState(false);
  const [addAddrMsg, setAddAddrMsg] = useState("");

  const [billingSummary, setBillingSummary] = useState<CustomerBillingSummary | null>(null);
  const [billingLedger, setBillingLedger] = useState<CustomerBillingLedgerData | null>(null);
  const [billingLedgerErr, setBillingLedgerErr] = useState("");
  const [customerPayments, setCustomerPayments] = useState<CustomerPaymentRow[]>([]);
  const [paymentsErr, setPaymentsErr] = useState("");

  const [editBasicName, setEditBasicName] = useState("");
  const [editBasicCustomerCode, setEditBasicCustomerCode] = useState("");
  const [editBasicContactName, setEditBasicContactName] = useState("");
  const [editBasicPhone, setEditBasicPhone] = useState("");
  const [editBasicMobile, setEditBasicMobile] = useState("");
  const [editBasicTaxId, setEditBasicTaxId] = useState("");
  const [editBasicDefaultInvoice, setEditBasicDefaultInvoice] = useState<DefaultInvoiceMode>("none");
  const [editBasicAddressZoneId, setEditBasicAddressZoneId] = useState("");
  const [editBasicAffiliatedCompanyId, setEditBasicAffiliatedCompanyId] = useState("");
  const [editBasicStandingRemark, setEditBasicStandingRemark] = useState("");
  const [editBasicBilling, setEditBasicBilling] = useState<"cash" | "monthly" | "prepaid">("cash");
  const [editBasicMonthlyDay, setEditBasicMonthlyDay] = useState("");
  const [editBasicAllowOverdraft, setEditBasicAllowOverdraft] = useState(false);
  const [editBasicCredit, setEditBasicCredit] = useState("0");
  const [editBasicNotes, setEditBasicNotes] = useState("");
  const [patchBasicSaving, setPatchBasicSaving] = useState(false);
  const [patchBasicMsg, setPatchBasicMsg] = useState("");

  const [editAddrId, setEditAddrId] = useState<string | null>(null);
  const [editAddrLabel, setEditAddrLabel] = useState("");
  const [editAddrLine, setEditAddrLine] = useState("");
  const [editAddrContactName, setEditAddrContactName] = useState("");
  const [editAddrContactPhone, setEditAddrContactPhone] = useState("");
  const [editAddrContactMobile, setEditAddrContactMobile] = useState("");
  const [editAddrDefault, setEditAddrDefault] = useState(false);
  const [editAddrBarrels, setEditAddrBarrels] = useState("0");
  const [editAddrFloor, setEditAddrFloor] = useState("");
  const [editAddrPatrol, setEditAddrPatrol] = useState<PatrolFormValue>(() => emptyPatrolForm());
  const [editAddrTargetWaterLevel, setEditAddrTargetWaterLevel] = useState("");
  const [editAddrPatrolProductId, setEditAddrPatrolProductId] = useState("");
  const [patchAddrSaving, setPatchAddrSaving] = useState(false);
  const [patchAddrMsg, setPatchAddrMsg] = useState("");
  const [deletingAddrId, setDeletingAddrId] = useState<string | null>(null);

  const [showAddAddressForm, setShowAddAddressForm] = useState(false);

  const resetCreateForm = () => {
    setName("");
    setCustomerCode("");
    setContactName("");
    setPhone("");
    setMobile("");
    setTaxId("");
    setDefaultCashInvoiceMode("none");
    setAddressZoneId("");
    setAffiliatedCompanyId("");
    setStandingRemark("");
    setBillingType("cash");
    setCreateMonthlyDay("");
    setCreateAllowOverdraft(false);
    setCreditLimit("0");
    setNotes("");
    setAddressRows([emptyAddressRow(true)]);
    setFormMessage("");
  };

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailErr("");
    setBillingSummary(null);
    setBillingLedger(null);
    setBillingLedgerErr("");
    setCustomerPayments([]);
    setPaymentsErr("");
    try {
      const res = await fetch(`/api/customers/${id}`);
      const data = await res.json();
      if (!res.ok) {
        setDetail(null);
        setDetailErr(data.message ?? "讀取客戶失敗");
        return;
      }
      const d = data as CustomerDetail;
      setDetail(d);
      setLifecyclePanelOpen(d.lifecycleStatus === "churned");
      setEditBasicName(d.name);
      setEditBasicCustomerCode(d.customerCode ?? "");
      setEditBasicContactName(d.contactName ?? "");
      setEditBasicPhone(d.phone ?? "");
      setEditBasicMobile(d.mobile ?? "");
      setEditBasicTaxId(d.taxId ?? "");
      setEditBasicDefaultInvoice(parseDefaultInvoice(d.defaultCashInvoiceMode));
      setEditBasicAddressZoneId(
        d.addressZoneId != null ? String(d.addressZoneId) : d.addressZone?.id != null ? String(d.addressZone.id) : "",
      );
      setEditBasicAffiliatedCompanyId(
        d.affiliatedCompanyId != null
          ? String(d.affiliatedCompanyId)
          : d.affiliatedCompany?.id != null
            ? String(d.affiliatedCompany.id)
            : "",
      );
      setEditBasicStandingRemark(d.standingRemark ?? "");
      setEditBasicBilling(parseBillingType(d.billingType));
      setEditBasicMonthlyDay(d.monthlySettlementDay != null ? String(d.monthlySettlementDay) : "");
      setEditBasicAllowOverdraft(Boolean(d.allowPrepaidOverdraft));
      setEditBasicCredit(String(d.creditLimit ?? "0"));
      setEditBasicNotes(d.notes ?? "");
      const [sumRes, ledRes, payRes] = await Promise.all([
        fetch(`/api/customers/${id}/billing-summary`),
        fetch(`/api/customers/${id}/billing-ledger?limit=300`),
        fetch(`/api/customers/${id}/payments?limit=100`),
      ]);
      if (sumRes.ok) {
        const sj = await sumRes.json();
        if (sj?.ok && sj.data) setBillingSummary(sj.data as CustomerBillingSummary);
        else setBillingSummary(null);
      } else {
        setBillingSummary(null);
      }
      setBillingLedgerErr("");
      setPaymentsErr("");
      try {
        if (ledRes.ok) {
          const lj = await ledRes.json();
          if (lj?.ok && lj.data) setBillingLedger(lj.data as CustomerBillingLedgerData);
          else {
            setBillingLedger(null);
            setBillingLedgerErr(lj?.message ?? "讀取帳務流水失敗");
          }
        } else {
          setBillingLedger(null);
          setBillingLedgerErr("讀取帳務流水失敗");
        }
      } catch {
        setBillingLedger(null);
        setBillingLedgerErr("讀取帳務流水失敗");
      }
      try {
        if (payRes.ok) {
          const pj = await payRes.json();
          if (pj?.ok && pj.data?.payments) setCustomerPayments(pj.data.payments as CustomerPaymentRow[]);
          else {
            setCustomerPayments([]);
            setPaymentsErr(pj?.message ?? "讀取收款紀錄失敗");
          }
        } else {
          setCustomerPayments([]);
          setPaymentsErr("讀取收款紀錄失敗");
        }
      } catch {
        setCustomerPayments([]);
        setPaymentsErr("讀取收款紀錄失敗");
      }
      setEditAddrId(null);
      setPatchBasicMsg("");
      setPatchAddrMsg("");
      void loadLifecycleEvents(id);
    } catch {
      setDetail(null);
      setBillingSummary(null);
      setBillingLedger(null);
      setCustomerPayments([]);
      setDetailErr("無法連線 API");
    } finally {
      setDetailLoading(false);
    }
  }, [loadLifecycleEvents]);

  useEffect(() => {
    if (detailId) {
      void fetchDetail(detailId);
    } else {
      setDetail(null);
      setBillingSummary(null);
      setBillingLedger(null);
      setBillingLedgerErr("");
      setCustomerPayments([]);
      setPaymentsErr("");
      setDetailErr("");
      setAddAddrMsg("");
      setPatchBasicMsg("");
      setPatchAddrMsg("");
      setEditAddrId(null);
      setShowAddAddressForm(false);
    }
  }, [detailId, fetchDetail]);

  const scrollToSection = (sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToEditSection = scrollToSection;

  const selectCustomer = (id: string, tab: WorkspaceTab = "summary") => {
    setDetailId(id);
    setPageMode("browse");
    setWorkspaceTab(tab);
    setLifecyclePanelOpen(false);
    setLifecycleActionMsg("");
  };

  const startCreateCustomer = () => {
    setPageMode("create");
    resetCreateForm();
  };

  const exitCreateCustomer = () => {
    setPageMode("browse");
    setWorkspaceTab("summary");
  };

  const customerOrderBillableAmount = (o: { orderBillableAmount?: string; totalAmount: string }) =>
    Number(o.orderBillableAmount ?? o.totalAmount);

  const customerOrderStats = useMemo(() => {
    const list = detail?.salesOrders ?? [];
    let totalAmount = 0;
    const byStatus: Record<string, number> = {};
    for (const o of list) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if (o.status === "cancelled") continue;
      const amt = customerOrderBillableAmount(o);
      if (Number.isFinite(amt)) totalAmount += amt;
    }
    return {
      count: list.length,
      totalAmount,
      completed: byStatus.completed ?? 0,
      inProgress: (byStatus.assigned ?? 0) + (byStatus.delivering ?? 0) + (byStatus.confirmed ?? 0),
      cancelled: byStatus.cancelled ?? 0,
    };
  }, [detail?.salesOrders]);

  const paymentsTotal = useMemo(() => {
    return customerPayments.reduce((sum, p) => {
      const n = Number(p.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }, [customerPayments]);

  const mergeDetailFromCustomerPayload = (cust: unknown) => {
    if (!cust || typeof cust !== "object") return;
    const c = cust as CustomerDetail;
    setDetail((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        ...c,
        salesOrders: prev.salesOrders,
      };
    });
    void refreshMasters(["customers"], true);
  };

  const patchAddressGeo = (addressId: string, patch: Partial<Address>) => {
    setDetail((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        addresses: (prev.addresses ?? []).map((a) =>
          String(a.id) === String(addressId) ? { ...a, ...patch } : a,
        ),
      };
    });
    void refreshMasters(["customers"], true);
  };

  const startEditAddress = (a: Address) => {
    setShowAddAddressForm(false);
    setEditAddrId(String(a.id));
    setEditAddrLabel(a.label ?? "");
    setEditAddrLine(a.addressLine);
    setEditAddrContactName(a.contactName ?? "");
    setEditAddrContactPhone(a.contactPhone ?? "");
    setEditAddrContactMobile(a.contactMobile ?? "");
    setEditAddrDefault(Boolean(a.isDefault));
    setEditAddrBarrels(String(a.barrelsOnSite ?? 0));
    setEditAddrFloor(a.deliveryFloor != null ? String(a.deliveryFloor) : "");
    setEditAddrPatrol(patrolFormFromAddress(a));
    setEditAddrTargetWaterLevel(a.targetWaterLevel != null ? String(a.targetWaterLevel) : "");
    setEditAddrPatrolProductId(a.patrolProductId != null ? String(a.patrolProductId) : a.patrolProduct?.id ? String(a.patrolProduct.id) : "");
    setPatchAddrMsg("");
    scrollToEditSection("edit-addresses");
  };

  const cancelEditAddress = () => {
    setEditAddrId(null);
    setPatchAddrMsg("");
  };

  const onSaveBasic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailId) return;
    setPatchBasicMsg("");
    const n = editBasicName.trim();
    if (!n) {
      setPatchBasicMsg("名稱不可為空");
      return;
    }
    const code = normalizeCustomerCode(editBasicCustomerCode);
    if (!code) {
      setPatchBasicMsg("客戶編號須為 6 碼數字");
      return;
    }
    const taxDigits = editBasicTaxId.trim().replace(/\D/g, "");
    if (taxDigits.length > 0 && taxDigits.length !== 8) {
      setPatchBasicMsg("統一編號須為 8 碼數字或留空");
      return;
    }
    let monthlyPayload: number | null | undefined;
    if (editBasicMonthlyDay.trim() === "") {
      monthlyPayload = null;
    } else {
      const md = Math.floor(Number(editBasicMonthlyDay));
      if (!Number.isFinite(md) || md < 1 || md > 31) {
        setPatchBasicMsg("月結日須為 1–31 或留空");
        return;
      }
      monthlyPayload = md;
    }

    setPatchBasicSaving(true);
    try {
      const res = await fetch(`/api/customers/${detailId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerCode: code,
          name: n,
          contactName: editBasicContactName.trim() || null,
          phone: editBasicPhone.trim() || null,
          mobile: editBasicMobile.trim() || null,
          taxId: taxDigits.length > 0 ? taxDigits : null,
          defaultCashInvoiceMode: editBasicDefaultInvoice,
          addressZoneId: editBasicAddressZoneId.trim() || null,
          affiliatedCompanyId: editBasicAffiliatedCompanyId.trim() || null,
          standingRemark: editBasicStandingRemark.trim() || null,
          billingType: editBasicBilling,
          creditLimit: Number(editBasicCredit) || 0,
          notes: editBasicNotes.trim() || null,
          monthlySettlementDay: monthlyPayload,
          allowPrepaidOverdraft: editBasicAllowOverdraft,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setPatchBasicMsg(payload.message ?? "更新失敗");
        return;
      }
      setPatchBasicMsg("已儲存基本資料");
      const updated = payload.data as CustomerDetail;
      setDetail((prev) => (prev ? { ...prev, ...updated, salesOrders: prev.salesOrders } : null));
      setEditBasicName(updated.name);
      setEditBasicCustomerCode(updated.customerCode ?? "");
      setEditBasicContactName(updated.contactName ?? "");
      setEditBasicPhone(updated.phone ?? "");
      setEditBasicMobile(updated.mobile ?? "");
      setEditBasicTaxId(updated.taxId ?? "");
      setEditBasicDefaultInvoice(parseDefaultInvoice(updated.defaultCashInvoiceMode));
      setEditBasicAddressZoneId(
        updated.addressZoneId != null
          ? String(updated.addressZoneId)
          : updated.addressZone?.id != null
            ? String(updated.addressZone.id)
            : "",
      );
      setEditBasicAffiliatedCompanyId(
        updated.affiliatedCompanyId != null
          ? String(updated.affiliatedCompanyId)
          : updated.affiliatedCompany?.id != null
            ? String(updated.affiliatedCompany.id)
            : "",
      );
      setEditBasicStandingRemark(updated.standingRemark ?? "");
      setEditBasicBilling(parseBillingType(updated.billingType));
      setEditBasicMonthlyDay(updated.monthlySettlementDay != null ? String(updated.monthlySettlementDay) : "");
      setEditBasicAllowOverdraft(Boolean(updated.allowPrepaidOverdraft));
      setEditBasicCredit(String(updated.creditLimit ?? "0"));
      setEditBasicNotes(updated.notes ?? "");
      void fetchDetail(detailId);
      void refreshMasters(["customers"], true);
    } catch {
      setPatchBasicMsg("無法連線 API");
    } finally {
      setPatchBasicSaving(false);
    }
  };

  const onSaveAddressEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailId || !editAddrId) return;
    setPatchAddrMsg("");
    const line = editAddrLine.trim();
    if (!line) {
      setPatchAddrMsg("地址內容為必填");
      return;
    }
    const barrels = Math.floor(Number(editAddrBarrels));
    if (!Number.isFinite(barrels) || barrels < 0) {
      setPatchAddrMsg("未收回空桶須為非負整數");
      return;
    }
    const floorTrim = editAddrFloor.trim();
    const deliveryFloor = floorTrim === "" ? null : Math.floor(Number(floorTrim));
    if (floorTrim !== "" && (!Number.isFinite(deliveryFloor) || deliveryFloor === 0)) {
      setPatchAddrMsg("送貨樓層須為非零整數（地下樓可填 -1）或留空");
      return;
    }
    const patrolParsed = patrolFormToApi(editAddrPatrol);
    if (!patrolParsed.ok) {
      setPatchAddrMsg(patrolParsed.message);
      return;
    }
    const levelTrim = editAddrTargetWaterLevel.trim();
    const targetWaterLevel = levelTrim === "" ? null : Math.floor(Number(levelTrim));
    if (levelTrim !== "" && (!Number.isFinite(targetWaterLevel) || targetWaterLevel! < 0)) {
      setPatchAddrMsg("目標水位須為非負整數或留空");
      return;
    }
    const patrolProductId = editAddrPatrolProductId.trim() || null;
    if (patrolParsed.body.patrolWeekday != null && !patrolProductId) {
      setPatchAddrMsg("啟用巡查時請指定預設商品");
      return;
    }
    setPatchAddrSaving(true);
    try {
      const res = await fetch(`/api/customers/${detailId}/addresses/${editAddrId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: editAddrLabel.trim() || null,
          addressLine: line,
          deliveryFloor,
          contactName: editAddrContactName.trim() || null,
          contactPhone: editAddrContactPhone.trim() || null,
          contactMobile: editAddrContactMobile.trim() || null,
          isDefault: editAddrDefault,
          barrelsOnSite: barrels,
          ...patrolParsed.body,
          targetWaterLevel,
          patrolProductId,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setPatchAddrMsg(payload.message ?? "更新失敗");
        return;
      }
      setPatchAddrMsg("已儲存地址");
      mergeDetailFromCustomerPayload(payload.customer);
      cancelEditAddress();
    } catch {
      setPatchAddrMsg("無法連線 API");
    } finally {
      setPatchAddrSaving(false);
    }
  };

  const onDeleteAddress = async (addressId: string) => {
    if (!detailId) return;
    const ok = window.confirm(
      "確定要刪除此送貨地址？\n\n若此地址曾被任何訂單使用，系統會拒絕刪除（以保護訂單與報表中的送貨紀錄）。\n客戶至少須保留一筆地址。",
    );
    if (!ok) return;
    setDeletingAddrId(addressId);
    try {
      const res = await fetch(`/api/customers/${detailId}/addresses/${addressId}`, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        window.alert(payload.message ?? "刪除失敗");
        return;
      }
      mergeDetailFromCustomerPayload(payload.customer);
      if (editAddrId === addressId) cancelEditAddress();
    } catch {
      window.alert("無法連線 API");
    } finally {
      setDeletingAddrId(null);
    }
  };

  const updateAddressRow = (key: string, patch: Partial<AddressFormRow>) => {
    setAddressRows((rows) =>
      rows.map((r) => {
        if (r.key !== key) return r;
        return { ...r, ...patch };
      }),
    );
  };

  const setRowDefault = (key: string) => {
    setAddressRows((rows) => rows.map((r) => ({ ...r, isDefault: r.key === key })));
  };

  const addAddressRow = () => {
    setAddressRows((rows) => [...rows, emptyAddressRow(false)]);
  };

  const removeAddressRow = (key: string) => {
    setAddressRows((rows) => {
      const next = rows.filter((r) => r.key !== key);
      if (next.length === 0) return [emptyAddressRow(true)];
      if (!next.some((r) => r.isDefault)) next[0] = { ...next[0], isDefault: true };
      return next;
    });
  };

  const onSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormMessage("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormMessage("請填寫客戶名稱。");
      return;
    }
    const code = normalizeCustomerCode(customerCode);
    if (!code) {
      setFormMessage("請填寫 6 碼數字的客戶編號。");
      return;
    }
    const taxDigits = taxId.trim().replace(/\D/g, "");
    if (taxDigits.length > 0 && taxDigits.length !== 8) {
      setFormMessage("統一編號須為 8 碼數字或留空。");
      return;
    }

    const addresses = addressRows
      .map((r) => {
        const barrels = Math.floor(Number(r.barrelsOnSite));
        if (!Number.isFinite(barrels) || barrels < 0) return null;
        const patrolParsed = patrolFormToApi(r.patrol);
        if (!patrolParsed.ok) return "INVALID_PATROL" as const;
        const levelTrim = r.targetWaterLevel.trim();
        const targetWaterLevel = levelTrim === "" ? null : Math.floor(Number(levelTrim));
        if (levelTrim !== "" && (!Number.isFinite(targetWaterLevel) || targetWaterLevel! < 0)) {
          return "INVALID_PATROL" as const;
        }
        const patrolProductId = r.patrolProductId.trim() || null;
        if (patrolParsed.body.patrolWeekday != null && !patrolProductId) return "INVALID_PATROL" as const;
        return {
          label: r.label.trim() || undefined,
          addressLine: r.addressLine.trim(),
          contactName: r.contactName.trim() || undefined,
          contactPhone: r.contactPhone.trim() || undefined,
          contactMobile: r.contactMobile.trim() || undefined,
          isDefault: r.isDefault,
          barrelsOnSite: barrels,
          ...patrolParsed.body,
          targetWaterLevel,
          patrolProductId,
        };
      });
    if (addresses.some((a) => a === "INVALID_PATROL")) {
      setFormMessage("巡查設定無效：請選頻率與星期；兩週以上只能選一天；啟用時須選預設商品。");
      return;
    }
    const validAddresses = addresses.filter(
      (a): a is Exclude<NonNullable<typeof a>, "INVALID_PATROL"> => a != null && a !== "INVALID_PATROL" && a.addressLine.length > 0,
    );

    if (validAddresses.length === 0) {
      setFormMessage("請至少新增一筆送貨地址（地址內容必填）。");
      return;
    }
    if (validAddresses.length !== addressRows.filter((r) => r.addressLine.trim().length > 0).length) {
      setFormMessage("各送貨點未收回空桶須為非負整數。");
      return;
    }

    let monthlySettlementDay: number | undefined;
    if (createMonthlyDay.trim() !== "") {
      const md = Math.floor(Number(createMonthlyDay));
      if (!Number.isFinite(md) || md < 1 || md > 31) {
        setFormMessage("月結日須為 1–31。");
        return;
      }
      monthlySettlementDay = md;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerCode: code,
          name: trimmedName,
          contactName: contactName.trim() || undefined,
          phone: phone.trim() || undefined,
          mobile: mobile.trim() || undefined,
          taxId: taxDigits.length > 0 ? taxDigits : undefined,
          defaultCashInvoiceMode,
          addressZoneId: addressZoneId.trim() || undefined,
          affiliatedCompanyId: affiliatedCompanyId.trim() || undefined,
          standingRemark: standingRemark.trim() || undefined,
          billingType,
          creditLimit: Number(creditLimit) || 0,
          notes: notes.trim() || undefined,
          addresses: validAddresses,
          ...(monthlySettlementDay !== undefined ? { monthlySettlementDay } : {}),
          allowPrepaidOverdraft: createAllowOverdraft,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setFormMessage(payload.message ?? "建立客戶失敗");
        return;
      }
      setFormMessage("建立成功。");
      resetCreateForm();
      setBillingSummary(null);
      setBillingLedger(null);
      setCustomerPayments([]);
      setDetail(null);
      await refreshMasters(["customers"], true);
      if (payload.data?.id != null) {
        setDetailId(String(payload.data.id));
        setWorkspaceTab("summary");
      }
      setPageMode("browse");
    } catch {
      setFormMessage("無法連線 API");
    } finally {
      setSaving(false);
    }
  };

  const onAddAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailId) return;
    setAddAddrMsg("");
    const line = newAddrLine.trim();
    if (!line) {
      setAddAddrMsg("地址內容為必填");
      return;
    }
    const floorTrim = newAddrFloor.trim();
    const deliveryFloor = floorTrim === "" ? null : Math.floor(Number(floorTrim));
    if (floorTrim !== "" && (!Number.isFinite(deliveryFloor) || deliveryFloor === 0)) {
      setAddAddrMsg("送貨樓層須為非零整數（地下樓可填 -1）或留空");
      return;
    }
    const patrolParsed = patrolFormToApi(newAddrPatrol);
    if (!patrolParsed.ok) {
      setAddAddrMsg(patrolParsed.message);
      return;
    }
    const levelTrim = newAddrTargetWaterLevel.trim();
    const targetWaterLevel = levelTrim === "" ? null : Math.floor(Number(levelTrim));
    if (levelTrim !== "" && (!Number.isFinite(targetWaterLevel) || targetWaterLevel! < 0)) {
      setAddAddrMsg("目標水位須為非負整數或留空");
      return;
    }
    const patrolProductId = newAddrPatrolProductId.trim() || null;
    if (patrolParsed.body.patrolWeekday != null && !patrolProductId) {
      setAddAddrMsg("啟用巡查時請指定預設商品");
      return;
    }
    setAddingAddr(true);
    try {
      const res = await fetch(`/api/customers/${detailId}/addresses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newAddrLabel.trim() || undefined,
          addressLine: line,
          deliveryFloor,
          contactName: newAddrContactName.trim() || undefined,
          contactPhone: newAddrContactPhone.trim() || undefined,
          contactMobile: newAddrContactMobile.trim() || undefined,
          isDefault: newAddrDefault,
          ...patrolParsed.body,
          targetWaterLevel,
          patrolProductId,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setAddAddrMsg(payload.message ?? "新增地址失敗");
        return;
      }
      setAddAddrMsg("已新增地址");
      setNewAddrLabel("");
      setNewAddrLine("");
      setNewAddrContactName("");
      setNewAddrContactPhone("");
      setNewAddrContactMobile("");
      setNewAddrDefault(false);
      setNewAddrFloor("");
      setNewAddrPatrol(emptyPatrolForm());
      setNewAddrTargetWaterLevel("");
      setNewAddrPatrolProductId("");
      setShowAddAddressForm(false);
      await fetchDetail(detailId);
      void refreshMasters(["customers"], true);
    } catch {
      setAddAddrMsg("無法連線 API");
    } finally {
      setAddingAddr(false);
    }
  };

  const fmtYmd = (iso: string | null | undefined) => {
    return fmtLocalYmd(iso);
  };

  const fmtDateTime = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("zh-TW", { hour12: false });
    } catch {
      return iso;
    }
  };

  const createHasValidCode = normalizeCustomerCode(customerCode) != null;
  const createHasName = name.trim().length > 0;
  const createHasAddress = addressRows.some((r) => r.addressLine.trim().length > 0);
  const createFormReady = createHasValidCode && createHasName && createHasAddress;

  const workspaceCustomer = detail ?? selectedListCustomer;
  const customerHubMobileClass =
    isMobile && pageMode === "create"
      ? " customer-hub--mobile-create"
      : isMobile && detailId && pageMode === "browse"
        ? " customer-hub--mobile-detail"
        : isMobile
          ? " customer-hub--mobile-list"
          : "";
  const workspaceTabs: { id: WorkspaceTab; label: string; count?: number }[] = [
    { id: "summary", label: "摘要" },
    { id: "orders", label: "新系統訂單", count: detail?.salesOrders?.length },
    { id: "billing", label: "帳務", count: billingLedger?.entries.length },
    { id: "edit", label: "編輯資料" },
  ];

  return (
    <section className={`card customer-hub${customerHubMobileClass}`}>
      <header className="customer-hub__header">
        <div className="customer-hub__header-main">
          <h2 className="card__title">客戶資料</h2>
          <p className="customer-hub__lead">左側選客戶、右側看帳務與訂單；切換系統時可用「上線交接」核對舊欠款、預收與桶數。</p>
        </div>
        <div className="customer-hub__header-actions">
          {user?.role === "admin" ? <LegacyMasterSync onSynced={async () => { await refreshMasters(["customers"], true); if (detailId) await fetchDetail(detailId); }} /> : null}
          {pageMode === "create" ? (
            <button type="button" className="btn btn--ghost" onClick={exitCreateCustomer}>
              返回瀏覽
            </button>
          ) : null}
          <button
            type="button"
            className={`btn btn--primary${pageMode === "create" ? " btn--active" : ""}`}
            onClick={startCreateCustomer}
          >
            新增客戶
          </button>
        </div>
      </header>

      <div className="customer-hub__toolbar">
        <div className="field customer-hub__search">
          <span>搜尋</span>
          <input
            type="search"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            placeholder="編號、名稱、電話、統編、地址…"
            autoComplete="off"
          />
        </div>
        <div className="customer-hub__filters" role="group" aria-label="結帳方式篩選">
          {(
            [
              ["all", "全部"],
              ["cash", "現金"],
              ["monthly", "月結"],
              ["prepaid", "預付"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`customer-hub__filter${billingFilter === value ? " customer-hub__filter--active" : ""}`}
              onClick={() => setBillingFilter(value)}
            >
              {label}
            </button>
          ))}
          {(
            [
              ["all", "全部狀態"],
              ["active", "使用中"],
              ["churned", "已流失"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`customer-hub__filter${lifecycleFilter === value ? " customer-hub__filter--active" : ""}`}
              onClick={() => setLifecycleFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="customer-hub__toolbar-meta">
          <span className="customer-hub__count">
            <strong>{displayedCustomers.length}</strong> / {customers.length} 筆
          </span>
          {customerSearch || billingFilter !== "all" || lifecycleFilter !== "all" ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearCustomerSearch}>
              清除篩選
            </button>
          ) : null}
        </div>
      </div>

      <div className="customer-hub__layout">
        <aside className="customer-hub__list-panel" aria-label="客戶清單">
          {displayedCustomers.length === 0 ? (
            <div className="customer-hub__list-empty">
              <p>沒有符合條件的客戶。</p>
              <p className="card__hint">可調整搜尋關鍵字或結帳篩選。</p>
            </div>
          ) : (
            <div className="customer-hub__list" role="list">
              {displayedCustomers.map((c) => {
                const defaultAddr = defaultCustomerAddress(c);
                const selected = detailId === String(c.id) && pageMode === "browse";
                return (
                  <button
                    key={String(c.id)}
                    type="button"
                    role="listitem"
                    className={`customer-hub__list-item${selected ? " customer-hub__list-item--selected" : ""}`}
                    onClick={() => selectCustomer(String(c.id), workspaceTab === "edit" ? "summary" : workspaceTab)}
                  >
                    <div className="customer-hub__list-item-head">
                      <span className="customer-hub__list-code mono-text">{c.customerCode ?? "—"}</span>
                      <span className={billingTypeBadgeClass(c.billingType)}>{billingTypeLabel(c.billingType)}</span>
                      {c.lifecycleStatus === "churned" ? (
                        <span className="badge badge--cancelled">已流失</span>
                      ) : null}
                    </div>
                    <strong className="customer-hub__list-name">{c.name}</strong>
                    <div className="customer-hub__list-meta">
                      {c.contactName ? <span>{c.contactName}</span> : null}
                      {c.mobile || c.phone ? <span>{c.mobile || c.phone}</span> : null}
                    </div>
                    {defaultAddr ? (
                      <p className="customer-hub__list-addr">
                        {defaultAddr.label ? `${defaultAddr.label} · ` : ""}
                        {defaultAddr.addressLine}
                      </p>
                    ) : null}
                    <div className="customer-hub__list-stats">
                      <span>空桶 {sumCustomerBarrelsOnSite(c)}</span>
                      <span>地址 {(c.addresses ?? []).length}</span>
                      {c.billingType === "prepaid" ? <span>預付 {c.prepaidBarrelBalance ?? 0}</span> : null}
                      {(c.addresses ?? []).some(
                        (a) => a.geocodeStatus !== "ok" && a.geocodeStatus !== "manual_confirmed",
                      ) ? (
                        <span className="badge badge--default">座標未齊</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <main className="customer-hub__workspace">
          {pageMode === "create" ? (
        <div className="customer-hub__create">
          {isMobile ? (
            <button type="button" className="btn btn--ghost btn--sm customer-hub__mobile-back" onClick={exitCreateCustomer}>
              ← 返回清單
            </button>
          ) : null}
          <div className="customer-detail-head">
            <h2 className="card__title">新增客戶</h2>
            <button type="button" className="btn btn--ghost" onClick={resetCreateForm} disabled={saving}>
              清除表單
            </button>
          </div>

          <div className="customer-create-hero">
            <p className="customer-create-hero__lead">建立新客戶前，請先完成下方必填項目，其餘欄位可日後再補。</p>
            <ul className="customer-create-checklist" aria-label="必填項目檢查">
              <li className={`customer-create-checklist__item${createHasValidCode ? " customer-create-checklist__item--done" : ""}`}>
                <span className="customer-create-checklist__mark" aria-hidden="true">{createHasValidCode ? "✓" : "1"}</span>
                客戶編號（6 碼數字）
              </li>
              <li className={`customer-create-checklist__item${createHasName ? " customer-create-checklist__item--done" : ""}`}>
                <span className="customer-create-checklist__mark" aria-hidden="true">{createHasName ? "✓" : "2"}</span>
                客戶名稱
              </li>
              <li className={`customer-create-checklist__item${createHasAddress ? " customer-create-checklist__item--done" : ""}`}>
                <span className="customer-create-checklist__mark" aria-hidden="true">{createHasAddress ? "✓" : "3"}</span>
                至少一筆送貨地址
              </li>
            </ul>
            {createFormReady ? (
              <p className="customer-create-hero__ready">必填項目已完成，可以建立客戶。</p>
            ) : (
              <p className="customer-create-hero__pending">尚有必填項目未完成。</p>
            )}
          </div>

          <form onSubmit={onSubmitCreate} className="customer-edit-layout customer-create-form">
            <nav className="customer-edit-nav" aria-label="新增客戶區塊導覽">
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-identity")}>
                基本識別
              </button>
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-contact")}>
                聯絡方式
              </button>
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-billing")}>
                帳務設定
              </button>
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-org")}>
                分區歸屬
              </button>
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-notes")}>
                備註與空桶
              </button>
              <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("create-addresses")}>
                送貨地址
              </button>
            </nav>

            <section id="create-identity" className="customer-edit-section">
              <header className="customer-edit-section__head">
                <h4 className="customer-edit-section__title">基本識別</h4>
                <p className="customer-edit-section__desc">客戶編號須為 6 碼數字，建立後仍可在修改頁調整。</p>
              </header>
              <div className="customer-edit-section__body form-grid form-grid--wide">
                <div className="field">
                  <span>客戶編號（6 碼數字，必填）</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={customerCode}
                    onChange={(e) => setCustomerCode(e.target.value)}
                    placeholder="例如 000123"
                    required
                  />
                </div>
                <div className="field">
                  <span>客戶名稱（必填）</span>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
              </div>
            </section>

            <section id="create-contact" className="customer-edit-section">
              <header className="customer-edit-section__head">
                <h4 className="customer-edit-section__title">聯絡方式</h4>
                <p className="customer-edit-section__desc">主要聯絡人與電話，供開單與客服參考（選填）。</p>
              </header>
              <div className="customer-edit-section__body form-grid form-grid--wide">
                <div className="form-row-2">
                  <div className="field">
                    <span>聯絡人</span>
                    <input type="text" value={contactName} onChange={(e) => setContactName(e.target.value)} />
                  </div>
                  <div className="field">
                    <span>統一編號（8 碼，選填）</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={8}
                      value={taxId}
                      onChange={(e) => setTaxId(e.target.value)}
                      placeholder="12345678"
                    />
                  </div>
                </div>
                <div className="form-row-2">
                  <div className="field">
                    <span>手機</span>
                    <input type="text" value={mobile} onChange={(e) => setMobile(e.target.value)} />
                  </div>
                  <div className="field">
                    <span>電話</span>
                    <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </div>
                </div>
              </div>
            </section>

            <section id="create-billing" className="customer-edit-section">
              <header className="customer-edit-section__head">
                <h4 className="customer-edit-section__title">帳務與結帳設定</h4>
                <p className="customer-edit-section__desc">預設結帳方式會影響新訂單；依類型顯示相關欄位。</p>
              </header>
              <div className="customer-edit-section__body form-grid form-grid--wide">
                <div className="field">
                  <span>預設結帳方式</span>
                  <select
                    value={billingType}
                    onChange={(e) => setBillingType(e.target.value as "cash" | "monthly" | "prepaid")}
                  >
                    <option value="cash">現金</option>
                    <option value="monthly">月結</option>
                    <option value="prepaid">預付（桶）</option>
                  </select>
                </div>
                {billingType === "cash" ? (
                  <div className="field">
                    <span>預設發票（現金列）</span>
                    <select
                      value={defaultCashInvoiceMode}
                      onChange={(e) => setDefaultCashInvoiceMode(e.target.value as DefaultInvoiceMode)}
                    >
                      <option value="none">不開</option>
                      <option value="tax_inclusive">含稅</option>
                      <option value="tax_exclusive">未稅</option>
                    </select>
                  </div>
                ) : null}
                {billingType === "monthly" ? (
                  <div className="field">
                    <span>月結參考日（1–31，選填）</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      step={1}
                      value={createMonthlyDay}
                      onChange={(e) => setCreateMonthlyDay(e.target.value)}
                      placeholder="例如 25"
                    />
                  </div>
                ) : null}
                {billingType === "prepaid" ? (
                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={createAllowOverdraft}
                      onChange={(e) => setCreateAllowOverdraft(e.target.checked)}
                    />
                    <span>預付桶不足時仍允許核銷送達（透支）</span>
                  </label>
                ) : null}
                <div className="field">
                  <span>信用額度</span>
                  <input type="number" min={0} step="0.01" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
                </div>
                {billingType === "prepaid" ? (
                  <p className="card__hint customer-edit-section__hint">
                    預付桶儲值請於客戶建立後，至<strong>新增訂單</strong>建立「預付桶儲值」明細。
                  </p>
                ) : null}
              </div>
            </section>

            <section id="create-org" className="customer-edit-section">
              <header className="customer-edit-section__head">
                <h4 className="customer-edit-section__title">分區與歸屬</h4>
                <p className="customer-edit-section__desc">
                  地址分區與隸屬公司可於{" "}
                  <Link to="/settings/customer-masters" className="text-muted">
                    客戶主檔設定
                  </Link>{" "}
                  管理（選填）。
                </p>
              </header>
              <div className="customer-edit-section__body form-grid form-grid--wide">
                <div className="form-row-2">
                  <div className="field">
                    <span>地址分區</span>
                    <select value={addressZoneId} onChange={(e) => setAddressZoneId(e.target.value)}>
                      <option value="">— 未設定 —</option>
                      {addressZones.map((z) => (
                        <option key={String(z.id)} value={String(z.id)}>
                          {z.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <span>隸屬公司</span>
                    <select value={affiliatedCompanyId} onChange={(e) => setAffiliatedCompanyId(e.target.value)}>
                      <option value="">— 未設定 —</option>
                      {affiliatedCompanies.map((co) => (
                        <option key={String(co.id)} value={String(co.id)}>
                          {co.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </section>

            <section id="create-notes" className="customer-edit-section">
              <header className="customer-edit-section__head">
                <h4 className="customer-edit-section__title">備註</h4>
                <p className="customer-edit-section__desc">常態備註會列印於送貨單。</p>
              </header>
              <div className="customer-edit-section__body form-grid form-grid--wide">
                <div className="field">
                  <span>客戶常態備註</span>
                  <textarea
                    value={standingRemark}
                    onChange={(e) => setStandingRemark(e.target.value)}
                    rows={2}
                    placeholder="列印送貨單、開單時顯示的固定備註"
                  />
                </div>
                <div className="field">
                  <span>內部備註（選填）</span>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                </div>
              </div>
            </section>

            <section id="create-addresses" className="customer-edit-section">
              <header className="customer-edit-section__head customer-edit-section__head--row">
                <div>
                  <h4 className="customer-edit-section__title">送貨地址（{addressRows.length}）</h4>
                  <p className="customer-edit-section__desc">
                    至少一筆地址且須填寫地址內容；僅能有一筆「預設送貨點」。未收回空桶依<strong>各送貨點</strong>分開計算。
                  </p>
                </div>
                <button type="button" className="btn btn--ghost btn--sm" onClick={addAddressRow}>
                  ＋ 新增地址
                </button>
              </header>
              <div className="customer-create-address-list">
                {addressRows.map((row, idx) => (
                  <div key={row.key} className="customer-create-address-row">
                    <div className="customer-create-address-row__head">
                      <strong>送貨點 {idx + 1}</strong>
                      <div className="customer-create-address-row__actions">
                        <label className="customer-address-card__default">
                          <input
                            type="radio"
                            name="defaultAddress"
                            checked={row.isDefault}
                            onChange={() => setRowDefault(row.key)}
                          />
                          預設送貨點
                        </label>
                        {addressRows.length > 1 ? (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => removeAddressRow(row.key)}>
                            移除
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="customer-create-address-row__body form-grid form-grid--wide">
                      <div className="form-row-2">
                        <div className="field">
                          <span>地址標籤（選填）</span>
                          <input
                            type="text"
                            value={row.label}
                            onChange={(e) => updateAddressRow(row.key, { label: e.target.value })}
                            placeholder={`例如：公司／住家 ${idx + 1}`}
                          />
                        </div>
                        <div className="field">
                          <span>地址內容（必填）</span>
                          <input
                            type="text"
                            value={row.addressLine}
                            onChange={(e) => updateAddressRow(row.key, { addressLine: e.target.value })}
                            required={idx === 0}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <span>現場聯絡人（選填）</span>
                        <input
                          type="text"
                          value={row.contactName}
                          onChange={(e) => updateAddressRow(row.key, { contactName: e.target.value })}
                        />
                      </div>
                      <div className="form-row-2">
                        <div className="field">
                          <span>現場手機（選填）</span>
                          <input
                            type="text"
                            value={row.contactMobile}
                            onChange={(e) => updateAddressRow(row.key, { contactMobile: e.target.value })}
                          />
                        </div>
                        <div className="field">
                          <span>現場電話（選填）</span>
                          <input
                            type="text"
                            value={row.contactPhone}
                            onChange={(e) => updateAddressRow(row.key, { contactPhone: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <span>未收回空桶（初值）</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={row.barrelsOnSite}
                          onChange={(e) => updateAddressRow(row.key, { barrelsOnSite: e.target.value })}
                        />
                      </div>
                      <div className="form-row-2">
                        <PatrolScheduleFields
                          idPrefix={`create-addr-${row.key}`}
                          value={row.patrol}
                          onChange={(patrol) => updateAddressRow(row.key, { patrol })}
                        />
                        <div className="field">
                          <span>目標水位（桶）</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={row.targetWaterLevel}
                            onChange={(e) => updateAddressRow(row.key, { targetWaterLevel: e.target.value })}
                            placeholder="例：8"
                          />
                        </div>
                      </div>
                      <div className="field">
                        <span>巡查預設商品{row.patrol.intervalWeeks ? "（必填）" : "（選填）"}</span>
                        <select
                          value={row.patrolProductId}
                          onChange={(e) => updateAddressRow(row.key, { patrolProductId: e.target.value })}
                        >
                          <option value="">—</option>
                          {activeProducts.map((p) => (
                            <option key={String(p.id)} value={String(p.id)}>
                              {(p.productCode ? `${p.productCode} ` : "") + p.name}
                            </option>
                          ))}
                        </select>
                        <span className="field-hint text-muted">結帳方式依客戶（現金／月結／預付），不必在此選。</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="customer-edit-save-bar customer-create-save-bar">
              <button type="submit" className="btn btn--primary" disabled={saving || !createFormReady}>
                {saving ? "建立中…" : "建立客戶"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={resetCreateForm} disabled={saving}>
                清除表單
              </button>
              {!createFormReady && !saving ? (
                <span className="customer-create-save-bar__hint">請完成上方必填項目後再建立。</span>
              ) : null}
              {formMessage ? (
                <span className={formMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>{formMessage}</span>
              ) : null}
            </div>
          </form>
        </div>
          ) : !detailId ? (
            <div className="customer-hub__workspace-empty">
              <p>請從左側清單選擇客戶。</p>
              <p className="card__hint">或按右上角「新增客戶」建立新資料。</p>
            </div>
          ) : (
            <div className="customer-hub__workspace-inner">
              {detailLoading ? <p className="card__hint">客戶資料載入中…</p> : null}
              {detailErr ? <p className="feedback feedback--err">{detailErr}</p> : null}

              {workspaceCustomer ? (
                <>
                <header className="customer-hub__hero">
                  {isMobile && pageMode === "browse" ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm customer-hub__mobile-back"
                      onClick={() => {
                        setDetailId(null);
                        setWorkspaceTab("summary");
                      }}
                    >
                      ← 返回清單
                    </button>
                  ) : null}
                  <div className="customer-hub__hero-main">
                    <p className="customer-hub__hero-code mono-text">
                      {workspaceCustomer.customerCode ?? "—"} · ID {String(workspaceCustomer.id)}
                    </p>
                    <h3 className="customer-hub__hero-title">{workspaceCustomer.name}</h3>
                    <div className="customer-hub__hero-badges">
                      <span className={billingTypeBadgeClass(workspaceCustomer.billingType)}>
                        {billingTypeLabel(workspaceCustomer.billingType)}
                      </span>
                      {workspaceCustomer.billingType === "cash" ? (
                        <span className="badge badge--default">
                          {cashInvoiceModeLabel(workspaceCustomer.defaultCashInvoiceMode)}
                        </span>
                      ) : null}
                      {workspaceCustomer.addressZone?.name ? (
                        <span className="badge badge--default">{workspaceCustomer.addressZone.name}</span>
                      ) : null}
                      {workspaceCustomer.affiliatedCompany?.name ? (
                        <span className="badge badge--default">{workspaceCustomer.affiliatedCompany.name}</span>
                      ) : null}
                      {workspaceCustomer.lineUserId ? (
                        <span className="badge badge--ok" title={workspaceCustomer.lineUserId}>
                          已綁 LINE
                        </span>
                      ) : (
                        <span className="badge badge--default">未綁 LINE</span>
                      )}
                      {workspaceCustomer.lifecycleStatus === "churned" ? (
                        <span className="badge badge--cancelled">已流失</span>
                      ) : (
                        <span className="badge badge--confirmed">使用中</span>
                      )}
                    </div>
                  </div>
                  <div className="customer-hub__hero-actions">
                    {workspaceCustomer.lifecycleStatus === "churned" ? (
                      <span className="text-muted" style={{ fontSize: "0.875rem" }}>
                        已流失，無法開新訂單
                      </span>
                    ) : (
                      <Link className="btn btn--secondary btn--sm" to="/orders/new">
                        開新訂單
                      </Link>
                    )}
                    {detailId ? (
                      <Link
                        className="btn btn--ghost btn--sm"
                        to={`/data/legacy-orders?customerId=${detailId}`}
                      >
                        舊系統歷史訂單
                      </Link>
                    ) : null}
                    {detailId && !workspaceCustomer.lineUserId && canIssueLineBind ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={issuingBindCode}
                        onClick={() => {
                          void (async () => {
                            setIssuingBindCode(true);
                            try {
                              const res = await fetch(`/api/customers/${detailId}/line-bind-code`, { method: "POST" });
                              const payload = await res.json().catch(() => ({}));
                              if (!res.ok || !payload.ok) {
                                window.alert(payload.message ?? "產生綁定碼失敗");
                                return;
                              }
                              const data = payload.data as {
                                customerCode: string;
                                bindCode: string;
                                expiresAt: string;
                              };
                              setLineBindIssued(data);
                              void fetchDetail(detailId);
                            } finally {
                              setIssuingBindCode(false);
                            }
                          })();
                        }}
                      >
                        {issuingBindCode ? "產生中…" : "產生 LINE 綁定碼"}
                      </button>
                    ) : null}
                    {detailId && workspaceCustomer.lineUserId && canUnbindLine ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          void (async () => {
                            if (!window.confirm("確定解除此客戶的 LINE 綁定？客戶需再向客服申請綁定碼才能訂水。")) return;
                            const res = await fetch(`/api/customers/${detailId}/unbind-line`, { method: "POST" });
                            const payload = await res.json().catch(() => ({}));
                            if (!res.ok || !payload.ok) {
                              window.alert(payload.message ?? "解除綁定失敗");
                              return;
                            }
                            setLineBindIssued(null);
                            void fetchDetail(detailId);
                          })();
                        }}
                      >
                        解除 LINE
                      </button>
                    ) : null}
                    {detailId ? (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void fetchDetail(detailId)}>
                        重新載入
                      </button>
                    ) : null}
                  </div>
                </header>
                {lineBindIssued ? (
                  <p className="feedback feedback--ok" style={{ marginTop: "0.75rem" }}>
                    LINE 綁定碼已產生（請立刻告知客戶，10 分鐘內有效）：編號{" "}
                    <strong>{lineBindIssued.customerCode}</strong>、綁定碼{" "}
                    <strong>{lineBindIssued.bindCode}</strong>
                  </p>
                ) : null}
                </>
              ) : null}

              <div className="customer-hub__kpi-row">
                <div className="customer-hub__kpi customer-hub__kpi--highlight">
                  <span className="customer-hub__kpi-label">往來餘額</span>
                  <strong className="customer-hub__kpi-value">
                    $ {moneyText(billingSummary?.accountBalance ?? "—")}
                  </strong>
                  <span className="customer-hub__kpi-hint">正＝客戶欠公司</span>
                </div>
                <div className="customer-hub__kpi">
                  <span className="customer-hub__kpi-label">AR 未清</span>
                  <strong className="customer-hub__kpi-value">
                    $ {moneyText(billingSummary?.arOutstandingAmount ?? 0)}
                  </strong>
                </div>
                <div className="customer-hub__kpi">
                  <span className="customer-hub__kpi-label">預付桶</span>
                  <strong className="customer-hub__kpi-value">
                    {billingSummary?.prepaidBarrelBalance ?? workspaceCustomer?.prepaidBarrelBalance ?? 0} 桶
                  </strong>
                </div>
                <div className="customer-hub__kpi">
                  <span className="customer-hub__kpi-label">訂單</span>
                  <strong className="customer-hub__kpi-value">{customerOrderStats.count}</strong>
                  <span className="customer-hub__kpi-hint">已完成 {customerOrderStats.completed}</span>
                </div>
                <div className="customer-hub__kpi">
                  <span className="customer-hub__kpi-label">合計應收</span>
                  <strong className="customer-hub__kpi-value">$ {moneyText(customerOrderStats.totalAmount)}</strong>
                  <span className="customer-hub__kpi-hint">含稅 · 最近 100 筆</span>
                </div>
                <div className="customer-hub__kpi">
                  <span className="customer-hub__kpi-label">未收回空桶</span>
                  <strong className="customer-hub__kpi-value">
                    {workspaceCustomer ? sumCustomerBarrelsOnSite(workspaceCustomer) : "—"}
                  </strong>
                </div>
              </div>

              <nav className="customer-hub__tabs" role="tablist" aria-label="客戶工作區">
                {workspaceTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={workspaceTab === tab.id}
                    className={`customer-hub__tab${workspaceTab === tab.id ? " customer-hub__tab--active" : ""}`}
                    onClick={() => setWorkspaceTab(tab.id)}
                  >
                    {tab.label}
                    {tab.count != null && tab.count > 0 ? (
                      <span className="customer-hub__tab-count">{tab.count}</span>
                    ) : null}
                  </button>
                ))}
              </nav>

              {workspaceTab === "summary" && workspaceCustomer ? (
                <div className="customer-hub__summary">
                  <div className="customer-hub__summary-grid">
                    <section className="customer-hub__panel">
                      <h4 className="customer-hub__panel-title">聯絡資訊</h4>
                      <dl className="customer-overview-dl">
                        <dt>聯絡人</dt>
                        <dd>{workspaceCustomer.contactName ?? "—"}</dd>
                        <dt>電話</dt>
                        <dd>{workspaceCustomer.phone ?? "—"}</dd>
                        <dt>手機</dt>
                        <dd>{workspaceCustomer.mobile ?? "—"}</dd>
                        <dt>統一編號</dt>
                        <dd className="mono-text">{workspaceCustomer.taxId ?? "—"}</dd>
                        <dt>信用額度</dt>
                        <dd>{fmtMoney(workspaceCustomer.creditLimit)}</dd>
                      </dl>
                    </section>
                    <section className="customer-hub__panel">
                      <h4 className="customer-hub__panel-title">帳務設定</h4>
                      <dl className="customer-overview-dl">
                        <dt>結帳方式</dt>
                        <dd>{billingTypeLabel(workspaceCustomer.billingType)}</dd>
                        {workspaceCustomer.billingType === "monthly" ? (
                          <>
                            <dt>月結參考日</dt>
                            <dd>
                              {workspaceCustomer.monthlySettlementDay
                                ? `每月 ${workspaceCustomer.monthlySettlementDay} 日`
                                : "—"}
                            </dd>
                          </>
                        ) : null}
                        {workspaceCustomer.billingType === "prepaid" ? (
                          <>
                            <dt>允許透支</dt>
                            <dd>{workspaceCustomer.allowPrepaidOverdraft ? "是" : "否"}</dd>
                          </>
                        ) : null}
                        <dt>金額預收</dt>
                        <dd>$ {moneyText(billingSummary?.prepaymentMoneyBalance ?? 0)}</dd>
                      </dl>
                    </section>
                  </div>

                  <section className={`customer-hub__panel customer-lifecycle-panel${lifecyclePanelOpen ? " customer-lifecycle-panel--open" : ""}`}>
                    <button
                      type="button"
                      className="customer-lifecycle-panel__toggle"
                      aria-expanded={lifecyclePanelOpen}
                      onClick={() => setLifecyclePanelOpen((v) => !v)}
                    >
                      <div className="customer-lifecycle-panel__toggle-main">
                        <h4 className="customer-hub__panel-title">客戶狀態</h4>
                        {workspaceCustomer.lifecycleStatus === "churned" ? (
                          <span className="badge badge--cancelled">已流失</span>
                        ) : (
                          <span className="badge badge--confirmed">使用中</span>
                        )}
                        {workspaceCustomer.lifecycleStatus === "churned" && workspaceCustomer.churnedAt ? (
                          <span className="customer-lifecycle-panel__toggle-meta mono-text">
                            {fmtLocalYmd(workspaceCustomer.churnedAt)}
                            {workspaceCustomer.churnReason?.label
                              ? ` · ${workspaceCustomer.churnReason.label}`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                      <span className="customer-lifecycle-panel__chevron" aria-hidden>
                        {lifecyclePanelOpen ? "收合" : "展開"}
                      </span>
                    </button>

                    {lifecyclePanelOpen ? (
                      <div className="customer-lifecycle-panel__body">
                        {workspaceCustomer.lifecycleStatus === "churned" ? (
                          <div className="customer-lifecycle-panel__content">
                            <div className="customer-lifecycle-status">
                              <div className="customer-lifecycle-status__row">
                                <span>流失日</span>
                                <strong className="mono-text">
                                  {fmtLocalYmd(workspaceCustomer.churnedAt) || "—"}
                                </strong>
                              </div>
                              <div className="customer-lifecycle-status__row">
                                <span>原因</span>
                                <strong>{workspaceCustomer.churnReason?.label ?? "—"}</strong>
                              </div>
                              {workspaceCustomer.churnReasonNote ? (
                                <div className="customer-lifecycle-status__row customer-lifecycle-status__row--note">
                                  <span>說明</span>
                                  <strong>{workspaceCustomer.churnReasonNote}</strong>
                                </div>
                              ) : null}
                            </div>
                            <form onSubmit={reactivateCustomer} className="customer-lifecycle-form">
                              <p className="customer-lifecycle-form__hint">標記回流後可再開新訂單與巡查。</p>
                              <div className="customer-lifecycle-form__row">
                                <label className="customer-lifecycle-field">
                                  <span>回流生效日</span>
                                  <input
                                    type="date"
                                    value={reactivatedAtYmd}
                                    onChange={(e) => setReactivatedAtYmd(e.target.value)}
                                    required
                                  />
                                </label>
                                <label className="customer-lifecycle-field customer-lifecycle-field--grow">
                                  <span>備註（選填）</span>
                                  <input
                                    type="text"
                                    value={reactivateNote}
                                    onChange={(e) => setReactivateNote(e.target.value)}
                                    placeholder="例如：恢復叫貨"
                                  />
                                </label>
                                <button
                                  type="submit"
                                  className="btn btn--primary btn--sm"
                                  disabled={lifecycleActionLoading}
                                >
                                  {lifecycleActionLoading ? "處理中…" : "標記回流"}
                                </button>
                              </div>
                            </form>
                          </div>
                        ) : (
                          <form onSubmit={markCustomerChurn} className="customer-lifecycle-form">
                            <p className="customer-lifecycle-form__hint">
                              標記後無法開新訂單，巡查亦會略過此客戶。
                            </p>
                            <div className="customer-lifecycle-form__row">
                              <label className="customer-lifecycle-field">
                                <span>不再服務日</span>
                                <input
                                  type="date"
                                  value={churnedAtYmd}
                                  onChange={(e) => setChurnedAtYmd(e.target.value)}
                                  required
                                />
                              </label>
                              <label className="customer-lifecycle-field customer-lifecycle-field--grow">
                                <span>流失原因</span>
                                <select
                                  value={churnReasonId}
                                  onChange={(e) => setChurnReasonId(e.target.value)}
                                  required
                                >
                                  <option value="">請選擇</option>
                                  {churnReasons.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="customer-lifecycle-form__row">
                              <label className="customer-lifecycle-field customer-lifecycle-field--grow">
                                <span>補充說明（原因為「其他」時必填）</span>
                                <input
                                  type="text"
                                  value={churnReasonNote}
                                  onChange={(e) => setChurnReasonNote(e.target.value)}
                                />
                              </label>
                              <button
                                type="submit"
                                className="btn btn--danger btn--sm"
                                disabled={lifecycleActionLoading}
                              >
                                {lifecycleActionLoading ? "處理中…" : "標記流失"}
                              </button>
                            </div>
                          </form>
                        )}

                        {lifecycleActionMsg ? (
                          <p
                            className={
                              lifecycleActionMsg.includes("失敗") || lifecycleActionMsg.includes("請")
                                ? "feedback feedback--err"
                                : "feedback feedback--ok"
                            }
                          >
                            {lifecycleActionMsg}
                          </p>
                        ) : null}

                        <div className="customer-lifecycle-history">
                          <div className="customer-lifecycle-history__head">狀態紀錄</div>
                          {lifecycleEventsLoading ? (
                            <p className="customer-lifecycle-history__empty">載入中…</p>
                          ) : lifecycleEvents.length === 0 ? (
                            <p className="customer-lifecycle-history__empty">尚無紀錄</p>
                          ) : (
                            <ul className="customer-lifecycle-history__list">
                              {lifecycleEvents.map((ev) => (
                                <li key={ev.id} className="customer-lifecycle-history__item">
                                  <div className="customer-lifecycle-history__item-top">
                                    <span className="badge badge--default">
                                      {lifecycleEventLabel(ev.eventType)}
                                    </span>
                                    <span className="mono-text">{ev.effectiveAt ?? "—"}</span>
                                    {ev.churnReason?.label ? (
                                      <span className="customer-lifecycle-history__reason">
                                        {ev.churnReason.label}
                                      </span>
                                    ) : null}
                                  </div>
                                  {ev.note ? (
                                    <p className="customer-lifecycle-history__note" title={ev.note}>
                                      {ev.note}
                                    </p>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </section>

                  {(workspaceCustomer.standingRemark || workspaceCustomer.notes) ? (
                    <section className="customer-hub__panel">
                      <h4 className="customer-hub__panel-title">備註</h4>
                      {workspaceCustomer.standingRemark ? (
                        <p className="customer-overview-preview__remark">
                          <strong>常態備註：</strong>
                          {workspaceCustomer.standingRemark}
                        </p>
                      ) : null}
                      {workspaceCustomer.notes ? (
                        <p className="customer-overview-preview__remark">
                          <strong>內部備註：</strong>
                          {workspaceCustomer.notes}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  <section className="customer-hub__panel">
                    <div className="customer-hub__panel-head">
                      <h4 className="customer-hub__panel-title">
                        送貨地址（{(workspaceCustomer.addresses ?? []).length}）
                      </h4>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWorkspaceTab("edit")}>
                        管理地址
                      </button>
                    </div>
                    {(workspaceCustomer.addresses ?? []).length === 0 ? (
                      <p className="card__hint">尚無送貨地址</p>
                    ) : (
                      <ul className="customer-overview-addresses">
                        {(workspaceCustomer.addresses ?? []).map((a) => (
                          <li key={String(a.id)} className="customer-overview-address">
                            <div className="customer-overview-address__head">
                              <strong>{a.label || "送貨點"}</strong>
                              {a.isDefault ? <span className="badge badge--confirmed">預設</span> : null}
                              <span className="badge badge--default">空桶 {a.barrelsOnSite ?? 0}</span>
                            {a.deliveryFloor != null ? (
                              <span className="badge badge--default">{formatDeliveryFloor(a.deliveryFloor)}</span>
                            ) : null}
                            {patrolScheduleLabel(a) ? (
                              <span className="badge badge--delivering">
                                巡查 {patrolScheduleLabel(a)}
                                {a.targetWaterLevel != null ? ` · 水位 ${a.targetWaterLevel}` : ""}
                              </span>
                            ) : null}
                            </div>
                            <p>{a.addressLine}</p>
                            {(a.contactName || a.contactPhone || a.contactMobile) ? (
                              <p className="customer-overview-address__contact">
                                {[a.contactName, a.contactPhone, a.contactMobile].filter(Boolean).join(" · ")}
                              </p>
                            ) : null}
                            <AddressGeocodePanel
                              address={a}
                              defaultOpen={false}
                              onUpdated={(patch) => patchAddressGeo(String(a.id), patch)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="customer-hub__panel">
                    <div className="customer-hub__panel-head">
                      <h4 className="customer-hub__panel-title">最近訂單（新系統）</h4>
                      <div style={{ display: "flex", gap: 8 }}>
                        {detailId ? (
                          <Link className="btn btn--ghost btn--sm" to={`/data/legacy-orders?customerId=${detailId}`}>
                            舊系統歷史
                          </Link>
                        ) : null}
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWorkspaceTab("orders")}>
                          查看全部
                        </button>
                      </div>
                    </div>
                    {(detail?.salesOrders ?? []).length === 0 ? (
                      <p className="card__hint">尚無訂單紀錄</p>
                    ) : (
                      <ul className="customer-order-cards">
                        {(detail?.salesOrders ?? []).slice(0, 3).map((o) => (
                          <li key={String(o.id)} className="customer-order-card customer-order-card--compact">
                            <div className="customer-order-card__head">
                              <div className="customer-order-card__head-main">
                                <span className="customer-order-card__no mono-text">{o.orderNo}</span>
                                <span className={orderStatusBadgeClass(o.status)}>{orderStatusLabel(o.status)}</span>
                              </div>
                              <strong className="customer-order-card__amount">
                                $ {moneyText(customerOrderBillableAmount(o))}
                              </strong>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="customer-hub__panel">
                    <div className="customer-hub__panel-head">
                      <h4 className="customer-hub__panel-title">空桶回收紀錄</h4>
                      <div className="customer-detail-actions customer-detail-actions--wrap">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => detailId && void loadBarrelCollections(detailId)}
                          disabled={barrelCollectionsLoading}
                        >
                          {barrelCollectionsLoading ? "讀取中…" : "重新載入"}
                        </button>
                        <Link
                          className="btn btn--secondary btn--sm"
                          to={`/orders/barrel-pickup/query?q=${encodeURIComponent(
                            workspaceCustomer.customerCode ?? workspaceCustomer.name,
                          )}`}
                        >
                          完整查詢
                        </Link>
                      </div>
                    </div>
                    {barrelCollectionsErr ? (
                      <p className="card__hint">{barrelCollectionsErr}</p>
                    ) : barrelCollectionsLoading ? (
                      <p className="card__hint">空桶回收紀錄載入中…</p>
                    ) : barrelCollections.length === 0 ? (
                      <p className="card__hint">此客戶目前沒有空桶回收紀錄。</p>
                    ) : (
                      <div className="table-wrap">
                        <table className="data-table data-table--compact">
                          <thead>
                            <tr>
                              <th>類型</th>
                              <th>狀態</th>
                              <th>收桶日</th>
                              <th>單號</th>
                              <th>送貨點</th>
                              <th>客戶押桶變化</th>
                              <th className="num">實收</th>
                            </tr>
                          </thead>
                          <tbody>
                            {barrelCollections.slice(0, 5).map((row) => (
                              <tr key={`${row.sourceType}-${row.id}`}>
                                <td>
                                  <span className={barrelCollectionSourceBadgeClass(row.sourceType)}>
                                    {barrelCollectionSourceLabel(row.sourceType)}
                                  </span>
                                </td>
                                <td>
                                  <span className={barrelPickupStatusBadgeClass(row.status)}>
                                    {barrelPickupStatusLabel(row.status)}
                                  </span>
                                </td>
                                <td className="cell-nowrap">{fmtLocalYmd(row.collectionDate ?? row.pickupDate)}</td>
                                <td>
                                  {row.sourceType === "delivery" && row.refId ? (
                                    <button
                                      type="button"
                                      className="btn btn--ghost btn--sm"
                                      style={{ padding: "0 0.25rem", fontSize: "0.8em" }}
                                      disabled={barrelOrderDetailLoading}
                                      onClick={() => void openBarrelCollectionOrder(row)}
                                      title="開啟訂單明細"
                                    >
                                      <code>{row.refNo ?? "—"}</code>
                                    </button>
                                  ) : (
                                    <code style={{ fontSize: "0.8em" }}>{row.refNo ?? "—"}</code>
                                  )}
                                </td>
                                <td>
                                  {row.deliveryAddress?.label ? `${row.deliveryAddress.label} · ` : ""}
                                  {row.deliveryAddress?.addressLine ?? "—"}
                                </td>
                                <td style={{ fontSize: "0.8125rem" }}>{formatBarrelSiteChangeSummary(row)}</td>
                                <td className="num">{row.barrelsReturned ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </div>
              ) : null}

              {workspaceTab === "edit" && detail && !detailLoading && detailId ? (
            <div className="customer-edit-layout">
              <nav className="customer-edit-nav" aria-label="修改區塊導覽">
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-identity")}>
                  基本識別
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-contact")}>
                  聯絡方式
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-billing")}>
                  帳務設定
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-org")}>
                  分區歸屬
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-notes")}>
                  備註
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToEditSection("edit-addresses")}>
                  送貨地址／空桶
                </button>
              </nav>

              <form onSubmit={onSaveBasic} className="customer-edit-form">
                <section id="edit-identity" className="customer-edit-section">
                  <header className="customer-edit-section__head">
                    <h4 className="customer-edit-section__title">基本識別</h4>
                    <p className="customer-edit-section__desc">客戶編號與名稱為系統辨識依據，編號須為 6 碼數字。</p>
                  </header>
                  <div className="customer-edit-section__body form-grid form-grid--wide">
                    <div className="field">
                      <span>客戶編號（6 碼數字）</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={editBasicCustomerCode}
                        onChange={(e) => setEditBasicCustomerCode(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <span>客戶名稱（必填）</span>
                      <input type="text" value={editBasicName} onChange={(e) => setEditBasicName(e.target.value)} required />
                    </div>
                  </div>
                </section>

                <section id="edit-contact" className="customer-edit-section">
                  <header className="customer-edit-section__head">
                    <h4 className="customer-edit-section__title">聯絡方式</h4>
                    <p className="customer-edit-section__desc">主要聯絡人與電話，供開單與客服參考。</p>
                  </header>
                  <div className="customer-edit-section__body form-grid form-grid--wide">
                    <div className="form-row-2">
                      <div className="field">
                        <span>聯絡人</span>
                        <input type="text" value={editBasicContactName} onChange={(e) => setEditBasicContactName(e.target.value)} />
                      </div>
                      <div className="field">
                        <span>統一編號（8 碼，選填）</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={8}
                          value={editBasicTaxId}
                          onChange={(e) => setEditBasicTaxId(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-row-2">
                      <div className="field">
                        <span>手機</span>
                        <input type="text" value={editBasicMobile} onChange={(e) => setEditBasicMobile(e.target.value)} />
                      </div>
                      <div className="field">
                        <span>電話</span>
                        <input type="text" value={editBasicPhone} onChange={(e) => setEditBasicPhone(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </section>

                <section id="edit-billing" className="customer-edit-section">
                  <header className="customer-edit-section__head">
                    <h4 className="customer-edit-section__title">帳務與結帳設定</h4>
                    <p className="customer-edit-section__desc">預設結帳方式會影響新訂單；依類型顯示相關欄位。</p>
                  </header>
                  <div className="customer-edit-section__body form-grid form-grid--wide">
                    <div className="field">
                      <span>預設結帳方式</span>
                      <select
                        value={editBasicBilling}
                        onChange={(e) => setEditBasicBilling(e.target.value as "cash" | "monthly" | "prepaid")}
                      >
                        <option value="cash">現金</option>
                        <option value="monthly">月結</option>
                        <option value="prepaid">預付（桶）</option>
                      </select>
                    </div>
                    {editBasicBilling === "cash" ? (
                      <div className="field">
                        <span>預設發票（現金列）</span>
                        <select
                          value={editBasicDefaultInvoice}
                          onChange={(e) => setEditBasicDefaultInvoice(e.target.value as DefaultInvoiceMode)}
                        >
                          <option value="none">不開</option>
                          <option value="tax_inclusive">含稅</option>
                          <option value="tax_exclusive">未稅</option>
                        </select>
                      </div>
                    ) : null}
                    {editBasicBilling === "monthly" ? (
                      <div className="field">
                        <span>月結參考日（1–31，留空表示未設定）</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          step={1}
                          value={editBasicMonthlyDay}
                          onChange={(e) => setEditBasicMonthlyDay(e.target.value)}
                          placeholder="例如 25"
                        />
                      </div>
                    ) : null}
                    {editBasicBilling === "prepaid" ? (
                      <label className="field field--checkbox">
                        <input
                          type="checkbox"
                          checked={editBasicAllowOverdraft}
                          onChange={(e) => setEditBasicAllowOverdraft(e.target.checked)}
                        />
                        <span>預付桶不足時仍允許核銷送達（透支）</span>
                      </label>
                    ) : null}
                    <div className="field">
                      <span>信用額度</span>
                      <input type="number" min={0} step="0.01" value={editBasicCredit} onChange={(e) => setEditBasicCredit(e.target.value)} />
                    </div>
                    {editBasicBilling === "prepaid" ? (
                      <p className="card__hint customer-edit-section__hint">
                        預付桶儲值請至<strong>新增訂單</strong>建立「預付桶儲值」明細；現金應收全數沖清後才入預付桶餘額。
                      </p>
                    ) : null}
                  </div>
                </section>

                <section id="edit-org" className="customer-edit-section">
                  <header className="customer-edit-section__head">
                    <h4 className="customer-edit-section__title">分區與歸屬</h4>
                    <p className="customer-edit-section__desc">
                      地址分區與隸屬公司可於{" "}
                      <Link to="/settings/customer-masters" className="text-muted">
                        客戶主檔設定
                      </Link>{" "}
                      管理。
                    </p>
                  </header>
                  <div className="customer-edit-section__body form-grid form-grid--wide">
                    <div className="form-row-2">
                      <div className="field">
                        <span>地址分區</span>
                        <select value={editBasicAddressZoneId} onChange={(e) => setEditBasicAddressZoneId(e.target.value)}>
                          <option value="">— 未設定 —</option>
                          {editZoneOptions.map((z) => (
                            <option key={String(z.id)} value={String(z.id)}>
                              {z.name}
                              {z.isActive === false ? "（已停用）" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <span>隸屬公司</span>
                        <select
                          value={editBasicAffiliatedCompanyId}
                          onChange={(e) => setEditBasicAffiliatedCompanyId(e.target.value)}
                        >
                          <option value="">— 未設定 —</option>
                          {editCompanyOptions.map((co) => (
                            <option key={String(co.id)} value={String(co.id)}>
                              {co.name}
                              {co.isActive === false ? "（已停用）" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </section>

                <section id="edit-notes" className="customer-edit-section">
                  <header className="customer-edit-section__head">
                    <h4 className="customer-edit-section__title">備註</h4>
                    <p className="customer-edit-section__desc">常態備註會列印於送貨單；內部備註僅供後台參考。</p>
                  </header>
                  <div className="customer-edit-section__body form-grid form-grid--wide">
                    <div className="field">
                      <span>客戶常態備註</span>
                      <textarea value={editBasicStandingRemark} onChange={(e) => setEditBasicStandingRemark(e.target.value)} rows={2} />
                    </div>
                    <div className="field">
                      <span>內部備註（選填）</span>
                      <textarea value={editBasicNotes} onChange={(e) => setEditBasicNotes(e.target.value)} rows={2} />
                    </div>
                  </div>
                </section>

                <div className="customer-edit-save-bar">
                  <button type="submit" className="btn btn--primary" disabled={patchBasicSaving}>
                    {patchBasicSaving ? "儲存中…" : "儲存基本資料"}
                  </button>
                  {patchBasicMsg ? (
                    <span className={patchBasicMsg.includes("已") ? "feedback feedback--ok" : "feedback feedback--err"}>{patchBasicMsg}</span>
                  ) : null}
                </div>
              </form>

              <section id="edit-addresses" className="customer-edit-section">
                <header className="customer-edit-section__head customer-edit-section__head--row">
                  <div>
                    <h4 className="customer-edit-section__title">送貨地址與未收回空桶（{(detail.addresses ?? []).length}）</h4>
                    <p className="customer-edit-section__desc">
                      核銷送達時依該訂單送貨點的押桶商品與回桶數自動增減；亦可於編輯地址時手動調整各點桶數。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setShowAddAddressForm((v) => !v);
                      setEditAddrId(null);
                    }}
                  >
                    {showAddAddressForm ? "收起新增表單" : "＋ 新增地址"}
                  </button>
                </header>

                {editAddrId ? (
                  <form onSubmit={onSaveAddressEdit} className="customer-address-edit-panel">
                    <header className="customer-address-edit-panel__head">
                      <h4 className="customer-address-edit-panel__title">編輯地址</h4>
                      <label className="customer-address-edit-panel__default">
                        <input
                          type="checkbox"
                          checked={editAddrDefault}
                          onChange={(e) => setEditAddrDefault(e.target.checked)}
                        />
                        <span>設為預設送貨點</span>
                      </label>
                    </header>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">基本資料</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field customer-address-field--sm">
                          <span>標籤</span>
                          <input type="text" value={editAddrLabel} onChange={(e) => setEditAddrLabel(e.target.value)} />
                        </label>
                        <label className="customer-address-field customer-address-field--wide">
                          <span>地址內容（必填）</span>
                          <input type="text" value={editAddrLine} onChange={(e) => setEditAddrLine(e.target.value)} required />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">聯絡方式</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field">
                          <span>聯絡人</span>
                          <input
                            type="text"
                            value={editAddrContactName}
                            onChange={(e) => setEditAddrContactName(e.target.value)}
                          />
                        </label>
                        <label className="customer-address-field">
                          <span>手機</span>
                          <input
                            type="text"
                            value={editAddrContactMobile}
                            onChange={(e) => setEditAddrContactMobile(e.target.value)}
                          />
                        </label>
                        <label className="customer-address-field">
                          <span>電話</span>
                          <input
                            type="text"
                            value={editAddrContactPhone}
                            onChange={(e) => setEditAddrContactPhone(e.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">送貨／空桶</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field customer-address-field--sm">
                          <span>未收回空桶</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={editAddrBarrels}
                            onChange={(e) => setEditAddrBarrels(e.target.value)}
                          />
                        </label>
                        <label className="customer-address-field">
                          <span>送貨樓層（選填）</span>
                          <input
                            type="number"
                            step={1}
                            value={editAddrFloor}
                            onChange={(e) => setEditAddrFloor(e.target.value)}
                            placeholder="例：2、3、-1"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">週期巡查</div>
                      <div className="customer-address-edit-panel__grid">
                        <PatrolScheduleFields
                          idPrefix="edit-addr"
                          value={editAddrPatrol}
                          onChange={setEditAddrPatrol}
                        />
                        <label className="customer-address-field customer-address-field--sm">
                          <span>目標水位（桶）</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={editAddrTargetWaterLevel}
                            onChange={(e) => setEditAddrTargetWaterLevel(e.target.value)}
                            placeholder="例：8"
                          />
                        </label>
                        <label className="customer-address-field customer-address-field--wide">
                          <span>巡查預設商品{editAddrPatrol.intervalWeeks ? "（必填）" : ""}</span>
                          <select
                            value={editAddrPatrolProductId}
                            onChange={(e) => setEditAddrPatrolProductId(e.target.value)}
                          >
                            <option value="">—</option>
                            {activeProducts.map((p) => (
                              <option key={String(p.id)} value={String(p.id)}>
                                {(p.productCode ? `${p.productCode} ` : "") + p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="customer-address-edit-panel__hint">
                        一鍵產單用。每週可選一天或多天；兩週以上只能選一天並指定起始週。結帳跟客戶主檔（目前：
                        {billingTypeLabel(detail?.billingType ?? workspaceCustomer?.billingType)}）
                      </p>
                    </div>

                    <div className="customer-address-edit-panel__actions">
                      <button type="submit" className="btn btn--primary btn--sm" disabled={patchAddrSaving}>
                        {patchAddrSaving ? "儲存中…" : "儲存地址"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={cancelEditAddress}
                        disabled={patchAddrSaving}
                      >
                        取消
                      </button>
                      {patchAddrMsg ? (
                        <span
                          className={
                            patchAddrMsg.includes("已") ? "feedback feedback--ok" : "feedback feedback--err"
                          }
                        >
                          {patchAddrMsg}
                        </span>
                      ) : null}
                    </div>
                  </form>
                ) : null}

                <ul className="customer-edit-address-list">
                  {(detail.addresses ?? []).map((a) => {
                    const isEditing = editAddrId === String(a.id);
                    const geoMeta = geocodeStatusMeta(a.geocodeStatus);
                    return (
                      <li
                        key={String(a.id)}
                        className={`customer-edit-address-card${isEditing ? " customer-edit-address-card--editing" : ""}`}
                      >
                        <div className="customer-edit-address-card__head">
                          <div>
                            <strong>{a.label || "送貨點"}</strong>
                            {a.isDefault ? <span className="badge badge--confirmed">預設</span> : null}
                            <span className="badge badge--default">空桶 {a.barrelsOnSite ?? 0}</span>
                            {a.deliveryFloor != null ? (
                              <span className="badge badge--default">{formatDeliveryFloor(a.deliveryFloor)}</span>
                            ) : null}
                            {patrolScheduleLabel(a) ? (
                              <span className="badge badge--delivering">
                                巡查 {patrolScheduleLabel(a)}
                                {a.targetWaterLevel != null ? ` · 水位 ${a.targetWaterLevel}` : ""}
                                {a.patrolProduct?.name ? ` · ${a.patrolProduct.name}` : ""}
                              </span>
                            ) : null}
                            <span className={geoMeta.className}>{geoMeta.text}</span>
                          </div>
                          <div className="customer-detail-actions">
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => startEditAddress(a)}>
                              編輯
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={deletingAddrId === String(a.id)}
                              onClick={() => void onDeleteAddress(String(a.id))}
                            >
                              {deletingAddrId === String(a.id) ? "刪除中…" : "刪除"}
                            </button>
                          </div>
                        </div>
                        <p className="customer-edit-address-card__line">{a.addressLine}</p>
                        {(a.contactName || a.contactPhone || a.contactMobile) ? (
                          <p className="customer-edit-address-card__contact">
                            {[a.contactName, a.contactPhone, a.contactMobile].filter(Boolean).join(" · ")}
                          </p>
                        ) : null}
                        <AddressGeocodePanel
                          address={a}
                          defaultOpen={a.geocodeStatus !== "ok" && a.geocodeStatus !== "manual_confirmed"}
                          onUpdated={(patch) => patchAddressGeo(String(a.id), patch)}
                        />
                      </li>
                    );
                  })}
                </ul>

                {showAddAddressForm ? (
                  <form onSubmit={onAddAddress} className="customer-address-edit-panel customer-address-edit-panel--add">
                    <header className="customer-address-edit-panel__head">
                      <h4 className="customer-address-edit-panel__title">新增送貨地址</h4>
                      <label className="customer-address-edit-panel__default">
                        <input
                          type="checkbox"
                          checked={newAddrDefault}
                          onChange={(e) => setNewAddrDefault(e.target.checked)}
                        />
                        <span>設為預設送貨點</span>
                      </label>
                    </header>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">基本資料</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field customer-address-field--sm">
                          <span>標籤</span>
                          <input type="text" value={newAddrLabel} onChange={(e) => setNewAddrLabel(e.target.value)} />
                        </label>
                        <label className="customer-address-field customer-address-field--wide">
                          <span>地址內容（必填）</span>
                          <input type="text" value={newAddrLine} onChange={(e) => setNewAddrLine(e.target.value)} required />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">聯絡方式</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field">
                          <span>聯絡人</span>
                          <input
                            type="text"
                            value={newAddrContactName}
                            onChange={(e) => setNewAddrContactName(e.target.value)}
                          />
                        </label>
                        <label className="customer-address-field">
                          <span>手機</span>
                          <input
                            type="text"
                            value={newAddrContactMobile}
                            onChange={(e) => setNewAddrContactMobile(e.target.value)}
                          />
                        </label>
                        <label className="customer-address-field">
                          <span>電話</span>
                          <input
                            type="text"
                            value={newAddrContactPhone}
                            onChange={(e) => setNewAddrContactPhone(e.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">送貨</div>
                      <div className="customer-address-edit-panel__grid">
                        <label className="customer-address-field">
                          <span>送貨樓層（選填）</span>
                          <input
                            type="number"
                            step={1}
                            value={newAddrFloor}
                            onChange={(e) => setNewAddrFloor(e.target.value)}
                            placeholder="例：2、3、-1"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="customer-address-edit-panel__section">
                      <div className="customer-address-edit-panel__section-title">週期巡查</div>
                      <div className="customer-address-edit-panel__grid">
                        <PatrolScheduleFields
                          idPrefix="new-addr"
                          value={newAddrPatrol}
                          onChange={setNewAddrPatrol}
                        />
                        <label className="customer-address-field customer-address-field--sm">
                          <span>目標水位（桶）</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={newAddrTargetWaterLevel}
                            onChange={(e) => setNewAddrTargetWaterLevel(e.target.value)}
                            placeholder="例：8"
                          />
                        </label>
                        <label className="customer-address-field customer-address-field--wide">
                          <span>巡查預設商品{newAddrPatrol.intervalWeeks ? "（必填）" : ""}</span>
                          <select
                            value={newAddrPatrolProductId}
                            onChange={(e) => setNewAddrPatrolProductId(e.target.value)}
                          >
                            <option value="">—</option>
                            {activeProducts.map((p) => (
                              <option key={String(p.id)} value={String(p.id)}>
                                {(p.productCode ? `${p.productCode} ` : "") + p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="customer-address-edit-panel__hint">
                        一鍵產單用。每週可選一天或多天；兩週以上只能選一天並指定起始週。結帳跟客戶主檔（目前：
                        {billingTypeLabel(detail?.billingType ?? workspaceCustomer?.billingType)}）
                      </p>
                    </div>

                    <div className="customer-address-edit-panel__actions">
                      <button type="submit" className="btn btn--primary btn--sm" disabled={addingAddr}>
                        {addingAddr ? "新增中…" : "新增地址"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setShowAddAddressForm(false)}
                        disabled={addingAddr}
                      >
                        取消
                      </button>
                      {addAddrMsg ? (
                        <span
                          className={
                            addAddrMsg.includes("已") ? "feedback feedback--ok" : "feedback feedback--err"
                          }
                        >
                          {addAddrMsg}
                        </span>
                      ) : null}
                    </div>
                  </form>
                ) : null}
              </section>
            </div>
              ) : null}

              {workspaceTab === "billing" && detail && !detailLoading && detailId ? (
            <div className="customer-edit-layout">
              <nav className="customer-edit-nav" aria-label="帳務區塊導覽">
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("billing-ledger")}>
                  帳務流水
                  {billingLedger ? `（${billingLedger.entries.length}）` : ""}
                </button>
                <button type="button" className="customer-edit-nav__btn" onClick={() => scrollToSection("billing-payments")}>
                  銷單收款
                  {customerPayments.length > 0 ? `（${customerPayments.length}）` : ""}
                </button>
              </nav>

              <section id="billing-ledger" className="customer-edit-section">
                <header className="customer-edit-section__head customer-edit-section__head--row">
                  <div>
                    <h4 className="customer-edit-section__title">帳務流水</h4>
                    <p className="customer-edit-section__desc">
                      由 AR 立帳／收款沖帳合成（與往來餘額同一口徑）；「本筆後餘額」為該筆入帳後之往來餘額。
                    </p>
                  </div>
                </header>
                <div className="customer-edit-section__body">
                  {billingLedgerErr ? <p className="feedback feedback--err">{billingLedgerErr}</p> : null}
                  {billingLedger && billingLedger.entries.length > 0 ? (
                    <>
                      <div className="customer-billing-meta-bar">
                        <span>
                          共 <strong>{billingLedger.totalCount}</strong> 筆，顯示最近 <strong>{billingLedger.entries.length}</strong> 筆
                        </span>
                        <span>
                          核對餘額：<strong>$ {Number(billingLedger.accountBalance).toLocaleString()}</strong>
                        </span>
                      </div>
                      <div className="table-wrap billing-ledger-scroll">
                        <table className="data-table data-table--compact">
                          <thead>
                            <tr>
                              <th>時間</th>
                              <th>類型</th>
                              <th className="num">金額</th>
                              <th className="num">桶</th>
                              <th>訂單</th>
                              <th className="num">本筆後餘額</th>
                              <th>備註</th>
                            </tr>
                          </thead>
                          <tbody>
                            {billingLedger.entries.map((e) => (
                              <tr key={e.id}>
                                <td className="mono-text cell-nowrap">{fmtDateTime(e.createdAt)}</td>
                                <td>
                                  <span title={e.entryType}>{ledgerEntryTypeLabel(e.entryType)}</span>
                                </td>
                                <td className="num">{Number(e.amount).toLocaleString()}</td>
                                <td className="num">{e.barrelDelta === 0 ? "—" : e.barrelDelta}</td>
                                <td className="mono-text">{e.orderNo ?? "—"}</td>
                                <td className="num">{Number(e.balanceAfter).toLocaleString()}</td>
                                <td>
                                  <small className="text-muted">{e.note ?? "—"}</small>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : billingLedger && !billingLedgerErr ? (
                    <p className="card__hint">尚無帳務流水</p>
                  ) : null}
                </div>
              </section>

              <section id="billing-payments" className="customer-edit-section">
                <header className="customer-edit-section__head customer-edit-section__head--row">
                  <div>
                    <h4 className="customer-edit-section__title">銷單收款紀錄</h4>
                    <p className="customer-edit-section__desc">實際收款（如司機帶回），可與帳務流水對照。</p>
                  </div>
                  {customerPayments.length > 0 ? (
                    <span className="customer-billing-payments-total">
                      合計 <strong>$ {paymentsTotal.toLocaleString()}</strong>
                    </span>
                  ) : null}
                </header>
                <div className="customer-edit-section__body">
                  {paymentsErr ? <p className="feedback feedback--err">{paymentsErr}</p> : null}
                  {customerPayments.length > 0 ? (
                    <ul className="customer-payment-cards">
                      {customerPayments.map((p) => (
                        <li key={p.id} className="customer-payment-card">
                          <div className="customer-payment-card__head">
                            <strong className="customer-payment-card__amount">$ {Number(p.amount).toLocaleString()}</strong>
                            <span className="badge badge--default">{p.paymentMethod}</span>
                          </div>
                          <dl className="customer-overview-dl">
                            <dt>收款時間</dt>
                            <dd className="mono-text">{fmtDateTime(p.paidAt)}</dd>
                            <dt>訂單</dt>
                            <dd className="mono-text">{p.orderNo ?? "—"}</dd>
                            {p.note ? (
                              <>
                                <dt>備註</dt>
                                <dd>{p.note}</dd>
                              </>
                            ) : null}
                          </dl>
                        </li>
                      ))}
                    </ul>
                  ) : !paymentsErr ? (
                    <p className="card__hint">尚無銷單收款紀錄</p>
                  ) : null}
                </div>
              </section>
            </div>
              ) : null}

              {workspaceTab === "orders" && detail && !detailLoading && detailId ? (
            <div className="customer-edit-layout">
              <div className="customer-edit-stats">
                <div className="customer-edit-stat">
                  <span className="customer-edit-stat__label">訂單筆數</span>
                  <strong className="customer-edit-stat__value">{customerOrderStats.count}</strong>
                </div>
                <div className="customer-edit-stat">
                  <span className="customer-edit-stat__label">已完成</span>
                  <strong className="customer-edit-stat__value">{customerOrderStats.completed}</strong>
                </div>
                <div className="customer-edit-stat">
                  <span className="customer-edit-stat__label">進行中</span>
                  <strong className="customer-edit-stat__value">{customerOrderStats.inProgress}</strong>
                </div>
                <div className="customer-edit-stat">
                  <span className="customer-edit-stat__label">合計應收</span>
                  <strong className="customer-edit-stat__value">$ {moneyText(customerOrderStats.totalAmount)}</strong>
                  <span className="customer-edit-stat__hint">含稅 · 最近 100 筆加總</span>
                </div>
              </div>

              {(detail.salesOrders ?? []).length === 0 ? (
                <p className="card__hint">尚無訂單紀錄</p>
              ) : (
                <ul className="customer-order-cards">
                  {(detail.salesOrders ?? []).map((o) => {
                    const deliveryDate =
                      o.assignments?.[0]?.driverReportedAt ??
                      o.assignments?.[0]?.assignmentDate ??
                      o.scheduledDeliveryDate;
                    const isMonthly =
                      o.billingTypeAtOrder === "monthly" || (o.billingTypeAtOrder == null && detail.billingType === "monthly");
                    return (
                      <li key={String(o.id)} className="customer-order-card">
                        <div className="customer-order-card__head">
                          <div className="customer-order-card__head-main">
                            <span className="customer-order-card__no mono-text">{o.orderNo}</span>
                            <span className={orderStatusBadgeClass(o.status)}>{orderStatusLabel(o.status)}</span>
                          </div>
                          <strong className="customer-order-card__amount">$ {moneyText(customerOrderBillableAmount(o))}</strong>
                        </div>
                        <dl className="customer-order-card__meta">
                          <dt>送貨日</dt>
                          <dd>{fmtYmd(deliveryDate as unknown as string | null | undefined)}</dd>
                          <dt>結帳</dt>
                          <dd>{billingTypeLabel(o.billingTypeAtOrder ?? detail.billingType)}</dd>
                          {isMonthly ? (
                            <>
                              <dt>月結期別</dt>
                              <dd>
                                {o.billingPeriodKey ?? "—"}
                                <span className="customer-order-card__paid">
                                  {o.monthlyPeriodPaid ? "已付" : "未付"}
                                </span>
                              </dd>
                            </>
                          ) : null}
                          <dt>送貨點</dt>
                          <dd>
                            {(o.deliveryAddress?.label ?? "").trim() || "—"}
                            {o.deliveryAddress?.addressLine ? (
                              <span className="customer-order-card__addr-line">{o.deliveryAddress.addressLine}</span>
                            ) : null}
                          </dd>
                        </dl>
                        {(o.lines ?? []).length > 0 ? (
                          <ul className="customer-order-card__lines">
                            {(o.lines ?? []).map((ln) => {
                              const lineBt =
                                ln.billingTypeAtLine ??
                                (o.billingTypeAtOrder && o.billingTypeAtOrder !== "mixed" ? o.billingTypeAtOrder : null) ??
                                detail.billingType;
                              return (
                                <li key={String(ln.id)}>
                                  <span>{ln.product?.name ?? "商品"}</span>
                                  <span className="customer-order-card__line-qty">× {ln.qtyOrdered}</span>
                                  {ln.isPromotionGift ? (
                                    <span className="badge badge--default">贈品</span>
                                  ) : ln.isReplenishment ? (
                                    <span className="badge badge--default">補送</span>
                                  ) : ln.linePurpose === "prepaid_barrel_topup" ? (
                                    <span className="badge badge--delivering">預付桶儲值</span>
                                  ) : (
                                    <span className="badge badge--default">{billingTypeLabel(lineBt)}</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                        {(o.pendingPrepaidTopupBarrels ?? 0) > 0 ? (
                          <p className="customer-order-card__notice">
                            儲值待入帳 <strong>{o.pendingPrepaidTopupBarrels}</strong> 桶（現金應收全沖清後才入預付桶餘額）
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
              ) : null}
            </div>
          )}
        </main>
      </div>
      {barrelOrderDetail ? (
        <OrderDetailModal order={barrelOrderDetail} onClose={() => setBarrelOrderDetail(null)} />
      ) : null}
    </section>
  );
}
