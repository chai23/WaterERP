import { useEffect, useMemo, useState } from "react";
import liff from "@line/liff";
import { TW_CITY_LIST, TW_DISTRICTS_BY_CITY, composeTaiwanAddress } from "./taiwanAddress";

type Address = {
  id: string | number;
  addressLine: string;
  label?: string | null;
  deliveryFloor?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactMobile?: string | null;
  notes?: string | null;
  barrelsOnSite?: number | null;
  isDefault?: boolean;
};

type PrepaidProductBalance = {
  productId: string;
  productName: string;
  unit?: string;
  barrels: number;
};

type Customer = {
  id: string;
  customerCode?: string | null;
  name: string;
  mobile?: string | null;
  phone?: string | null;
  billingType?: string;
  prepaidBarrelBalance?: number;
  prepaidBarrelByProduct?: PrepaidProductBalance[];
  addresses: Address[];
};

type Product = {
  id: string | number;
  productCode?: string | null;
  name: string;
  unit: string;
  salePrice: string | number;
  consumesPrepaidBarrel?: boolean;
};

type OrderLine = {
  qtyOrdered: number;
  qtyDelivered?: number;
  unitPrice?: string | number;
  lineAmount?: string | number;
  linePurpose?: string | null;
  isPromotionGift?: boolean;
  promotionNote?: string | null;
  promotionRuleKey?: string | null;
  product?: { name?: string; unit?: string } | null;
};

type OrderRow = {
  id: string | number;
  orderNo: string;
  status: string;
  totalAmount: string | number;
  subtotal?: string | number;
  scheduledDeliveryDate?: string | null;
  remark?: string | null;
  source?: string;
  billingTypeAtOrder?: string | null;
  createdAt?: string;
  deliveryAddress?: Address | null;
  lines?: OrderLine[];
  assignments?: Array<{
    estimatedDeliverySlot?: string | null;
    assignmentDate?: string | null;
    status?: string;
    driver?: { user?: { displayName?: string | null } | null } | null;
  }>;
};

type Tab = "order" | "orders" | "account";
type OrderFilter = "all" | "active" | "done";

const TOKEN_KEY = "water_liff_member_token";

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ ok: boolean; status: number; data?: T; message?: string; needRegister?: boolean }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "1",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let payload: { ok?: boolean; data?: T; message?: string; needRegister?: boolean } = {};
  try {
    payload = raw ? (JSON.parse(raw) as typeof payload) : {};
  } catch {
    return {
      ok: false,
      status: res.status,
      message: res.ok
        ? "伺服器回應格式錯誤（若使用 ngrok，請確認隧道仍在運作）"
        : `連線失敗（HTTP ${res.status}）`,
    };
  }
  return {
    ok: Boolean(payload.ok),
    status: res.status,
    data: payload.data,
    message: payload.message,
    needRegister: Boolean(payload.needRegister),
  };
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending_review":
      return "待確認";
    case "confirmed":
      return "已接單";
    case "assigned":
      return "已派車";
    case "delivering":
      return "配送中";
    case "pending_settlement":
      return "待核銷";
    case "completed":
      return "已完成";
    case "not_delivered":
      return "未送達";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "pending_review":
      return "badge badge--pending";
    case "confirmed":
    case "assigned":
    case "delivering":
    case "pending_settlement":
      return "badge badge--progress";
    case "completed":
      return "badge badge--done";
    case "not_delivered":
      return "badge badge--fail";
    case "cancelled":
      return "badge badge--cancel";
    default:
      return "badge badge--progress";
  }
}

function isActiveStatus(status: string): boolean {
  return !["completed", "cancelled", "not_delivered"].includes(status);
}

function money(v: string | number | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("zh-TW") : String(v ?? "0");
}

function billingLabel(type?: string | null): string {
  switch (type) {
    case "monthly":
      return "月結";
    case "prepaid":
      return "預付桶";
    case "cash":
      return "現金";
    case "mixed":
      return "混合";
    default:
      return type || "現金";
  }
}

function billingHint(type?: string | null): string {
  switch (type) {
    case "monthly":
      return "依您的會員設定，線上訂單將以「月結」記帳，配送後併入月結對帳。";
    case "prepaid":
      return "依您的會員設定以「預付桶」扣抵。餘額不足時可同單加儲值，配送時一併收款後入帳。";
    case "cash":
      return "依您的會員設定，線上訂單為「現金」結算，配送時請備妥貨款。";
    default:
      return "結帳方式依您的會員主檔設定，無需自行選擇。";
  }
}

function floorLabel(floor?: number | null): string | null {
  if (floor == null || !Number.isFinite(floor)) return null;
  if (floor === 0) return "地面／騎樓";
  if (floor < 0) return `地下 ${Math.abs(floor)} 樓`;
  return `${floor} 樓`;
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function formatYmd(raw?: string | null): string {
  if (!raw) return "—";
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return ymdLocal(d);
  return s.slice(0, 10);
}

function orderDeliveryDateLabel(o: {
  scheduledDeliveryDate?: string | null;
  assignments?: Array<{ assignmentDate?: string | null }>;
}): string {
  if (o.scheduledDeliveryDate) return formatYmd(o.scheduledDeliveryDate);
  const assignDate = o.assignments?.[0]?.assignmentDate;
  if (assignDate) return formatYmd(assignDate);
  return "—";
}

function linePurposeLabel(l: OrderLine): string {
  if (l.isPromotionGift) return l.promotionNote?.trim() || "贈送";
  if ((l.linePurpose ?? "delivery") === "prepaid_barrel_topup") return "預付儲值";
  return "出貨配送";
}

function lineSummaryText(l: OrderLine): string {
  const name = l.product?.name ?? "商品";
  const purpose = linePurposeLabel(l);
  return `${name}×${l.qtyOrdered}（${purpose}）`;
}

function formatDateTime(raw?: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16);
  return d.toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function IconOrder({ active }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 7h13l-1.4 8.2a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.6L5.2 4H3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={active ? 1 : 0.85}
      />
      <circle cx="10" cy="20" r="1.2" fill="currentColor" />
      <circle cx="17" cy="20" r="1.2" fill="currentColor" />
    </svg>
  );
}

function IconList({ active }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 7h12M8 12h12M8 17h12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity={active ? 1 : 0.85}
      />
      <circle cx="4.5" cy="7" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="17" r="1.2" fill="currentColor" />
    </svg>
  );
}

