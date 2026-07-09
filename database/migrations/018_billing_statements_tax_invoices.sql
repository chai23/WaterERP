-- 月結 R2：批次結帳立單筆月結 AR（未稅）；整期彙總發票（tax_invoices）。
-- 現金立帳仍於訂單確認時；cash_invoice_mode / invoice_mode 供發票開立。

CREATE TABLE IF NOT EXISTS `billing_statements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `statement_no` VARCHAR(40) NOT NULL COMMENT '結帳批次編號',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'posted' COMMENT 'posted',
  `cutoff_date` DATE NULL DEFAULT NULL COMMENT '對帳截止日（參考）',
  `untaxed_total` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT '月結應收未稅合計（AR 本金）',
  `tax_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT '營業稅（發票彙總）',
  `total_with_tax` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT '含稅總額（發票參考）',
  `tax_rate` DECIMAL(8, 6) NOT NULL DEFAULT 0.050000,
  `invoice_mode` VARCHAR(32) NOT NULL DEFAULT 'tax_exclusive' COMMENT 'none | tax_inclusive | tax_exclusive',
  `posted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_billing_statements_no` (`statement_no`),
  KEY `fk_bs_customer` (`customer_id`),
  CONSTRAINT `fk_bs_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='月結結帳批次';

CREATE TABLE IF NOT EXISTS `billing_statement_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `billing_statement_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `monthly_untaxed_amount` DECIMAL(14, 2) NOT NULL COMMENT '該訂單納入本期之月結未稅金額快照',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bso_sales_order` (`sales_order_id`),
  KEY `fk_bso_statement` (`billing_statement_id`),
  CONSTRAINT `fk_bso_statement` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_bso_sales_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tax_invoices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `invoice_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `basis_type` VARCHAR(24) NOT NULL COMMENT 'billing_statement | sales_order',
  `billing_statement_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `invoice_mode` VARCHAR(32) NOT NULL DEFAULT 'tax_exclusive',
  `untaxed_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `tax_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `tax_rate` DECIMAL(8, 6) NOT NULL DEFAULT 0.050000,
  `status` VARCHAR(24) NOT NULL DEFAULT 'issued',
  `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tax_invoices_no` (`invoice_no`),
  KEY `fk_ti_customer` (`customer_id`),
  KEY `fk_ti_bs` (`billing_statement_id`),
  KEY `fk_ti_so` (`sales_order_id`),
  CONSTRAINT `fk_ti_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ti_bs` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_ti_so` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='發票主檔（憑證資訊；AR 仍為未稅本金）';

ALTER TABLE `ar_documents`
  ADD COLUMN `billing_statement_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `sales_order_id`,
  ADD KEY `fk_ar_billing_statement` (`billing_statement_id`),
  ADD CONSTRAINT `fk_ar_billing_statement` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `sales_orders`
  ADD COLUMN `cash_invoice_mode` VARCHAR(32) NULL DEFAULT NULL COMMENT 'none | tax_inclusive | tax_exclusive' AFTER `pending_prepaid_topup_barrels`;

ALTER TABLE `sales_order_lines`
  ADD COLUMN `invoice_mode` VARCHAR(32) NULL DEFAULT NULL COMMENT 'none | tax_inclusive | tax_exclusive（現金/儲值列）' AFTER `line_purpose`;
