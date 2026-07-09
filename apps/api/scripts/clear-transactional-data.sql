SET FOREIGN_KEY_CHECKS = 0;

-- 先回補銷貨出庫對庫存的影響（僅 sales_order 來源）
UPDATE `inventory_balances` ib
INNER JOIN (
  SELECT `product_id`, SUM(`qty_delta`) AS `sum_delta`
  FROM `stock_movements`
  WHERE `ref_type` = 'sales_order'
  GROUP BY `product_id`
) t ON t.`product_id` = ib.`product_id`
SET ib.`qty_on_hand` = ib.`qty_on_hand` - t.`sum_delta`;

-- AR / 收款 / 配送 / 訂單 交易資料
DELETE FROM `credit_note_allocations`;
DELETE FROM `credit_notes`;
DELETE FROM `prepayment_txns`;
DELETE FROM `ar_allocation_maps`;
DELETE FROM `ar_open_items`;
DELETE FROM `ar_documents`;
DELETE FROM `customer_ledger_entries`;
DELETE FROM `payments`;
DELETE FROM `receipt_vouchers`;
DELETE FROM `delivery_assignments`;
DELETE FROM `sales_orders`;

-- 銷貨相關庫存流水
DELETE FROM `stock_movements` WHERE `ref_type` = 'sales_order';

-- 客戶交易衍生欄位歸零（保留主檔）
UPDATE `customers`
SET
  `barrels_on_site` = 0,
  `prepaid_barrel_balance` = 0;

-- 金額型預收錢包歸零（保留每位客戶錢包）
UPDATE `customer_prepayment_wallets`
SET `balance_amount` = 0.00;

SET FOREIGN_KEY_CHECKS = 1;
