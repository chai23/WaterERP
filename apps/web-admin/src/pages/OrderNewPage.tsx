import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newOrderFormLine, useDashboard, type LineBillingType, type LinePurpose } from "../DashboardContext";
import type { Customer, CustomerBillingSummary, CustomerDetail, CustomerSalesOrder, Product } from "../adminUtils";
import { billingTypeLabel, fmtLocalYmd, orderStatusBadgeClass, sumCustomerBarrelsOnSite } from "../adminUtils";
import { breakdownCashTaxInvoicePreview, DEFAULT_VAT_RATE } from "../taxDisplay";
import { RemarkSloganPicker } from "../components/RemarkSloganPicker";

function parseLineBilling(c: string | undefined | null): LineBillingType {
  if (c === "monthly" || c === "prepaid" || c === "cash") return c;
  return "cash";
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** 字元是否依序出現在字串中（輕量相似：支援略打錯順序時仍有弱命中） */
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
  const idStr = String(c.id);

  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, "0");
    if (code === q || code === padded) return 1_000_000;
    if (code.startsWith(q)) return 900_000 + q.length * 500;
    if (code.includes(q)) return 750_000;
  }

  if (idStr === q || idStr.includes(q)) return 930_000;

  const qDigits = digitsOnly(qRaw);
  const phoneBuckets = new Set<string>();
  const pushDigits = (s: string | null | undefined) => {
    const d = digitsOnly(s ?? "");
    if (d.length > 0) phoneBuckets.add(d);
  };
  pushDigits(c.phone ?? "");
  for (const a of c.addresses ?? []) {
    pushDigits(a.contactPhone ?? "");
  }
  if (qDigits.length >= 6) {
    for (const p of phoneBuckets) {
      if (p === qDigits) return 920_000;
      if (p.endsWith(qDigits)) return 880_000;
      if (p.includes(qDigits)) return 760_000;
    }
  } else if (qDigits.length >= 4 && qDigits === qRaw.trim()) {
    for (const p of phoneBuckets) {
      if (p === qDigits) return 915_000;
      if (p.endsWith(qDigits)) return 870_000;
      if (p.includes(qDigits)) return 720_000;
    }
  }

  const name = (c.name ?? "").toLowerCase();
  if (name === q) return 860_000;
  if (name.startsWith(q)) return 650_000;
  if (name.includes(q)) return 480_000 + Math.min(q.length * 800, 24_000);

  const addrBlob = (c.addresses ?? [])
    .map((a) => `${a.label ?? ""} ${a.addressLine ?? ""} ${a.contactPhone ?? ""}`.toLowerCase())
    .join(" ");
  if (addrBlob.includes(q)) return 460_000;

  if (q.length >= 2 && charsInOrder(q, name)) return 220_000;

  return 0;
}

function defaultDeliveryAddressId(c: Customer): string {
  const list = c.addresses ?? [];
  if (list.length === 0) return "";
  const def = list.find((a) => a.isDefault);
  return String((def ?? list[0]).id);
}

const MATCH_DEBOUNCE_MS = 320;
/** 低於此分數不自動帶入（避免過鬆的模糊命中） */
const MIN_AUTO_SCORE = 240_000;
const AMBIGUOUS_GAP = 38_000;
function resolveProductByCode(active: Product[], codeDigits: string): Product | undefined {
  const raw = codeDigits.trim();
  if (!/^\d{3}$/.test(raw)) return undefined;
  return active.find((pp) => pp.isActive !== false && (pp.productCode ?? "").trim() === raw);
}

function defaultUnitPriceForProduct(
  product: Product,
  lastPriceMap: Record<string, { unitPrice: string; orderedAt: string }>,
): string {
  const last = lastPriceMap[String(product.id)];
  const lastNum = last ? Number(last.unitPrice) : NaN;
  if (last && Number.isFinite(lastNum) && lastNum >= 0) return last.unitPrice;
  return String(product.salePrice);
}

function orderNewMatchHintClass(msg: string): string {
  const base = "order-new__match-hint";
  if (!msg) return base;
  if (msg.includes("找不到") || msg.includes("不明確")) return `${base} order-new__match-hint--err`;
  if (msg.includes("相近")) return `${base} order-new__match-hint--warn`;
  return `${base} order-new__match-hint--ok`;
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
    case "not_delivered":
      return "未送達";
    case "cancelled":
      return "已取消";
    default:
      return status ?? "—";
  }
}

/** 與查詢訂單頁相同：由配送指派紀錄推估實際配送日（YYYY-MM-DD） */
function historyActualDeliveryYmd(o: CustomerSalesOrder): string | null {
  const assignments = Array.isArray(o.assignments) ? o.assignments : [];
  if (assignments.length === 0) return null;
  const picked = assignments
    .map((a) => a?.driverReportedAt ?? a?.assignmentDate ?? a?.completedAt ?? a?.officeSettledAt ?? null)
    .find((v) => v != null && String(v).trim() !== "");
  if (!picked) return null;
  const ymd = fmtLocalYmd(picked);
  return ymd === "—" ? null : ymd;
}

/** 排序用：已完成／未送達優先實際配送日，其餘用預計配送日（對齊查詢頁 deliveryDateLabel 邏輯） */
function historySortDeliveryYmd(o: CustomerSalesOrder): string | null {
  const status = String(o.status ?? "");
  if (status === "completed" || status === "not_delivered") {
    const a = historyActualDeliveryYmd(o);
    if (a) return a;
  }
  const s = fmtLocalYmd(o.scheduledDeliveryDate);
  return s === "—" ? null : s;
}

function historyDeliverySortKeyMs(o: CustomerSalesOrder): number {
  const ymd = historySortDeliveryYmd(o);
  if (!ymd) return Number.MIN_SAFE_INTEGER;
  const parts = ymd.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return Number.MIN_SAFE_INTEGER;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).getTime();
}

function historyLineSummary(line: NonNullable<CustomerSalesOrder["lines"]>[number]): string {
  const name = line.product?.name?.trim() || "（商品）";
  const unit = line.product?.unit?.trim();
  const qty = line.qtyOrdered;
  const suffix = line.isPromotionGift
    ? " · 贈品"
    : line.isReplenishment
      ? " · 補送"
      : line.linePurpose === "prepaid_barrel_topup"
        ? " · 預付桶儲值"
        : "";
  const u = unit ? `${unit}` : "";
  return `${name}${u ? `（${u}）` : ""} × ${qty}${suffix}`;
}

/** 清單列顯示用配送日（實際為主，否則預計） */
function historyDisplayYmd(o: CustomerSalesOrder): string {
  const a = historyActualDeliveryYmd(o);
  if (a) return a;
  const s = fmtLocalYmd(o.scheduledDeliveryDate);
  return s === "—" ? "—" : s;
}

