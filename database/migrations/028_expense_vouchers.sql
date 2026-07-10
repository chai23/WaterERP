-- 公司支出憑證（表頭 + 明細 + 類別主檔）

CREATE TABLE IF NOT EXISTS `expense_categories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `requires_customer` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '此類別明細須選客戶（如退押金）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_expense_categories_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='支出類別主檔';

INSERT IGNORE INTO `expense_categories` (`name`, `sort_order`, `requires_customer`) VALUES
  ('消耗品', 10, 0),
  ('加油費', 20, 0),
  ('車輛維修', 30, 0),
  ('退押金', 40, 1),
  ('水電費', 50, 0),
  ('辦公用品', 60, 0),
  ('雜支', 70, 0),
  ('其他', 80, 0);

CREATE TABLE IF NOT EXISTS `expense_vouchers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `voucher_no` VARCHAR(40) NOT NULL COMMENT 'EX+YYYYMMDD+序號',
  `expense_date` DATE NOT NULL COMMENT '支出日期',
  `vendor_name` VARCHAR(200) NOT NULL COMMENT '廠商／收款對象',
  `affiliated_company_id` BIGINT UNSIGNED NOT NULL COMMENT '發票歸屬公司',
  `invoice_date` DATE NULL DEFAULT NULL COMMENT '開票日期',
  `payment_method` VARCHAR(32) NOT NULL DEFAULT 'cash' COMMENT 'cash,transfer,check,monthly,other',
  `remark` TEXT NULL DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending | verified',
  `untaxed_total` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tax_total` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `verified_at` DATETIME(3) NULL DEFAULT NULL,
  `verified_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_expense_vouchers_no` (`voucher_no`),
  KEY `idx_expense_vouchers_date_status` (`expense_date`, `status`),
  KEY `fk_expense_vouchers_company` (`affiliated_company_id`),
  KEY `fk_expense_vouchers_creator` (`created_by_user_id`),
  KEY `fk_expense_vouchers_verifier` (`verified_by_user_id`),
  CONSTRAINT `fk_expense_vouchers_company` FOREIGN KEY (`affiliated_company_id`) REFERENCES `affiliated_companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_expense_vouchers_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_expense_vouchers_verifier` FOREIGN KEY (`verified_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='公司支出憑證表頭';

CREATE TABLE IF NOT EXISTS `expense_lines` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `expense_voucher_id` BIGINT UNSIGNED NOT NULL,
  `category_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `item_name` VARCHAR(200) NOT NULL,
  `customer_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '關聯客戶（退押金等）',
  `qty` INT NOT NULL DEFAULT 1,
  `unit_price` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tax_mode` VARCHAR(32) NOT NULL DEFAULT 'tax_exclusive' COMMENT 'tax_inclusive | tax_exclusive | none',
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `line_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '含稅總額',
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_expense_lines_voucher` (`expense_voucher_id`),
  KEY `fk_expense_lines_category` (`category_id`),
  KEY `fk_expense_lines_customer` (`customer_id`),
  CONSTRAINT `fk_expense_lines_voucher` FOREIGN KEY (`expense_voucher_id`) REFERENCES `expense_vouchers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_expense_lines_category` FOREIGN KEY (`category_id`) REFERENCES `expense_categories` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_expense_lines_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='公司支出明細';
