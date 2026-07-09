import JsBarcode from "jsbarcode";

/** 產生訂單編號的 Code 128 一維條碼（SVG 字串），供套印列印；掃描結果為訂單編號字串。 */
export function encodeOrderNoToCode128Svg(orderNo: string): string {
  const text = String(orderNo ?? "").trim();
  if (!text) {
    throw new Error("訂單編號為空，無法產生條碼");
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(svg, text, {
    format: "CODE128",
    displayValue: true,
    font: "monospace",
    fontSize: 11,
    textMargin: 2,
    height: 44,
    width: 1.75,
    margin: 0,
    background: "#ffffff",
    lineColor: "#000000",
  });
  return svg.outerHTML;
}
