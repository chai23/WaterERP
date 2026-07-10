import { billingTypeLabel, fmtLocalYmd } from "../adminUtils";
import type { OrderPrintLayoutV1, OrderSlipSource, FieldPos, LineColumnPos } from "./layoutTypes";
import { encodeOrderNoToCode128Svg } from "./orderNoBarcode";
import { coercePrintVisibility, isFieldPrintEnabled, isLineColPrintEnabled } from "./printVisibility";

function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function moneyStr(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  return n.toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fieldStyle(pos: FieldPos, layout: OrderPrintLayoutV1, extra = ""): string {
  const fs = pos.fontSizePt ?? layout.baseFontPt;
  const mw = pos.maxWidthMm != null ? `max-width:${pos.maxWidthMm}mm;` : "";
  return `left:${pos.leftMm}mm;top:${pos.topMm}mm;font-size:${fs}pt;${mw}${extra}`;
}

function colStyle(col: LineColumnPos, topMm: number, layout: OrderPrintLayoutV1): string {
  const fs = col.fontSizePt ?? layout.baseFontPt;
  const mw = col.maxWidthMm != null ? `max-width:${col.maxWidthMm}mm;width:${col.maxWidthMm}mm;` : "";
  return `left:${col.leftMm}mm;top:${topMm}mm;font-size:${fs}pt;${mw}`;
}

type SlipLine = NonNullable<OrderSlipSource["lines"]>[number];

function isFooterNoticeLine(line: SlipLine): boolean {
  const code = String(line.productCode ?? "").trim();
  const name = line.product?.name ?? "";
  return code === "000" && name.includes("未收款月結單");
}

function lineProductLabel(line: SlipLine): string {
  const name = line.product?.name?.trim() || "（商品）";
  const unit = line.product?.unit?.trim();
  const u = unit ? `（${unit}）` : "";
  const top = line.isPromotionGift
    ? " · 贈品"
    : line.linePurpose === "prepaid_barrel_topup"
      ? " · 預付桶儲值"
      : "";
  const promo = line.promotionNote?.trim() ? ` · ${line.promotionNote.trim()}` : "";
  return `${name}${u}${top}${promo}`;
}

function billingLineLabel(line: SlipLine): string {
  const t = line.billingTypeAtLine;
  if (t === "monthly") return "月";
  if (t === "prepaid") return "預";
  if (t === "cash") return "現";
  return "";
}

/**
 * 產出可寫入列印視窗的完整 HTML（含 screen/print 樣式）。
 * 若版面啟用訂單編號一維條碼（Code 128），會嵌入 SVG。
 */
export function buildOrderSlipHtml(order: OrderSlipSource, layout: OrderPrintLayoutV1): string {
  const printVisibility = layout.printVisibility ?? coercePrintVisibility(undefined, layout.orderNoBarcode?.enabled);
  const { pageWidthMm, pageHeightMm, fontFamily, fields, linesBlock, orderNoBarcode } = layout;
  const layoutWithVis: OrderPrintLayoutV1 = { ...layout, printVisibility };
  const cust = order.customer;
  const addr = order.deliveryAddress;
  const sched = fmtLocalYmd(order.scheduledDeliveryDate);
  const bill = billingTypeLabel(order.billingTypeAtOrder ?? cust?.billingType ?? "cash");
  const cashMode = order.cashInvoiceMode;
  const cashNote =
    cashMode === "tax_exclusive" ? "現金發票·稅外加" : cashMode === "tax_inclusive" ? "現金發票·含稅" : "";

  const blocks: string[] = [];

  if (printVisibility.orderNoBarcode && orderNoBarcode.enabled) {
    const rawNo = String(order.orderNo ?? "").trim();
    if (rawNo) {
      try {
        const svg = encodeOrderNoToCode128Svg(rawNo);
        const b = orderNoBarcode;
        blocks.push(
          `<div class="slip-barcode" style="left:${b.leftMm}mm;top:${b.topMm}mm;width:${b.widthMm}mm;height:${b.heightMm}mm;">${svg}</div>`,
        );
      } catch {
        /* 略過條碼，其餘欄位仍列印 */
      }
    }
  }

  const abs = (content: string, pos: FieldPos, extraClass = "") => {
    blocks.push(
      `<div class="slip-field${extraClass ? ` ${extraClass}` : ""}" style="${fieldStyle(pos, layout)}">${content}</div>`,
    );
  };

  const absField = (
    key: Parameters<typeof isFieldPrintEnabled>[1],
    content: string,
    pos: FieldPos,
    extraClass = "",
  ) => {
    if (!isFieldPrintEnabled(layoutWithVis, key)) return;
    abs(content, pos, extraClass);
  };

  const absIf = (
    key: Parameters<typeof isFieldPrintEnabled>[1],
    content: string | null | undefined,
    pos: FieldPos,
    extraClass = "",
  ) => {
    if (!isFieldPrintEnabled(layoutWithVis, key)) return;
    if (content == null || String(content).trim() === "") return;
    abs(escHtml(content), pos, extraClass);
  };

  absField("orderNo", escHtml(order.orderNo), fields.orderNo);
  absField("customerCode", escHtml(cust?.customerCode ?? "—"), fields.customerCode);
  absField("customerName", escHtml(cust?.name ?? "—"), fields.customerName);
  absField("customerPhone", escHtml(cust?.phone ?? "—"), fields.customerPhone);
  absField("businessTaxId", escHtml(cust?.businessTaxId ?? ""), fields.businessTaxId);
  absField("addressLabel", escHtml(addr?.label ? `${addr.label}` : "送貨地址"), fields.addressLabel);
  absField("addressLine", escHtml(addr?.addressLine ?? "—"), fields.addressLine);
  absField("addressPhone", escHtml(addr?.contactPhone ?? ""), fields.addressPhone);
  absField("scheduledDate", escHtml(sched === "—" ? "" : sched), fields.scheduledDate);
  absField(
    "remark",
    escHtml(cust?.standingRemark ?? order.remark ?? ""),
    fields.remark,
    "slip-field--wrap",
  );
  absIf("productRemark", order.productRemark, fields.productRemark, "slip-field--wrap");
  absField("totalAmount", escHtml(moneyStr(order.totalAmount)), fields.totalAmount);
  absField(
    "taxLine",
    escHtml(`稅金：${order.taxAmount != null && order.taxAmount !== "" ? moneyStr(order.taxAmount) : ""}`),
    fields.taxLine,
  );
  absField("billingType", escHtml(`${bill}${cashNote ? ` ${cashNote}` : ""}`), fields.billingType, "slip-field--small");
  absIf("announcement", order.announcement, fields.announcement, "slip-field--wrap");
  absIf("driverName", order.driverName, fields.driverName);
  absIf("remainBalance", order.remainBalance, fields.remainBalance);
  absIf("bucketCount", order.bucketCount, fields.bucketCount);
  absIf("lastOrderDate", order.lastOrderDate, fields.lastOrderDate);
  absIf("lastBottleQty", order.lastBottleQty, fields.lastBottleQty);

  const lines = Array.isArray(order.lines) ? [...order.lines] : [];
  const footerCfg = linesBlock.footerNotice;

  let normalY = linesBlock.startTopMm;
  let footerY = footerCfg?.startTopMm ?? linesBlock.startTopMm + 80;
  let normalUsed = 0;
  let footerUsed = 0;
  let skippedNormal = 0;
  let skippedFooter = 0;

  for (const line of lines) {
    if (isFooterNoticeLine(line)) {
      if (!printVisibility.footerNotice) {
        continue;
      }
      if (!footerCfg) {
        skippedFooter += 1;
        continue;
      }
      const maxF = footerCfg.maxRows;
      if (footerUsed >= maxF) {
        skippedFooter += 1;
        continue;
      }
      const top = footerY;
      const titleHtml = escHtml(line.product?.name?.trim() || "（未收款月結單）");
      const priceHtml = escHtml(`$${moneyStr(line.unitPrice)}`);
      blocks.push(
        `<div class="slip-field slip-line" style="${colStyle(footerCfg.title, top, layout)}">${titleHtml}</div>`,
      );
      blocks.push(
        `<div class="slip-field slip-line slip-num" style="${colStyle(footerCfg.amount, top, layout)}">${priceHtml}</div>`,
      );
      footerY += footerCfg.rowHeightMm;
      footerUsed += 1;
    } else {
      if (!printVisibility.normalLines) {
        continue;
      }
      if (normalUsed >= linesBlock.maxRows) {
        skippedNormal += 1;
        continue;
      }
      const top = normalY;
      const idHtml = escHtml(String(line.productCode ?? "").trim());
      const nameHtml = escHtml(lineProductLabel(line));
      const qtyHtml = escHtml(String(line.qtyOrdered));
      const upHtml = escHtml(moneyStr(line.unitPrice));
      const amtHtml = escHtml(moneyStr(line.lineAmount));
      const bl = billingLineLabel(line);
      if (isLineColPrintEnabled(layoutWithVis, "productId")) {
        blocks.push(`<div class="slip-field slip-line slip-num" style="${colStyle(linesBlock.productId, top, layout)}">${idHtml}</div>`);
      }
      if (isLineColPrintEnabled(layoutWithVis, "productName")) {
        blocks.push(
          `<div class="slip-field slip-line" style="${colStyle(linesBlock.productName, top, layout)}">${nameHtml}${bl ? ` <span class="slip-muted">${escHtml(bl)}</span>` : ""}</div>`,
        );
      }
      if (isLineColPrintEnabled(layoutWithVis, "qty")) {
        blocks.push(`<div class="slip-field slip-line slip-num" style="${colStyle(linesBlock.qty, top, layout)}">${qtyHtml}</div>`);
      }
      if (isLineColPrintEnabled(layoutWithVis, "unitPrice")) {
        blocks.push(`<div class="slip-field slip-line slip-num" style="${colStyle(linesBlock.unitPrice, top, layout)}">${upHtml}</div>`);
      }
      if (isLineColPrintEnabled(layoutWithVis, "lineAmount")) {
        blocks.push(`<div class="slip-field slip-line slip-num" style="${colStyle(linesBlock.lineAmount, top, layout)}">${amtHtml}</div>`);
      }
      normalY += linesBlock.rowHeightMm;
      normalUsed += 1;
    }
  }

  const warnParts: string[] = [];
  if (skippedNormal > 0) warnParts.push(`${skippedNormal} 筆一般明細`);
  if (skippedFooter > 0) warnParts.push(`${skippedFooter} 筆未收款月結列`);
  if (warnParts.length > 0) {
    const top = Math.max(normalY, footerY) + 1;
    blocks.push(
      `<div class="slip-field slip-muted" style="left:8mm;top:${top}mm;font-size:${Math.max(7, layout.baseFontPt - 1)}pt;">（尚有 ${warnParts.join("、")}未印出，請調高 maxRows／footer 列數或另紙）</div>`,
    );
  }

  const inner = blocks.join("\n");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>訂單 ${escHtml(order.orderNo)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: ${escHtml(fontFamily)}; }
    @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
    @media print {
      .no-print { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media screen {
      body { background: #e2e8f0; padding: 12px; }
      .slip-wrap { box-shadow: 0 4px 24px rgba(0,0,0,.12); }
    }
    .slip-wrap {
      width: ${pageWidthMm}mm;
      height: ${pageHeightMm}mm;
      margin: 0 auto;
      background: #fff;
      position: relative;
    }
    #slip {
      width: ${pageWidthMm}mm;
      height: ${pageHeightMm}mm;
      position: relative;
      overflow: hidden;
    }
    .slip-field {
      position: absolute;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
    }
    .slip-field--wrap {
      white-space: normal;
      overflow: visible;
      word-break: break-word;
    }
    .slip-field--small { font-size: ${Math.max(7, layout.baseFontPt - 2)}pt; }
    .slip-line { }
    .slip-num { text-align: right; font-variant-numeric: tabular-nums; }
    .slip-muted { color: #64748b; font-size: 9pt; }
    .slip-barcode {
      position: absolute;
      overflow: hidden;
      line-height: 0;
    }
    .slip-barcode svg {
      display: block;
      width: 100%;
      height: auto;
      max-height: 100%;
    }
    .no-print {
      text-align: center;
      padding: 8px;
      font-size: 13px;
      color: #334155;
    }
  </style>
</head>
<body>
  <p class="no-print">預覽／請確認無誤後使用 Ctrl+P 或下方關閉後再列印。</p>
  <div class="slip-wrap">
    <div id="slip">${inner}</div>
  </div>
</body>
</html>`;
}
