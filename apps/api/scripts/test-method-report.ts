import assert from "node:assert/strict";
import { assembleMethodReport } from "../src/modules/legacy-history/method-report.ts";

const products = new Map([["160", "竹炭水"], ["190", "竹炭水方桶16L"]]);
const base = { names: new Map<string, string>(), products, lines: [], received: new Map<string, number>(), overShort: new Map<string, number>(), prepaidProducts: new Map<string, string[]>(), hasOrders: new Set<string>(), laterUnpaid: new Map<string, number>() };
const customer = (id: string, remain: number, bucket = 0, mark = "") => ({ id, mark, name: id, bucket, remain });

const one = assembleMethodReport({ ...base, customers: [customer("020240", 30, 5)], hasOrders: new Set(["020240"]), prepaidProducts: new Map([["020240", ["190"]]]), lines: [
  { orderId: "A", customerId: "020240", completed: false, collected: false, billing: "現金", subtotal: 100, productName: "竹炭水方桶16L" },
] });
assert.equal(one[0]!.mode, "自動交接");
assert.equal(one[0]!.method, "排除部分舊單");
assert.match(one[0]!.text, /未完成配送 1 張排除/);
assert.match(one[0]!.productText, /登入 190 竹炭水方桶16L/);

const none = assembleMethodReport({ ...base, customers: [customer("000055", 59, 6)] });
assert.equal(none[0]!.method, "無訂單，傳餘額後標記流失");
assert.equal(none[0]!.churn, true);
assert.match(none[0]!.productText, /不登入商品/);

const negative = assembleMethodReport({ ...base, customers: [customer("000026", -4, 12)], hasOrders: new Set(["000026"]), prepaidProducts: new Map([["000026", ["160"]]]) });
assert.equal(negative[0]!.mode, "自動交接");
assert.match(negative[0]!.productText, /登入 160 竹炭水，並勾選預付桶不足時仍允許核銷送達（透支）/);

const multi = assembleMethodReport({ ...base, customers: [customer("040061", 89)], hasOrders: new Set(["040061"]), prepaidProducts: new Map([["040061", ["160", "190"]]]) });
assert.equal(multi[0]!.reasons, "預付商品一種以上");

const partial = assembleMethodReport({ ...base, customers: [customer("000090", 0)], hasOrders: new Set(["000090"]), lines: [
  { orderId: "B", customerId: "000090", completed: true, collected: true, billing: "現金", subtotal: 200, productName: "維修費" },
  { orderId: "B", customerId: "000090", completed: true, collected: false, billing: "現金", subtotal: 195, productName: "竹炭水" },
] });
assert.equal(partial[0]!.cashAmount, 195);
assert.equal(partial[0]!.mode, "自動交接");

const samePool = assembleMethodReport({ ...base, customers: [customer("000141", 74, 7), customer("000141-1", 74, 8)], hasOrders: new Set(["000141"]), prepaidProducts: new Map([["000141", ["160"]]]) });
assert.equal(samePool[0]!.prepaidBarrels, 74);
assert.equal(samePool[0]!.emptyBarrels, 15);
assert.equal(samePool[0]!.reasons, "");
assert.match(samePool[0]!.productText, /登入 160/);

const differ = assembleMethodReport({ ...base, customers: [customer("130016", 6), customer("130016-1", 8)], hasOrders: new Set(["130016"]), prepaidProducts: new Map([["130016", ["160"]]]) });
assert.equal(differ[0]!.reasons, "分店預付桶和主檔不同");
assert.equal(differ[0]!.prepaidBarrels, 6);

console.log("method report rules ok");

const withTaxDiscount = assembleMethodReport({
  ...base,
  customers:[customer("140063",0)],
  hasOrders:new Set(["140063"]),
  lines:[
    {orderId:"TAX",customerId:"140063",completed:false,collected:false,billing:"現金",subtotal:1298,productName:"月結單"},
    {orderId:"TAX",customerId:"140063",completed:false,collected:false,billing:"現金",subtotal:-1,productName:"稅金折讓費"},
  ],
});
assert.equal(withTaxDiscount[0]!.billedCount,1);
assert.equal(withTaxDiscount[0]!.billedAmount,1297);
assert.equal(withTaxDiscount[0]!.reasons,"");
