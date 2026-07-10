import { useEffect, useState } from "react";
import { cashInvoiceModeLabel } from "../taxDisplay";
import type { TaxInvoiceRecord } from "../taxInvoiceUtils";
import {
  patchTaxInvoice,
  taxInvoiceBasisLabel,
  taxInvoiceDisplayNo,
  taxInvoiceStatusLabel,
} from "../taxInvoiceUtils";

type Props = {
  invoice: TaxInvoiceRecord;
  onClose: () => void;
  onSaved: (updated: TaxInvoiceRecord) => void;
};

export default function TaxInvoiceRegisterModal({ invoice, onClose, onSaved }: Props) {
  const [externalInvoiceNo, setExternalInvoiceNo] = useState(invoice.externalInvoiceNo ?? "");
  const [buyerName, setBuyerName] = useState(invoice.buyerName ?? "");
  const [buyerTaxId, setBuyerTaxId] = useState(invoice.buyerTaxId ?? "");
  const [note, setNote] = useState(invoice.note ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const save = async () => {
    const ext = externalInvoiceNo.trim();
    if (!ext) {
      setMsg("請填寫實際發票號碼");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const updated = await patchTaxInvoice(invoice.id, {
        externalInvoiceNo: ext,
        buyerName: buyerName.trim() || undefined,
        buyerTaxId: buyerTaxId.trim() || undefined,
        note: note.trim() || undefined,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  };

  const voidInvoice = async () => {
    if (!window.confirm("確定作廢此發票紀錄？作廢後不可再補登號碼。")) return;
    setSaving(true);
    setMsg("");
    try {
      const updated = await patchTaxInvoice(invoice.id, { status: "voided" });
      onSaved(updated);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "作廢失敗");
    } finally {
      setSaving(false);
    }
  };

  const readOnly = invoice.status === "voided" || invoice.status === "issued";

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tax-invoice-register-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <h2 id="tax-invoice-register-title" className="modal-dialog__title">
            {readOnly ? "發票紀錄" : "補登發票號碼"}
          </h2>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>

        <div className="modal-dialog__body">
          <dl className="detail-list detail-list--compact">
            <dt>內部編號</dt>
            <dd className="mono-text">{invoice.invoiceNo}</dd>
            <dt>狀態</dt>
            <dd>{taxInvoiceStatusLabel(invoice.status)}</dd>
            <dt>來源</dt>
            <dd>{taxInvoiceBasisLabel(invoice.basisType)}</dd>
            <dt>客戶</dt>
            <dd>{invoice.customerName ?? "—"}</dd>
            <dt>關聯</dt>
            <dd>
              {invoice.salesOrderNo
                ? `訂單 ${invoice.salesOrderNo}`
                : invoice.billingStatementNo
                  ? `月結 ${invoice.billingStatementNo}`
                  : invoice.receiptVoucherNo
                    ? `收款單 ${invoice.receiptVoucherNo}`
                    : "—"}
            </dd>
            <dt>模式</dt>
            <dd>{cashInvoiceModeLabel(invoice.invoiceMode)}</dd>
            <dt className="num">含稅總額</dt>
            <dd className="num">
              <strong>{invoice.totalAmount}</strong>
            </dd>
            {invoice.externalInvoiceNo ? (
              <>
                <dt>實際發票號碼</dt>
                <dd className="mono-text">{taxInvoiceDisplayNo(invoice)}</dd>
              </>
            ) : null}
          </dl>

          {!readOnly ? (
            <div className="form-grid" style={{ marginTop: "1rem" }}>
              <label className="field">
                <span>實際發票號碼 *</span>
                <input
                  value={externalInvoiceNo}
                  onChange={(e) => setExternalInvoiceNo(e.target.value)}
                  placeholder="例如：AB12345678"
                  disabled={saving}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>買方抬頭</span>
                <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} disabled={saving} />
              </label>
              <label className="field">
                <span>買方統編</span>
                <input value={buyerTaxId} onChange={(e) => setBuyerTaxId(e.target.value)} disabled={saving} />
              </label>
              <label className="field field--span2">
                <span>備註</span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="載具、捐贈碼等"
                  disabled={saving}
                />
              </label>
            </div>
          ) : null}

          {msg ? <div className="alert alert--error" style={{ marginTop: "0.75rem" }}>{msg}</div> : null}
        </div>

        <footer className="modal-dialog__footer">
          {!readOnly ? (
            <>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => void voidInvoice()} disabled={saving}>
                作廢
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
                {saving ? "儲存中…" : "儲存發票號碼"}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              關閉
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
