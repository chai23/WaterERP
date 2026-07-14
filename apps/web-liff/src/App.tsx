import { useEffect, useMemo, useState } from "react";
import liff from "@line/liff";

type Address = {
  id: string | number;
  addressLine: string;
  label?: string | null;
  deliveryFloor?: number | null;
  isDefault?: boolean;
};

type Customer = {
  id: string;
  customerCode?: string | null;
  name: string;
  mobile?: string | null;
  billingType?: string;
  addresses: Address[];
};

type Product = {
  id: string | number;
  name: string;
  unit: string;
  salePrice: string | number;
};

type OrderRow = {
  id: string | number;
  orderNo: string;
  status: string;
  totalAmount: string | number;
  scheduledDeliveryDate?: string | null;
  source?: string;
  lines?: Array<{ qtyOrdered: number; product?: { name?: string } | null }>;
  assignments?: Array<{
    estimatedDeliverySlot?: string | null;
    assignmentDate?: string | null;
    status?: string;
  }>;
};

type Tab = "order" | "orders" | "account";

const TOKEN_KEY = "water_liff_member_token";

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ ok: boolean; status: number; data?: T; message?: string; needRegister?: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  return {
    ok: Boolean(payload.ok ?? res.ok),
    status: res.status,
    data: payload.data as T | undefined,
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

function money(v: string | number | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("zh-TW") : String(v ?? "0");
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
  const [needRegister, setNeedRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [regAddress, setRegAddress] = useState("");
  const [bindMsg, setBindMsg] = useState("");
  const [binding, setBinding] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [qtyByProduct, setQtyByProduct] = useState<Record<string, number>>({});
  const [addressId, setAddressId] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [remark, setRemark] = useState("");
  const [orderMsg, setOrderMsg] = useState("");
  const [ordering, setOrdering] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);

  const selectedLines = useMemo(
    () =>
      Object.entries(qtyByProduct)
        .filter(([, q]) => q > 0)
        .map(([productId, qty]) => ({ productId, qty })),
    [qtyByProduct],
  );

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
            liff.login();
            return;
          }
          nextIdToken = liff.getIDToken() || "";
          if (!nextIdToken) throw new Error("無法取得 LIFF ID Token");
        }
        if (cancelled) return;
        setIdToken(nextIdToken);

        const existing = localStorage.getItem(TOKEN_KEY);
        if (existing) {
          const me = await api<Customer>("/api/liff/me", { token: existing });
          if (me.ok && me.data) {
            setToken(existing);
            setCustomer(me.data);
            const def = me.data.addresses.find((a) => a.isDefault) ?? me.data.addresses[0];
            if (def) setAddressId(String(def.id));
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
          setCustomer(session.data.customer);
          const def =
            session.data.customer.addresses.find((a) => a.isDefault) ?? session.data.customer.addresses[0];
          if (def) setAddressId(String(def.id));
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
      const [prodRes, orderRes] = await Promise.all([
        api<Product[]>("/api/liff/products", { token }),
        api<OrderRow[]>("/api/liff/orders", { token }),
      ]);
      if (prodRes.ok && prodRes.data) setProducts(prodRes.data);
      if (orderRes.ok && orderRes.data) setOrders(orderRes.data);
    })();
  }, [token]);

  const requestOtp = async () => {
    if (!idToken) return;
    setBindMsg("");
    setOtpHint("");
    const res = await api<{ expiresAt: string; devCode?: string }>("/api/liff/otp/request", {
      method: "POST",
      body: { idToken, mobile },
    });
    if (!res.ok) {
      setBindMsg(res.message || "無法寄送驗證碼");
      return;
    }
    if (res.data?.devCode) {
      setOtpHint(`開發模式驗證碼：${res.data.devCode}`);
      setOtpCode(res.data.devCode);
    } else {
      setOtpHint("驗證碼已產生（正式環境請接簡訊閘道）");
    }
  };

  const bind = async () => {
    if (!idToken) return;
    setBinding(true);
    setBindMsg("");
    try {
      const res = await api<{ token: string; customer: Customer }>("/api/liff/bind", {
        method: "POST",
        body: {
          idToken,
          mobile,
          code: otpCode,
          ...(needRegister
            ? { name: regName, addressLine: regAddress }
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
        setCustomer(res.data.customer);
        const def =
          res.data.customer.addresses.find((a) => a.isDefault) ?? res.data.customer.addresses[0];
        if (def) setAddressId(String(def.id));
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
      if (!addressId || selectedLines.length === 0) {
        setOrderMsg("請選擇配送地址並至少加購一項商品");
        return;
      }
      const res = await api<{ orderNo?: string }>("/api/liff/orders", {
        method: "POST",
        token,
        body: {
          deliveryAddressId: addressId,
          lines: selectedLines.map((l) => ({
            productId: l.productId,
            qty: l.qty,
          })),
          scheduledDeliveryDate: scheduledDate || undefined,
          remark: remark || undefined,
        },
      });
      if (!res.ok) {
        setOrderMsg(res.message || "下單失敗");
        return;
      }
      setOrderMsg(`下單成功：${res.data?.orderNo ?? ""}`);
      setQtyByProduct({});
      setRemark("");
      const orderRes = await api<OrderRow[]>("/api/liff/orders", { token });
      if (orderRes.ok && orderRes.data) setOrders(orderRes.data);
      setTab("orders");
    } finally {
      setOrdering(false);
    }
  };

  if (booting) {
    return <div className="loading">載入中…</div>;
  }

  if (bootError) {
    return (
      <div className="liff-shell">
        <div className="liff-card">
          <h2>無法啟動訂水頁面</h2>
          <p className="feedback feedback--err">{bootError}</p>
        </div>
      </div>
    );
  }

  if (!customer || !token) {
    return (
      <div className="liff-shell">
        <header className="liff-hero">
          <h1 className="liff-hero__brand">超好企業</h1>
          <p className="liff-hero__sub">綁定手機成為會員，即可線上訂水</p>
        </header>
        <section className="liff-card">
          <h2>會員綁定</h2>
          <label className="field">
            <span>手機號碼</span>
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="09xxxxxxxx" inputMode="tel" />
          </label>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <button type="button" className="btn btn--ghost" onClick={() => void requestOtp()}>
              取得驗證碼
            </button>
          </div>
          {otpHint ? <p className="muted">{otpHint}</p> : null}
          <label className="field">
            <span>驗證碼</span>
            <input value={otpCode} onChange={(e) => setOtpCode(e.target.value)} placeholder="6 位數字" inputMode="numeric" />
          </label>
          {needRegister ? (
            <>
              <label className="field">
                <span>姓名／公司名稱</span>
                <input value={regName} onChange={(e) => setRegName(e.target.value)} />
              </label>
              <label className="field">
                <span>配送地址</span>
                <textarea value={regAddress} onChange={(e) => setRegAddress(e.target.value)} rows={3} />
              </label>
            </>
          ) : null}
          <button type="button" className="btn btn--primary" disabled={binding} onClick={() => void bind()}>
            {binding ? "綁定中…" : needRegister ? "註冊並綁定" : "驗證並綁定"}
          </button>
          {bindMsg ? <p className="feedback feedback--err">{bindMsg}</p> : null}
          <p className="muted" style={{ marginTop: "0.85rem" }}>
            若您是新客戶，驗證後會提示補填姓名與地址以完成註冊。
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="liff-shell">
      <header className="liff-hero">
        <h1 className="liff-hero__brand">超好企業</h1>
        <p className="liff-hero__sub">您好，{customer.name}</p>
      </header>

      {tab === "order" ? (
        <section className="liff-card">
          <h2>線上訂水</h2>
          <label className="field">
            <span>配送地址</span>
            <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
              <option value="">請選擇</option>
              {customer.addresses.map((a) => (
                <option key={String(a.id)} value={String(a.id)}>
                  {(a.label ? `${a.label} · ` : "") + a.addressLine}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>希望配送日（選填）</span>
            <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
          </label>
          <div>
            {products.map((p) => {
              const id = String(p.id);
              const qty = qtyByProduct[id] ?? 0;
              return (
                <div className="product-row" key={id}>
                  <div>
                    <strong>{p.name}</strong>
                    <div className="muted">
                      ${money(p.salePrice)}／{p.unit}
                    </div>
                  </div>
                  <div className="qty-ctl">
                    <button
                      type="button"
                      onClick={() =>
                        setQtyByProduct((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] ?? 0) - 1) }))
                      }
                    >
                      −
                    </button>
                    <span>{qty}</span>
                    <button
                      type="button"
                      onClick={() => setQtyByProduct((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))}
                    >
                      ＋
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <label className="field" style={{ marginTop: "0.75rem" }}>
            <span>備註</span>
            <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="上樓、聯絡方式等" />
          </label>
          <button type="button" className="btn btn--primary" disabled={ordering} onClick={() => void submitOrder()}>
            {ordering ? "送出中…" : "送出訂單"}
          </button>
          {orderMsg ? (
            <p className={`feedback ${orderMsg.includes("成功") ? "feedback--ok" : "feedback--err"}`}>{orderMsg}</p>
          ) : null}
        </section>
      ) : null}

      {tab === "orders" ? (
        <section className="liff-card">
          <h2>我的訂單</h2>
          {orders.length === 0 ? <p className="muted">尚無訂單</p> : null}
          {orders.map((o) => {
            const latest = o.assignments?.[0];
            return (
              <div className="order-row" key={String(o.id)}>
                <div>
                  <div>
                    <strong>{o.orderNo}</strong> <span className="badge">{statusLabel(o.status)}</span>
                  </div>
                  <div className="muted">
                    {o.lines?.map((l) => `${l.product?.name ?? "商品"}×${l.qtyOrdered}`).join("、") || "—"}
                  </div>
                  {latest?.estimatedDeliverySlot ? (
                    <div className="muted">預計時段：{latest.estimatedDeliverySlot}</div>
                  ) : null}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div>${money(o.totalAmount)}</div>
                  <div className="muted">{String(o.scheduledDeliveryDate ?? "").slice(0, 10)}</div>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {tab === "account" ? (
        <section className="liff-card">
          <h2>會員資料</h2>
          <p>
            <strong>{customer.name}</strong>
          </p>
          <p className="muted">客戶編號：{customer.customerCode ?? "—"}</p>
          <p className="muted">手機：{customer.mobile ?? "—"}</p>
          <p className="muted">結帳方式：{customer.billingType ?? "cash"}</p>
          <h2 style={{ marginTop: "1rem" }}>配送地址</h2>
          {customer.addresses.map((a) => (
            <p key={String(a.id)} className="muted">
              {(a.label ? `${a.label}：` : "") + a.addressLine}
            </p>
          ))}
        </section>
      ) : null}

      <nav className="liff-nav">
        <button type="button" className={tab === "order" ? "is-active" : ""} onClick={() => setTab("order")}>
          訂水
        </button>
        <button type="button" className={tab === "orders" ? "is-active" : ""} onClick={() => setTab("orders")}>
          訂單
        </button>
        <button type="button" className={tab === "account" ? "is-active" : ""} onClick={() => setTab("account")}>
          會員
        </button>
      </nav>
    </div>
  );
}
