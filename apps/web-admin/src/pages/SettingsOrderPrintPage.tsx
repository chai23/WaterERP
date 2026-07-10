import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ORDER_PRINT_LAYOUT,
  buildOrderSlipHtml,
  defaultPrintVisibility,
  loadOrderPrintLayout,
  openOrderPrintWindow,
  saveOrderPrintLayout,
  SAMPLE_ORDER_SLIP,
  slipWithOrderAnnouncement,
} from "../orderPrint";
import type { FieldPos, OrderPrintLayoutV1 } from "../orderPrint";
import { DesktopOnlyNotice } from "../components/DesktopOnlyNotice";

/** 設定頁預覽縮放（僅螢幕；列印仍 1:1）。0.9 為螢幕略縮小預覽；1 為與版面 mm 同比例。 */
const ORDER_PRINT_PREVIEW_SCALE = 0.9;

const FIELD_LABELS: { key: keyof OrderPrintLayoutV1["fields"]; label: string }[] = [
  { key: "customerCode", label: "客戶編號" },
  { key: "customerName", label: "客戶名稱" },
  { key: "addressLine", label: "客戶／送貨地址" },
  { key: "remark", label: "客戶常態備註" },
  { key: "businessTaxId", label: "統一編號" },
  { key: "customerPhone", label: "客戶電話" },
  { key: "orderNo", label: "訂單編號" },
  { key: "scheduledDate", label: "日期" },
  { key: "lastBottleQty", label: "上次送瓶數量" },
  { key: "addressLabel", label: "地址標籤" },
  { key: "addressPhone", label: "送貨點電話" },
  { key: "productRemark", label: "商品／訂單備註（紙上）" },
  { key: "taxLine", label: "稅金行（內容為「稅金：」+ 金額）" },
  { key: "totalAmount", label: "訂單總額" },
  { key: "billingType", label: "結帳方式" },
  { key: "announcement", label: "公告" },
  { key: "driverName", label: "司機" },
  { key: "remainBalance", label: "餘款／餘額" },
  { key: "bucketCount", label: "桶" },
  { key: "lastOrderDate", label: "上次訂單日" },
];

function updateField(layout: OrderPrintLayoutV1, key: keyof OrderPrintLayoutV1["fields"], patch: Partial<FieldPos>): OrderPrintLayoutV1 {
  return {
    ...layout,
    fields: {
      ...layout.fields,
      [key]: { ...layout.fields[key], ...patch },
    },
  };
}

function withBarcodePrint(layout: OrderPrintLayoutV1, enabled: boolean): OrderPrintLayoutV1 {
  return {
    ...layout,
    printVisibility: { ...layout.printVisibility, orderNoBarcode: enabled },
    orderNoBarcode: { ...layout.orderNoBarcode, enabled },
  };
}