function IconUser({ active }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" opacity={active ? 1 : 0.85} />
      <path
        d="M5 19.2c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity={active ? 1 : 0.85}
      />
    </svg>
  );
}

export default function App() {
  const [bootError, setBootError] = useState("");
  const [booting, setBooting] = useState(true);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [tab, setTab] = useState<Tab>("order");

  const [mobile, setMobile] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpHint, setOtpHint] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [needRegister, setNeedRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [regBillingType, setRegBillingType] = useState<"cash" | "monthly" | "prepaid">("cash");
  const [regCity, setRegCity] = useState("");
  const [regDistrict, setRegDistrict] = useState("");
  const [regStreet, setRegStreet] = useState("");
  const [bindMsg, setBindMsg] = useState("");
  const [binding, setBinding] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [qtyByProduct, setQtyByProduct] = useState<Record<string, number>>({});
  const [topupQtyByProduct, setTopupQtyByProduct] = useState<Record<string, number>>({});
  const [orderMode, setOrderMode] = useState<"delivery" | "topup">("delivery");
  const [addressId, setAddressId] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [showCustomDate, setShowCustomDate] = useState(false);
  const [remark, setRemark] = useState("");
  const [orderMsg, setOrderMsg] = useState("");
  const [ordering, setOrdering] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [productsError, setProductsError] = useState("");
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  const [newAddrLabel, setNewAddrLabel] = useState("");
  const [newAddrCity, setNewAddrCity] = useState("");
  const [newAddrDistrict, setNewAddrDistrict] = useState("");
  const [newAddrStreet, setNewAddrStreet] = useState("");
  const [newAddrFloor, setNewAddrFloor] = useState("");
  const [addingAddr, setAddingAddr] = useState(false);
  const [addrMsg, setAddrMsg] = useState("");
  const [showAddAddr, setShowAddAddr] = useState(false);

  const regDistricts = regCity ? TW_DISTRICTS_BY_CITY[regCity] ?? [] : [];
  const newAddrDistricts = newAddrCity ? TW_DISTRICTS_BY_CITY[newAddrCity] ?? [] : [];

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const datePresets = useMemo(
    () => [
      { key: "today", label: "今天", value: ymdLocal(today) },
      { key: "tomorrow", label: "明天", value: ymdLocal(addDays(today, 1)) },
      { key: "day2", label: "後天", value: ymdLocal(addDays(today, 2)) },
    ],
    [today],
  );

  const selectedLines = useMemo(
    () =>
      Object.entries(qtyByProduct)
        .filter(([, q]) => q > 0)
        .map(([productId, qty]) => ({ productId, qty })),
    [qtyByProduct],
  );

  const selectedTopupLines = useMemo(
    () =>
      Object.entries(topupQtyByProduct)
        .filter(([, q]) => q > 0)
        .map(([productId, qty]) => ({ productId, qty })),
    [topupQtyByProduct],
  );

  const cartTotal = useMemo(() => {
    let total = 0;
    let qtySum = 0;
    let itemCount = 0;
    let topupCash = 0;
    const addFrom = (source: Record<string, number>, asTopup: boolean) => {
      for (const [id, qty] of Object.entries(source)) {
        if (qty <= 0) continue;
        const p = products.find((x) => String(x.id) === id);
        if (!p) continue;
        const amount = Number(p.salePrice) * qty;
        total += amount;
        qtySum += qty;
        itemCount += 1;
        if (asTopup) topupCash += amount;
      }
    };
    if (orderMode === "topup") {
      addFrom(topupQtyByProduct, true);
    } else {
      addFrom(qtyByProduct, false);
      addFrom(topupQtyByProduct, true);
    }
    return { total, qtySum, itemCount, topupCash };
  }, [orderMode, qtyByProduct, topupQtyByProduct, products]);

  const selectedAddress = useMemo(
    () => customer?.addresses.find((a) => String(a.id) === addressId) ?? null,
    [customer, addressId],
  );

  const filteredOrders = useMemo(() => {
    if (orderFilter === "active") return orders.filter((o) => isActiveStatus(o.status));
    if (orderFilter === "done") return orders.filter((o) => !isActiveStatus(o.status));
    return orders;
  }, [orders, orderFilter]);

  const activeOrderCount = useMemo(() => orders.filter((o) => isActiveStatus(o.status)).length, [orders]);

  const prepaidBalanceByProductId = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of customer?.prepaidBarrelByProduct ?? []) {
      map.set(String(row.productId), row.barrels);
    }
    return map;
  }, [customer]);

  const prepaidCartNeed = useMemo(() => {
    if (customer?.billingType !== "prepaid") {
      return [] as Array<{ id: string; name: string; need: number; avail: number; topup: number }>;
    }
    const needMap = new Map<string, { id: string; name: string; need: number; avail: number; topup: number }>();
    for (const [id, qty] of Object.entries(qtyByProduct)) {
      if (qty <= 0) continue;
      const p = products.find((x) => String(x.id) === id);
      if (!p?.consumesPrepaidBarrel) continue;
      const avail = prepaidBalanceByProductId.get(id) ?? 0;
      const topup = topupQtyByProduct[id] ?? 0;
      needMap.set(id, { id, name: p.name, need: qty, avail, topup });
    }
    return [...needMap.values()];
  }, [customer?.billingType, qtyByProduct, topupQtyByProduct, products, prepaidBalanceByProductId]);

  const prepaidShortfall = prepaidCartNeed.some((r) => r.need > r.avail + r.topup);

  const coverPrepaidShortfall = () => {
    setTopupQtyByProduct((prev) => {
      const next = { ...prev };
      for (const row of prepaidCartNeed) {
        const needTopup = Math.max(0, row.need - row.avail);
        if (needTopup > 0) next[row.id] = needTopup;
        else delete next[row.id];
      }
      return next;
    });
  };

  const applyCustomer = (c: Customer) => {
    setCustomer(c);
    if (c.addresses.length === 1) {
      setAddressId(String(c.addresses[0].id));
    } else {
      setAddressId((prev) => (c.addresses.some((a) => String(a.id) === prev) ? prev : ""));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const liffId = import.meta.env.VITE_LIFF_ID?.trim();
        const bypass = import.meta.env.VITE_LIFF_DEV_BYPASS === "1" || !liffId;
        let nextIdToken: string;

        if (bypass) {
          const fakeUser = localStorage.getItem("water_liff_dev_user") || `U_dev_${Date.now()}`;
          localStorage.setItem("water_liff_dev_user", fakeUser);
          nextIdToken = `dev:${fakeUser}`;
        } else {
          await liff.init({ liffId });
          if (!liff.isLoggedIn()) {
            liff.login({ redirectUri: window.location.href.split("#")[0] });
            return;
          }
          nextIdToken = liff.getIDToken() || "";
          if (!nextIdToken) {
            try {
              liff.logout();
            } catch {
              // ignore
            }
            liff.login({ redirectUri: window.location.href.split("#")[0] });
            return;
          }
        }
        if (cancelled) return;
        setIdToken(nextIdToken);

        const existing = localStorage.getItem(TOKEN_KEY);
        if (existing) {
          const me = await api<Customer>("/api/liff/me", { token: existing });
          if (me.ok && me.data) {
            setToken(existing);
            applyCustomer(me.data);
            setBooting(false);
            return;
          }
          localStorage.removeItem(TOKEN_KEY);
        }

        const session = await api<{
          bound: boolean;
          token?: string;
          customer?: Customer;
        }>("/api/liff/session", { method: "POST", body: { idToken: nextIdToken } });

        if (!session.ok) {
          setBootError(session.message || "無法建立 LIFF 工作階段");
          setBooting(false);
          return;
        }
        if (session.data?.bound && session.data.token && session.data.customer) {
          localStorage.setItem(TOKEN_KEY, session.data.token);
          setToken(session.data.token);
          applyCustomer(session.data.customer);
        }
        setBooting(false);
      } catch (e) {
        if (!cancelled) {
          setBootError(String(e));
          setBooting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      setProductsError("");
      const [prodRes, orderRes, meRes] = await Promise.all([
        api<Product[]>("/api/liff/products", { token }),
        api<OrderRow[]>("/api/liff/orders", { token }),
        api<Customer>("/api/liff/me", { token }),
      ]);
      if (prodRes.ok && prodRes.data) {
        setProducts(prodRes.data);
        if (prodRes.data.length === 0) {
          setProductsError("目前沒有開放線上訂購的商品，請洽客服或稍後再試。");
        }
      } else {
        setProducts([]);
        setProductsError(prodRes.message || "無法載入商品列表");
      }
      if (orderRes.ok && orderRes.data) setOrders(orderRes.data);
      if (meRes.ok && meRes.data) setCustomer(meRes.data);
    })();
  }, [token]);

  useEffect(() => {
    if (!token || tab !== "account") return;
    void (async () => {
      const me = await api<Customer>("/api/liff/me", { token });
      if (me.ok && me.data) setCustomer(me.data);
    })();
  }, [token, tab]);

  const requestOtp = async () => {
    if (!idToken) return;
    setBindMsg("");
    setOtpHint("");
    const res = await api<{
      expiresAt: string;
      devCode?: string;
      skipped?: boolean;
      delivery?: "line" | "dev" | "skip";
    }>("/api/liff/otp/request", {
      method: "POST",
      body: { idToken, mobile },
    });
    if (!res.ok) {
      setBindMsg(res.message || "無法寄送驗證碼");
      return;
    }
    setOtpSent(true);
    if (res.data?.skipped || res.data?.delivery === "skip") {
      setOtpHint("測試模式：已略過驗證碼，請直接按「綁定會員」");
      setOtpCode("");
    } else if (res.data?.devCode) {
      setOtpHint(`開發模式驗證碼：${res.data.devCode}`);
      setOtpCode(res.data.devCode);
    } else {
      setOtpHint("驗證碼已透過 LINE 訊息發送，請到官方帳號聊天室查看後輸入");
    }
  };

  const bind = async () => {
    if (!idToken) return;
    setBinding(true);
    setBindMsg("");
    try {
      let addressLine: string | undefined;
      if (needRegister) {
        if (!regCity || !regDistrict || !regStreet.trim()) {
          setBindMsg("請選擇縣市、鄉鎮市區，並填寫街道與門牌");
          return;
        }
        addressLine = composeTaiwanAddress(regCity, regDistrict, regStreet);
      }
      const res = await api<{ token: string; customer: Customer }>("/api/liff/bind", {
        method: "POST",
        body: {
          idToken,
          mobile,
          code: otpCode,
          ...(needRegister
            ? { name: regName, addressLine, billingType: regBillingType }
            : {}),
        },
      });
      if (!res.ok) {
        if (res.needRegister) setNeedRegister(true);
        setBindMsg(res.message || "綁定失敗");
        return;
      }
      if (res.data?.token) {
        localStorage.setItem(TOKEN_KEY, res.data.token);
        setToken(res.data.token);
        applyCustomer(res.data.customer);
      }
    } finally {
      setBinding(false);
    }
  };

  const submitOrder = async () => {
    if (!token) return;
    setOrdering(true);
    setOrderMsg("");
    try {
      if (!addressId) {
        setOrderMsg("請選擇配送／聯絡地址");
        return;
      }
      const isTopupOnly = orderMode === "topup";
      if (isTopupOnly) {
        if (selectedTopupLines.length === 0) {
          setOrderMsg("請至少選擇一項要儲值的商品數量");
          return;
        }
      } else if (selectedLines.length === 0) {
        setOrderMsg("請至少加購一項商品");
        return;
      }
      if (!isTopupOnly && prepaidShortfall) {
        setOrderMsg("預付桶不足，請先「一鍵補足儲值」或調高本單儲值桶數（可配送時再收款）");
        return;
      }

      const lines = isTopupOnly
        ? selectedTopupLines.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            linePurpose: "prepaid_barrel_topup" as const,
          }))
        : [
            ...selectedLines.map((l) => ({
              productId: l.productId,
              qty: l.qty,
            })),
            ...selectedTopupLines.map((l) => ({
              productId: l.productId,
              qty: l.qty,
              linePurpose: "prepaid_barrel_topup" as const,
            })),
          ];

      const hasTopup = lines.some((l) => "linePurpose" in l && l.linePurpose === "prepaid_barrel_topup");
      const remarkText = remark.trim();
      const res = await api<{ orderNo?: string }>("/api/liff/orders", {
        method: "POST",
        token,
        body: {
          deliveryAddressId: addressId,
          lines,
          scheduledDeliveryDate: isTopupOnly ? undefined : scheduledDate || undefined,
          remark: isTopupOnly
            ? `【LINE 預付儲值申請】${remarkText}`.trim()
            : hasTopup
              ? `【LINE 配送時收款儲值】${remarkText}`.trim()
              : remarkText || undefined,
        },
      });
      if (!res.ok) {
        setOrderMsg(res.message || (isTopupOnly ? "儲值申請失敗" : "下單失敗"));
        return;
      }
      setOrderMsg(
        isTopupOnly
          ? `儲值申請已送出：${res.data?.orderNo ?? ""}，客服確認並完成收款後會入帳桶數`
          : hasTopup
            ? `下單成功：${res.data?.orderNo ?? ""}（含儲值，配送時收款後入帳）`
            : `下單成功：${res.data?.orderNo ?? ""}，客服確認後會安排配送`,
      );
      setQtyByProduct({});
      setTopupQtyByProduct({});
      setRemark("");
      const [orderRes, meRes] = await Promise.all([
        api<OrderRow[]>("/api/liff/orders", { token }),
        api<Customer>("/api/liff/me", { token }),
      ]);
      if (orderRes.ok && orderRes.data) setOrders(orderRes.data);
      if (meRes.ok && meRes.data) setCustomer(meRes.data);
      setTab("orders");
      setOrderFilter("active");
      setOrderMode("delivery");
    } finally {
      setOrdering(false);
    }
  };

  const addAddress = async () => {
    if (!token) return;
    setAddingAddr(true);
    setAddrMsg("");
    try {
      if (!newAddrCity || !newAddrDistrict || !newAddrStreet.trim()) {
        setAddrMsg("請選擇縣市、鄉鎮市區，並填寫街道與門牌");
        return;
      }
      const addressLine = composeTaiwanAddress(newAddrCity, newAddrDistrict, newAddrStreet);
      const res = await api<Address>("/api/liff/addresses", {
        method: "POST",
        token,
        body: {
          addressLine,
          label: newAddrLabel.trim() || undefined,
          deliveryFloor: newAddrFloor.trim() !== "" ? Number(newAddrFloor) : undefined,
        },
      });
      if (!res.ok || !res.data) {
        setAddrMsg(res.message || "新增地址失敗");
        return;
      }
      const me = await api<Customer>("/api/liff/me", { token });
      if (me.ok && me.data) {
        setCustomer(me.data);
        setAddressId(String(res.data.id));
      }
      setNewAddrLabel("");
      setNewAddrCity("");
      setNewAddrDistrict("");
      setNewAddrStreet("");
      setNewAddrFloor("");
      setShowAddAddr(false);
      setAddrMsg("已新增配送地址");
    } finally {
      setAddingAddr(false);
    }
  };

  const setQty = (id: string, next: number) => {
    setQtyByProduct((prev) => {
      const q = Math.max(0, Math.min(99, next));
      if (q === 0) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: q };
    });
  };

  const setTopupQty = (id: string, next: number) => {
    setTopupQtyByProduct((prev) => {
      const q = Math.max(0, Math.min(999, next));
      if (q === 0) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: q };
    });
  };

  if (booting) {
    return (
      <div className="loading">
        <div className="loading__dot" />
        <div>載入訂水服務…</div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="liff-shell">
        <header className="liff-hero">
          <p className="liff-hero__eyebrow">LINE 訂水</p>
          <h1 className="liff-hero__brand">超好企業</h1>
        </header>
        <div className="liff-card">
          <h2>無法啟動訂水頁面</h2>
          <p className="feedback feedback--err">{bootError}</p>
        </div>
      </div>
    );
  }

  if (!customer || !token) {
    const bindStep = needRegister ? 3 : otpSent ? 2 : 1;
    return (
      <div className="liff-shell">
        <header className="liff-hero">
          <p className="liff-hero__eyebrow">LINE 訂水</p>
          <h1 className="liff-hero__brand">超好企業</h1>
          <p className="liff-hero__sub">綁定手機成為會員，即可線上訂水、查詢配送進度</p>
        </header>
        <section className="liff-card">
          <div className="step-pills" aria-hidden="true">
            <div className={`step-pill ${bindStep >= 1 ? "is-on" : ""}`}>1 手機</div>
            <div className={`step-pill ${bindStep >= 2 ? "is-on" : ""}`}>2 驗證</div>
            <div className={`step-pill ${bindStep >= 3 ? "is-on" : ""}`}>3 完成</div>
          </div>
          <div className="section-head">
            <h2>會員綁定</h2>
            <span className="hint">約 1 分鐘完成</span>
          </div>
          <label className="field">
            <span>手機號碼</span>
            <input
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="09xxxxxxxx"
              inputMode="tel"
              autoComplete="tel"
            />
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn--ghost" onClick={() => void requestOtp()}>
              {otpSent ? "重新取得驗證碼" : "取得驗證碼"}
            </button>
          </div>
          {otpHint ? <p className="feedback feedback--info">{otpHint}</p> : null}
          <label className="field">
            <span>驗證碼</span>
            <input
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="6 位數字"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          {needRegister ? (
            <>
              <p className="muted" style={{ marginBottom: "0.75rem" }}>
                查無既有會員，請補填資料完成註冊。
              </p>
              <label className="field">
                <span>姓名／公司名稱</span>
                <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="例：王小明" />
              </label>
              <div className="field">
                <span>結帳方式</span>
                <div className="addr-grid">
                  {(
                    [
                      { value: "cash" as const, title: "現金", desc: "配送時付款" },
                      { value: "monthly" as const, title: "月結", desc: "月底／約定日對帳" },
                      { value: "prepaid" as const, title: "預付桶", desc: "先儲值再扣桶出貨" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`addr-card${regBillingType === opt.value ? " is-selected" : ""}`}
                      onClick={() => setRegBillingType(opt.value)}
                    >
                      <div className="addr-card__top">
                        <span className="addr-card__label">{opt.title}</span>
                      </div>
                      <div className="addr-card__line">{opt.desc}</div>
                    </button>
                  ))}
                </div>
                {regBillingType === "prepaid" ? (
                  <p className="muted" style={{ marginTop: "0.45rem", marginBottom: 0 }}>
                    註冊後預付餘額為 0，請向客服完成儲值後再下單。
                  </p>
                ) : null}
                {regBillingType === "monthly" ? (
                  <p className="muted" style={{ marginTop: "0.45rem", marginBottom: 0 }}>
                    月結條件（結帳日等）可由客服後續協助確認。
                  </p>
                ) : null}
              </div>
              <label className="field">
                <span>縣市</span>
                <select
                  value={regCity}
                  onChange={(e) => {
                    setRegCity(e.target.value);
                    setRegDistrict("");
                  }}
                >
                  <option value="">請選擇縣市</option>
                  {TW_CITY_LIST.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>鄉鎮市區</span>
                <select
                  value={regDistrict}
                  disabled={!regCity}
                  onChange={(e) => setRegDistrict(e.target.value)}
                >
                  <option value="">{regCity ? "請選擇鄉鎮市區" : "請先選擇縣市"}</option>
                  {regDistricts.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>街道與門牌</span>
                <input
                  value={regStreet}
                  onChange={(e) => setRegStreet(e.target.value)}
                  disabled={!regDistrict}
                  placeholder="例：中正路 100 號 3 樓"
                />
              </label>
              {regCity && regDistrict && regStreet.trim() ? (
                <p className="muted" style={{ marginTop: "-0.35rem", marginBottom: "0.75rem" }}>
                  完整地址：{composeTaiwanAddress(regCity, regDistrict, regStreet)}
                </p>
              ) : null}
            </>
          ) : null}
          <button type="button" className="btn btn--primary" disabled={binding} onClick={() => void bind()}>
            {binding ? "綁定中…" : needRegister ? "註冊並綁定" : "驗證並綁定"}
          </button>
          {bindMsg ? <p className="feedback feedback--err">{bindMsg}</p> : null}
        </section>
      </div>
    );
  }

  const showCart = tab === "order" && cartTotal.itemCount > 0;

  return (
    <div className={`liff-shell${showCart ? " liff-shell--cart" : ""}`}>
      <header className="liff-hero">
        <p className="liff-hero__eyebrow">LINE 訂水</p>
        <h1 className="liff-hero__brand">超好企業</h1>
        <p className="liff-hero__sub">您好，{customer.name}</p>
        <div className="liff-hero__meta">
          {customer.customerCode ? <span className="chip chip--glass">編號 {customer.customerCode}</span> : null}
          <span className="chip chip--glass">{billingLabel(customer.billingType)}</span>
          {activeOrderCount > 0 ? <span className="chip chip--glass">{activeOrderCount} 筆進行中</span> : null}
        </div>
      </header>

      {tab === "order" ? (
        <>
          <section className="liff-card">
            <div className="section-head">
              <h2>結帳方式</h2>
              <span className="hint">{billingLabel(customer.billingType)}</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {billingHint(customer.billingType)}
            </p>
            {customer.billingType === "prepaid" ? (
              <div className="billing-prepaid">
                {(customer.prepaidBarrelByProduct?.length ?? 0) > 0 ? (
                  <div className="profile-block">
                    {customer.prepaidBarrelByProduct!.map((row) => (
                      <div className="profile-row" key={row.productId}>
                        <span>{row.productName}</span>
                        <strong>
                          剩 {row.barrels} {row.unit || "桶"}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="feedback feedback--info" style={{ marginBottom: 0 }}>
                    預付餘額為 0 仍可先訂水：在商品上加「本單儲值」，配送時一併收款後入帳。
                  </p>
                )}
                <div className="mode-toggle" role="tablist" aria-label="訂水或儲值">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={orderMode === "delivery"}
                    className={`mode-toggle__btn${orderMode === "delivery" ? " is-on" : ""}`}
                    onClick={() => setOrderMode("delivery")}
                  >
                    訂水配送
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={orderMode === "topup"}
                    className={`mode-toggle__btn${orderMode === "topup" ? " is-on" : ""}`}
                    onClick={() => setOrderMode("topup")}
                  >
                    僅申請儲值
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="liff-card">
            <div className="section-head">
              <h2>{orderMode === "topup" ? "聯絡地址" : "配送地址"}</h2>
              <span className="hint">點選即可切換</span>
            </div>
            {customer.addresses.length === 0 ? (
              <p className="muted">尚無地址，請到「會員」新增。</p>
            ) : (
              <div className="addr-grid">
                {customer.addresses.map((a) => {
                  const id = String(a.id);
                  const selected = id === addressId;
                  const fl = floorLabel(a.deliveryFloor);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`addr-card${selected ? " is-selected" : ""}`}
                      onClick={() => setAddressId(id)}
                    >
                      <div className="addr-card__top">
                        <span className="addr-card__label">{a.label?.trim() || "配送點"}</span>
                      </div>
                      <div className="addr-card__line">{a.addressLine}</div>
                      <div className="addr-card__meta">
                        {fl ? <span className="mini-tag">{fl}</span> : null}
                        {a.barrelsOnSite != null && a.barrelsOnSite > 0 ? (
                          <span className="mini-tag">現場空桶 {a.barrelsOnSite}</span>
                        ) : null}
                        {a.contactMobile || a.contactPhone ? (
                          <span className="mini-tag">{a.contactMobile || a.contactPhone}</span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {orderMode === "delivery" ? (
          <>
          <section className="liff-card">
            <div className="section-head">
              <h2>希望配送日</h2>
              <span className="hint">可略過，由客服安排</span>
            </div>
            <div className="date-row">
              <button
                type="button"
                className={`chip chip--btn${!scheduledDate ? " is-on" : ""}`}
                onClick={() => {
                  setScheduledDate("");
                  setShowCustomDate(false);
                }}
              >
                不指定
              </button>
              {datePresets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`chip chip--btn${scheduledDate === p.value && !showCustomDate ? " is-on" : ""}`}
                  onClick={() => {
                    setScheduledDate(p.value);
                    setShowCustomDate(false);
                  }}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className={`chip chip--btn${showCustomDate ? " is-on" : ""}`}
                onClick={() => setShowCustomDate(true)}
              >
                其他日期
              </button>
            </div>
            {showCustomDate ? (
              <label className="field date-custom">
                <span>自訂日期</span>
                <input
                  type="date"
                  value={scheduledDate}
                  min={ymdLocal(today)}
                  onChange={(e) => setScheduledDate(e.target.value)}
                />
              </label>
            ) : scheduledDate ? (
              <p className="muted">已選：{scheduledDate}</p>
            ) : null}
          </section>

          <section className="liff-card">
            <div className="section-head">
              <h2>選擇商品</h2>
              <span className="hint">{products.length} 項可訂</span>
            </div>
            {productsError ? <p className="feedback feedback--err">{productsError}</p> : null}
            {!productsError && products.length === 0 ? <p className="muted">載入商品中…</p> : null}
            <div className="product-list">
              {products.map((p) => {
                const id = String(p.id);
                const qty = qtyByProduct[id] ?? 0;
                const topupQty = topupQtyByProduct[id] ?? 0;
                const lineTotal = Number(p.salePrice) * qty;
                const showTopup = customer.billingType === "prepaid" && p.consumesPrepaidBarrel && qty > 0;
                return (
                  <div className={`product-card${qty > 0 ? " has-qty" : ""}`} key={id}>
                    <div className="product-card__main">
                      <div>
                        <h3 className="product-card__name">{p.name}</h3>
                        <div className="product-card__price">
                          ${money(p.salePrice)}
                          <span>／{p.unit}</span>
                        </div>
                        <div className="product-card__tags">
                          {p.productCode ? <span className="mini-tag">#{p.productCode}</span> : null}
                          {customer.billingType === "prepaid" && p.consumesPrepaidBarrel ? (
                            <span className="mini-tag mini-tag--accent">
                              剩 {prepaidBalanceByProductId.get(id) ?? 0} 桶
                            </span>
                          ) : null}
                        </div>
                        {qty > 0 ? (
                          <div className="product-card__sub">
                            出貨小計 ${money(lineTotal)}（{qty} {p.unit}）
                          </div>
                        ) : null}
                      </div>
                      <div className="qty-ctl">
                        <button type="button" aria-label="減少" onClick={() => setQty(id, qty - 1)}>
                          −
                        </button>
                        <span className="qty-ctl__val">{qty}</span>
                        <button type="button" aria-label="增加" onClick={() => setQty(id, qty + 1)}>
                          ＋
                        </button>
                      </div>
                    </div>
                    {showTopup ? (
                      <div className="product-card__topup">
                        <div className="product-card__topup-head">
                          <span>本單儲值（配送時收款）</span>
                          {topupQty > 0 ? <span>${money(Number(p.salePrice) * topupQty)}</span> : null}
                        </div>
                        <div className="qty-ctl">
                          <button type="button" aria-label="減少儲值" onClick={() => setTopupQty(id, topupQty - 1)}>
                            −
                          </button>
                          <span className="qty-ctl__val">{topupQty}</span>
                          <button type="button" aria-label="增加儲值" onClick={() => setTopupQty(id, topupQty + 1)}>
                            ＋
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <label className="field" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              <span>備註（選填）</span>
              <input
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="上樓方式、聯絡時段、門口注意事項…"
              />
            </label>
            {prepaidCartNeed.length > 0 && orderMode === "delivery" ? (
              <div className={`feedback ${prepaidShortfall ? "feedback--err" : "feedback--info"}`} style={{ marginTop: "0.75rem" }}>
                {prepaidCartNeed.map((r) => (
                  <div key={r.id}>
                    {r.name}：出貨 {r.need}／餘額 {r.avail}
                    {r.topup > 0 ? `／本單儲值 ${r.topup}` : ""}
                    {r.need > r.avail + r.topup ? "（仍不足）" : "（已可下單）"}
                  </div>
                ))}
                {prepaidShortfall ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ marginTop: "0.55rem" }}
                    onClick={coverPrepaidShortfall}
                  >
                    一鍵補足儲值（配送時收款）
                  </button>
                ) : cartTotal.topupCash > 0 ? (
                  <div style={{ marginTop: "0.35rem" }}>配送時預估收款（儲值）${money(cartTotal.topupCash)}</div>
                ) : null}
              </div>
            ) : null}
            {orderMsg ? (
              <p className={`feedback ${orderMsg.includes("成功") || orderMsg.includes("已送出") ? "feedback--ok" : "feedback--err"}`}>{orderMsg}</p>
            ) : null}
            {selectedAddress && cartTotal.itemCount === 0 ? (
              <p className="muted" style={{ marginTop: "0.75rem" }}>
                點商品右側 ＋ 加入數量後即可送出。
              </p>
            ) : null}
          </section>
          </>
          ) : (
          <section className="liff-card">
            <div className="section-head">
              <h2>申請預付儲值</h2>
              <span className="hint">送出後由客服確認收款</span>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              選擇要儲值的商品與桶數後送出。客服會在後台「確認 LINE 訂單」看到申請，收款沖帳完成後桶數會自動入帳。
            </p>
            {productsError ? <p className="feedback feedback--err">{productsError}</p> : null}
            <div className="product-list">
              {products.map((p) => {
                const id = String(p.id);
                const qty = topupQtyByProduct[id] ?? 0;
                const lineTotal = Number(p.salePrice) * qty;
                return (
                  <div className={`product-card${qty > 0 ? " has-qty" : ""}`} key={id}>
                    <div className="product-card__main">
                      <div>
                        <h3 className="product-card__name">{p.name}</h3>
                        <div className="product-card__price">
                          ${money(p.salePrice)}
                          <span>／{p.unit}</span>
                        </div>
                        <div className="product-card__tags">
                          {p.productCode ? <span className="mini-tag">#{p.productCode}</span> : null}
                          <span className="mini-tag">目前剩 {prepaidBalanceByProductId.get(id) ?? 0} 桶</span>
                        </div>
                        {qty > 0 ? (
                          <div className="product-card__sub">
                            儲值金額 ${money(lineTotal)}（{qty} {p.unit}）
                          </div>
                        ) : null}
                      </div>
                      <div className="qty-ctl">
                        <button type="button" aria-label="減少" onClick={() => setTopupQty(id, qty - 1)}>
                          −
                        </button>
                        <span className="qty-ctl__val">{qty}</span>
                        <button type="button" aria-label="增加" onClick={() => setTopupQty(id, qty + 1)}>
                          ＋
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <label className="field" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              <span>備註（選填）</span>
              <input
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="匯款帳號後五碼、希望聯絡時段…"
              />
            </label>
            {orderMsg ? (
              <p className={`feedback ${orderMsg.includes("成功") || orderMsg.includes("已送出") ? "feedback--ok" : "feedback--err"}`}>{orderMsg}</p>
            ) : null}
          </section>
          )}
        </>
      ) : null}

      {tab === "orders" ? (
        <section className="liff-card">
          <div className="section-head">
            <h2>我的訂單</h2>
            <span className="hint">共 {orders.length} 筆</span>
          </div>
          <div className="filter-row">
            {(
              [
                ["all", "全部"],
                ["active", "進行中"],
                ["done", "已結束"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip chip--btn${orderFilter === key ? " is-on" : ""}`}
                onClick={() => setOrderFilter(key)}
              >
                {label}
                {key === "active" && activeOrderCount > 0 ? ` ${activeOrderCount}` : ""}
              </button>
            ))}
          </div>
          {filteredOrders.length === 0 ? (
            <div className="empty-state">
              <strong>目前沒有訂單</strong>
              <span>{orderFilter === "all" ? "到「訂水」頁面下第一筆訂單吧" : "換個篩選條件看看"}</span>
            </div>
          ) : null}
          {filteredOrders.map((o) => {
            const id = String(o.id);
            const open = expandedOrderId === id;
            const latest = o.assignments?.[0];
            const driverName = latest?.driver?.user?.displayName;
            const addr = o.deliveryAddress;
            return (
              <div className="order-card" key={id}>
                <button
                  type="button"
                  className="order-card__main"
                  onClick={() => setExpandedOrderId(open ? null : id)}
                  aria-expanded={open}
                >
                  <div>
                    <div className="order-card__no">
                      {o.orderNo}{" "}
                      <span className={statusBadgeClass(o.status)}>{statusLabel(o.status)}</span>
                    </div>
                    <div className="order-card__lines">
                      {o.lines?.map((l) => lineSummaryText(l)).join("、") || "—"}
                    </div>
                    <div className="order-card__meta">
                      {orderDeliveryDateLabel(o) !== "—" ? (
                        <span className="mini-tag">配送 {orderDeliveryDateLabel(o)}</span>
                      ) : (
                        <span className="mini-tag">配送日未指定</span>
                      )}
                      {latest?.estimatedDeliverySlot ? (
                        <span className="mini-tag mini-tag--accent">{latest.estimatedDeliverySlot}</span>
                      ) : null}
                      {o.source === "liff" ? <span className="mini-tag">線上</span> : null}
                    </div>
                  </div>
                  <div className="order-card__amount">
                    <strong>${money(o.totalAmount)}</strong>
                    <div className="muted">{open ? "收合詳情" : "查看詳情"}</div>
                  </div>
                </button>
                {open ? (
                  <div className="order-card__detail">
                    <dl>
                      <div className="detail-row">
                        <dt>狀態</dt>
                        <dd>{statusLabel(o.status)}</dd>
                      </div>
                      <div className="detail-row">
                        <dt>下單時間</dt>
                        <dd>{formatDateTime(o.createdAt)}</dd>
                      </div>
                      <div className="detail-row">
                        <dt>配送日</dt>
                        <dd>{orderDeliveryDateLabel(o)}</dd>
                      </div>
                      {latest?.estimatedDeliverySlot ? (
                        <div className="detail-row">
                          <dt>時段</dt>
                          <dd>{latest.estimatedDeliverySlot}</dd>
                        </div>
                      ) : null}
                      {driverName ? (
                        <div className="detail-row">
                          <dt>司機</dt>
                          <dd>{driverName}</dd>
                        </div>
                      ) : null}
                      {addr ? (
                        <div className="detail-row">
                          <dt>地址</dt>
                          <dd>
                            {(addr.label ? `${addr.label} · ` : "") + addr.addressLine}
                            {floorLabel(addr.deliveryFloor) ? `（${floorLabel(addr.deliveryFloor)}）` : ""}
                          </dd>
                        </div>
                      ) : null}
                      {o.billingTypeAtOrder ? (
                        <div className="detail-row">
                          <dt>結帳</dt>
                          <dd>{billingLabel(o.billingTypeAtOrder)}</dd>
                        </div>
                      ) : null}
                      {o.remark ? (
                        <div className="detail-row">
                          <dt>備註</dt>
                          <dd>{o.remark}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {o.lines && o.lines.length > 0 ? (
                      <table className="line-table">
                        <thead>
                          <tr>
                            <th>品項</th>
                            <th>用途</th>
                            <th>數量</th>
                            <th>金額</th>
                          </tr>
                        </thead>
                        <tbody>
                          {o.lines.map((l, idx) => {
                            const purpose = (l.linePurpose ?? "delivery") === "prepaid_barrel_topup";
                            const gift = Boolean(l.isPromotionGift);
                            return (
                              <tr key={idx}>
                                <td>
                                  <div>{l.product?.name ?? "商品"}</div>
                                  {gift && l.promotionNote ? (
                                    <div className="muted" style={{ fontSize: "0.75rem" }}>
                                      {l.promotionNote}
                                    </div>
                                  ) : null}
                                </td>
                                <td>
                                  <span
                                    className={`mini-tag${gift ? "" : purpose ? " mini-tag--accent" : ""}`}
                                  >
                                    {linePurposeLabel(l)}
                                  </span>
                                </td>
                                <td>
                                  {l.qtyOrdered}
                                  {!purpose &&
                                  !gift &&
                                  l.qtyDelivered != null &&
                                  l.qtyDelivered !== l.qtyOrdered
                                    ? `（送 ${l.qtyDelivered}）`
                                    : ""}
                                </td>
                                <td>
                                  {gift || Number(l.lineAmount ?? 0) === 0
                                    ? gift
                                      ? "贈送"
                                      : "$0"
                                    : `$${money(l.lineAmount ?? Number(l.unitPrice ?? 0) * l.qtyOrdered)}`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {tab === "account" ? (
        <>
          <section className="liff-card">
            <div className="section-head">
              <h2>會員資料</h2>
              <span className="hint">綁定中</span>
            </div>
            <div className="profile-block">
              <div className="profile-row">
                <span>名稱</span>
                <strong>{customer.name}</strong>
              </div>
              <div className="profile-row">
                <span>客戶編號</span>
                <strong>{customer.customerCode ?? "—"}</strong>
              </div>
              <div className="profile-row">
                <span>手機</span>
                <strong>{customer.mobile || customer.phone || "—"}</strong>
              </div>
              <div className="profile-row">
                <span>結帳方式</span>
                <strong>{billingLabel(customer.billingType)}</strong>
              </div>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
              {billingHint(customer.billingType)}
            </p>
          </section>

          {customer.billingType === "prepaid" || (customer.prepaidBarrelByProduct?.length ?? 0) > 0 ? (
            <section className="liff-card">
              <div className="section-head">
                <h2>預付桶餘額</h2>
                <span className="hint">共 {customer.prepaidBarrelBalance ?? 0} 桶</span>
              </div>
              {(customer.prepaidBarrelByProduct?.length ?? 0) > 0 ? (
                <div className="profile-block">
                  {customer.prepaidBarrelByProduct!.map((row) => (
                    <div className="profile-row" key={row.productId}>
                      <span>{row.productName}</span>
                      <strong>
                        {row.barrels} {row.unit || "桶"}
                      </strong>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">目前沒有可用的預付桶餘額。</p>
              )}
            </section>
          ) : null}

          <section className="liff-card">
            <div className="section-head">
              <h2>配送地址</h2>
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setShowAddAddr((v) => !v)}>
                {showAddAddr ? "取消" : "新增"}
              </button>
            </div>
            {customer.addresses.length === 0 ? <p className="muted">尚無配送地址</p> : null}
            {customer.addresses.map((a) => (
              <div className="addr-static" key={String(a.id)}>
                <div className="addr-static__title">
                  <span>{a.label?.trim() || "配送點"}</span>
                </div>
                <div className="addr-card__line">{a.addressLine}</div>
                <div className="addr-card__meta">
                  {floorLabel(a.deliveryFloor) ? <span className="mini-tag">{floorLabel(a.deliveryFloor)}</span> : null}
                  {a.barrelsOnSite != null && a.barrelsOnSite > 0 ? (
                    <span className="mini-tag">現場空桶 {a.barrelsOnSite}</span>
                  ) : null}
                  {a.contactName ? <span className="mini-tag">{a.contactName}</span> : null}
                  {a.contactMobile || a.contactPhone ? (
                    <span className="mini-tag">{a.contactMobile || a.contactPhone}</span>
                  ) : null}
                </div>
                {a.notes ? <p className="muted" style={{ margin: "0.4rem 0 0" }}>{a.notes}</p> : null}
              </div>
            ))}
            {showAddAddr ? (
              <div className="add-addr">
                <label className="field">
                  <span>名稱（選填）</span>
                  <input value={newAddrLabel} onChange={(e) => setNewAddrLabel(e.target.value)} placeholder="公司／住家" />
                </label>
                <label className="field">
                  <span>縣市</span>
                  <select
                    value={newAddrCity}
                    onChange={(e) => {
                      setNewAddrCity(e.target.value);
                      setNewAddrDistrict("");
                    }}
                  >
                    <option value="">請選擇縣市</option>
                    {TW_CITY_LIST.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>鄉鎮市區</span>
                  <select
                    value={newAddrDistrict}
                    disabled={!newAddrCity}
                    onChange={(e) => setNewAddrDistrict(e.target.value)}
                  >
                    <option value="">{newAddrCity ? "請選擇鄉鎮市區" : "請先選擇縣市"}</option>
                    {newAddrDistricts.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>街道與門牌</span>
                  <input
                    value={newAddrStreet}
                    onChange={(e) => setNewAddrStreet(e.target.value)}
                    disabled={!newAddrDistrict}
                    placeholder="例：中正路 100 號 3 樓"
                  />
                </label>
                {newAddrCity && newAddrDistrict && newAddrStreet.trim() ? (
                  <p className="muted" style={{ marginTop: "-0.35rem", marginBottom: "0.75rem" }}>
                    完整地址：{composeTaiwanAddress(newAddrCity, newAddrDistrict, newAddrStreet)}
                  </p>
                ) : null}
                <label className="field">
                  <span>樓層（選填，數字）</span>
                  <input
                    value={newAddrFloor}
                    onChange={(e) => setNewAddrFloor(e.target.value)}
                    inputMode="numeric"
                    placeholder="例：2"
                  />
                </label>
                <button type="button" className="btn btn--primary" disabled={addingAddr} onClick={() => void addAddress()}>
                  {addingAddr ? "新增中…" : "儲存地址"}
                </button>
              </div>
            ) : null}
            {addrMsg ? (
              <p className={`feedback ${addrMsg.includes("失敗") || addrMsg.includes("請") ? "feedback--err" : "feedback--ok"}`}>
                {addrMsg}
              </p>
            ) : null}
          </section>
        </>
      ) : null}

      {showCart ? (
        <div className="cart-bar">
          <div className="cart-bar__summary">
            <strong>${money(cartTotal.total)}</strong>
            <span>
              {cartTotal.itemCount} 項 · 共 {cartTotal.qtySum} 件
              {cartTotal.topupCash > 0 ? ` · 含儲值 $${money(cartTotal.topupCash)}` : ""}
              {selectedAddress ? ` · ${selectedAddress.label?.trim() || "已選地址"}` : " · 尚未選地址"}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--primary"
            disabled={ordering || !addressId || (orderMode === "delivery" && prepaidShortfall)}
            onClick={() => void submitOrder()}
          >
            {ordering
              ? "送出中…"
              : orderMode === "delivery" && prepaidShortfall
                ? "餘額不足"
                : orderMode === "topup"
                  ? "送出儲值申請"
                  : "送出訂單"}
          </button>
        </div>
      ) : null}

      <nav className="liff-nav">
        <button type="button" className={tab === "order" ? "is-active" : ""} onClick={() => setTab("order")}>
          <IconOrder active={tab === "order"} />
          訂水
        </button>
        <button
          type="button"
          className={`${tab === "orders" ? "is-active" : ""}${activeOrderCount > 0 ? " nav-badge" : ""}`}
          data-count={activeOrderCount > 0 ? String(Math.min(activeOrderCount, 9)) : undefined}
          onClick={() => setTab("orders")}
        >
          <IconList active={tab === "orders"} />
          訂單
        </button>
        <button type="button" className={tab === "account" ? "is-active" : ""} onClick={() => setTab("account")}>
          <IconUser active={tab === "account"} />
          會員
        </button>
      </nav>
    </div>
  );
}
