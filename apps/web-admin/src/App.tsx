import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import "./admin-ui.css";
import "./admin-mobile.css";
import { AuthProvider, useAuth } from "./AuthContext";
import { DashboardProvider } from "./DashboardContext";
import { ThemeProvider } from "./ThemeContext";
import AdminLayout from "./layout/AdminLayout";
import LoginPage from "./pages/LoginPage";
import OverviewPage from "./pages/OverviewPage";
import OrderCreatePage from "./pages/OrderCreatePage";
import OrderAssignPage from "./pages/OrderAssignPage";
import OrderCompletePage from "./pages/OrderCompletePage";
import OrderProxyReportPage from "./pages/OrderProxyReportPage";
import OrderQueryPage from "./pages/OrderQueryPage";
import ServiceTicketsPage from "./pages/ServiceTicketsPage";
import BarrelPickupNewPage from "./pages/BarrelPickupNewPage";
import BarrelPickupSettlePage from "./pages/BarrelPickupSettlePage";
import BarrelPickupQueryPage from "./pages/BarrelPickupQueryPage";
import DataCustomersPage from "./pages/DataCustomersPage";
import DataDriversPage from "./pages/DataDriversPage";
import DataProductsPage from "./pages/DataProductsPage";
import DataVehiclesPage from "./pages/DataVehiclesPage";
import DataUsersPage from "./pages/DataUsersPage";
import SettingsExpenseCategoriesPage from "./pages/SettingsExpenseCategoriesPage";
import FloorDeliveryBonusQueryPage from "./pages/FloorDeliveryBonusQueryPage";

const ReportDailyPage = lazy(() => import("./pages/ReportDailyPage"));
const ReportMonthlyPage = lazy(() => import("./pages/ReportMonthlyPage"));
const ReportExceptionCenterPage = lazy(() => import("./pages/ReportExceptionCenterPage"));
const ReportCustomerLifecyclePage = lazy(() => import("./pages/ReportCustomerLifecyclePage"));
const DriverDailyCollectionReportPage = lazy(() => import("./pages/DriverDailyCollectionReportPage"));
const BillingArPage = lazy(() => import("./pages/BillingArPage"));
const TaxInvoiceQueryPage = lazy(() => import("./pages/TaxInvoiceQueryPage"));
const SettingsPromotionsPage = lazy(() => import("./pages/SettingsPromotionsPage"));
const SettingsPermissionsPage = lazy(() => import("./pages/SettingsPermissionsPage"));
const SettingsOrderPrintPage = lazy(() => import("./pages/SettingsOrderPrintPage"));
const SettingsCustomerMastersPage = lazy(() => import("./pages/SettingsCustomerMastersPage"));
const SettingsPrintSlogansPage = lazy(() => import("./pages/SettingsPrintSlogansPage"));
const SettingsOrderAnnouncementsPage = lazy(() => import("./pages/SettingsOrderAnnouncementsPage"));
const SettingsOpsPage = lazy(() => import("./pages/SettingsOpsPage"));
const ExpenseNewPage = lazy(() => import("./pages/ExpenseNewPage"));
const ExpenseQueryPage = lazy(() => import("./pages/ExpenseQueryPage"));
const ExpenseAnalyticsPage = lazy(() => import("./pages/ExpenseAnalyticsPage"));
const ExpenseVerifyPage = lazy(() => import("./pages/ExpenseVerifyPage"));