export default function SettingsOrderPrintPage() {
  const [layout, setLayout] = useState<OrderPrintLayoutV1>(() => loadOrderPrintLayout());
  const [savedMsg, setSavedMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");

  const previewSlip = useMemo(() => ({ ...SAMPLE_ORDER_SLIP }), []);

  const persist = useCallback((next: OrderPrintLayoutV1) => {
    saveOrderPrintLayout(next);
    setSavedMsg("已儲存於此瀏覽器（localStorage）。");
    setTimeout(() => setSavedMsg(""), 2500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        const slip = await slipWithOrderAnnouncement(previewSlip);
        if (!cancelled) setPreviewHtml(buildOrderSlipHtml(slip, layout));
      })();
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [layout, previewSlip]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `order-print-layout-v1-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File | null) => {
    setErrMsg("");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as unknown;
        if (!raw || typeof raw !== "object") throw new Error("格式錯誤");
        saveOrderPrintLayout(raw as OrderPrintLayoutV1);
        setLayout(loadOrderPrintLayout());
        setSavedMsg("已從檔案匯入並儲存。");
      } catch {
        setErrMsg("匯入失敗：請確認為本頁匯出的 JSON。");
      }
    };
    reader.readAsText(file, "utf-8");
  };

  const testPrint = () => {
    setErrMsg("");
    void (async () => {
      const slip = await slipWithOrderAnnouncement(previewSlip);
      const ok = openOrderPrintWindow(slip, layout);
      if (!ok) setErrMsg("無法開啟列印視窗，請允許此網站的彈出視窗後再試。");
    })();
  };

  const resetDefault = () => {
    if (!window.confirm("確定重設為系統預設版面？（會一併重設自動列印開關為關）")) return;
    const next = { ...DEFAULT_ORDER_PRINT_LAYOUT };
    setLayout(next);
    persist(next);
  };

  const lineColKeys = useMemo(() => ["productId", "productName", "qty", "unitPrice", "lineAmount"] as const, []);
  const lineColLabel: Record<(typeof lineColKeys)[number], string> = {
    productId: "品號欄",
    productName: "品名欄（左緣）",
    qty: "數量欄",
    unitPrice: "單價欄",
    lineAmount: "小計欄",
  };

  return (
    <>
      <DesktopOnlyNotice feature="訂單列印版面編輯" />
      <section className="card order-print-editor">
        <h2 className="card__title">訂單列印版面（點陣套印）</h2>
        <p className="card__hint">
          版面以<strong>毫米（mm）</strong>定位，配合公司已印格線的空白訂單紙套印文字。設定儲存在<strong>本機瀏覽器</strong>
          （每台電腦／瀏覽器獨立），可匯出 JSON 複製到其他電腦。建立訂單成功後可選<strong>自動開啟列印</strong>（仍須在系統列印對話框確認）。
          「公告」欄位的文字內容請至<strong>系統設定 → 訂單公告</strong>維護（全站與特定期間）；本頁僅調整公告在紙上的位置與字型。
        </p>
        {savedMsg ? <p className="feedback feedback--ok">{savedMsg}</p> : null}
        {errMsg ? <p className="feedback feedback--err">{errMsg}</p> : null}
      </section>

      <section className="card">
        <h3 className="card__title">紙張與字型</h3>
        <div className="form-row-2">
          <div className="field">
            <label htmlFor="op-page-w">紙張寬（mm）</label>
            <input
              id="op-page-w"
              type="number"
              step="0.1"
              value={layout.pageWidthMm}
              onChange={(e) => setLayout((L) => ({ ...L, pageWidthMm: Number(e.target.value) || L.pageWidthMm }))}
            />
          </div>
          <div className="field">
            <label htmlFor="op-page-h">紙張高（mm）</label>
            <input
              id="op-page-h"
              type="number"
              step="0.1"
              value={layout.pageHeightMm}
              onChange={(e) => setLayout((L) => ({ ...L, pageHeightMm: Number(e.target.value) || L.pageHeightMm }))}
            />
          </div>
        </div>
        <div className="field field--full">
          <label htmlFor="op-font">字型（建議等寬）</label>
          <input
            id="op-font"
            type="text"
            value={layout.fontFamily}
            onChange={(e) => setLayout((L) => ({ ...L, fontFamily: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="op-base-fs">預設字級（pt）</label>
          <input
            id="op-base-fs"
            type="number"
            step="0.5"
            value={layout.baseFontPt}
            onChange={(e) => setLayout((L) => ({ ...L, baseFontPt: Number(e.target.value) || L.baseFontPt }))}
          />
        </div>
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={layout.autoPrintAfterCreate}
              onChange={(e) => setLayout((L) => ({ ...L, autoPrintAfterCreate: e.target.checked }))}
            />
            <span>建立訂單成功後自動開啟列印視窗</span>
          </label>
        </div>
        <div className="form-actions" style={{ marginTop: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <button type="button" className="btn btn--primary" onClick={() => persist(layout)}>
            儲存設定
          </button>
          <button type="button" className="btn btn--secondary" onClick={testPrint}>
            測試列印（假資料）
          </button>
          <button type="button" className="btn btn--secondary" onClick={exportJson}>
            匯出 JSON
          </button>
          <label className="btn btn--secondary" style={{ cursor: "pointer", margin: 0 }}>
            匯入 JSON
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => importJson(e.target.files?.[0] ?? null)}
            />
          </label>
          <button type="button" className="btn btn--secondary" onClick={resetDefault}>
            重設為預設版面
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">列印項目</h3>
        <p className="card__hint" style={{ marginTop: 0 }}>
          取消勾選的項目不會印在紙上（座標設定仍保留，日後可再勾選啟用）。變更後請用下方預覽或測試列印確認。
        </p>
        <div className="form-actions" style={{ marginTop: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() =>
              setLayout((L) => ({
                ...L,
                printVisibility: defaultPrintVisibility(),
                orderNoBarcode: { ...L.orderNoBarcode, enabled: true },
              }))
            }
          >
            全部勾選
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              const off = defaultPrintVisibility();
              const fields = { ...off.fields };
              for (const { key } of FIELD_LABELS) fields[key] = false;
              setLayout((L) => ({
                ...L,
                printVisibility: {
                  ...off,
                  fields,
                  orderNoBarcode: false,
                  normalLines: false,
                  footerNotice: false,
                  lineColumns: {
                    productId: false,
                    productName: false,
                    qty: false,
                    unitPrice: false,
                    lineAmount: false,
                  },
                },
                orderNoBarcode: { ...L.orderNoBarcode, enabled: false },
              }));
            }}
          >
            全部取消
          </button>
        </div>
        <h4 className="order-new__subsection-label" style={{ marginTop: "1rem" }}>
          表頭與頁尾欄位
        </h4>
        <div className="order-print-vis-grid">
          {FIELD_LABELS.map(({ key, label }) => (
            <label key={key} className="order-print-vis-item">
              <input
                type="checkbox"
                checked={layout.printVisibility.fields[key]}
                onChange={(e) =>
                  setLayout((L) => ({
                    ...L,
                    printVisibility: {
                      ...L.printVisibility,
                      fields: { ...L.printVisibility.fields, [key]: e.target.checked },
                    },
                  }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <h4 className="order-new__subsection-label" style={{ marginTop: "1.25rem" }}>
          其他
        </h4>
        <div className="order-print-vis-grid">
          <label className="order-print-vis-item">
            <input
              type="checkbox"
              checked={layout.printVisibility.orderNoBarcode}
              onChange={(e) => setLayout((L) => withBarcodePrint(L, e.target.checked))}
            />
            <span>訂單編號一維條碼（Code 128）</span>
          </label>
          <label className="order-print-vis-item">
            <input
              type="checkbox"
              checked={layout.printVisibility.normalLines}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  printVisibility: { ...L.printVisibility, normalLines: e.target.checked },
                }))
              }
            />
            <span>一般商品明細列</span>
          </label>
          <label className="order-print-vis-item">
            <input
              type="checkbox"
              checked={layout.printVisibility.footerNotice}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  printVisibility: { ...L.printVisibility, footerNotice: e.target.checked },
                }))
              }
            />
            <span>「未收款月結單」類列</span>
          </label>
        </div>
        <h4 className="order-new__subsection-label" style={{ marginTop: "1.25rem" }}>
          明細各欄（一般商品列）
        </h4>
        <div className="order-print-vis-grid">
          {lineColKeys.map((k) => (
            <label key={k} className="order-print-vis-item">
              <input
                type="checkbox"
                checked={layout.printVisibility.lineColumns[k]}
                onChange={(e) =>
                  setLayout((L) => ({
                    ...L,
                    printVisibility: {
                      ...L.printVisibility,
                      lineColumns: { ...L.printVisibility.lineColumns, [k]: e.target.checked },
                    },
                  }))
                }
              />
              <span>{lineColLabel[k]}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">訂單編號一維條碼（Code 128）</h3>
        <p className="card__hint" style={{ marginTop: 0 }}>
          條碼<strong>內容與訂單編號字串相同</strong>（非網址）。掃描槍掃入後可貼到「查詢訂單」關鍵字、或內部流程用於分派辨識。紙上為橫向長條，請以寬／高（mm）框住條碼區；若與格線重疊請調整。
        </p>
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={layout.printVisibility.orderNoBarcode}
              onChange={(e) => setLayout((L) => withBarcodePrint(L, e.target.checked))}
            />
            <span>列印時顯示訂單編號條碼</span>
          </label>
        </div>
        <div className="form-row-2" style={{ marginTop: "0.75rem" }}>
          <div className="field">
            <label htmlFor="op-bc-left">條碼區左緣（mm）</label>
            <input
              id="op-bc-left"
              type="number"
              step="0.5"
              value={layout.orderNoBarcode.leftMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  orderNoBarcode: { ...L.orderNoBarcode, leftMm: Number(e.target.value) || 0 },
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="op-bc-top">條碼區上緣（mm）</label>
            <input
              id="op-bc-top"
              type="number"
              step="0.5"
              value={layout.orderNoBarcode.topMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  orderNoBarcode: { ...L.orderNoBarcode, topMm: Number(e.target.value) || 0 },
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="op-bc-w">條碼區寬（mm）</label>
            <input
              id="op-bc-w"
              type="number"
              step="0.5"
              min={12}
              value={layout.orderNoBarcode.widthMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  orderNoBarcode: {
                    ...L.orderNoBarcode,
                    widthMm: Math.max(12, Number(e.target.value) || L.orderNoBarcode.widthMm),
                  },
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="op-bc-h">條碼區高（mm）</label>
            <input
              id="op-bc-h"
              type="number"
              step="0.5"
              min={6}
              value={layout.orderNoBarcode.heightMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  orderNoBarcode: {
                    ...L.orderNoBarcode,
                    heightMm: Math.max(6, Number(e.target.value) || L.orderNoBarcode.heightMm),
                  },
                }))
              }
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">欄位座標（mm）</h3>
        <p className="card__hint" style={{ marginTop: 0 }}>
          字級、最大寬可留空則沿用預設字級；最大寬用於截斷過長文字。
          預設座標係依舊版 WinForms <code>DrawString</code> 之像素位置、以 96 DPI 換算為 mm（×25.4÷96），方便舊紙對位。
        </p>
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>欄位</th>
                <th className="num">左 mm</th>
                <th className="num">上 mm</th>
                <th className="num">字級 pt</th>
                <th className="num">最大寬 mm</th>
              </tr>
            </thead>
            <tbody>
              {FIELD_LABELS.map(({ key, label }) => {
                const f = layout.fields[key];
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        value={f.leftMm}
                        onChange={(e) => setLayout((L) => updateField(L, key, { leftMm: Number(e.target.value) || 0 }))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        value={f.topMm}
                        onChange={(e) => setLayout((L) => updateField(L, key, { topMm: Number(e.target.value) || 0 }))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="預設"
                        value={f.fontSizePt ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) =>
                            updateField(L, key, v === "" ? { fontSizePt: undefined } : { fontSizePt: Number(v) || undefined }),
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="—"
                        value={f.maxWidthMm ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) =>
                            updateField(L, key, v === "" ? { maxWidthMm: undefined } : { maxWidthMm: Number(v) || undefined }),
                          );
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">商品明細列</h3>
        <div className="form-row-2">
          <div className="field">
            <label>第一列上緣（mm）</label>
            <input
              type="number"
              step="0.5"
              value={layout.linesBlock.startTopMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: { ...L.linesBlock, startTopMm: Number(e.target.value) || 0 },
                }))
              }
            />
          </div>
          <div className="field">
            <label>列高（mm）</label>
            <input
              type="number"
              step="0.1"
              value={layout.linesBlock.rowHeightMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: { ...L.linesBlock, rowHeightMm: Number(e.target.value) || 0 },
                }))
              }
            />
          </div>
          <div className="field">
            <label>最多列數</label>
            <input
              type="number"
              min={1}
              max={40}
              value={layout.linesBlock.maxRows}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: { ...L.linesBlock, maxRows: Math.max(1, Math.min(40, Math.floor(Number(e.target.value) || 1))) },
                }))
              }
            />
          </div>
        </div>
        <h4 className="order-new__subsection-label" style={{ marginTop: "1rem" }}>
          各欄左緣（mm，列高由上方統一控制）
        </h4>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>欄</th>
                <th className="num">左 mm</th>
                <th className="num">字級 pt</th>
                <th className="num">最大寬 mm</th>
              </tr>
            </thead>
            <tbody>
              {lineColKeys.map((k) => {
                const c = layout.linesBlock[k];
                return (
                  <tr key={k}>
                    <td>{lineColLabel[k]}</td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        value={c.leftMm}
                        onChange={(e) =>
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              [k]: { ...L.linesBlock[k], leftMm: Number(e.target.value) || 0 },
                            },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="預設"
                        value={c.fontSizePt ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              [k]: { ...L.linesBlock[k], fontSizePt: v === "" ? undefined : Number(v) || undefined },
                            },
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="—"
                        value={c.maxWidthMm ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              [k]: { ...L.linesBlock[k], maxWidthMm: v === "" ? undefined : Number(v) || undefined },
                            },
                          }));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h4 className="order-new__subsection-label" style={{ marginTop: "1.25rem" }}>
          「未收款月結單」列（品號 000 且品名含「未收款月結單」；舊版 num1 區）
        </h4>
        <p className="card__hint" style={{ marginTop: 0 }}>
          與一般明細依訂單順序穿插列印；僅印品名與「$」+ 單價。
        </p>
        <div className="form-row-2" style={{ marginTop: "0.5rem" }}>
          <div className="field">
            <label>此區第一列上緣（mm）</label>
            <input
              type="number"
              step="0.5"
              value={layout.linesBlock.footerNotice.startTopMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: {
                    ...L.linesBlock,
                    footerNotice: { ...L.linesBlock.footerNotice, startTopMm: Number(e.target.value) || 0 },
                  },
                }))
              }
            />
          </div>
          <div className="field">
            <label>此區列高（mm）</label>
            <input
              type="number"
              step="0.1"
              value={layout.linesBlock.footerNotice.rowHeightMm}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: {
                    ...L.linesBlock,
                    footerNotice: { ...L.linesBlock.footerNotice, rowHeightMm: Number(e.target.value) || 0 },
                  },
                }))
              }
            />
          </div>
          <div className="field">
            <label>此區最多列數</label>
            <input
              type="number"
              min={1}
              max={20}
              value={layout.linesBlock.footerNotice.maxRows}
              onChange={(e) =>
                setLayout((L) => ({
                  ...L,
                  linesBlock: {
                    ...L.linesBlock,
                    footerNotice: {
                      ...L.linesBlock.footerNotice,
                      maxRows: Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))),
                    },
                  },
                }))
              }
            />
          </div>
        </div>
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>欄</th>
                <th className="num">左 mm</th>
                <th className="num">字級 pt</th>
                <th className="num">最大寬 mm</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  { key: "title" as const, label: "品名（整行說明）" },
                  { key: "amount" as const, label: "金額（$ + 單價）" },
                ] as const
              ).map(({ key, label }) => {
                const c = layout.linesBlock.footerNotice[key];
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        value={c.leftMm}
                        onChange={(e) =>
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              footerNotice: {
                                ...L.linesBlock.footerNotice,
                                [key]: { ...L.linesBlock.footerNotice[key], leftMm: Number(e.target.value) || 0 },
                              },
                            },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="預設"
                        value={c.fontSizePt ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              footerNotice: {
                                ...L.linesBlock.footerNotice,
                                [key]: {
                                  ...L.linesBlock.footerNotice[key],
                                  fontSizePt: v === "" ? undefined : Number(v) || undefined,
                                },
                              },
                            },
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        className="table-inline-num"
                        placeholder="—"
                        value={c.maxWidthMm ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLayout((L) => ({
                            ...L,
                            linesBlock: {
                              ...L.linesBlock,
                              footerNotice: {
                                ...L.linesBlock.footerNotice,
                                [key]: {
                                  ...L.linesBlock.footerNotice[key],
                                  maxWidthMm: v === "" ? undefined : Number(v) || undefined,
                                },
                              },
                            },
                          }));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">
          套印預覽（假資料，螢幕
          {ORDER_PRINT_PREVIEW_SCALE >= 0.999 ? " 1:1" : ` 約 ${Math.round(ORDER_PRINT_PREVIEW_SCALE * 100)}% 縮小`}
          ）
        </h3>
        <p className="card__hint">
          僅供對位參考；實際列印請用「測試列印」以 1:1 對紙。若仍嫌小可縮小瀏覽器側邊欄或使用全螢幕；區塊可橫向捲動。
        </p>
        <div className="order-print-preview-shell">
          {previewHtml ? (
            <div
              className="order-print-preview-frame"
              style={
                {
                  ["--op-scale" as string]: String(ORDER_PRINT_PREVIEW_SCALE),
                  ["--op-w" as string]: `${layout.pageWidthMm}mm`,
                  ["--op-h" as string]: `${layout.pageHeightMm}mm`,
                } as React.CSSProperties
              }
            >
              <div className="order-print-preview-scaler">
                <iframe
                  title="套印預覽"
                  srcDoc={previewHtml}
                  className="order-print-preview-iframe"
                  style={{ width: `${layout.pageWidthMm}mm`, height: `${layout.pageHeightMm}mm` }}
                />
              </div>
            </div>
          ) : (
            <span className="text-muted">預覽載入中…</span>
          )}
        </div>
      </section>
    </>
  );
}
