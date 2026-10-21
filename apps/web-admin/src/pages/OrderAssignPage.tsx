import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AssignmentStatusPanel from "./OrderAssignmentStatusPage";
import AiSuggestAssignPanel from "../components/AiSuggestAssignPanel";
import DriverAssignmentLookupPanel from "./DriverAssignmentLookupPanel";

type PageTab = "status" | "assign" | "ai";

export default function OrderAssignPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/delivery-planning/status")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ ok?: boolean; data?: { enabled?: boolean } }>;
      })
      .then((j) => {
        if (!cancelled && j?.data?.enabled) setAiEnabled(true);
      })
      .catch(() => {
        /* flag 關或未部署時維持 false */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pageTab: PageTab = useMemo(() => {
    const t = searchParams.get("tab");
    if (t === "ai" && aiEnabled) return "ai";
    if (t === "assign" || t === "status") return t;
    return "status";
  }, [searchParams, aiEnabled]);

  const setPageTab = useCallback(
    (tab: PageTab) => {
      setSearchParams({ tab });
    },
    [setSearchParams],
  );

  const dispatchChrome = pageTab === "status" || pageTab === "assign";

  return (
    <section className={`card order-new-page order-new-page--pro order-assign-page${dispatchChrome ? " dispatch-view" : ""}`}>
      <header className="order-new__hero">
        <div className="order-new__hero-top">
          <div className="order-new__hero-titles">
            <span className="order-new__badge">訂單作業</span>
            <h2 className="order-new__page-title">分配訂單</h2>
          </div>
        </div>
        <p className="order-new__hero-lead">
          {pageTab === "status"
            ? "左側勾選待派訂單，右側查看司機任務與額度；支援批次指派及拖放操作。"
            : pageTab === "ai"
              ? "選班別、確認出勤與跑區，勾選訂單後一鍵排班；確認發布才寫入正式派單。"
              : "選擇日期與司機，查看該日已分配給這位司機的訂單。"}
        </p>
        <nav className="order-assign-tabs" role="tablist" aria-label="分配訂單分頁">
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === "status"}
            className={`order-assign-tabs__btn${pageTab === "status" ? " order-assign-tabs__btn--active" : ""}`}
            onClick={() => setPageTab("status")}
          >
            分派狀態
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === "assign"}
            className={`order-assign-tabs__btn${pageTab === "assign" ? " order-assign-tabs__btn--active" : ""}`}
            onClick={() => setPageTab("assign")}
          >
            派單查詢
          </button>
          {aiEnabled ? (
            <button
              type="button"
              role="tab"
              aria-selected={pageTab === "ai"}
              className={`order-assign-tabs__btn${pageTab === "ai" ? " order-assign-tabs__btn--active" : ""}`}
              onClick={() => setPageTab("ai")}
            >
              班次排程
            </button>
          ) : null}
        </nav>
      </header>

      {pageTab === "status" ? (
        <AssignmentStatusPanel />
      ) : pageTab === "ai" ? (
        <AiSuggestAssignPanel />
      ) : (
        <DriverAssignmentLookupPanel />
      )}
    </section>
  );
}