function LazyFallback() {
  return (
    <div className="card">
      <p className="card__hint">載入頁面中…</p>
    </div>
  );
}
function ProtectedShell() {
  const { user, loading } = useAuth();
  if (loading) return <div className="login-shell"><div className="login-panel">登入狀態確認中…</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <DashboardProvider>
      <Suspense fallback={<LazyFallback />}>
        <AdminLayout />
      </Suspense>
    </DashboardProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<ProtectedShell />}>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="overview" element={<OverviewPage />} />

              <Route path="orders" element={<Navigate to="/orders/new" replace />} />
              <Route path="orders/new" element={<OrderCreatePage />} />
              <Route path="orders/patrol" element={<Navigate to="/orders/new?tab=patrol" replace />} />
              <Route path="orders/liff-review" element={<Navigate to="/orders/new?tab=liff" replace />} />
              <Route path="orders/assign" element={<OrderAssignPage />} />
              <Route path="orders/assignment-status" element={<Navigate to="/orders/assign?tab=status" replace />} />
              <Route path="orders/proxy-report" element={<OrderProxyReportPage />} />
              <Route path="orders/complete" element={<OrderCompletePage />} />
              <Route path="orders/floor-bonus" element={<FloorDeliveryBonusQueryPage />} />
              <Route path="orders/barrel-pickup/new" element={<BarrelPickupNewPage />} />
              <Route path="orders/barrel-pickup/settle" element={<BarrelPickupSettlePage />} />
              <Route path="orders/barrel-pickup/query" element={<BarrelPickupQueryPage />} />
              <Route path="orders/service-tickets" element={<ServiceTicketsPage />} />
              <Route path="orders/query" element={<OrderQueryPage />} />
              <Route path="data" element={<Navigate to="/data/customers" replace />} />
              <Route path="data/customers" element={<DataCustomersPage />} />
              <Route path="data/drivers" element={<DataDriversPage />} />
              <Route path="data/products" element={<DataProductsPage />} />
              <Route path="data/vehicles" element={<DataVehiclesPage />} />
              <Route path="data/users" element={<DataUsersPage />} />

              <Route path="expenses" element={<Navigate to="/expenses/new" replace />} />
              <Route path="expenses/new" element={<ExpenseNewPage />} />
              <Route path="expenses/edit/:voucherId" element={<ExpenseNewPage />} />
              <Route path="expenses/query" element={<ExpenseQueryPage />} />
              <Route path="expenses/analytics" element={<ExpenseAnalyticsPage />} />
              <Route path="expenses/today" element={<Navigate to="/expenses/analytics" replace />} />
              <Route path="expenses/reports" element={<Navigate to="/expenses/analytics?tab=monthly" replace />} />
              <Route path="expenses/verify" element={<ExpenseVerifyPage />} />

              <Route path="reports" element={<Navigate to="/reports/daily" replace />} />
              <Route path="reports/daily" element={<ReportDailyPage />} />
              <Route path="reports/monthly" element={<ReportMonthlyPage />} />
              <Route path="reports/exceptions" element={<ReportExceptionCenterPage />} />
              <Route path="reports/customer-lifecycle" element={<ReportCustomerLifecyclePage />} />
              <Route path="reports/driver-daily" element={<DriverDailyCollectionReportPage />} />
              <Route path="reports/billing-ar" element={<BillingArPage />} />
              <Route path="reports/tax-invoices" element={<TaxInvoiceQueryPage />} />
              <Route path="reports/billing-monthly" element={<Navigate to="/reports/billing-ar" replace />} />

              <Route path="settings" element={<Navigate to="/settings/promotions" replace />} />
              <Route path="settings/promotions" element={<SettingsPromotionsPage />} />
              <Route path="settings/permissions" element={<SettingsPermissionsPage />} />
              <Route path="settings/order-print" element={<SettingsOrderPrintPage />} />
              <Route path="settings/print-slogans" element={<SettingsPrintSlogansPage />} />
              <Route path="settings/order-announcements" element={<SettingsOrderAnnouncementsPage />} />
              <Route path="settings/customer-masters" element={<SettingsCustomerMastersPage />} />
              <Route path="settings/expense-categories" element={<SettingsExpenseCategoriesPage />} />
              <Route path="settings/ops" element={<SettingsOpsPage />} />

              {/* 舊路徑導向新結構 */}
              <Route path="masters" element={<Navigate to="/data/customers" replace />} />
              <Route path="products" element={<Navigate to="/data/products" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
