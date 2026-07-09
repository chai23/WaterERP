-- 明細級結帳方式 + 訂單現金/月結小計（沖銷上限）
SET NAMES utf8mb4;

ALTER TABLE `sales_order_lines`
  ADD COLUMN `billing_type_at_line` VARCHAR(32) NULL DEFAULT NULL COMMENT 'cash|monthly|prepaid' AFTER `line_amount`;

UPDATE `sales_order_lines` sol
INNER JOIN `sales_orders` so ON so.`id` = sol.`sales_order_id`
SET sol.`billing_type_at_line` = COALESCE(so.`billing_type_at_order`, 'cash');

ALTER TABLE `sales_orders`
  ADD COLUMN `cash_subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '明細現金列合計' AFTER `billing_type_at_order`,
  ADD COLUMN `monthly_subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '明細月結列合計' AFTER `cash_subtotal`;

UPDATE `sales_orders` so
SET so.`cash_subtotal` = CASE WHEN so.`billing_type_at_order` = 'cash' THEN so.`total_amount` ELSE 0 END,
    so.`monthly_subtotal` = CASE WHEN so.`billing_type_at_order` = 'monthly' THEN so.`total_amount` ELSE 0 END;
