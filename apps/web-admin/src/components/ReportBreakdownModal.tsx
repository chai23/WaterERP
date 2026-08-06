import { useEffect, useState } from "react";
import { moneyText } from "../adminUtils";
import { paymentMethodLabel } from "../reportUtils";

export type ReportBreakdownKind = "revenue" | "ar" | "pendingMonthly" | "payments";

type Props = {
  open: boolean;
  kind: ReportBreakdownKind | null;
  queryString: string;
  onClose: () => void;
};

const TITLES: Record<ReportBreakdownKind, string> = {
  revenue: "營收明細",
  ar: "AR 未清明細",
  pendingMonthly: "待開月結明細",
  payments: "收款明細",
};

export default function ReportBreakdownModal({ open, kind, queryString, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    if (!open || !kind) return;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams(queryString);
    qs.set("breakdown", kind);
    fetch(`/api/reports/period-detail?${qs.toString()}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${r.status}`);
        return (body.data?.rows ?? []) as Array<Record<string, unknown>>;
      })
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => setLoading(false));
  }, [open, kind, queryString]);

  if (!open || !kind) return null;

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-breakdown-title"
        style={{ maxWidth: "56rem", width: "min(92vw, 56rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-dialog__header">
          <h2 id="report-breakdown-title" className="modal-dialog__title">
            {TITLES[kind]}
            <span className="card__title-count">{rows.length} 筆</span>
          </h2>
          <button type="button" className="modal-dialog__close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="modal-dialog__body">
          {loading ? <p className="card__hint">載入中…</p> : null}
          {error ? <div className="alert alert--error">{error}</div> : null}
          <div className="table-wrap modal-dialog__table-wrap">
            <table className="data-table data-table--compact">
              <thead>
                {kind === "revenue" ? (
                  <tr>
                    <th>時間</th>
                    <th>來源</th>
                    <th>單號</th>
                    <th>客戶</th>
                    <th>司機</th>
                    <th className="num">應收</th>
                  </tr>
                ) : null}
                {kind === "ar" ? (
                  <tr>
                    <th>AR 編號</th>
                    <th>訂單</th>
                    <th>客戶</th>
                    <th>到期</th>
                    <th className="num">未清</th>
                    <th>狀態</th>
                  </tr>
                ) : null}
                {kind === "pendingMonthly" ? (
                  <tr>
                    <th>訂單</th>
                    <th>客戶</th>
                    <th className="num">待開月結</th>
                  </tr>
                ) : null}
                {kind === "payments" ? (
                  <tr>
                    <th>收款時間</th>
                    <th>客戶</th>
                    <th>訂單</th>
                    <th>方式</th>
                    <th className="num">金額</th>
                  </tr>
                ) : null}
              </thead>
              <tbody>
                {kind === "revenue"
                  ? rows.map((r) => (
                      <tr key={String(r.id)}>
                        <td>{r.at ? String(r.at).slice(0, 19).replace("T", " ") : "—"}</td>
                        <td>{r.kind === "service" ? "服務" : "配送"}</td>
                        <td>{String(r.orderNo ?? "—")}</td>
                        <td>{String(r.customerName ?? "—")}</td>
                        <td>{String(r.driverName ?? "—")}</td>
                        <td className="num">{moneyText(r.amount as string)}</td>
                      </tr>
                    ))
                  : null}
                {kind === "ar"
                  ? rows.map((r) => (
                      <tr key={String(r.id)}>
                        <td>{String(r.arNo ?? "—")}</td>
                        <td>{String(r.orderNo ?? "—")}</td>
                        <td>{String(r.customerName ?? "—")}</td>
                        <td>{String(r.dueDate ?? "—")}</td>
                        <td className="num">{moneyText(r.outstandingAmount as string)}</td>
                        <td>{String(r.status ?? "—")}</td>
                      </tr>
                    ))
                  : null}
                {kind === "pendingMonthly"
                  ? rows.map((r) => (
                      <tr key={String(r.id)}>
                        <td>{String(r.orderNo ?? "—")}</td>
                        <td>{String(r.customerName ?? "—")}</td>
                        <td className="num">{moneyText(r.amount as string)}</td>
                      </tr>
                    ))
                  : null}
                {kind === "payments"
                  ? rows.map((r) => (
                      <tr key={String(r.id)}>
                        <td>{r.paidAt ? String(r.paidAt).slice(0, 19).replace("T", " ") : "—"}</td>
                        <td>{String(r.customerName ?? "—")}</td>
                        <td>{String(r.orderNo ?? "—")}</td>
                        <td>{paymentMethodLabel(String(r.paymentMethod ?? ""))}</td>
                        <td className="num">{moneyText(r.amount as string)}</td>
                      </tr>
                    ))
                  : null}
                {!loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>此區間無明細</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <footer className="modal-dialog__footer">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            關閉
          </button>
        </footer>
      </div>
    </div>
  );
}
