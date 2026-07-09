-- =============================================================================
-- WaterERP：清空「所有銷貨訂單」及相關資料（保留客戶、商品、司機、車輛等主檔）
-- =============================================================================
-- 執行前請先備份資料庫。
--
-- 會刪除／處理：
--   • sales_orders、sales_order_lines（明細隨主檔 CASCADE）
--   • delivery_assignments、delivery_events（先刪分派，事件隨分派 CASCADE）
--   • customer_ledger_entries 中 sales_order_id 不為 NULL 的流水（訂單關聯：沖銷、差額、月結應收、預付扣桶等）
--   • payments 中 sales_order_id 不為 NULL 的紀錄（訂單關聯收款）
--   • stock_movements 中 ref_type = 'sales_order' 的出庫流水，並依流水還原 inventory_balances
--
-- 不會刪除：customers、products、drivers、vehicles、採購／生產單等。
--
-- 用法：mysql -u USER -p DATABASE < database/migrations/008_clear_all_sales_orders.sql
-- =============================================================================

SET NAMES utf8mb4;

START TRANSACTION;

-- 依銷貨出庫流水還原庫存（qty_delta 出庫為負；還原：qty_on_hand - sum_delta = 加回）
UPDATE `inventory_balances` ib
INNER JOIN (
  SELECT `product_id`, SUM(`qty_delta`) AS `sum_delta`
  FROM `stock_movements`
  WHERE `ref_type` = 'sales_order'
  GROUP BY `product_id`
) t ON t.`product_id` = ib.`product_id`
SET ib.`qty_on_hand` = ib.`qty_on_hand` - t.`sum_delta`;

DELETE FROM `stock_movements` WHERE `ref_type` = 'sales_order';

-- 刪除所有配送分派（delivery_events 因 ON DELETE CASCADE 一併刪除）
DELETE FROM `delivery_assignments`;

-- 刪除與訂單綁定的收款（僅 sales_order_id 有值者）
DELETE FROM `payments` WHERE `sales_order_id` IS NOT NULL;

-- 刪除與訂單綁定的客戶流水（避免刪單後 sales_order_id 被 SET NULL 殘留無關流水）
DELETE FROM `customer_ledger_entries` WHERE `sales_order_id` IS NOT NULL;

-- 刪除所有銷貨訂單（sales_order_lines 隨主檔 CASCADE）
DELETE FROM `sales_orders`;

-- 訂單已清空後，客戶「未收回空桶」與「預付桶餘額」若仍沿用舊累計會失準；以下歸零（若需保留手動值請改為註解掉）
UPDATE `customers` SET `barrels_on_site` = 0, `prepaid_barrel_balance` = 0;

COMMIT;