function historyGoodsSummary(o: CustomerSalesOrder, maxLen = 88): string {
  const parts = (o.lines ?? []).map((ln) => {
    let t = historyLineSummary(ln);
    if (t.includes("預付桶儲值")) t = t.replace(" · 預付桶儲值", "（儲值）");
    if (t.includes("補送")) t = t.replace(" · 補送", "（補）");
    if (t.includes("贈品")) t = t.replace(" · 贈品", "（贈）");
    return t;
  });
  const s = parts.join("；");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** 歷史訂單最新配送任務的空桶回收數；尚無回報時回傳 null */
function historyEmptyBarrels(o: CustomerSalesOrder): number | null {
  const assignments = Array.isArray(o.assignments) ? o.assignments : [];
  if (assignments.length === 0) return null;
  const n = assignments[0]?.emptyBarrelsReturned;
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.max(0, Math.floor(Number(n)));
}

function historyRowDetailTitle(o: CustomerSalesOrder): string {
  const lines = (o.lines ?? []).map((ln) => historyLineSummary(ln)).join("\n");
  const empty = historyEmptyBarrels(o);
  const emptyLine = empty != null ? `\n收空桶 ${empty}` : "";
  return `${historyDisplayYmd(o)}｜${o.orderNo}${emptyLine}\n${lines}`;
}

type OrderLineField = "code" | "billing" | "price" | "qty";

function lineFieldKey(rowId: string, field: OrderLineField): string {
  return `${rowId}-${field}`;
}

type OrderNewPageProps = {
  /** 嵌入「建立訂單」分頁殼層時略過外層 card／hero */
  embedded?: boolean;
};

export default function OrderNewPage({ embedded = false }: OrderNewPageProps) {
  const {
    customers,
    products,
    saving,
    formMessage,
    form,
    setForm,
    onSubmitCreateOrder,
    selectedCustomer,
    refreshMasters,
  } = useDashboard();
  const [billingSummary, setBillingSummary] = useState<CustomerBillingSummary | null>(null);
  const [lastPriceMap, setLastPriceMap] = useState<Record<string, { unitPrice: string; orderedAt: string }>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [historyOrders, setHistoryOrders] = useState<CustomerSalesOrder[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [customerKeyword, setCustomerKeyword] = useState("");
  const [matchHint, setMatchHint] = useState("");
  const [lineProductCodes, setLineProductCodes] = useState<Record<string, string>>({});
  const [promotionPreview, setPromotionPreview] = useState<string[]>([]);
  const lineFieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const pendingLineFocus = useRef<{ rowId: string; field: OrderLineField } | null>(null);

  useEffect(() => {
    void refreshMasters(["customers", "products"], false);
  }, [refreshMasters]);

  const focusLineField = useCallback((rowId: string, field: OrderLineField) => {
    requestAnimationFrame(() => {
      const el = lineFieldRefs.current[lineFieldKey(rowId, field)];
      el?.focus();
      if (el instanceof HTMLInputElement && field !== "billing") {
        el.select();
      }
    });
  }, []);

  const setLineFieldRef = useCallback((rowId: string, field: OrderLineField) => {
    return (el: HTMLElement | null) => {
      lineFieldRefs.current[lineFieldKey(rowId, field)] = el;
    };
  }, []);

  useEffect(() => {
    const pending = pendingLineFocus.current;
    if (!pending) return;
    pendingLineFocus.current = null;
    focusLineField(pending.rowId, pending.field);
  }, [form.lines, focusLineField]);

  const alternateCandidates = useMemo(() => {
    const q = customerKeyword.trim();
    if (!q) return [];
    return customers
      .map((c) => ({ c, score: scoreCustomerMatch(c, customerKeyword) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 18);
  }, [customers, customerKeyword]);

  const pickerOptions = useMemo(() => {
    const base = alternateCandidates;
    if (!form.customerId) return base;
    if (base.some(({ c }) => String(c.id) === form.customerId)) return base;
    const sel = customers.find((c) => String(c.id) === form.customerId);
    if (!sel) return base;
    return [{ c: sel, score: 0 }, ...base];
  }, [alternateCandidates, customers, form.customerId]);

  useEffect(() => {
    const q = customerKeyword.trim();
    const timer = window.setTimeout(() => {
      if (!q) {
        setMatchHint("");
        setForm((f) => ({ ...f, customerId: "", deliveryAddressId: "" }));
        return;
      }

      const ranked = customers
        .map((c) => ({ c, score: scoreCustomerMatch(c, customerKeyword) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length === 0) {
        setMatchHint("找不到相符客戶，請換個關鍵字試試。");
        setForm((f) => ({ ...f, customerId: "", deliveryAddressId: "" }));
        return;
      }

      const top = ranked[0];
      const second = ranked[1];
      const ambiguous =
        second != null && top.score >= MIN_AUTO_SCORE && second.score >= MIN_AUTO_SCORE && top.score - second.score < AMBIGUOUS_GAP;

      if (top.score < MIN_AUTO_SCORE) {
        setMatchHint("結果不明確，請輸入更完整的客戶編號、電話或地址。");
        setForm((f) => ({ ...f, customerId: "", deliveryAddressId: "" }));
        return;
      }

      const addrId = defaultDeliveryAddressId(top.c);
      setForm((f) => ({
        ...f,
        customerId: String(top.c.id),
        deliveryAddressId: addrId,
      }));

      if (ambiguous) {
        setMatchHint(
          `已自動帶入最相近客戶（${top.c.customerCode ?? "------"}／${top.c.name}）。另有相近結果，若不正確請從下方「改選」或繼續輸入更完整資料。`,
        );
      } else {
        setMatchHint(`已自動選取：${top.c.customerCode ?? "------"}／${top.c.name}`);
      }
    }, MATCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [customerKeyword, customers, setForm]);

  useEffect(() => {
    if (!form.customerId) {
      setBillingSummary(null);
      setLastPriceMap({});
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    void fetch(`/api/customers/${form.customerId}/billing-summary`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.ok && j.data) setBillingSummary(j.data as CustomerBillingSummary);
        else setBillingSummary(null);
      })
      .catch(() => {
        if (!cancelled) setBillingSummary(null);
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.customerId]);

  useEffect(() => {
    if (!form.customerId) {
      setHistoryOrders([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    void fetch(`/api/customers/${form.customerId}`)
      .then(async (r) => {
        const data: unknown = await r.json();
        if (cancelled) return;
        if (!r.ok || !data || typeof data !== "object") {
          setHistoryOrders([]);
          return;
        }
        const raw = (data as CustomerDetail).salesOrders;
        setHistoryOrders(Array.isArray(raw) ? raw : []);
      })
      .catch(() => {
        if (!cancelled) setHistoryOrders([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.customerId]);

  useEffect(() => {
    if (!form.customerId) {
      setLastPriceMap({});
      return;
    }
    let cancelled = false;
    void fetch(`/api/customers/${form.customerId}/last-product-prices`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j?.ok || !Array.isArray(j.data)) {
          setLastPriceMap({});
          return;
        }
        const next: Record<string, { unitPrice: string; orderedAt: string }> = {};
        for (const row of j.data as Array<{ productId?: string; unitPrice?: string; orderedAt?: string }>) {
          if (!row?.productId) continue;
          next[String(row.productId)] = {
            unitPrice: String(row.unitPrice ?? "0"),
            orderedAt: String(row.orderedAt ?? ""),
          };
        }
        setLastPriceMap(next);
      })
      .catch(() => {
        if (!cancelled) setLastPriceMap({});
      });
    return () => {
      cancelled = true;
    };
  }, [form.customerId]);

  useEffect(() => {
    if (!form.customerId || !selectedCustomer) return;
    const bt = parseLineBilling(selectedCustomer.billingType);
    const invRaw = selectedCustomer.defaultCashInvoiceMode;
    const inv =
      invRaw === "tax_inclusive" || invRaw === "tax_exclusive" || invRaw === "none" ? invRaw : "none";
    setForm((f) => ({
      ...f,
      cashInvoiceMode: inv,
      lines: f.lines.map((row) => {
        if (row.linePurpose === "prepaid_barrel_topup" || row.isReplenishment) {
          return { ...row, billingType: "cash" };
        }
        return { ...row, billingType: bt };
      }),
    }));
  }, [form.customerId, selectedCustomer?.billingType, selectedCustomer?.defaultCashInvoiceMode]);

  const activeProducts = useMemo(() => products.filter((p) => p.isActive !== false), [products]);

  useEffect(() => {
    if (!form.customerId || Object.keys(lastPriceMap).length === 0) return;
    setForm((f) => {
      let changed = false;
      const nextLines = f.lines.map((ln) => {
        if (!ln.productId || ln.isReplenishment) return ln;
        const p = activeProducts.find((x) => String(x.id) === ln.productId);
        if (!p) return ln;
        const price = defaultUnitPriceForProduct(p, lastPriceMap);
        const catalog = String(p.salePrice);
        const shouldApply = ln.unitPrice.trim() === "" || (ln.unitPrice === catalog && price !== catalog);
        if (shouldApply && ln.unitPrice !== price) {
          changed = true;
          return { ...ln, unitPrice: price };
        }
        return ln;
      });
      return changed ? { ...f, lines: nextLines } : f;
    });
  }, [lastPriceMap, form.customerId, activeProducts, setForm]);

  const lineSubtotals = useMemo(() => {
    const topupProducts = new Set(
      form.lines.filter((l) => l.linePurpose === "prepaid_barrel_topup" && l.productId).map((l) => l.productId),
    );
    return form.lines.map((l) => {
      if (!l.productId || l.qty <= 0) return 0;
      const p = activeProducts.find((x) => String(x.id) === l.productId);
      if (!p) return 0;
      const up = l.unitPrice.trim() === "" ? Number(p.salePrice) : Number(l.unitPrice);
      if (!Number.isFinite(up) || up < 0) return 0;
      const sub = up * l.qty;
      if (
        l.linePurpose !== "prepaid_barrel_topup" &&
        l.billingType === "prepaid" &&
        topupProducts.has(l.productId)
      ) {
        return 0;
      }
      return sub;
    });
  }, [form.lines, activeProducts]);

  const estimatedTotal = useMemo(() => lineSubtotals.reduce((a, b) => a + b, 0), [lineSubtotals]);

  const estimatedByBilling = useMemo(() => {
    let cash = 0;
    let monthly = 0;
    let prepaid = 0;
    form.lines.forEach((l, i) => {
      const sub = lineSubtotals[i] ?? 0;
      if (sub <= 0) return;
      if (l.billingType === "cash") cash += sub;
      else if (l.billingType === "monthly") monthly += sub;
      else prepaid += sub;
    });
    return { cash, monthly, prepaid };
  }, [form.lines, lineSubtotals]);

  const cashInvoicePreview = useMemo(
    () => breakdownCashTaxInvoicePreview(estimatedByBilling.cash, form.cashInvoiceMode ?? "none"),
    [estimatedByBilling.cash, form.cashInvoiceMode],
  );

  const lineBillingMix = useMemo(() => {
    const set = new Set(form.lines.map((l) => l.billingType));
    return set.size > 1;
  }, [form.lines]);

  const promotionPreviewSig = useMemo(
    () =>
      form.lines
        .filter((l) => l.productId && l.qty > 0)
        .map((l) => `${l.productId}:${l.qty}:${l.linePurpose}:${l.billingType}:${l.isReplenishment ? 1 : 0}`)
        .join("|"),
    [form.lines],
  );

  useEffect(() => {
    const filled = form.lines.filter((l) => l.productId && l.qty > 0);
    if (filled.length === 0) {
      setPromotionPreview([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch("/api/promotion-rules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: filled.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            billingType: l.billingType,
            linePurpose: l.linePurpose,
            isReplenishment: Boolean(l.isReplenishment),
          })),
        }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          const messages = Array.isArray(j?.data?.messages)
            ? (j.data.messages as Array<{ message?: string }>).map((m) => String(m.message ?? "")).filter(Boolean)
            : [];
          setPromotionPreview(messages);
        })
        .catch(() => {
          if (!cancelled) setPromotionPreview([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [promotionPreviewSig]);

  const lineIdsSig = useMemo(() => form.lines.map((r) => r.id).join("|"), [form.lines]);

  const sortedHistoryOrders = useMemo(() => {
    const list = [...historyOrders];
    list.sort((a, b) => {
      const kb = historyDeliverySortKeyMs(b);
      const ka = historyDeliverySortKeyMs(a);
      if (kb !== ka) return kb - ka;
      return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
    });
    return list;
  }, [historyOrders]);

  useEffect(() => {
    setLineProductCodes((prev) => {
      const next = { ...prev };
      for (const row of form.lines) {
        const p = row.productId ? activeProducts.find((x) => String(x.id) === row.productId) : undefined;
        const fromP = (p?.productCode ?? "").trim();
        if (!(row.id in next)) {
          next[row.id] = fromP;
        } else if (row.productId && fromP && next[row.id] === "") {
          next[row.id] = fromP;
        }
      }
      for (const k of Object.keys(next)) {
        if (!form.lines.some((r) => r.id === k)) delete next[k];
      }
      return next;
    });
  }, [lineIdsSig, activeProducts, form.lines]);

  useEffect(() => {
    setForm((f) => {
      let changed = false;
      const nextLines = f.lines.map((ln) => {
        const v = (lineProductCodes[ln.id] ?? "").trim();
        if (!/^\d{3}$/.test(v)) return ln;
        const hit = resolveProductByCode(activeProducts, v);
        if (!hit) {
          if (ln.productId !== "") changed = true;
          return { ...ln, productId: "", unitPrice: ln.unitPrice };
        }
        const pid = String(hit.id);
        const price = ln.isReplenishment ? "0" : defaultUnitPriceForProduct(hit, lastPriceMap);
        if (ln.productId !== pid) {
          changed = true;
          return { ...ln, productId: pid, unitPrice: price };
        }
        if (ln.unitPrice.trim() === "") {
          changed = true;
          return { ...ln, productId: pid, unitPrice: price };
        }
        return ln;
      });
      return changed ? { ...f, lines: nextLines } : f;
    });
  }, [activeProducts, lineProductCodes, lastPriceMap, setForm]);

  const applyHistoryOrderToLines = useCallback(
    (o: CustomerSalesOrder) => {
      const sourceLines = (o.lines ?? []).filter((ln) => !ln.isPromotionGift);
      if (sourceLines.length === 0) {
        window.alert("此筆歷史訂單沒有可帶入的商品明細。");
        return;
      }

      const hasExisting = form.lines.some((l) => l.productId);
      if (
        hasExisting &&
        !window.confirm(`要以歷史訂單 ${o.orderNo} 的商品明細覆寫目前列表嗎？`)
      ) {
        return;
      }

      const defBilling = parseLineBilling(selectedCustomer?.billingType);
      const nextLines: ReturnType<typeof newOrderFormLine>[] = [];
      const nextCodes: Record<string, string> = {};
      const skipped: string[] = [];

      for (const ln of sourceLines) {
        if (nextLines.length >= 30) break;
        const pid = ln.product?.id != null ? String(ln.product.id) : "";
        const catalog = pid ? activeProducts.find((p) => String(p.id) === pid && p.isActive !== false) : undefined;
        if (!catalog) {
          skipped.push(ln.product?.name?.trim() || "未知商品");
          continue;
        }

        const purpose: LinePurpose =
          ln.linePurpose === "prepaid_barrel_topup" ? "prepaid_barrel_topup" : "delivery";
        const isReplenishment = Boolean(ln.isReplenishment) && purpose === "delivery";
        const billing: LineBillingType = purpose === "prepaid_barrel_topup"
          ? "cash"
          : parseLineBilling(ln.billingTypeAtLine ?? selectedCustomer?.billingType);

        const qtyRaw = Math.floor(Number(ln.qtyOrdered));
        const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
        const priceRaw = String(ln.unitPrice ?? "").trim();
        const unitPrice = isReplenishment
          ? "0"
          : priceRaw !== ""
            ? priceRaw
            : defaultUnitPriceForProduct(catalog, lastPriceMap);

        const row = newOrderFormLine(billing);
        row.productId = pid;
        row.qty = qty;
        row.unitPrice = unitPrice;
        row.linePurpose = purpose;
        row.isReplenishment = isReplenishment;
        nextLines.push(row);

        const code = (catalog.productCode ?? ln.product?.productCode ?? "").trim();
        if (/^\d{3}$/.test(code)) nextCodes[row.id] = code;
      }

      if (nextLines.length === 0) {
        window.alert(
          skipped.length > 0
            ? `無法帶入：商品已下架或不存在（${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? "…" : ""}）`
            : "無法帶入商品明細。",
        );
        return;
      }

      if (nextLines.length < 30) {
        nextLines.push(newOrderFormLine(defBilling));
      }

      setForm((f) => ({ ...f, lines: nextLines }));
      setLineProductCodes(nextCodes);

      requestAnimationFrame(() => {
        document.getElementById("order-new-zone-lines")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [activeProducts, form.lines, lastPriceMap, selectedCustomer?.billingType, setForm],
  );

  const updateLine = (
    id: string,
    patch: Partial<{
      productId: string;
      qty: number;
      unitPrice: string;
      billingType: LineBillingType;
      linePurpose: LinePurpose;
      isReplenishment: boolean;
    }>,
  ) => {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const applyProductCodeChange = useCallback(
    (rowId: string, raw: string) => {
      const v = raw.replace(/\D/g, "").slice(0, 3);
      setLineProductCodes((prev) => ({ ...prev, [rowId]: v }));
      setForm((f) => {
        let validProduct = false;
        const nextLines = f.lines.map((ln) => {
          if (ln.id !== rowId) return ln;
          if (!/^\d{3}$/.test(v)) {
            return { ...ln, productId: "", unitPrice: ln.unitPrice };
          }
          const hit = resolveProductByCode(activeProducts, v);
          if (!hit) {
            return { ...ln, productId: "", unitPrice: ln.unitPrice };
          }
          validProduct = true;
          const pid = String(hit.id);
          const catalogPrice = defaultUnitPriceForProduct(hit, lastPriceMap);
          const price = ln.isReplenishment ? "0" : catalogPrice;
          const productChanged = ln.productId !== pid;
          return {
            ...ln,
            productId: pid,
            unitPrice: productChanged
              ? price
              : ln.isReplenishment
                ? ln.unitPrice.trim() !== ""
                  ? ln.unitPrice
                  : "0"
                : ln.unitPrice.trim() !== ""
                  ? ln.unitPrice
                  : price,
          };
        });
        const rowIdx = nextLines.findIndex((ln) => ln.id === rowId);
        if (validProduct && rowIdx === nextLines.length - 1) {
          const def = parseLineBilling(selectedCustomer?.billingType);
          return { ...f, lines: [...nextLines, newOrderFormLine(def)] };
        }
        return { ...f, lines: nextLines };
      });
      return /^\d{3}$/.test(v) && Boolean(resolveProductByCode(activeProducts, v));
    },
    [activeProducts, lastPriceMap, selectedCustomer?.billingType, setForm],
  );

  const handleLineFieldEnter = useCallback(
    (e: React.KeyboardEvent, rowId: string, field: OrderLineField) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();

      const row = form.lines.find((ln) => ln.id === rowId);
      if (!row) return;

      if (field === "code") {
        const digits = (lineProductCodes[rowId] ?? "").trim();
        if (/^\d{3}$/.test(digits) && resolveProductByCode(activeProducts, digits)) {
          focusLineField(rowId, "billing");
        }
        return;
      }
      if (field === "billing") {
        focusLineField(rowId, "price");
        return;
      }
      if (field === "price") {
        focusLineField(rowId, "qty");
        return;
      }
      const idx = form.lines.findIndex((ln) => ln.id === rowId);
      const nextRow = idx >= 0 ? form.lines[idx + 1] : undefined;
      if (nextRow) {
        focusLineField(nextRow.id, "code");
        return;
      }
      if (row.productId) {
        const def = parseLineBilling(selectedCustomer?.billingType);
        const newLine = newOrderFormLine(def);
        pendingLineFocus.current = { rowId: newLine.id, field: "code" };
        setForm((f) => ({ ...f, lines: [...f.lines, newLine] }));
      }
    },
    [activeProducts, focusLineField, form.lines, lineProductCodes, selectedCustomer?.billingType, setForm],
  );

  const onOrderLinesKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if ((e.target as HTMLElement).closest(".order-lines-field")) {
      e.preventDefault();
    }
  }, []);

  const addLine = () => {
    const def = parseLineBilling(selectedCustomer?.billingType);
    setForm((f) => ({ ...f, lines: [...f.lines, newOrderFormLine(def)] }));
  };

  const removeLine = (id: string) => {
    setForm((f) => {
      if (f.lines.length <= 1) return f;
      return { ...f, lines: f.lines.filter((row) => row.id !== id) };
    });
  };

  const formBody = (
      <form onSubmit={onSubmitCreateOrder} className="order-new__form order-new__form--layout" onKeyDown={onOrderLinesKeyDown}>
        <div className="order-new__workspace" aria-label="訂單資料分區">
          <section className="order-new__zone order-new__zone--tools" aria-labelledby="order-new-zone-tools-title">
            <header className="order-new__zone-head">
              <span className="order-new__zone-index" aria-hidden="true">
                1
              </span>
              <div className="order-new__zone-head-text">
                <p className="order-new__zone-eyebrow">輸入 · 送貨設定</p>
                <h3 id="order-new-zone-tools-title" className="order-new__zone-title">
                  搜尋客戶與送貨條件
                </h3>
              </div>
            </header>
            <div className="order-new__zone-body">
              <div className="order-new__tool-section">
                <p className="order-new__tool-section-label">客戶搜尋</p>
                <div className="field order-new__field--code">
                  <label htmlFor="order-new-customer-search">關鍵字（6 碼編號優先）</label>
                  <input
                    id="order-new-customer-search"
                    type="search"
                    className="order-new__input-code"
                    placeholder="6 碼編號或關鍵字"
                    value={customerKeyword}
                    onChange={(e) => setCustomerKeyword(e.target.value)}
                    autoComplete="off"
                  />
                  {matchHint ? <p className={orderNewMatchHintClass(matchHint)}>{matchHint}</p> : null}

                  {customerKeyword.trim() && pickerOptions.length > 1 ? (
                    <div className="field order-new__field--nested">
                      <label htmlFor="order-new-customer-picker">改選相符客戶</label>
                      <select
                        id="order-new-customer-picker"
                        className="order-new__select-block"
                        value={form.customerId}
                        onChange={(e) => {
                          const id = e.target.value;
                          const row = pickerOptions.find(({ c }) => String(c.id) === id);
                          const addrId = row ? defaultDeliveryAddressId(row.c) : "";
                          setForm((prev) => ({
                            ...prev,
                            customerId: id,
                            deliveryAddressId: addrId,
                          }));
                        }}
                        aria-label="改選其他相符客戶"
                      >
                        {pickerOptions.map(({ c }) => (
                          <option key={String(c.id)} value={String(c.id)}>
                            {`${c.customerCode ?? "------"} · ${c.name}${c.phone ? ` · ${c.phone}` : ""}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <p className="order-new__meta-line">相符約 {alternateCandidates.length} 筆（改選最多 18 筆）</p>
                </div>
              </div>

              <hr className="order-new__surface-rule" />

              <div className="order-new__tool-section">
                <p className="order-new__tool-section-label">配送與現金區發票</p>
                <div className="order-new__inline-row">
                  <div className="field order-new__field--date">
                    <label htmlFor="order-new-scheduled-date">預計配送日</label>
                    <input
                      id="order-new-scheduled-date"
                      type="date"
                      className="order-new__input-date"
                      value={form.scheduledDeliveryDate}
                      onChange={(e) => setForm({ ...form, scheduledDeliveryDate: e.target.value })}
                    />
                  </div>
                  <div className="field order-new__field--invoice-mini">
                    <label htmlFor="order-new-cash-invoice">現金區發票</label>
                    <select
                      id="order-new-cash-invoice"
                      className="order-new__select-short"
                      value={form.cashInvoiceMode ?? "none"}
                      onChange={(e) => setForm((f) => ({ ...f, cashInvoiceMode: e.target.value }))}
                    >
                      <option value="none">不開</option>
                      <option value="tax_exclusive">稅外加</option>
                      <option value="tax_inclusive">含稅</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="order-new__zone order-new__zone--main" aria-labelledby="order-new-zone-main-title">
            <header className="order-new__zone-head">
              <span className="order-new__zone-index order-new__zone-index--slate" aria-hidden="true">
                2
              </span>
              <div className="order-new__zone-head-text">
                <p className="order-new__zone-eyebrow">主檔 · 帳務</p>
                <h3 id="order-new-zone-main-title" className="order-new__zone-title">
                  客戶資料與帳務摘要
                </h3>
              </div>
            </header>
            <div className="order-new__zone-body">
            {form.customerId && selectedCustomer ? (
              <div className="order-new__cust-billing-merge">
                <header className="order-new__cust-head">
                  <div className="order-new__cust-head-main">
                    <span className="order-new__cust-code mono-text">
                      {selectedCustomer.customerCode ?? "------"}
                    </span>
                    <strong className="order-new__cust-name">{selectedCustomer.name}</strong>
                    <span className="badge badge--default">
                      {billingTypeLabel(parseLineBilling(selectedCustomer.billingType))}
                    </span>
                    {selectedCustomer.lifecycleStatus === "churned" ? (
                      <span className="badge badge--cancelled">已流失</span>
                    ) : null}
                  </div>
                  <div className="order-new__cust-head-meta">
                    {selectedCustomer.contactName ? <span>{selectedCustomer.contactName}</span> : null}
                    {selectedCustomer.mobile || selectedCustomer.phone ? (
                      <span className="mono-text">{selectedCustomer.mobile || selectedCustomer.phone}</span>
                    ) : null}
                    <span className="text-muted">ID {selectedCustomer.id}</span>
                  </div>
                </header>

                <div className="order-new__cust-billing-grid">
                  <div className="order-new__billing-col">
                    <p className="order-new__panel-label">帳務摘要</p>
                    {summaryLoading ? (
                      <p className="text-muted order-new__placeholder-sm">帳務摘要載入中…</p>
                    ) : billingSummary ? (
                      <div className="order-new__billing-cards">
                        <div className="order-new__billing-card">
                          <span className="order-new__billing-card-label">結帳方式</span>
                          <strong className="order-new__billing-card-value">
                            {billingTypeLabel(billingSummary.billingType)}
                          </strong>
                          <span className="order-new__billing-card-hint">
                            {billingSummary.billingType === "monthly"
                              ? billingSummary.monthlySettlementDay != null
                                ? `每月 ${billingSummary.monthlySettlementDay} 號`
                                : "月結日未設定"
                              : billingSummary.billingType === "prepaid"
                                ? billingSummary.allowPrepaidOverdraft
                                  ? "允許透支"
                                  : "不可透支"
                                : "現金結帳"}
                          </span>
                        </div>
                        <div className="order-new__billing-card">
                          <span className="order-new__billing-card-label">往來餘額</span>
                          <strong className="order-new__billing-card-value">
                            $ {Number(billingSummary.accountBalance).toLocaleString()}
                          </strong>
                          <span className="order-new__billing-card-hint">正＝客戶欠公司</span>
                        </div>
                        <div className="order-new__billing-card">
                          <span className="order-new__billing-card-label">預付桶剩餘</span>
                          <strong className="order-new__billing-card-value">
                            {billingSummary.prepaidBarrelBalance} 桶
                          </strong>
                          {Array.isArray(billingSummary.prepaidBarrelByProduct) &&
                          billingSummary.prepaidBarrelByProduct.length > 0 ? (
                            <span className="order-new__billing-card-hint">
                              {billingSummary.prepaidBarrelByProduct
                                .map((x) => `${x.productName} ${x.barrels}`)
                                .join("、")}
                            </span>
                          ) : (
                            <span className="order-new__billing-card-hint">
                              {billingSummary.allowPrepaidOverdraft ? "允許透支" : "無分商品餘額"}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="order-new__placeholder-sm">
                        <span className="feedback feedback--err">無法讀取帳務摘要。</span>{" "}
                        <span className="text-muted">
                          主檔：{billingTypeLabel(parseLineBilling(selectedCustomer.billingType))}
                        </span>
                      </p>
                    )}
                    <p className="order-new__billing-note">
                      單內可混現金／月結／預付；預付桶儲值於明細勾選。點送貨點列可切換地址。
                    </p>
                  </div>

                  <div className="order-new__cust-col">
                    <div className="order-new__panel-label-row">
                      <p className="order-new__panel-label">送貨點</p>
                      {(() => {
                        const selectedAddr = (selectedCustomer.addresses ?? []).find(
                          (a) => String(a.id) === form.deliveryAddressId,
                        );
                        const totalBarrels = sumCustomerBarrelsOnSite(selectedCustomer);
                        return (
                          <span className="order-new__barrel-chip">
                            空桶{" "}
                            {selectedAddr ? (
                              <>
                                此點 <strong>{selectedAddr.barrelsOnSite ?? 0}</strong>
                                {(selectedCustomer.addresses ?? []).length > 1 ? (
                                  <span className="text-muted">／合計 {totalBarrels}</span>
                                ) : null}
                              </>
                            ) : (
                              <>
                                合計 <strong>{totalBarrels}</strong>
                              </>
                            )}
                          </span>
                        );
                      })()}
                    </div>

                    {(selectedCustomer.addresses ?? []).length > 0 ? (
                      <ul className="order-new__addr-cards" role="listbox" aria-label="送貨點">
                        {(selectedCustomer.addresses ?? []).map((a) => {
                          const selected = String(a.id) === form.deliveryAddressId;
                          return (
                            <li key={String(a.id)}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-current={selected ? "true" : undefined}
                                className={`order-new__addr-card${selected ? " order-new__addr-card--selected" : ""}`}
                                onClick={() =>
                                  setForm((prev) => ({ ...prev, deliveryAddressId: String(a.id) }))
                                }
                              >
                                <span className="order-new__addr-card-mark" aria-hidden="true">
                                  {selected ? "✓" : ""}
                                </span>
                                <span className="order-new__addr-card-label">
                                  {a.isDefault ? <span className="badge badge--ok">預設</span> : null}
                                  {a.label?.trim() ? a.label : "送貨點"}
                                </span>
                                <p className="order-new__addr-card-line">
                                  {selected ? <span className="order-new__addr-card-pick">已選</span> : null}
                                  <span className="order-new__addr-card-line-text">{a.addressLine}</span>
                                </p>
                                <span className="order-new__addr-card-barrels">
                                  空桶 {a.barrelsOnSite ?? 0}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-muted order-new__placeholder-sm">尚無送貨地址</p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="order-new__empty-state">
                <p className="order-new__empty-state-title">尚未選定客戶</p>
                <p className="text-muted order-new__empty-state-desc">請於上方輸入客戶編號或關鍵字。</p>
              </div>
            )}
            </div>
          </section>
        </div>

        <section
          id="order-new-zone-lines"
          className="order-new__zone order-new__zone--lines"
          aria-labelledby="order-new-lines-title"
        >
          <header className="order-new__zone-head order-new__zone-head--flush">
            <span className="order-new__zone-index order-new__zone-index--brand" aria-hidden="true">
              3
            </span>
            <div className="order-new__zone-head-text">
              <p className="order-new__zone-eyebrow">明細 · 計價</p>
              <div className="order-new__lines-title-row">
                <h3 id="order-new-lines-title" className="order-new__zone-title">
                  商品明細
                </h3>
                <span className="order-new__zone-tag">3 碼編號</span>
              </div>
            </div>
          </header>
          <div className="order-new__zone-body order-new__zone-body--lines">
            <span id="order-new-lines-desc" className="sr-only">
              每列請輸入三位數商品編號，並選擇結帳方式、單價與數量。
            </span>
            <div className="field field--full order-lines-field" role="group" aria-describedby="order-new-lines-desc">
              <span aria-hidden="true">商品列</span>
              <div className="order-lines">
            <div className="order-lines__head">
              <span className="order-lines__col order-lines__col--product">商品編號（3 碼）</span>
              <span className="order-lines__col order-lines__col--billing">結帳</span>
              <span className="order-lines__col order-lines__col--price">單價</span>
              <span className="order-lines__col order-lines__col--qty">數量</span>
              <span className="order-lines__col order-lines__col--sub">小計</span>
              <span className="order-lines__col order-lines__col--act" />
            </div>
            {form.lines.map((row, idx) => (
              <div key={row.id} className="order-lines__row">
                <div className="order-lines__main">
                  <div className="order-lines__col order-lines__col--product">
                    <div className="order-lines__product-main">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={3}
                        className="mono-text order-new__product-code"
                        placeholder="例 001"
                        value={lineProductCodes[row.id] ?? ""}
                        ref={setLineFieldRef(row.id, "code")}
                        onChange={(e) => {
                          applyProductCodeChange(row.id, e.target.value);
                        }}
                        onKeyDown={(e) => handleLineFieldEnter(e, row.id, "code")}
                        aria-label={`第 ${idx + 1} 列商品編號`}
                      />
                      {(() => {
                        const digits = (lineProductCodes[row.id] ?? "").trim();
                        const matched = digits.length === 3 ? resolveProductByCode(activeProducts, digits) : undefined;
                        if (digits.length === 3 && !matched) {
                          return (
                            <span className="order-new__line-help feedback feedback--err">
                              無此編號或商品未設定編號／已下架
                            </span>
                          );
                        }
                        if (matched) {
                          const last = row.productId ? lastPriceMap[row.productId] : undefined;
                          return (
                            <span className="order-new__line-help order-new__line-help--product">
                              <strong>{matched.name}</strong>
                              <span className="order-new__line-help__sep">·</span>
                              售價 <strong>$ {matched.salePrice}</strong>
                              {matched.unit ? `／${matched.unit}` : ""}
                              {last ? (
                                <>
                                  <span className="order-new__line-help__sep">·</span>
                                  <span className="order-lines__last-price">
                                    {last.orderedAt
                                      ? `上次 ${fmtLocalYmd(last.orderedAt)} · $ ${last.unitPrice}`
                                      : `上次 $ ${last.unitPrice}`}
                                  </span>
                                </>
                              ) : null}
                            </span>
                          );
                        }
                        return digits.length > 0 && digits.length < 3 ? (
                          <span className="order-new__line-help text-muted">請輸入完整 3 碼</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <div className="order-lines__col order-lines__col--billing">
                    <select
                      ref={setLineFieldRef(row.id, "billing")}
                      value={row.billingType}
                      onChange={(e) => updateLine(row.id, { billingType: e.target.value as LineBillingType })}
                      onKeyDown={(e) => handleLineFieldEnter(e, row.id, "billing")}
                      disabled={row.linePurpose === "prepaid_barrel_topup" || row.isReplenishment}
                      aria-label={`第 ${idx + 1} 列結帳方式`}
                    >
                      <option value="cash">現金</option>
                      <option value="monthly">月結</option>
                      <option value="prepaid">預付（桶）</option>
                    </select>
                  </div>
                  <div className="order-lines__col order-lines__col--price">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      ref={setLineFieldRef(row.id, "price")}
                      value={row.unitPrice}
                      onChange={(e) => updateLine(row.id, { unitPrice: e.target.value })}
                      onKeyDown={(e) => handleLineFieldEnter(e, row.id, "price")}
                      aria-label={`第 ${idx + 1} 列單價`}
                    />
                  </div>
                  <div className="order-lines__col order-lines__col--qty">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      ref={setLineFieldRef(row.id, "qty")}
                      value={row.qty}
                      onChange={(e) =>
                        updateLine(row.id, { qty: Math.max(0, Math.floor(Number(e.target.value)) || 0) })
                      }
                      onKeyDown={(e) => handleLineFieldEnter(e, row.id, "qty")}
                      aria-label={`第 ${idx + 1} 列數量`}
                    />
                  </div>
                  <div className="order-lines__col order-lines__col--sub num">
                    {lineSubtotals[idx] != null ? (
                      <>
                        <span className="order-lines__sub-label">小計</span>
                        <strong>$ {lineSubtotals[idx].toLocaleString()}</strong>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="order-lines__col order-lines__col--act">
                    <button
                      type="button"
                      className="btn btn--danger btn--sm order-lines__remove"
                      disabled={form.lines.length <= 1}
                      onClick={() => removeLine(row.id)}
                      title={form.lines.length <= 1 ? "至少保留一列" : "移除此列"}
                    >
                      刪除
                    </button>
                  </div>
                </div>
                {selectedCustomer ? (
                  <div className="order-line-flags">
                    <label
                      className={`order-line-flag${row.linePurpose === "prepaid_barrel_topup" ? " order-line-flag--on" : ""}`}
                      title="現金應收沖清後入帳桶數"
                    >
                      <input
                        type="checkbox"
                        checked={row.linePurpose === "prepaid_barrel_topup"}
                        disabled={row.isReplenishment}
                        onChange={(e) => {
                          const topup = e.target.checked;
                          updateLine(row.id, {
                            linePurpose: topup ? "prepaid_barrel_topup" : "delivery",
                            billingType: topup ? "cash" : parseLineBilling(selectedCustomer.billingType),
                            isReplenishment: false,
                          });
                        }}
                      />
                      預付桶儲值
                    </label>
                    <label
                      className={`order-line-flag${row.isReplenishment ? " order-line-flag--on" : ""}`}
                      title="預設免費；仍計未收回空桶"
                    >
                      <input
                        type="checkbox"
                        checked={row.isReplenishment}
                        disabled={row.linePurpose === "prepaid_barrel_topup"}
                        onChange={(e) => {
                          const on = e.target.checked;
                          if (on) {
                            updateLine(row.id, {
                              isReplenishment: true,
                              linePurpose: "delivery",
                              billingType: "cash",
                              unitPrice: "0",
                            });
                          } else {
                            const p = activeProducts.find((x) => String(x.id) === row.productId);
                            const restore = p
                              ? defaultUnitPriceForProduct(p, lastPriceMap)
                              : row.unitPrice;
                            updateLine(row.id, {
                              isReplenishment: false,
                              billingType: parseLineBilling(selectedCustomer.billingType),
                              unitPrice: restore,
                            });
                          }
                        }}
                      />
                      補送
                    </label>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="order-lines__toolbar">
            <button type="button" className="btn btn--secondary btn--sm" onClick={addLine} disabled={form.lines.length >= 30}>
              ＋ 新增商品列
            </button>
            <div className="order-new__totals-bar order-lines__total">
              預計合計（依售價）：<strong>$ {estimatedTotal.toLocaleString()}</strong>
              {estimatedTotal > 0 && (lineBillingMix || estimatedByBilling.cash > 0) ? (
                <>
                  {" "}
                  · 現金列 <strong>$ {estimatedByBilling.cash.toLocaleString()}</strong>
                  {estimatedByBilling.monthly > 0 ? (
                    <>
                      {" "}
                      · 月結列 <strong>$ {estimatedByBilling.monthly.toLocaleString()}</strong>
                    </>
                  ) : null}
                  {estimatedByBilling.prepaid > 0 ? (
                    <>
                      {" "}
                      · 預付列 <strong>$ {estimatedByBilling.prepaid.toLocaleString()}</strong>（送達扣桶）
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
          {promotionPreview.length > 0 ? (
            <div className="order-new__promotion-preview">
              <strong>優惠預覽（開單後自動加入贈品列）：</strong>
              <ul>
                {promotionPreview.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {selectedCustomer && estimatedByBilling.cash > 0 ? (
            <p className="order-new__cash-policy">
              <strong>現金列：</strong>建議收款＝本單現金 AR＋可催收舊欠 − 預收錢包；核銷時<strong>本單優先</strong>沖 AR，溢收進預收錢包。
            </p>
          ) : null}

          <div className="order-new__lines-extras">
            <div className="order-new__invoice-detail">
              <div className="order-new__invoice-detail-head">
                <div className="order-new__invoice-detail-titles">
                  <h3 className="order-new__invoice-detail-title">發票試算</h3>
                  <p className="order-new__invoice-detail-lead">
                    現金／儲值區發票請在步驟一「現金區發票」選擇。稅外加時現金應收為含稅；月結批次發票於 AR 作業台處理。
                  </p>
                </div>
                <span className="order-new__invoice-rate-pill">稅率 {DEFAULT_VAT_RATE * 100}%</span>
              </div>

              {form.cashInvoiceMode !== "none" && estimatedByBilling.cash <= 0 ? (
                <p className="order-new__invoice-empty">目前無現金列小計，加入現金商品後即可預覽。</p>
              ) : null}

              {cashInvoicePreview ? (
                <div className="order-new__tax-preview">
                  <div className="order-new__tax-preview-head">
                    <span className="order-new__tax-preview-title">現金列發票</span>
                    <span className="order-new__tax-mode-pill">
                      {cashInvoicePreview.mode === "tax_exclusive" ? "稅外加" : "含稅"}
                    </span>
                  </div>
                  <div className="order-new__tax-rows">
                    <div className="order-new__tax-row">
                      <span className="order-new__tax-row__label">未稅合計</span>
                      <span className="order-new__tax-row__value num">
                        ${" "}
                        {cashInvoicePreview.untaxedAmount.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                    <div className="order-new__tax-row">
                      <span className="order-new__tax-row__label">營業稅</span>
                      <span className="order-new__tax-row__value num">
                        ${" "}
                        {cashInvoicePreview.taxAmount.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                    <div className="order-new__tax-row order-new__tax-row--total">
                      <span className="order-new__tax-row__label">含稅總額</span>
                      <span className="order-new__tax-row__value num">
                        ${" "}
                        {cashInvoicePreview.totalWithTax.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>
                  <p className="order-new__tax-preview-note">
                    {cashInvoicePreview.mode === "tax_exclusive"
                      ? "稅外加：現金列合計視為未稅，系統另計稅額；司機收款以含稅為準。"
                      : "含稅：現金列合計為含稅總額，系統反拆未稅與稅額（憑證參考）。"}
                  </p>
                </div>
              ) : null}
            </div>

            <div className="order-new__lines-extras-remark">
              <div className="field order-new__field--remark">
                <label htmlFor="order-new-remark">商品／訂單備註（紙上，選填）</label>
                <textarea
                  id="order-new-remark"
                  className="order-new__input-remark"
                  rows={2}
                  placeholder="例如：代收貨款、指定時段、請放管理室…；亦可點選下方標語快速加入"
                  value={form.remark}
                  onChange={(e) => setForm({ ...form, remark: e.target.value })}
                />
                <RemarkSloganPicker value={form.remark} onChange={(remark) => setForm({ ...form, remark })} />
              </div>
              <div className="order-new__submit-area order-new__submit-area--inline">
                <div className="form-actions">
                  <button type="submit" className="btn btn--primary" disabled={saving}>
                    {saving ? "建立中..." : "建立訂單"}
                  </button>
                  {formMessage ? (
                    <span className={formMessage.includes("成功") ? "feedback feedback--ok" : "feedback feedback--err"}>
                      {formMessage}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
            </div>
          </div>
        </section>

        <aside className="order-new__zone order-new__zone--history" aria-label="客戶歷史訂單">
          <header className="order-new__zone-head">
            <span className="order-new__zone-index order-new__zone-index--amber" aria-hidden="true">
              4
            </span>
            <div className="order-new__zone-head-text">
              <p className="order-new__zone-eyebrow">參考</p>
              <h3 className="order-new__zone-title">歷史叫貨清單</h3>
            </div>
          </header>
          <div className="order-new__zone-body order-new__zone-body--history">
            {!form.customerId ? (
              <p className="text-muted order-new__placeholder-sm">選定客戶後顯示</p>
            ) : historyLoading ? (
              <p className="text-muted order-new__placeholder-sm">載入中…</p>
            ) : sortedHistoryOrders.length === 0 ? (
              <p className="text-muted order-new__placeholder-sm">尚無紀錄</p>
            ) : (
              <>
                <p className="order-new__meta-line order-new__history-caption">
                  {sortedHistoryOrders.length} 筆 · 配送日近→遠 · 最多 100 筆 · 雙擊可帶入商品明細
                </p>
                <div className="order-new__history-table" role="list">
                  <div className="order-new__history-head" aria-hidden="true">
                    <span>配送日</span>
                    <span>狀態</span>
                    <span>品項</span>
                    <span>收空</span>
                    <span>單號</span>
                  </div>
                  {sortedHistoryOrders.map((o) => {
                    const dateStr = historyDisplayYmd(o);
                    const statusRaw = String(o.status ?? "");
                    const goods = historyGoodsSummary(o);
                    const emptyBarrels = historyEmptyBarrels(o);
                    const title = `${historyRowDetailTitle(o)}\n\n雙擊：帶入商品、單價與數量到商品明細`;
                    return (
                      <div
                        role="listitem"
                        key={String(o.id)}
                        className="order-new__history-row order-new__history-row--applyable"
                        title={title}
                        onDoubleClick={() => applyHistoryOrderToLines(o)}
                      >
                        <div className="order-new__history-row__date-line">
                          <span className="order-new__history-row__ymd mono-text">{dateStr}</span>
                          <span className={orderStatusBadgeClass(statusRaw)}>{orderStatusLabel(o.status)}</span>
                        </div>
                        <p className="order-new__history-row__goods">{goods || "無明細"}</p>
                        <div className="order-new__history-row__meta">
                          {emptyBarrels != null ? (
                            <span className="order-new__history-row__empty">收空 {emptyBarrels}</span>
                          ) : (
                            <span className="order-new__history-row__empty order-new__history-row__empty--na">收空 —</span>
                          )}
                          <span className="order-new__history-row__no mono-text">{o.orderNo}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </aside>
      </form>
  );

  if (embedded) return formBody;

  return (
    <section className="card order-new-page order-new-page--pro">
      <header className="order-new__hero">
        <div className="order-new__hero-top">
          <div className="order-new__hero-titles">
            <span className="order-new__badge">建立訂單</span>
            <h2 className="order-new__page-title">新增訂單</h2>
          </div>
        </div>
        <p className="order-new__hero-lead">
          左欄搜尋客戶與配送條件，右欄核對帳務與送貨點；接著填商品明細與發票／備註，最後可對照歷史叫貨。輸入<strong>6 碼編號</strong>
          或電話／名稱即可匹配；雙擊歷史列可帶入商品。
        </p>
      </header>
      {formBody}
    </section>
  );
}
