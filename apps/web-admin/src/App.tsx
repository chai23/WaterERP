import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./admin-ui.css";
import { AuthProvider, useAuth } from "./AuthContext";
import { DashboardProvider } from "./DashboardContext";
import { ThemeProvider } from "./ThemeContext";
import AdminLayout from "./layout/AdminLayout";
import LoginPage from "./pages/LoginPage";
import OverviewPage from "./pages/OverviewPage";
import OrderNewPage from "./pages/OrderNewPage";
import OrderAssignPage from "./pages/OrderAssignPage";
import OrderCompletePage from "./pages/OrderCompletePage";
import OrderProxyReportPage from "./pages/OrderProxyReportPage";
import OrderQueryPage from "./pages/OrderQueryPage";
import OrderEditPage from "./pages/OrderEditPage";
import BarrelPickupNewPage from "./pages/BarrelPickupNewPage";
import BarrelPickupSettlePage from "./pages/BarrelPickupSettlePage";
import BarrelPickupQueryPage from "./pages/BarrelPickupQueryPage";
import DataCustomersPage from "./pages/DataCustomersPage";
import DataDriversPage from "./pages/DataDriversPage";
import DataProductsPage from "./pages/DataProductsPage";
import DataVehiclesPage from "./pages/DataVehiclesPage";
import DataUsersPage from "./pages/DataUsersPage";
import ReportDailyPage from "./pages/ReportDailyPage";
import ReportMonthlyPage from "./pages/ReportMonthlyPage";
import BillingArPage from "./pages/BillingArPage";
import SettingsPromotionsPage from "./pages/SettingsPromotionsPage";
import SettingsPermissionsPage from "./pages/SettingsPermissionsPage";
import SettingsOrderPrintPage from "./pages/SettingsOrderPrintPage";
import SettingsCustomerMastersPage from "./pages/SettingsCustomerMastersPage";
import SettingsPrintSlogansPage from "./pages/SettingsPrintSlogansPage";
import SettingsOrderAnnouncementsPage from "./pages/SettingsOrderAnnouncementsPage";
import ExpenseNewPage from "./pages/ExpenseNewPage";
import ExpenseQueryPage from "./pages/ExpenseQueryPage";
import ExpenseTodayPage from "./pages/ExpenseTodayPage";
import ExpenseVerifyPage from "./pages/ExpenseVerifyPage";
import ExpenseReportsPage from "./pages/ExpenseReportsPage";
import SettingsExpenseCategoriesPage from "./pages/SettingsExpenseCategoriesPage";

function ProtectedShell() {
  const { user, loading } = useAuth();
  if (loading) return <div className="login-shell"><div className="login-panel">登入狀態確認中…</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <DashboardProvider>
      <AdminLayout />
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
              <Route path="orders/new" element={<OrderNewPage />} />
              <Route path="orders/assign" element={<OrderAssignPage />} />
              <Route path="orders/proxy-report" element={<OrderProxyReportPage />} />
              <Route path="orders/complete" element={<OrderCompletePage />} />
              <Route path="orders/barrel-pickup/new" element={<BarrelPickupNewPage />} />
              <Route path="orders/barrel-pickup/settle" element={<BarrelPickupSettlePage />} />
              <Route path="orders/barrel-pickup/query" element={<BarrelPickupQueryPage />} />
              <Route path="orders/query" element={<OrderQueryPage />} />
              <Route path="orders/edit" element={<OrderEditPage />} />

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
              <Route path="expenses/today" element={<ExpenseTodayPage />} />
              <Route path="expenses/verify" element={<ExpenseVerifyPage />} />
              <Route path="expenses/reports" element={<ExpenseReportsPage />} />

              <Route path="reports" element={<Navigate to="/reports/daily" replace />} />
              <Route path="reports/daily" element={<ReportDailyPage />} />
              <Route path="reports/monthly" element={<ReportMonthlyPage />} />
              <Route path="reports/billing-ar" element={<BillingArPage />} />
              <Route path="reports/billing-monthly" element={<Navigate to="/reports/billing-ar" replace />} />

              <Route path="settings" element={<Navigate to="/settings/promotions" replace />} />
              <Route path="settings/promotions" element={<SettingsPromotionsPage />} />
              <Route path="settings/permissions" element={<SettingsPermissionsPage />} />
              <Route path="settings/order-print" element={<SettingsOrderPrintPage />} />
              <Route path="settings/print-slogans" element={<SettingsPrintSlogansPage />} />
              <Route path="settings/order-announcements" element={<SettingsOrderAnnouncementsPage />} />
              <Route path="settings/customer-masters" element={<SettingsCustomerMastersPage />} />
              <Route path="settings/expense-categories" element={<SettingsExpenseCategoriesPage />} />

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
