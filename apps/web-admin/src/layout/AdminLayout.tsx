import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useDashboard } from "../DashboardContext";
import { useTheme, type AdminTheme } from "../ThemeContext";

const navGroups: { id: string; title: string; items: { to: string; label: string }[] }[] = [
  {
    id: "orders",
    title: "訂單資料",
    items: [
      { to: "/orders/new", label: "新增訂單" },
      { to: "/orders/assign", label: "分配訂單" },
      { to: "/orders/proxy-report", label: "代登配送回報" },
      { to: "/orders/complete", label: "核銷訂單" },
      { to: "/orders/floor-bonus", label: "搬運獎金查詢" },
      { to: "/orders/query", label: "查詢訂單" },
      { to: "/orders/edit", label: "修改訂單" },
    ],
  },
  {
    id: "barrel-pickup",
    title: "收空桶",
    items: [
      { to: "/orders/barrel-pickup/new", label: "建立收空桶" },
      { to: "/orders/barrel-pickup/settle", label: "核銷收空桶" },
      { to: "/orders/barrel-pickup/query", label: "查詢收空桶" },
    ],
  },
  {
    id: "data",
    title: "資料庫",
    items: [
      { to: "/data/customers", label: "客戶資料" },
      { to: "/data/drivers", label: "司機資料" },
      { to: "/data/products", label: "商品資料" },
      { to: "/data/vehicles", label: "車輛資料" },
      { to: "/data/users", label: "使用者資料" },
    ],
  },
  {
    id: "expenses",
    title: "公司支出",
    items: [
      { to: "/expenses/new", label: "新增支出" },
      { to: "/expenses/query", label: "查詢支出" },
      { to: "/expenses/today", label: "支出統計" },
      { to: "/expenses/verify", label: "會計核銷" },
      { to: "/expenses/reports", label: "支出報表" },
    ],
  },
  {
    id: "reports",
    title: "會計報表",
    items: [
      { to: "/reports/daily", label: "日報表" },
      { to: "/reports/monthly", label: "月報表" },
      { to: "/reports/driver-daily", label: "司機日收款核對" },
      { to: "/reports/billing-ar", label: "AR 沖帳與稽核" },
      { to: "/reports/tax-invoices", label: "發票查詢與補登" },
    ],
  },
  {
    id: "settings",
    title: "系統設定",
    items: [
      { to: "/settings/promotions", label: "優惠活動設定" },
      { to: "/settings/permissions", label: "權限設定" },
      { to: "/settings/order-print", label: "訂單列印版面" },
      { to: "/settings/order-announcements", label: "訂單公告" },
      { to: "/settings/print-slogans", label: "套印標語" },
      { to: "/settings/customer-masters", label: "地址分區與隸屬公司" },
      { to: "/settings/expense-categories", label: "支出類別設定" },
    ],
  },
];

function groupIdFromPath(pathname: string): string | null {
  if (pathname.startsWith("/orders/barrel-pickup")) return "barrel-pickup";
  if (pathname.startsWith("/orders")) return "orders";
  if (pathname.startsWith("/expenses")) return "expenses";
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}

function navLinkClass(active: boolean, sub?: boolean) {
  return `admin-nav__link${sub ? " admin-nav__link--sub" : ""}${active ? " admin-nav__link--active" : ""}`;
}

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const { error } = useDashboard();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const activeId = groupIdFromPath(location.pathname);
    setOpenGroups(activeId ? new Set([activeId]) : new Set());
  }, [location.pathname]);

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

  return (
    <div className="admin-app">
      <header className="admin-header">
        <div className="admin-header__inner">
          <div>
            <h1 className="admin-brand">WaterERP</h1>
            <p className="admin-tagline">營運後台 · 訂單、資料庫、會計報表與系統設定</p>
          </div>
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
            <span className="pill pill--subtle">{user?.name ?? "使用者"} · {user?.employeeCode}</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={logout}>
              登出
            </button>
          </div>
        </div>
      </header>

      <div className="admin-shell">
        <nav className="admin-nav" aria-label="後台主要選單">
          <p className="admin-nav__section">功能選單</p>
          <div className="admin-nav__inner">
            <NavLink to="/overview" end className={({ isActive }) => navLinkClass(isActive, false)}>
              總覽
            </NavLink>

            {navGroups.map((g) => {
              const routeActive = groupIdFromPath(location.pathname) === g.id;
              const isOpen = openGroups.has(g.id);

              return (
                <div key={g.id} className={`admin-nav__accordion admin-nav__accordion--${g.id}`}>
                  <button
                    type="button"
                    className={`admin-nav__accordion-head${isOpen ? " admin-nav__accordion-head--open" : ""}${routeActive ? " admin-nav__accordion-head--route-active" : ""}`}
                    aria-expanded={isOpen}
                    aria-controls={`nav-panel-${g.id}`}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <span className="admin-nav__accordion-title">{g.title}</span>
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
                            className={({ isActive }) => `admin-nav__sublink${isActive ? " admin-nav__sublink--active" : ""}`}
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
          </div>
        </nav>

        <main className="admin-main">
          {error ? <div className="alert alert--error">{error}</div> : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
