-- 三種結帳：現金往來／月結／預付桶 + 客戶流水帳 + 訂單欄位

ALTER TABLE `customers`
  MODIFY COLUMN `billing_type` VARCHAR(32) NOT NULL DEFAULT 'cash' COMMENT 'cash, monthly, prepaid',
  ADD COLUMN `monthly_settlement_day` INT NULL DEFAULT NULL COMMENT '月結：每月幾號對帳參考 1-31' AFTER `barrels_on_site`,
  ADD COLUMN `prepaid_barrel_balance` INT NOT NULL DEFAULT 0 COMMENT '預付：可用桶數' AFTER `monthly_settlement_day`,
  ADD COLUMN `allow_prepaid_overdraft` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '預付不足時是否仍允許核銷' AFTER `prepaid_barrel_balance`;

ALTER TABLE `sales_orders`
  ADD COLUMN `billing_type_at_order` VARCHAR(32) NULL DEFAULT NULL COMMENT '下單時結帳方式快照' AFTER `remark`,
  ADD COLUMN `order_cash_adjustment` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現金本單沖銷往來（正＝客戶多付沖欠款）' AFTER `billing_type_at_order`,
  ADD COLUMN `billing_period_key` VARCHAR(7) NULL DEFAULT NULL COMMENT '月結曆月 YYYY-MM' AFTER `order_cash_adjustment`,
  ADD COLUMN `monthly_period_paid` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '月結該筆所屬期是否已收款' AFTER `billing_period_key`,
  ADD KEY `idx_so_billing_period` (`billing_period_key`, `customer_id`);

CREATE TABLE `customer_ledger_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `entry_type` VARCHAR(40) NOT NULL COMMENT 'cash_variance_short, cash_variance_over, cash_offset_order, monthly_accrual, monthly_payment, prepaid_topup, prepaid_consumption',
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現金往來：正＝客戶欠公司增加',
  `barrel_delta` INT NOT NULL DEFAULT 0 COMMENT '預付桶：正＝儲值增加',
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `payment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_cle_customer_created` (`customer_id`, `created_at`),
  KEY `fk_cle_order` (`sales_order_id`),
  KEY `fk_cle_payment` (`payment_id`),
  KEY `fk_cle_user` (`created_by_user_id`),
  CONSTRAINT `fk_cle_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
