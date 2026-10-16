import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { canAccessOverview, canAccessPath } from "../rolePermissions";
import { setupResponsiveTables } from "../responsiveTables";
import { useTheme, type AdminTheme } from "../ThemeContext";
import { useMediaQuery } from "../useMediaQuery";
import { InterfaceIcon, WaterMark } from "../components/WaterIdentity";

const navGroups: { id: string; title: string; items: { to: string; label: string }[] }[] = [
  {
    id: "orders",
    title: "訂單作業",
    items: [
      { to: "/orders/new", label: "建立訂單" },
      { to: "/orders/assign", label: "分配訂單" },
      { to: "/orders/proxy-report", label: "代登配送回報" },
      { to: "/orders/complete", label: "核銷訂單" },
      { to: "/orders/query", label: "查詢訂單" },
    ],
  },
  {
    id: "barrel-pickup",
    title: "收空桶",
    items: [
      { to: "/orders/barrel-pickup/new", label: "建立收空桶" },
      { to: "/orders/barrel-pickup/settle", label: "核銷收空桶" },
      { to: "/orders/barrel-pickup/query", label: "查詢空桶回收" },
    ],
  },
  {
    id: "service-tickets",
    title: "飲水機服務",
    items: [
      { to: "/orders/service-tickets/new", label: "建立服務單" },
      { to: "/orders/service-tickets", label: "服務單管理" },
    ],
  },
  {
    id: "data",
    title: "主檔資料",
    items: [
      { to: "/data/customers", label: "客戶資料" },
      { to: "/data/legacy-orders", label: "舊系統歷史訂單" },
      { to: "/data/legacy-cutover", label: "切換日開帳" },
      { to: "/data/drivers", label: "司機資料" },
      { to: "/data/products", label: "商品資料" },
      { to: "/data/vehicles", label: "車輛資料" },
      { to: "/data/users", label: "使用者資料" },
    ],
  },
  {
    id: "reports",
    title: "收入與報表",
    items: [
      { to: "/reports/daily", label: "日報表" },
      { to: "/reports/monthly", label: "月報表" },
      { to: "/reports/exceptions", label: "異常中心" },
      { to: "/reports/customer-lifecycle", label: "客戶增減" },
      { to: "/reports/driver-daily", label: "司機日收款核對" },
      { to: "/orders/floor-bonus", label: "司機薪資統計" },
      { to: "/reports/billing-ar", label: "AR 沖帳與稽核" },
      { to: "/reports/tax-invoices", label: "發票查詢與補登" },
    ],
  },
  {
    id: "expenses",
    title: "公司支出",
    items: [
      { to: "/expenses/new", label: "新增支出" },
      { to: "/expenses/query", label: "查詢支出" },
      { to: "/expenses/analytics", label: "支出報表" },
      { to: "/expenses/verify", label: "會計核銷" },
    ],
  },
  {
    id: "print",
    title: "列印與公告",
    items: [
      { to: "/settings/order-print", label: "訂單列印版面" },
      { to: "/settings/print-slogans", label: "套印標語" },
      { to: "/settings/order-announcements", label: "訂單公告" },
    ],
  },
  {
    id: "settings",
    title: "系統設定",
    items: [
      { to: "/settings/promotions", label: "優惠活動設定" },
      { to: "/settings/customer-masters", label: "地址分區與隸屬公司" },
      { to: "/settings/expense-categories", label: "支出類別設定" },
      { to: "/settings/ops", label: "關帳與備份" },
      { to: "/settings/permissions", label: "權限設定" },
    ],
  },
];

const PRINT_SETTING_PATHS = ["/settings/order-print", "/settings/print-slogans", "/settings/order-announcements"];
const SIDEBAR_COLLAPSED_KEY = "watererp.admin.sidebarCollapsed";

function readSidebarCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

const pageMeta = navGroups.flatMap((group) =>
  group.items.map((item) => ({ ...item, groupTitle: group.title })),
);

