import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { billingTypeLabel, todayLocalYmd } from "../adminUtils";

type PatrolCandidate = {
  addressId: string;
  customerId: string;
  customerCode: string | null;
  customerName: string;
  billingType: string;
  addressLabel: string | null;
  addressLine: string;
  patrolWeekday: number;
  patrolWeekdayLabel: string;
  scheduledDeliveryDate: string;
  targetWaterLevel: number | null;
  productId: string;
  productName: string;
  skipReason: string | null;
};

type PreviewData = {
  weekStart: string;
  weekEnd: string;
  total: number;
  creatable: number;
  skipped: number;
  candidates: PatrolCandidate[];
};

type GenerateResult = {
  weekStart: string;
  weekEnd: string;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  created: Array<{ orderNo: string; customerName: string; scheduledDeliveryDate: string }>;
  skipped: PatrolCandidate[];
  errors: Array<{ customerName: string; message: string }>;
};

export default function OrderPatrolGeneratePage() {
  const [weekStart, setWeekStart] = useState(todayLocalYmd());
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);

  const loadPreview = useCallback(async (anchor: string, opts?: { preserveFeedback?: boolean }) => {
    setLoading(true);
    if (!opts?.preserveFeedback) {
      setMessage("");
      setResult(null);
    }
    try {
      const q = encodeURIComponent(anchor);
      const res = await fetch(`/api/sales-orders/patrol-preview?weekStart=${q}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setPreview(null);
        setMessage(payload.message ?? "載入預覽失敗");
        return;
      }
      setPreview(payload.data as PreviewData);
      if (payload.data?.weekStart) setWeekStart(String(payload.data.weekStart));
    } catch {
      setPreview(null);
      setMessage("無法連線 API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview(todayLocalYmd());
  }, [loadPreview]);

  const onGenerate = async () => {
    if (!preview || preview.creatable <= 0) return;
    if (!window.confirm(`將產生 ${preview.creatable} 張巡查單（數量待定、結帳依客戶設定）。確定？`)) return;
    setGenerating(true);
    setMessage("");
    try {
      const res = await fetch("/api/sales-orders/generate-patrol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart: preview.weekStart }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setMessage(payload.message ?? "產生失敗");
        return;
      }
      const data = payload.data as GenerateResult;
      setResult(data);
      setMessage(`已產生 ${data.createdCount} 張；略過 ${data.skippedCount}；失敗 ${data.errorCount}`);
      await loadPreview(preview.weekStart, { preserveFeedback: true });
    } catch {
      setMessage("無法連線 API");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="card">
      <div className="card__head">
        <h2>產生本週巡查單</h2>
        <p className="card__hint">
          依送貨點設定的巡查星期／預設商品開單；數量為 0（現場回報），結帳方式跟客戶主檔（現金／月結／預付扣桶）。
          目標水位寫進備註供司機參考。同點同日已有訂單會自動略過。
        </p>
      </div>

      <div className="form-row-2" style={{ maxWidth: "36rem", marginBottom: "1rem" }}>
        <div className="field">
          <span>週次錨點日（會對齊該週週一～週日）</span>
          <input
            type="date"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
          />
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <span>&nbsp;</span>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={loading || !weekStart}
            onClick={() => void loadPreview(weekStart)}
          >
            {loading ? "載入中…" : "重新預覽"}
          </button>
        </div>
      </div>

      {preview ? (
        <p className="card__hint">
          本週 <strong>{preview.weekStart}</strong>〜<strong>{preview.weekEnd}</strong>
          {" · "}可產生 <strong>{preview.creatable}</strong>
          {" · "}略過 {preview.skipped}
          {" · "}設定總計 {preview.total}
          {preview.creatable === 0 && preview.total > 0 ? (
            <>
              <br />
              目前沒有可新開的巡查單（見下方「狀態」欄）。若要開下週，請把錨點日改到下週任一日期後按「重新預覽」。
            </>
          ) : null}
        </p>
      ) : null}

      <div className="customer-detail-actions" style={{ marginBottom: "1rem", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={generating || loading || !preview || preview.creatable <= 0}
          onClick={() => void onGenerate()}
        >
          {generating ? "產生中…" : `一鍵產生本週巡查單${preview ? `（${preview.creatable}）` : ""}`}
        </button>
        <Link to="/data/customers" className="btn btn--ghost">
          去客戶主檔設定巡查
        </Link>
        <Link to="/orders/assign" className="btn btn--ghost">
          去分配訂單
        </Link>
      </div>

      {message ? (
        <p className={message.includes("失敗") || message.includes("無法") ? "feedback feedback--err" : "feedback feedback--ok"}>
          {message}
        </p>
      ) : null}

      {result && result.created.length > 0 ? (
        <div style={{ marginBottom: "1rem" }}>
          <h3 className="customer-hub__panel-title">剛產生的訂單</h3>
          <ul>
            {result.created.map((r) => (
              <li key={r.orderNo}>
                <span className="mono-text">{r.orderNo}</span> · {r.customerName} · {r.scheduledDeliveryDate}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview && preview.candidates.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>配送日</th>
                <th>星期</th>
                <th>客戶</th>
                <th>結帳</th>
                <th>送貨點</th>
                <th>商品</th>
                <th>目標水位</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {preview.candidates.map((c) => (
                <tr key={`${c.addressId}-${c.scheduledDeliveryDate}`}>
                  <td className="mono-text">{c.scheduledDeliveryDate}</td>
                  <td>{c.patrolWeekdayLabel}</td>
                  <td>
                    {c.customerCode ? <span className="mono-text">{c.customerCode} </span> : null}
                    {c.customerName}
                  </td>
                  <td>{billingTypeLabel(c.billingType)}</td>
                  <td>
                    {c.addressLabel ? `${c.addressLabel} · ` : ""}
                    {c.addressLine}
                  </td>
                  <td>{c.productName}</td>
                  <td className="num">{c.targetWaterLevel != null ? c.targetWaterLevel : "—"}</td>
                  <td>
                    {c.skipReason ? (
                      <span className="text-muted">{c.skipReason}</span>
                    ) : (
                      <span className="badge badge--confirmed">可產生</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading ? (
        <p className="card__hint">本週沒有已設定巡查的送貨點。請至客戶資料 → 送貨地址填寫巡查星期、目標水位、預設商品。</p>
      ) : null}
    </section>
  );
}
