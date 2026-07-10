import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ExpenseFlatLine, ExpenseSummary } from "../expenseUtils";
import { exportExpenseLinesCsv, paymentMethodLabel, statusLabel, TAX_MODE_LABELS } from "../expenseUtils";

type Props = {
  title: string;
  dateLabel: string;
  summaryUrl: string;
  linkTo?: string;
  linkLabel?: string;
};

export default function ExpenseSummarySection({ title, dateLabel, summaryUrl, linkTo, linkLabel }: Props) {
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    fetch(summaryUrl)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body?.ok === false) throw new Error(body?.message ?? `HTTP ${r.status}`);
        return body.data as ExpenseSummary;
      })
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : "讀取失敗"))
      .finally(() => setLoading(false));
  }, [summaryUrl]);

  const lines = summary?.lines ?? [];

  const exportCsv = () => {
    if (!summary) return;
    exportExpenseLinesCsv(`expenses-${dateLabel.replace(/\s+/g, "_")}.csv`, lines);
  };

  return (
    <section className="card">
      <h2 className="card__title">
        {title} <span className="card__title-count">{summary ? `${summary.voucherCount} 張 · ${summary.lineCount} 筆明細` : "—"}</span>
      </h2>
      <p className="card__hint">依支出日期統計；明細列展開顯示每一行項目。</p>

      {loading ? <p className="card__hint">讀取中…</p> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}

      {summary ? (
        <>
          <div className="stats-grid" style={{ marginBottom: "1rem" }}>
            <article className="stat-card">
              <div className="stat-card__label">含稅總支出</div>
              <div className="stat-card__value">{Number(summary.totalAmount).toLocaleString()}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">未稅合計</div>
              <div className="stat-card__value">{Number(summary.untaxedTotal).toLocaleString()}</div>
            </article>
            <article className="stat-card">
              <div className="stat-card__label">已核銷</div>
              <div className="stat-card__value">{summary.verifiedCount} 張</div>
            </article>
            <article className="stat-card stat-card--unpaid">
              <div className="stat-card__label">待核銷</div>
              <div className="stat-card__value">{summary.pendingCount} 張</div>
            </article>
          </div>

          {summary.byCategory.length > 0 ? (
            <p className="card__hint" style={{ marginBottom: "0.75rem" }}>
              依類別：
              {summary.byCategory.map((c, i) => (
                <span key={c.name}>
                  {i > 0 ? " │ " : " "}
                  {c.name} ${Number(c.totalAmount).toLocaleString()}（{c.count} 筆）
                </span>
              ))}
            </p>
          ) : null}

          <div className="toolbar">
            <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={lines.length === 0}>
              匯出支出 CSV
            </button>
            {linkTo ? (
              <Link className="btn btn--secondary btn--sm" to={linkTo}>
                {linkLabel ?? "查看完整支出"}
              </Link>
            ) : null}
          </div>

          <div className="table-wrap">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>單號</th>
                  <th>公司</th>
                  <th>廠商</th>
                  <th>類別</th>
                  <th>項目</th>
                  <th>客戶</th>
                  <th className="num">金額</th>
                  <th>付款</th>
                  <th>核銷</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l: ExpenseFlatLine) => (
                  <tr key={l.lineId}>
                    <td className="cell-nowrap">{l.expenseDate}</td>
                    <td>{l.voucherNo}</td>
                    <td>{l.companyName}</td>
                    <td>{l.vendorName}</td>
                    <td>{l.categoryName ?? "—"}</td>
                    <td>{l.itemName}</td>
                    <td>{l.customerName ?? "—"}</td>
                    <td className="num">{l.lineAmount}</td>
                    <td>{paymentMethodLabel(l.paymentMethod)}</td>
                    <td>
                      <span className={`badge ${l.status === "verified" ? "badge--completed" : "badge--default"}`}>
                        {statusLabel(l.status)}
                      </span>
                    </td>
                  </tr>
                ))}
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={10}>此區間無支出記錄</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function ExpenseNetHint({ cashReceived, expenseTotal }: { cashReceived: number; expenseTotal: number }) {
  const net = cashReceived - expenseTotal;
  return (
    <p className="card__hint" style={{ marginTop: "0.5rem" }}>
      區間淨額（現收 − 支出）：{" "}
      <strong className={net >= 0 ? "text-success" : "text-danger"}>{net.toLocaleString()}</strong>
    </p>
  );
}

export { TAX_MODE_LABELS };
