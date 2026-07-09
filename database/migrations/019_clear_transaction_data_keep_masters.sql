-- =============================================================================
-- WaterERP：清空「交易／業務流水」資料（保留客戶、地址、商品、司機、車輛、使用者、供應商等主檔）
-- =============================================================================
-- 執行前請先備份資料庫。
--
-- 會清空：銷／採／生產單、配送、庫存異動、收款／收據／沖帳／AR／折讓／客戶流水／預收錢包／預付桶分帳／月結批次／發票 等。
-- 庫存現量歸零；客戶 barrels_on_site、prepaid_barrel_balance 歸零。
--
-- 用法：npx prisma db execute --schema prisma/schema.prisma --file ../../database/migrations/019_clear_transaction_data_keep_masters.sql
-- =============================================================================

SET NAMES utf8mb4;

START TRANSACTION;

SET FOREIGN_KEY_CHECKS = 0;

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

TRUNCATE TABLE `delivery_events`;
TRUNCATE TABLE `delivery_assignments`;

TRUNCATE TABLE `stock_movements`;

TRUNCATE TABLE `purchase_order_lines`;
TRUNCATE TABLE `purchase_orders`;

TRUNCATE TABLE `production_order_lines`;
TRUNCATE TABLE `production_orders`;

TRUNCATE TABLE `sales_order_lines`;
TRUNCATE TABLE `sales_orders`;

SET FOREIGN_KEY_CHECKS = 1;

UPDATE `inventory_balances` SET `qty_on_hand` = 0;
UPDATE `customers` SET `barrels_on_site` = 0, `prepaid_barrel_balance` = 0;

COMMIT;
