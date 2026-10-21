-- =============================================================================
-- WaterERP：清空業務資料（含 users，不保留任何帳號）
-- =============================================================================
-- 使用前請先備份整個資料庫（mysqldump）。
-- 執行後：訂單、客戶、司機、商品、車輛、庫存異動、配送、收款、使用者等皆清空。
-- 登入帳號請於「轉換使用者資料」後取得（會建立 id=1 的 admin）。
--
-- 用法：mysql -u... -p water_erp < database/maintenance/reset_data_keep_single_admin.sql
-- 或：npm run db:reset
-- =============================================================================

SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS = 0;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='cutover_monthly_items')>0, 'DELETE FROM cutover_monthly_items', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='cutover_handover')>0, 'UPDATE cutover_handover SET revision=revision+1, status=''empty'', snapshot=NULL, created_by=NULL, applied_by=NULL, applied_at=NULL, updated_at=NOW(3) WHERE id=1', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


TRUNCATE TABLE `ar_allocation_maps`;
TRUNCATE TABLE `credit_note_allocations`;
TRUNCATE TABLE `credit_notes`;
TRUNCATE TABLE `prepayment_txns`;
TRUNCATE TABLE `customer_prepayment_wallets`;
TRUNCATE TABLE `tax_invoices`;
TRUNCATE TABLE `billing_statement_orders`;
TRUNCATE TABLE `receipt_vouchers`;
TRUNCATE TABLE `ar_open_items`;
TRUNCATE TABLE `ar_documents`;
TRUNCATE TABLE `billing_statements`;
TRUNCATE TABLE `customer_prepaid_product_balances`;
TRUNCATE TABLE `customer_ledger_entries`;
TRUNCATE TABLE `order_announcements`;
TRUNCATE TABLE `barrel_pickup_events`;
TRUNCATE TABLE `barrel_pickups`;
TRUNCATE TABLE `delivery_events`;
TRUNCATE TABLE `delivery_assignments`;
TRUNCATE TABLE `payments`;
TRUNCATE TABLE `purchase_order_lines`;
TRUNCATE TABLE `purchase_orders`;
TRUNCATE TABLE `suppliers`;
TRUNCATE TABLE `stock_movements`;
TRUNCATE TABLE `inventory_balances`;
TRUNCATE TABLE `production_order_lines`;
TRUNCATE TABLE `production_orders`;
TRUNCATE TABLE `sales_order_lines`;
TRUNCATE TABLE `sales_orders`;
TRUNCATE TABLE `products`;
TRUNCATE TABLE `delivery_addresses`;
TRUNCATE TABLE `customers`;
TRUNCATE TABLE `drivers`;
TRUNCATE TABLE `vehicles`;
TRUNCATE TABLE `address_zones`;
TRUNCATE TABLE `affiliated_companies`;
TRUNCATE TABLE `users`;

SET FOREIGN_KEY_CHECKS = 1;

ALTER TABLE `users` AUTO_INCREMENT = 1;

-- 完成：SELECT COUNT(*) FROM users; 應為 0
