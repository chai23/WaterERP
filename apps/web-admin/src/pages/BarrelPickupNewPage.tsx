import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "../DashboardContext";
import type { Customer } from "../adminUtils";
import { todayLocalYmd } from "../adminUtils";

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function charsInOrder(query: string, haystack: string): boolean {
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < query.length; i++) {
    if (haystack[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

function scoreCustomerMatch(c: Customer, qRaw: string): number {
  const q = qRaw.trim().toLowerCase();
  if (!q) return 0;
  const code = (c.customerCode ?? "").trim().toLowerCase();
  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, "0");
    if (code === q || code === padded) return 1_000_000;
    if (code.startsWith(q)) return 900_000;
  }
  const name = (c.name ?? "").toLowerCase();
  if (name.includes(q)) return 480_000;
  const qDigits = digitsOnly(qRaw);
  if (qDigits.length >= 6) {
    const phone = digitsOnly(c.phone ?? "");
    if (phone.includes(qDigits)) return 760_000;
  }
  if (q.length >= 2 && charsInOrder(q, name)) return 220_000;
  return 0;
}

const MIN_AUTO_SCORE = 240_000;

export default function BarrelPickupNewPage() {
  const { customers, drivers, vehicles, refreshMasters } = useDashboard();
  const [customerKeyword, setCustomerKeyword] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [pickupDate, setPickupDate] = useState(todayLocalYmd);
  const [barrelsExpected, setBarrelsExpected] = useState("");
  const [remark, setRemark] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void refreshMasters(["customers", "drivers", "vehicles"], false);
  }, [refreshMasters]);
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.find((c) => String(c.id) === customerId);
  const addresses = selectedCustomer?.addresses ?? [];

  useEffect(() => {
    const q = customerKeyword.trim();
    if (!q) {
      setCustomerId("");
      return;
    }
    const ranked = customers
      .map((c) => ({ c, score: scoreCustomerMatch(c, customerKeyword) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0 || ranked[0].score < MIN_AUTO_SCORE) {
      setCustomerId("");
      return;
    }
    setCustomerId(String(ranked[0].c.id));
  }, [customerKeyword, customers]);

  useEffect(() => {
    if (!customerId) {
      setAddressId("");
      return;
    }
    const def = addresses.find((a) => a.isDefault) ?? addresses[0];
    setAddressId(def ? String(def.id) : "");
  }, [customerId, addresses]);

  const addrBarrels = useMemo(() => {
    const a = addresses.find((x) => String(x.id) === addressId);
    return a?.barrelsOnSite ?? 0;
  }, [addresses, addressId]);

  const submit = async () => {
    setMsg("");
    if (!customerId || !addressId || !driverId || !pickupDate) {
      setMsg("請選定客戶、送貨地址、司機與收桶日");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/barrel-pickups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          deliveryAddressId: addressId,
          driverId,
          vehicleId: vehicleId || undefined,
          pickupDateYmd: pickupDate,
          barrelsExpected: barrelsExpected === "" ? undefined : Number(barrelsExpected),
          remark,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "建立失敗");
        return;
      }
      const no = data.data?.pickupNo ?? "";
      setMsg(`已建立收空桶任務 ${no}`);
      setRemark("");
      setBarrelsExpected("");
    } catch {
      setMsg("建立時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">建立收空桶任務</h2>
        <p className="page__desc text-muted">
          司機路過僅收空桶、不送貨時使用。不經銷售訂單；核銷後減少送貨點在場空桶數。
        </p>
      </header>

      <section className="card">
        <div className="card__body">
          <div className="field">
            <span>客戶關鍵字</span>
            <input
              type="search"
              value={customerKeyword}
              onChange={(e) => setCustomerKeyword(e.target.value)}
              placeholder="6 碼編號、姓名或電話"
              autoComplete="off"
            />
          </div>
          {selectedCustomer ? (
            <p className="order-new__identity order-new__identity--compact" style={{ marginTop: "0.5rem" }}>
              <strong>{selectedCustomer.customerCode ?? "------"}</strong> · <strong>{selectedCustomer.name}</strong>
            </p>
          ) : customerKeyword.trim() ? (
            <p className="text-muted">找不到相符客戶</p>
          ) : null}

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>送貨地址</span>
            <select value={addressId} onChange={(e) => setAddressId(e.target.value)} disabled={!customerId}>
              <option value="">— 請選擇 —</option>
              {addresses.map((a) => (
                <option key={String(a.id)} value={String(a.id)}>
                  {(a.label ? `${a.label} · ` : "") + a.addressLine}（在場 {a.barrelsOnSite ?? 0} 桶）
                </option>
              ))}
            </select>
          </div>
          {addressId ? (
            <p className="text-muted" style={{ fontSize: "0.85rem" }}>
              此送貨點目前在場空桶：<strong>{addrBarrels}</strong> 桶（核銷時若司機回報超過此數將拒絕）
            </p>
          ) : null}

          <div className="field-row" style={{ marginTop: "0.75rem", flexWrap: "wrap", gap: "0.75rem" }}>
            <div className="field">
              <span>司機</span>
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)} required>
                <option value="">— 請選擇 —</option>
                {drivers.map((d) => (
                  <option key={String(d.id)} value={String(d.id)}>
                    {d.user?.employeeCode ?? ""} / {d.user?.name ?? ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span>車輛（選填）</span>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">— 不指定 —</option>
                {vehicles.map((v) => (
                  <option key={String(v.id)} value={String(v.id)}>
                    {v.plateNo}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span>預定收桶日</span>
              <input type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
            </div>
            <div className="field">
              <span>預估收桶數（選填）</span>
              <input
                type="number"
                min={0}
                value={barrelsExpected}
                onChange={(e) => setBarrelsExpected(e.target.value)}
                placeholder="可不填"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>備註</span>
            <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} />
          </div>

          {msg ? (
            <div className={msg.includes("已建立") ? "feedback feedback--ok" : "feedback feedback--err"} style={{ marginTop: "0.75rem" }}>
              {msg}
            </div>
          ) : null}

          <button type="button" className="btn btn--primary" style={{ marginTop: "1rem" }} disabled={saving} onClick={() => void submit()}>
            {saving ? "建立中…" : "建立收空桶任務"}
          </button>
        </div>
      </section>
    </div>
  );
}
