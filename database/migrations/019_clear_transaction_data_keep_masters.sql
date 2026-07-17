-- =============================================================================
-- WaterERP：清空「交易／業務流水」資料（保留主檔）
-- =============================================================================
-- 執行前請先備份資料庫。
--
-- 會清空：訂單／配送／收空桶／服務單、庫存異動、收款／AR／月結／發票／折讓、
--         支出單據、上樓獎金紀錄、通知／OTP 暫存等交易資料。
-- 庫存現量歸零；客戶與送貨地址的 barrels_on_site、客戶 prepaid_barrel_balance 歸零。
--
-- 會保留：客戶、送貨地址、商品、司機、車輛、使用者、供應商、
--         地址分區、隸屬公司、支出類別、優惠活動、印刷標語、訂單公告、
--         薪資／樓層費率設定、客戶搬運費率等主檔與設定。
--
-- 用法：
--   npm run db:clear-transactions
--   或：npx prisma db execute --schema prisma/schema.prisma --file ../../database/migrations/019_clear_transaction_data_keep_masters.sql
-- =============================================================================

SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS = 0;

-- 帳務／沖帳（核心表：結構升級後應已存在）
TRUNCATE TABLE `ar_allocation_maps`;
TRUNCATE TABLE `credit_note_allocations`;
TRUNCATE TABLE `credit_notes`;
TRUNCATE TABLE `ar_open_items`;
TRUNCATE TABLE `ar_documents`;
TRUNCATE TABLE `billing_statement_orders`;
TRUNCATE TABLE `billing_statements`;
TRUNCATE TABLE `tax_invoices`;
TRUNCATE TABLE `payments`;
TRUNCATE TABLE `prepayment_txns`;
TRUNCATE TABLE `receipt_vouchers`;
TRUNCATE TABLE `customer_ledger_entries`;
TRUNCATE TABLE `customer_prepayment_wallets`;
TRUNCATE TABLE `customer_prepaid_product_balances`;

-- 配送／訂單
TRUNCATE TABLE `delivery_events`;
TRUNCATE TABLE `delivery_assignments`;
TRUNCATE TABLE `sales_order_lines`;
TRUNCATE TABLE `sales_orders`;

-- 庫存／進貨／製令
TRUNCATE TABLE `stock_movements`;
TRUNCATE TABLE `purchase_order_lines`;
TRUNCATE TABLE `purchase_orders`;
TRUNCATE TABLE `production_order_lines`;
TRUNCATE TABLE `production_orders`;

-- 較新交易表：不存在時略過（相容尚未升級結構的環境）
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'floor_delivery_bonus_records') > 0,
  'TRUNCATE TABLE `floor_delivery_bonus_records`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'notification_logs') > 0,
  'TRUNCATE TABLE `notification_logs`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'line_otp_challenges') > 0,
  'TRUNCATE TABLE `line_otp_challenges`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'barrel_pickup_events') > 0,
  'TRUNCATE TABLE `barrel_pickup_events`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'barrel_pickups') > 0,
  'TRUNCATE TABLE `barrel_pickups`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'barrel_movements') > 0,
  'TRUNCATE TABLE `barrel_movements`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'service_tickets') > 0,
  'TRUNCATE TABLE `service_tickets`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'expense_lines') > 0,
  'TRUNCATE TABLE `expense_lines`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'expense_vouchers') > 0,
  'TRUNCATE TABLE `expense_vouchers`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;

UPDATE `inventory_balances` SET `qty_on_hand` = 0;
UPDATE `customers` SET `barrels_on_site` = 0, `prepaid_barrel_balance` = 0;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'delivery_addresses' AND column_name = 'barrels_on_site') > 0,
  'UPDATE `delivery_addresses` SET `barrels_on_site` = 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
