import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ExpenseVoucher } from "../expenseUtils";
import { paymentMethodLabel, statusLabel, TAX_MODE_LABELS } from "../expenseUtils";

type Props = {
  voucher: ExpenseVoucher;
  onClose: () => void;
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="order-detail__row">
      <span className="order-detail__meta-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="order-detail__stat">
      <span className="order-detail__stat-label">{label}</span>
      <span className="order-detail__stat-value">{value}</span>
    </div>
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const s = String(value);
  if (s.length >= 16) return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
  return s.slice(0, 10);
}

export function ExpenseDetailModal({ voucher, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = Array.isArray(voucher.lines) ? voucher.lines : [];
  const canEdit = voucher.status !== "verified";

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-dialog--order-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expense-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <div className="order-detail__header-main">
            <h2 id="expense-detail-title" className="modal-dialog__title">
              支出詳情
            </h2>
            <code className="modal-dialog__order-no">{voucher.voucherNo}</code>
            <div className="order-detail__header-badges">
              <span className={`badge ${voucher.status === "verified" ? "badge--completed" : "badge--default"}`}>
                {statusLabel(voucher.status)}
              </span>
            </div>
          </div>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉視窗">
            ×
          </button>
        </header>

        <div className="modal-dialog__body">
          <div className="order-detail__summary">
            <SummaryStat label="含稅總額" value={String(voucher.totalAmount)} />
            <SummaryStat label="未稅合計" value={String(voucher.untaxedTotal)} />
            <SummaryStat label="稅額合計" value={String(voucher.taxTotal)} />
            <SummaryStat label="明細筆數" value={String(lines.length)} />
          </div>

          <div className="order-detail__panels">
            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">憑證資訊</h3>
              <DetailRow label="支出日期">{fmtDate(voucher.expenseDate)}</DetailRow>
              <DetailRow label="廠商／對象">{voucher.vendorName || "—"}</DetailRow>
              <DetailRow label="歸屬公司">{voucher.affiliatedCompany?.name ?? "—"}</DetailRow>
              <DetailRow label="付款方式">{paymentMethodLabel(voucher.paymentMethod)}</DetailRow>
              <DetailRow label="開票日期">{fmtDate(voucher.invoiceDate)}</DetailRow>
              <DetailRow label="備註">{voucher.remark?.trim() || "—"}</DetailRow>
            </section>

            <section className="order-detail__panel">
              <h3 className="order-detail__panel-title">登錄與核銷</h3>
              <DetailRow label="核銷狀態">{statusLabel(voucher.status)}</DetailRow>
              <DetailRow label="登錄人">
                {voucher.createdBy?.name ?? "—"}
                {voucher.createdBy?.employeeCode ? (
                  <span className="text-muted">（{voucher.createdBy.employeeCode}）</span>
                ) : null}
              </DetailRow>
              <DetailRow label="核銷人">
                {voucher.verifiedBy?.name ?? "—"}
                {voucher.verifiedBy?.employeeCode ? (
                  <span className="text-muted">（{voucher.verifiedBy.employeeCode}）</span>
                ) : null}
              </DetailRow>
              <DetailRow label="核銷時間">{fmtDateTime(voucher.verifiedAt)}</DetailRow>
            </section>
          </div>

          <h3 className="modal-dialog__section-title">支出明細</h3>
          {lines.length === 0 ? (
            <p className="modal-dialog__empty">此憑證沒有明細列。</p>
          ) : (
            <div className="table-wrap modal-dialog__table-wrap">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th>類別</th>
                    <th>項目</th>
                    <th>客戶</th>
                    <th className="num">數量</th>
                    <th className="num">單價</th>
                    <th>稅別</th>
                    <th className="num">稅額</th>
                    <th className="num">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const custCode = line.customer?.customerCode;
                    const custName = line.customer?.name;
                    const customerLabel =
                      custCode || custName
                        ? [custCode, custName].filter(Boolean).join(" · ")
                        : "—";
                    return (
                      <tr key={String(line.id)}>
                        <td>{line.category?.name ?? "—"}</td>
                        <td>{line.itemName || "—"}</td>
                        <td>{customerLabel}</td>
                        <td className="num">{line.qty}</td>
                        <td className="num">{line.unitPrice}</td>
                        <td>{TAX_MODE_LABELS[line.taxMode] ?? line.taxMode}</td>
                        <td className="num">{line.taxAmount}</td>
                        <td className="num">
                          <strong>{line.lineAmount}</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="modal-dialog__footer">
          {canEdit ? (
            <Link className="btn btn--primary btn--sm" to={`/expenses/edit/${voucher.id}`} onClick={onClose}>
              編輯憑證
            </Link>
          ) : null}
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            關閉
          </button>
        </footer>
      </div>
    </div>
  );
}
