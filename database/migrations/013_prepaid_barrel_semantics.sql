-- 計入押桶 vs 預付扣桶：商品區分 consumes_prepaid_barrel
-- 訂單明細：line_purpose 標記預付桶儲值（不出庫；核銷收款後入桶數）

ALTER TABLE `products`
  ADD COLUMN `consumes_prepaid_barrel` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '預付結帳列出貨時是否自 prepaid_barrel_balance 扣桶（與計入押桶／未收回空桶無關）' AFTER `counts_deposit_barrel`;

UPDATE `products`
SET `consumes_prepaid_barrel` = `counts_deposit_barrel`;

ALTER TABLE `sales_order_lines`
  ADD COLUMN `line_purpose` VARCHAR(32) NOT NULL DEFAULT 'delivery' COMMENT 'delivery|prepaid_barrel_topup（預付桶儲值：不出庫）' AFTER `billing_type_at_line`;