function groupIdFromPath(pathname: string): string | null {
  if (pathname.startsWith("/orders/barrel-pickup")) return "barrel-pickup";
  if (pathname.startsWith("/orders/service-tickets")) return "service-tickets";
  if (pathname.startsWith("/orders/floor-bonus")) return "reports";
  if (pathname.startsWith("/orders")) return "orders";
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/expenses")) return "expenses";
  if (PRINT_SETTING_PATHS.some((p) => pathname.startsWith(p))) return "print";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}

function navLinkClass(active: boolean, sub?: boolean) {
  return `admin-nav__link${sub ? " admin-nav__link--sub" : ""}${active ? " admin-nav__link--active" : ""}`;
}

function isTabActive(tabId: string, pathname: string, navOpen: boolean) {
  if (tabId === "menu") return navOpen;
  if (tabId === "home") return pathname === "/overview";
  if (tabId === "orders") {
    return pathname.startsWith("/orders") && !pathname.startsWith("/orders/floor-bonus");
  }
  if (tabId === "customers") return pathname.startsWith("/data/customers");
  return false;
}

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const { error } = useDashboard();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const mainRef = useRef<HTMLElement>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set([groupIdFromPath(location.pathname) ?? ""]));
  const [navOpen, setNavOpen] = useState(false);
  const [navQuery, setNavQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  const visibleNavGroups = useMemo(
    () =>
      navGroups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => canAccessPath(user?.role, item.to)),
        }))
        .filter((group) => group.items.length > 0),
    [user?.role],
  );

  const showOverview = canAccessOverview(user?.role);
  const showOrdersTab = canAccessPath(user?.role, "/orders/query");
  const showCustomersTab = canAccessPath(user?.role, "/data/customers");
  const currentPage = useMemo(() => {
    if (location.pathname === "/overview") return { label: "營運總覽", groupTitle: "首頁" };
    return pageMeta.find((item) => location.pathname.startsWith(item.to)) ?? {
      label: "後台管理",
      groupTitle: "營運系統",
    };
  }, [location.pathname]);

  const filteredNavGroups = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return visibleNavGroups;
    return visibleNavGroups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) => item.label.toLowerCase().includes(q) || group.title.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [visibleNavGroups, navQuery]);

  const searching = navQuery.trim().length > 0;
  const showOverviewLink = showOverview && (!searching || "總覽".includes(navQuery.trim().toLowerCase()));

  useEffect(() => {
    setNavOpen(false);
    setNavQuery("");
    const group = groupIdFromPath(location.pathname);
    if (group) setOpenGroups(new Set([group]));
  }, [location.pathname]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isMobile) {
      setNavOpen(false);
      setNavQuery("");
    }
  }, [isMobile]);

  useEffect(() => {
    document.body.classList.toggle("admin-nav-body-lock", isMobile && navOpen);
    return () => document.body.classList.remove("admin-nav-body-lock");
  }, [isMobile, navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const nav = document.getElementById("admin-primary-nav");
    nav?.querySelector<HTMLElement>("button, input, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
      if (event.key === "Tab" && nav) {
        const controls = Array.from(nav.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled)')).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [navOpen]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    return setupResponsiveTables(main);
  }, []);

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.clear();
        next.add(groupId);
      }
      return next;
    });
  };

  const closeNav = () => {
    setNavOpen(false);
    setNavQuery("");
  };

  const openGroupsForRender = searching ? new Set(filteredNavGroups.map((group) => group.id)) : openGroups;

  const mobileTabs = [
    ...(showOverview ? [{ id: "home", to: "/overview", label: "總覽" }] : []),
    ...(showOrdersTab ? [{ id: "orders", to: "/orders/query", label: "訂單" }] : []),
    ...(showCustomersTab ? [{ id: "customers", to: "/data/customers", label: "客戶" }] : []),
    { id: "menu", label: "選單" },
  ];

  const renderNav = (inDrawer: boolean) => (
    <nav
      id="admin-primary-nav"
      className={`admin-nav${inDrawer ? " admin-nav--drawer" : ""}${navOpen ? " admin-nav--open" : ""}`}
      aria-label="後台主要選單"
      aria-hidden={(inDrawer && !navOpen) || (!inDrawer && sidebarCollapsed) ? true : undefined}
      inert={(inDrawer && !navOpen) || (!inDrawer && sidebarCollapsed) ? true : undefined}
    >
      <div className="admin-nav__inner">
        {!inDrawer && <div className="admin-nav__identity"><WaterMark /><div>超好企業<small>營運工作空間</small></div></div>}
        {inDrawer ? (
          <div className="admin-nav__drawer-head">
            <div>
              <p className="admin-nav__drawer-kicker">超好企業進銷存系統</p>
              <strong>{user?.name ?? "使用者"}</strong>
              <span>{user?.employeeCode}</span>
            </div>
            <button type="button" className="admin-nav__drawer-close" aria-label="關閉選單" onClick={closeNav}>
              ×
            </button>
          </div>
        ) : null}

        <label className="admin-nav__search">
            <span className="sr-only">搜尋功能</span>
            <InterfaceIcon name="search" />
            <input
              type="search"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              placeholder="搜尋功能，例如：查詢訂單"
              enterKeyHint="search"
            />
        </label>

        {showOverviewLink ? (
          <NavLink to="/overview" end className={({ isActive }) => navLinkClass(isActive, false)} onClick={closeNav}>
            <InterfaceIcon name="overview" /> 營運總覽
          </NavLink>
        ) : null}

        {filteredNavGroups.map((g) => {
          const routeActive = groupIdFromPath(location.pathname) === g.id;
          const isOpen = openGroupsForRender.has(g.id);

          return (
            <div key={g.id} className={`admin-nav__accordion admin-nav__accordion--${g.id}`}>
              <button
                type="button"
                className={`admin-nav__accordion-head${isOpen ? " admin-nav__accordion-head--open" : ""}${routeActive ? " admin-nav__accordion-head--route-active" : ""}`}
                aria-expanded={isOpen}
                aria-controls={`nav-panel-${g.id}`}
                onClick={() => toggleGroup(g.id)}
              >
                <span className="admin-nav__accordion-title"><InterfaceIcon name={g.id} />{g.title}</span>
                <span className={`admin-nav__chevron${isOpen ? " admin-nav__chevron--open" : ""}`} aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>

              <div
                id={`nav-panel-${g.id}`}
                role="region"
                aria-label={g.title}
                hidden={!isOpen}
                className={`admin-nav__collapse${isOpen ? " admin-nav__collapse--open" : ""}`}
              >
                <div className="admin-nav__collapse-inner">
                  <div className="admin-nav__sublist">
                    {g.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end
                        className={({ isActive }) => `admin-nav__sublink${isActive ? " admin-nav__sublink--active" : ""}`}
                        onClick={closeNav}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {searching && filteredNavGroups.length === 0 && !showOverviewLink ? (
          <p className="admin-nav__empty">找不到符合的功能</p>
        ) : null}

        {inDrawer ? (
          <div className="admin-nav__drawer-foot">
            <div className="theme-switch" role="group" aria-label="配色版本">
              {(["light", "dark"] as AdminTheme[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`theme-switch__option${theme === option ? " theme-switch__option--active" : ""}`}
                  onClick={() => setTheme(option)}
                  aria-pressed={theme === option}
                >
                  {option === "light" ? "淺色" : "暗色"}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--secondary" onClick={logout}>
              登出
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  );

  return (
    <div className={`admin-app${isMobile ? " admin-app--mobile" : ""}${!isMobile && sidebarCollapsed ? " admin-app--nav-collapsed" : ""}`}>
      <a className="admin-skip-link" href="#admin-content">跳至主要內容</a>
      <header className="admin-header">
        <div className="admin-header__inner">
          <div className="admin-header__brand-block">
            <button
              type="button"
              className={`admin-header__menu-btn${(isMobile ? navOpen : !sidebarCollapsed) ? " admin-header__menu-btn--open" : ""}`}
              aria-label={isMobile ? (navOpen ? "關閉選單" : "開啟選單") : sidebarCollapsed ? "開啟選單" : "關閉選單"}
              aria-expanded={isMobile ? navOpen : !sidebarCollapsed}
              aria-controls="admin-primary-nav"
              onClick={() => {
                if (isMobile) setNavOpen((open) => !open);
                else setSidebarCollapsed((collapsed) => !collapsed);
              }}
            >
              <span className="admin-header__menu-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>
            <div className="admin-header__titles">
              {isMobile ? (
                <>
                  <p className="admin-header__section">{currentPage.groupTitle}</p>
                  <h1 className="admin-brand">{currentPage.label}</h1>
                </>
              ) : (
                <>
                  <h1 className="admin-brand">超好企業<span className="admin-brand__suffix">營運管理</span></h1>
                  <p className="admin-tagline">WATER ERP · EVERY DROP, CONNECTED.</p>
                </>
              )}
            </div>
          </div>
          {!isMobile ? (
            <div className="admin-header__meta">
              <div className="theme-switch" role="group" aria-label="配色版本">
                {(["light", "dark"] as AdminTheme[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`theme-switch__option${theme === option ? " theme-switch__option--active" : ""}`}
                    onClick={() => setTheme(option)}
                    aria-pressed={theme === option}
                  >
                    {option === "light" ? "淺色" : "暗色"}
                  </button>
                ))}
              </div>
              <span className="pill pill--subtle admin-header__user-pill">
                {user?.name ?? "使用者"} · {user?.employeeCode}
              </span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={logout}>
                登出
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="admin-shell">
        {isMobile && navOpen ? (
          <button type="button" className="admin-nav-backdrop" aria-label="關閉選單" onClick={closeNav} />
        ) : null}

        {renderNav(isMobile)}

        <main className="admin-main" id="admin-content" tabIndex={-1} ref={mainRef} inert={isMobile && navOpen ? true : undefined}>
          {error ? <div className="alert alert--error">{error}</div> : null}
          <div className="admin-page-heading">
            <div>
              <div className="admin-page-heading__crumb">
                <span>超好企業</span>
                <span aria-hidden="true">/</span>
                <span>{currentPage.groupTitle}</span>
              </div>
              <h2>{currentPage.label}</h2>
            </div>
            <div className="admin-page-heading__date" aria-label="今天日期">
              <span>今天</span>
              <strong>
                {new Intl.DateTimeFormat("zh-TW", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  weekday: "short",
                }).format(new Date())}
              </strong>
            </div>
          </div>
          <Suspense fallback={<div className="card" role="status">載入頁面中…</div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {isMobile ? (
        <nav className="admin-tabbar" aria-label="手機快捷選單">
          {mobileTabs.map((tab) => {
            const active = isTabActive(tab.id, location.pathname, navOpen);
            if (tab.id === "menu" || !tab.to) {
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`admin-tabbar__item${active ? " admin-tabbar__item--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setNavOpen((open) => !open)}
                >
                  <TabIcon name="menu" />
                  <span>{tab.label}</span>
                </button>
              );
            }
            return (
              <NavLink
                key={tab.id}
                to={tab.to}
                className={`admin-tabbar__item${active ? " admin-tabbar__item--active" : ""}`}
                onClick={closeNav}
              >
                <TabIcon name={tab.id} />
                <span>{tab.label}</span>
              </NavLink>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}

function TabIcon({ name }: { name: string }) {
  if (name === "home") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 10.5 12 4.5l7.5 6V20a1 1 0 0 1-1 1h-4.2v-6.2h-4.6V21H5.5a1 1 0 0 1-1-1z" />
      </svg>
    );
  }
  if (name === "orders") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v13.2L12 16.4 5.5 19.2V6A1.5 1.5 0 0 1 7 4.5Zm1.6 4h6.8v1.5H8.6V8.5Zm0 3.2h4.8v1.5H8.6v-1.5Z" />
      </svg>
    );
  }
  if (name === "customers") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 12.2a3.4 3.4 0 1 0-3.4-3.4A3.4 3.4 0 0 0 12 12.2Zm0 1.6c3.3 0 7.5 1.7 7.5 4.2V20H4.5v-2c0-2.5 4.2-4.2 7.5-4.2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.2h14v1.8H5V6.2Zm0 4.9h14v1.8H5v-1.8Zm0 4.9h14V18H5v-1.9Z" />
    </svg>
  );
}
