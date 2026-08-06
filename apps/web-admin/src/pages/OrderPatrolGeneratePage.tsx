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
  blockingOrderNo: string | null;
  blockingOrderDate: string | null;
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

/** 產生巡查單內容區（供建立訂單分頁嵌入） */
export function OrderPatrolGeneratePanel() {
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

  const feedbackClass =
    message.includes("失敗") || message.includes("無法") ? "feedback feedback--err" : "feedback feedback--ok";

  return (
    <div className="order-new__form order-new__form--layout order-create-panel">
      <section className="order-new__zone order-new__zone--tools" aria-labelledby="order-patrol-zone-tools-title">
        <header className="order-new__zone-head">
          <span className="order-new__zone-index" aria-hidden="true">
            1
          </span>
          <div className="order-new__zone-head-text">
            <p className="order-new__zone-eyebrow">選擇 · 預覽</p>
            <h3 id="order-patrol-zone-tools-title" className="order-new__zone-title">
              週次與產生
            </h3>
          </div>
        </header>
        <div className="order-new__zone-body">
          <div className="order-create-panel__week-row">
            <div className="field order-create-panel__week-field">
              <label htmlFor="order-patrol-week-start">週次錨點日</label>
              <input
                id="order-patrol-week-start"
                type="date"
                value={weekStart}
                onChange={(e) => setWeekStart(e.target.value)}
              />
              <p className="order-create-panel__field-hint">會對齊該週週一～週日</p>
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={loading || !weekStart}
              onClick={() => void loadPreview(weekStart)}
            >
              {loading ? "載入中…" : "重新預覽"}
            </button>
          </div>

          {preview ? (
            <>
              <div className="order-create-panel__week-chip" aria-live="polite">
                本週 <strong>{preview.weekStart}</strong>
                <span aria-hidden="true">〜</span>
                <strong>{preview.weekEnd}</strong>
              </div>
              <div className="order-create-panel__stats" role="group" aria-label="本週預覽統計">
                <div className="order-create-panel__stat order-create-panel__stat--accent">
                  <span className="order-create-panel__stat-value">{preview.creatable}</span>
                  <span className="order-create-panel__stat-label">可產生</span>
                </div>
                <div className="order-create-panel__stat">
                  <span className="order-create-panel__stat-value">{preview.skipped}</span>
                  <span className="order-create-panel__stat-label">略過</span>
                </div>
                <div className="order-create-panel__stat">
                  <span className="order-create-panel__stat-value">{preview.total}</span>
                  <span className="order-create-panel__stat-label">設定總計</span>
                </div>
              </div>
              {preview.creatable === 0 && preview.total > 0 ? (
                <p className="order-create-panel__note">
                  目前沒有可新開的巡查單（見下方「狀態」欄）。同送貨點若有未完成訂單會先略過；若要開下週，請把錨點日改到下週任一日期後按「重新預覽」。
                </p>
              ) : null}
            </>
          ) : null}

          <div className="order-create-panel__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={generating || loading || !preview || preview.creatable <= 0}
              onClick={() => void onGenerate()}
            >
              {generating ? "產生中…" : `一鍵產生本週巡查單${preview ? `（${preview.creatable}）` : ""}`}
            </button>
            <Link to="/data/customers" className="btn btn--ghost btn--sm">
              客戶主檔設定巡查
            </Link>
            <Link to="/orders/assign" className="btn btn--ghost btn--sm">
              去分配訂單
            </Link>
          </div>

          {message ? <p className={feedbackClass}>{message}</p> : null}

          {result && result.created.length > 0 ? (
            <div className="order-create-panel__created">
              <p className="order-new__tool-section-label">剛產生的訂單</p>
              <ul className="order-create-panel__created-list">
                {result.created.map((r) => (
                  <li key={r.orderNo}>
                    <span className="mono-text">{r.orderNo}</span>
                    <span>{r.customerName}</span>
                    <span className="text-muted">{r.scheduledDeliveryDate}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="order-new__zone order-new__zone--lines" aria-labelledby="order-patrol-zone-list-title">
        <header className="order-new__zone-head">
          <span className="order-new__zone-index order-new__zone-index--slate" aria-hidden="true">
            2
          </span>
          <div className="order-new__zone-head-text">
            <p className="order-new__zone-eyebrow">預覽清單</p>
            <div className="order-new__lines-title-row">
              <h3 id="order-patrol-zone-list-title" className="order-new__zone-title">
                本週候選
              </h3>
              {preview ? (
                <span className="order-new__zone-tag">{preview.candidates.length} 筆</span>
              ) : null}
            </div>
          </div>
        </header>
        <div className="order-new__zone-body order-new__zone-body--lines">
          {preview && preview.candidates.length > 0 ? (
            <div className="table-wrap order-create-panel__table-wrap">
              <table className="data-table data-table--compact order-create-panel__table">
                <thead>
                  <tr>
                    <th>配送日</th>
                    <th>客戶／送貨點</th>
                    <th>結帳</th>
                    <th>商品</th>
                    <th className="num">目標水位</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.candidates.map((c) => (
                    <tr key={`${c.addressId}-${c.scheduledDeliveryDate}`}>
                      <td className="order-create-panel__cell-date">
                        <span className="mono-text">{c.scheduledDeliveryDate}</span>
                        <span className="order-create-panel__sub">{c.patrolWeekdayLabel}</span>
                      </td>
                      <td className="order-create-panel__cell-customer">
                        <div className="order-create-panel__cust-name">
                          {c.customerCode ? <span className="mono-text order-create-panel__cust-code">{c.customerCode}</span> : null}
                          <span>{c.customerName}</span>
                        </div>
                        <div className="order-create-panel__sub">
                          {c.addressLabel ? `${c.addressLabel} · ` : ""}
                          {c.addressLine}
                        </div>
                      </td>
                      <td>{billingTypeLabel(c.billingType)}</td>
                      <td>{c.productName}</td>
                      <td className="num">{c.targetWaterLevel != null ? c.targetWaterLevel : "—"}</td>
                      <td>
                        {c.skipReason ? (
                          <span className="text-muted order-create-panel__skip">{c.skipReason}</span>
                        ) : (
                          <span className="badge badge--confirmed">可產生</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : loading ? (
            <p className="text-muted" style={{ margin: 0 }}>
              載入預覽中…
            </p>
          ) : (
            <div className="order-new__empty-state">
              <p className="order-new__empty-state-title">本週沒有已設定巡查的送貨點</p>
              <p className="order-new__empty-state-desc">
                請至客戶資料 → 送貨地址填寫巡查星期、目標水位、預設商品。
              </p>
              <Link to="/data/customers" className="btn btn--secondary btn--sm">
                去客戶主檔
              </Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function OrderPatrolGeneratePage() {
  return <OrderPatrolGeneratePanel />;
}
