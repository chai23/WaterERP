import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import OrderNewPage from "./OrderNewPage";
import { OrderPatrolGeneratePanel } from "./OrderPatrolGeneratePage";
import { OrderLiffReviewPanel } from "./OrderLiffReviewPage";

type PageTab = "new" | "patrol" | "liff";

const TAB_LEAD: Record<PageTab, string> = {
  new: "搜尋客戶與送貨點，再填寫商品與配送資訊。可用客戶編號、電話或名稱搜尋，雙擊歷史訂單帶入商品。",
  patrol:
    "依送貨點巡查頻率與星期開單；數量為 0（現場回報），結帳方式跟客戶主檔。同點同日已有訂單、本週或更早的未完成一般訂單、或配送日已過會略過；兩週以上只在巡查週產生。",
  liff: "客戶自 LINE 下單後會先進入待確認，請核對客戶、地址與品項後再確認或駁回。一般訂水確認後可至分配訂單派車。",
};

export default function OrderCreatePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const pageTab: PageTab = useMemo(() => {
    const t = searchParams.get("tab");
    if (t === "patrol" || t === "liff" || t === "new") return t;
    return "new";
  }, [searchParams]);

  const setPageTab = useCallback(
    (tab: PageTab) => {
      if (tab === "new") {
        setSearchParams({});
        return;
      }
      setSearchParams({ tab });
    },
    [setSearchParams],
  );

  return (
    <section className={`card order-new-page order-new-page--pro order-create-page${pageTab === "new" ? " order-create-compact" : ""}`}>
      <header className="order-new__hero">
        <div className="order-new__hero-top">
          <div className="order-new__hero-titles">
            <h2 className="order-new__page-title">{pageTab === "new" ? "新增訂單" : pageTab === "patrol" ? "產生巡查單" : "確認 LINE 訂單"}</h2>
          </div>
        </div>
        <p className="order-new__hero-lead">{TAB_LEAD[pageTab]}</p>
        <nav className="order-assign-tabs" role="tablist" aria-label="建立訂單分頁">
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === "new"}
            className={`order-assign-tabs__btn${pageTab === "new" ? " order-assign-tabs__btn--active" : ""}`}
            onClick={() => setPageTab("new")}
          >
            新增訂單
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === "patrol"}
            className={`order-assign-tabs__btn${pageTab === "patrol" ? " order-assign-tabs__btn--active" : ""}`}
            onClick={() => setPageTab("patrol")}
          >
            產生巡查單
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === "liff"}
            className={`order-assign-tabs__btn${pageTab === "liff" ? " order-assign-tabs__btn--active" : ""}`}
            onClick={() => setPageTab("liff")}
          >
            確認 LINE 訂單
          </button>
        </nav>
      </header>

      {pageTab === "new" ? (
        <OrderNewPage embedded />
      ) : pageTab === "patrol" ? (
        <OrderPatrolGeneratePanel />
      ) : (
        <OrderLiffReviewPanel />
      )}
    </section>
  );
}
