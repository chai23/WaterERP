/* eslint-disable no-console */
async function main() {
  const base = "http://localhost:3000";
  const req = async (url: string, opt?: RequestInit) => {
    const r = await fetch(base + url, {
      headers: { "Content-Type": "application/json" },
      ...(opt ?? {}),
    });
    const txt = await r.text();
    let body: any = null;
    try {
      body = txt ? JSON.parse(txt) : null;
    } catch {
      body = txt;
    }
    if (!r.ok) throw new Error(`${url} ${r.status} ${JSON.stringify(body)}`);
    return body;
  };

  const customers = await req("/api/customers");
  const products = await req("/api/products");
  const drivers = await req("/api/drivers");
  const cashCustomer = (customers as any[]).find((c) => c.billingType === "cash" && Array.isArray(c.addresses) && c.addresses.length > 0);
  const product = (products as any[]).find((p) => p.isActive && Number(p.salePrice) > 0);
  const driver = (drivers as any[]).find((d) => d.isActive);
  if (!cashCustomer || !product || !driver) {
    throw new Error("缺少測試主檔：現金客戶/商品/司機");
  }

  const out: any[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const createOrder = async (qty: number, date: string) => {
    const payload = {
      customerId: cashCustomer.id,
      deliveryAddressId: cashCustomer.addresses[0].id,
      scheduledDeliveryDate: date,
      lines: [{ productId: product.id, qty, billingType: "cash" }],
    };
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = await req("/api/sales-orders", { method: "POST", body: JSON.stringify(payload) });
        return r.data;
      } catch (e) {
        const msg = String(e);
        if (!msg.includes("uk_sales_order_no") || i === 3) throw e;
        await sleep(1100);
      }
    }
    throw new Error("createOrder 重試失敗");
  };
  const assign = async (salesOrderId: string, date: string) => {
    const r = await req("/api/delivery-assignments", {
      method: "POST",
      body: JSON.stringify({ salesOrderId, driverId: driver.id, assignmentDate: date }),
    });
    return r.data;
  };
  const driverComplete = async (assignmentId: string, cashReceived: number, ymd: string) => {
    const r = await req("/api/driver/complete", {
      method: "POST",
      body: JSON.stringify({
        assignmentId,
        delivered: true,
        cashReceived,
        emptyBarrelsReturned: 0,
        reportedAtYmd: ymd,
      }),
    });
    return r.data;
  };
  const approve = async (assignmentId: string, iso: string) => {
    const r = await req("/api/settlements/approve", {
      method: "POST",
      body: JSON.stringify({ assignmentId, officeSettledAt: iso }),
    });
    return r.data;
  };
  const getDriverRow = async (date: string, orderNo: string) => {
    const code = encodeURIComponent(driver.user?.employeeCode ?? "D001");
    const rows = await req(`/api/driver/today?employeeCode=${code}&date=${date}`);
    return (rows as any[]).find((x) => x.salesOrder?.orderNo === orderNo);
  };
  const getSummary = async () => {
    const s = await req(`/api/customers/${cashCustomer.id}/billing-summary`);
    return s.data;
  };

  // A 足額
  const o1 = await createOrder(2, "2026-05-16");
  const a1 = await assign(o1.id, "2026-05-16");
  const d1 = await getDriverRow("2026-05-16", o1.orderNo);
  await driverComplete(a1.id, Number(d1.driverBillingHints.cashDue), "2026-05-16");
  const ap1 = await approve(a1.id, "2026-05-16T09:00:00+08:00");
  out.push({
    case: "A足額",
    orderNo: o1.orderNo,
    driverDue: d1.driverBillingHints.cashDue,
    expectedAmount: String(ap1.expectedAmount ?? ""),
    cashReceived: String(ap1.cashReceived ?? ""),
    cashVariance: String(ap1.cashVariance ?? ""),
    outcome: ap1.settlementOutcome,
  });

  // B 未收
  const o2 = await createOrder(1, "2026-05-17");
  const a2 = await assign(o2.id, "2026-05-17");
  const d2 = await getDriverRow("2026-05-17", o2.orderNo);
  await driverComplete(a2.id, 0, "2026-05-17");
  const ap2 = await approve(a2.id, "2026-05-17T09:00:00+08:00");
  out.push({
    case: "B未收",
    orderNo: o2.orderNo,
    driverDue: d2.driverBillingHints.cashDue,
    expectedAmount: String(ap2.expectedAmount ?? ""),
    cashReceived: String(ap2.cashReceived ?? ""),
    cashVariance: String(ap2.cashVariance ?? ""),
    outcome: ap2.settlementOutcome,
  });

  // C 少收
  const o3 = await createOrder(1, "2026-05-18");
  const a3 = await assign(o3.id, "2026-05-18");
  const d3 = await getDriverRow("2026-05-18", o3.orderNo);
  const due3 = Number(d3.driverBillingHints.cashDue);
  await driverComplete(a3.id, Math.max(0, due3 - 10), "2026-05-18");
  const ap3 = await approve(a3.id, "2026-05-18T09:00:00+08:00");
  out.push({
    case: "C少收",
    orderNo: o3.orderNo,
    driverDue: d3.driverBillingHints.cashDue,
    expectedAmount: String(ap3.expectedAmount ?? ""),
    cashReceived: String(ap3.cashReceived ?? ""),
    cashVariance: String(ap3.cashVariance ?? ""),
    outcome: ap3.settlementOutcome,
  });

  // D 多收
  const o4 = await createOrder(1, "2026-05-19");
  const a4 = await assign(o4.id, "2026-05-19");
  const d4 = await getDriverRow("2026-05-19", o4.orderNo);
  const due4 = Number(d4.driverBillingHints.cashDue);
  await driverComplete(a4.id, due4 + 20, "2026-05-19");
  const ap4 = await approve(a4.id, "2026-05-19T09:00:00+08:00");
  out.push({
    case: "D多收",
    orderNo: o4.orderNo,
    driverDue: d4.driverBillingHints.cashDue,
    expectedAmount: String(ap4.expectedAmount ?? ""),
    cashReceived: String(ap4.cashReceived ?? ""),
    cashVariance: String(ap4.cashVariance ?? ""),
    outcome: ap4.settlementOutcome,
  });

  // E 自動預收抵扣
  const o5 = await createOrder(1, "2026-05-20");
  const a5 = await assign(o5.id, "2026-05-20");
  const d5 = await getDriverRow("2026-05-20", o5.orderNo);
  out.push({
    case: "E預收自動抵扣(檢查)",
    orderNo: o5.orderNo,
    cashPriorBalance: d5.driverBillingHints.cashPriorBalance,
    cashSubtotal: d5.driverBillingHints.cashSubtotal,
    driverDue: d5.driverBillingHints.cashDue,
    assignmentId: a5.id,
  });

  const summary = await getSummary();
  console.log(
    JSON.stringify(
      {
        customer: { id: cashCustomer.id, name: cashCustomer.name },
        driver: { id: driver.id, name: driver.user?.name, code: driver.user?.employeeCode },
        product: { id: product.id, name: product.name, salePrice: product.salePrice },
        results: out,
        finalSummary: summary,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});

