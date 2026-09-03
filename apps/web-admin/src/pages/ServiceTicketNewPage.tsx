import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDashboard } from "../DashboardContext";
import type { Customer } from "../adminUtils";

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
    const mobile = digitsOnly(c.mobile ?? "");
    if (phone.includes(qDigits) || mobile.includes(qDigits)) return 760_000;
  }
  if (q.length >= 2 && charsInOrder(q, name)) return 220_000;
  return 0;
}

const MIN_AUTO_SCORE = 240_000;

export default function ServiceTicketNewPage() {
  const { customers, refreshMasters } = useDashboard();
  const navigate = useNavigate();
  const [customerKeyword, setCustomerKeyword] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [serviceType, setServiceType] = useState<"cleaning" | "repair" | "both">("repair");
  const [preferredDate, setPreferredDate] = useState("");
  const [preferredSlot, setPreferredSlot] = useState("");
  const [problemNote, setProblemNote] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [needLoaner, setNeedLoaner] = useState(false);
  const [loanerNote, setLoanerNote] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refreshMasters(["customers"], false);
  }, [refreshMasters]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    if (!customerId || !addressId) {
      setMsg("請選定客戶與服務地址");
      return;
    }
    if (!problemNote.trim()) {
      setMsg("請填寫問題說明（來電內容）");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/service-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          deliveryAddressId: addressId,
          serviceType,
          preferredDate: preferredDate || undefined,
          preferredSlot: preferredSlot.trim() || undefined,
          problemNote: problemNote.trim(),
          customerNote: customerNote.trim() || undefined,
          needLoaner,
          loanerNote: needLoaner ? loanerNote.trim() || undefined : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg(data.message ?? "建立失敗");
        return;
      }
      const ticketNo = data.data?.ticketNo ?? "";
      const id = data.data?.id ?? "";
      setMsg(`已建立服務單 ${ticketNo}`);
      if (id) {
        navigate(`/orders/service-tickets?selected=${encodeURIComponent(id)}`, { replace: false });
      }
    } catch {
      setMsg("建立時發生錯誤");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h2 className="page__title">建立飲水機服務單</h2>
        <p className="page__desc text-muted">
          顧客來電要求維修／清洗時使用。建立後會進入「待受理」，可於{" "}
          <Link to="/orders/service-tickets">服務單管理</Link> 派評估。
        </p>
      </header>

      <section className="card">
        <form className="card__body" onSubmit={(e) => void submit(e)}>
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
              {selectedCustomer.mobile || selectedCustomer.phone ? (
                <span className="text-muted"> · {selectedCustomer.mobile || selectedCustomer.phone}</span>
              ) : null}
            </p>
          ) : customerKeyword.trim() ? (
            <p className="text-muted">找不到相符客戶</p>
          ) : null}

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>服務地址</span>
            <select value={addressId} onChange={(e) => setAddressId(e.target.value)} disabled={!customerId} required>
              <option value="">— 請選擇 —</option>
              {addresses.map((a) => (
                <option key={String(a.id)} value={String(a.id)}>
                  {(a.label ? `${a.label} · ` : "") + a.addressLine}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row-2" style={{ marginTop: "0.75rem" }}>
            <div className="field">
              <span>服務類型</span>
              <select
                value={serviceType}
                onChange={(e) => setServiceType(e.target.value as "cleaning" | "repair" | "both")}
              >
                <option value="repair">維修飲水機</option>
                <option value="cleaning">清洗飲水機</option>
                <option value="both">清洗＋維修</option>
              </select>
            </div>
            <div className="field">
              <span>希望日期（選填）</span>
              <input type="date" value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} />
            </div>
          </div>

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>希望時段（選填）</span>
            <input
              type="text"
              value={preferredSlot}
              onChange={(e) => setPreferredSlot(e.target.value)}
              placeholder="例如：上午、下午 2 點後"
            />
          </div>

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>問題說明（來電內容）</span>
            <textarea
              value={problemNote}
              onChange={(e) => setProblemNote(e.target.value)}
              rows={3}
              required
              placeholder="客戶描述的故障／清洗需求"
            />
          </div>

          <div className="field" style={{ marginTop: "0.75rem" }}>
            <span>內部備註（選填）</span>
            <textarea
              value={customerNote}
              onChange={(e) => setCustomerNote(e.target.value)}
              rows={2}
              placeholder="客服備註，客戶看不到"
            />
          </div>

          <label className="table-inline-check" style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
            <input type="checkbox" checked={needLoaner} onChange={(e) => setNeedLoaner(e.target.checked)} />
            <span>客戶需要備用機（若需載回廠維修）</span>
          </label>
          {needLoaner ? (
            <div className="field" style={{ marginTop: "0.5rem" }}>
              <span>備用機備註（選填）</span>
              <input type="text" value={loanerNote} onChange={(e) => setLoanerNote(e.target.value)} />
            </div>
          ) : null}

          <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn--primary" disabled={saving || !customerId || !addressId}>
              {saving ? "建立中…" : "建立服務單"}
            </button>
            <Link to="/orders/service-tickets" className="btn btn--ghost">
              返回列表
            </Link>
            {msg ? (
              <span className={msg.includes("失敗") || msg.includes("請") ? "feedback feedback--err" : "feedback feedback--ok"}>
                {msg}
              </span>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
