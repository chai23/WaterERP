-- WaterERP — MySQL 8
-- 使用方式：先 CREATE DATABASE，再執行本檔
--   CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   USE water_erp;
--   SOURCE schema.sql;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- 使用者（後台／司機登入）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `expense_lines`;
DROP TABLE IF EXISTS `expense_vouchers`;
DROP TABLE IF EXISTS `expense_categories`;
DROP TABLE IF EXISTS `barrel_pickup_events`;
DROP TABLE IF EXISTS `barrel_pickups`;
DROP TABLE IF EXISTS `delivery_events`;
DROP TABLE IF EXISTS `delivery_assignments`;
DROP TABLE IF EXISTS `delivery_plan_unassigned`;
DROP TABLE IF EXISTS `delivery_route_stops`;
DROP TABLE IF EXISTS `delivery_routes`;
DROP TABLE IF EXISTS `delivery_planning_audit_logs`;
DROP TABLE IF EXISTS `delivery_plans`;
DROP TABLE IF EXISTS `delivery_planning_settings`;
DROP TABLE IF EXISTS `driver_attendance`;
DROP TABLE IF EXISTS `credit_note_allocations`;
DROP TABLE IF EXISTS `credit_notes`;
DROP TABLE IF EXISTS `prepayment_txns`;
DROP TABLE IF EXISTS `customer_prepayment_wallets`;
DROP TABLE IF EXISTS `tax_invoices`;
DROP TABLE IF EXISTS `billing_statement_orders`;
DROP TABLE IF EXISTS `ar_allocation_maps`;
DROP TABLE IF EXISTS `receipt_vouchers`;
DROP TABLE IF EXISTS `ar_open_items`;
DROP TABLE IF EXISTS `ar_documents`;
DROP TABLE IF EXISTS `billing_statements`;
DROP TABLE IF EXISTS `customer_prepaid_product_balances`;
DROP TABLE IF EXISTS `customer_ledger_entries`;
DROP TABLE IF EXISTS `payments`;
DROP TABLE IF EXISTS `purchase_order_lines`;
DROP TABLE IF EXISTS `purchase_orders`;
DROP TABLE IF EXISTS `suppliers`;
DROP TABLE IF EXISTS `stock_movements`;
DROP TABLE IF EXISTS `inventory_balances`;
DROP TABLE IF EXISTS `production_order_lines`;
DROP TABLE IF EXISTS `production_orders`;
DROP TABLE IF EXISTS `sales_order_lines`;
DROP TABLE IF EXISTS `sales_orders`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `delivery_addresses`;
DROP TABLE IF EXISTS `customers`;
DROP TABLE IF EXISTS `drivers`;
DROP TABLE IF EXISTS `vehicles`;
DROP TABLE IF EXISTS `users`;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_code` VARCHAR(50) NOT NULL COMMENT '登入帳號（員編）',
  `phone` VARCHAR(32) NULL DEFAULT NULL COMMENT '聯絡手機',
  `password_hash` VARCHAR(255) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'dispatcher' COMMENT 'admin, dispatcher, warehouse, driver',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_employee_code` (`employee_code`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系統使用者';

CREATE TABLE `vehicles` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plate_no` VARCHAR(20) NOT NULL COMMENT '車牌',
  `description` VARCHAR(200) NULL DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_vehicles_plate` (`plate_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `drivers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL COMMENT '對應 users（role=driver）',
  `vehicle_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `employee_code` VARCHAR(50) NULL DEFAULT NULL,
  `max_order_count` INT UNSIGNED NOT NULL DEFAULT 20 COMMENT '可負荷最高訂單數',
  `max_barrel_qty` INT UNSIGNED NOT NULL DEFAULT 150 COMMENT '可運送最大桶數',
  `work_start_time` TIME NULL DEFAULT NULL,
  `work_end_time` TIME NULL DEFAULT NULL,
  `depot_latitude` DECIMAL(10, 7) NULL DEFAULT NULL,
  `depot_longitude` DECIMAL(10, 7) NULL DEFAULT NULL,
  `familiar_zone_ids_json` JSON NULL DEFAULT NULL COMMENT 'AddressZone id 陣列',
  `can_high_floor` TINYINT(1) NULL DEFAULT NULL,
  `base_salary` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '月基本底薪',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_drivers_user` (`user_id`),
  KEY `fk_drivers_vehicle` (`vehicle_id`),
  CONSTRAINT `fk_drivers_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_drivers_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `address_zones` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_address_zones_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `affiliated_companies` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_affiliated_companies_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `print_slogans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(80) NOT NULL COMMENT '後台顯示名稱（選取按鈕）',
  `body` TEXT NOT NULL COMMENT '寫入訂單備註的完整文字',
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_print_slogans_title` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `order_announcements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(80) NOT NULL COMMENT '後台識別名稱',
  `body` TEXT NOT NULL COMMENT '套印在訂單上的公告全文',
  `kind` VARCHAR(16) NOT NULL DEFAULT 'standing' COMMENT 'standing=全站, period=特定期間',
  `starts_on` DATE NULL DEFAULT NULL COMMENT '特定期間起日（含）',
  `ends_on` DATE NULL DEFAULT NULL COMMENT '特定期間迄日（含）',
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_order_announcements_kind_active` (`kind`, `is_active`),
  KEY `idx_order_announcements_period` (`starts_on`, `ends_on`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='訂單套印公告';

CREATE TABLE `expense_categories` (
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

CREATE TABLE `expense_vouchers` (
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

CREATE TABLE `expense_lines` (
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

CREATE TABLE `barrel_pickups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pickup_no` VARCHAR(24) NOT NULL COMMENT 'BP+YYYYMMDD+序號',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `delivery_address_id` BIGINT UNSIGNED NOT NULL,
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `vehicle_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `assigned_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `pickup_date` DATE NOT NULL COMMENT '預定收桶日',
  `status` VARCHAR(32) NOT NULL DEFAULT 'assigned' COMMENT 'assigned|pending_settlement|completed|cancelled',
  `barrels_expected` INT UNSIGNED NULL DEFAULT NULL COMMENT '預估收桶數（可選）',
  `barrels_returned` INT UNSIGNED NULL DEFAULT NULL COMMENT '司機回報實收',
  `driver_note` VARCHAR(500) NULL DEFAULT NULL,
  `driver_reported_at` DATETIME(3) NULL DEFAULT NULL,
  `office_settled_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `office_settled_at` DATETIME(3) NULL DEFAULT NULL,
  `remark` TEXT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_barrel_pickups_pickup_no` (`pickup_no`),
  KEY `idx_barrel_pickups_status_date` (`status`, `pickup_date`),
  KEY `fk_barrel_pickups_customer` (`customer_id`),
  KEY `fk_barrel_pickups_address` (`delivery_address_id`),
  KEY `fk_barrel_pickups_driver` (`driver_id`),
  KEY `fk_barrel_pickups_vehicle` (`vehicle_id`),
  CONSTRAINT `fk_barrel_pickups_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `fk_barrel_pickups_address` FOREIGN KEY (`delivery_address_id`) REFERENCES `delivery_addresses` (`id`),
  CONSTRAINT `fk_barrel_pickups_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`),
  CONSTRAINT `fk_barrel_pickups_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_pickups_assigned_by` FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_pickups_created_by` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_pickups_settled_by` FOREIGN KEY (`office_settled_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='收空桶任務';

CREATE TABLE `barrel_pickup_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `barrel_pickup_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `payload_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_barrel_pickup_events_pickup` (`barrel_pickup_id`),
  CONSTRAINT `fk_barrel_pickup_events_pickup` FOREIGN KEY (`barrel_pickup_id`) REFERENCES `barrel_pickups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='收空桶事件紀錄';

CREATE TABLE `barrel_movements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `movement_date` DATE NOT NULL COMMENT '業務日期（收桶日／核銷日）',
  `occurred_at` DATETIME(3) NOT NULL COMMENT '辦公室核銷時間',
  `source_type` VARCHAR(32) NOT NULL COMMENT 'pickup|delivery',
  `source_ref_id` BIGINT UNSIGNED NOT NULL COMMENT 'barrel_pickup.id 或 delivery_assignment.id',
  `ref_no` VARCHAR(40) NOT NULL COMMENT 'pickup_no 或 order_no',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `delivery_address_id` BIGINT UNSIGNED NOT NULL,
  `barrels_returned` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '回收空桶數',
  `barrels_delivered` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '押桶出貨數（配送才有）',
  `barrel_delta` INT NOT NULL COMMENT '在場空桶淨變動：正=增加、負=減少',
  `barrels_on_site_before` INT UNSIGNED NULL DEFAULT NULL COMMENT '核銷前送貨點在場空桶',
  `barrels_on_site_after` INT UNSIGNED NULL DEFAULT NULL COMMENT '核銷後送貨點在場空桶',
  `driver_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `vehicle_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `barrel_pickup_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `delivery_assignment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_barrel_movements_source` (`source_type`, `source_ref_id`),
  KEY `idx_barrel_movements_customer_date` (`customer_id`, `movement_date`),
  KEY `idx_barrel_movements_address_date` (`delivery_address_id`, `movement_date`),
  KEY `idx_barrel_movements_ref_no` (`ref_no`),
  KEY `fk_barrel_movements_customer` (`customer_id`),
  KEY `fk_barrel_movements_address` (`delivery_address_id`),
  KEY `fk_barrel_movements_driver` (`driver_id`),
  KEY `fk_barrel_movements_vehicle` (`vehicle_id`),
  KEY `fk_barrel_movements_sales_order` (`sales_order_id`),
  KEY `fk_barrel_movements_pickup` (`barrel_pickup_id`),
  KEY `fk_barrel_movements_assignment` (`delivery_assignment_id`),
  CONSTRAINT `fk_barrel_movements_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `fk_barrel_movements_address` FOREIGN KEY (`delivery_address_id`) REFERENCES `delivery_addresses` (`id`),
  CONSTRAINT `fk_barrel_movements_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_movements_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_movements_sales_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_movements_pickup` FOREIGN KEY (`barrel_pickup_id`) REFERENCES `barrel_pickups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_movements_assignment` FOREIGN KEY (`delivery_assignment_id`) REFERENCES `delivery_assignments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_barrel_movements_created_by` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='空桶回收稽核流水';

CREATE TABLE `customers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_code` CHAR(6) NULL DEFAULT NULL COMMENT '客戶編號（6碼數字，可自訂）',
  `name` VARCHAR(200) NOT NULL,
  `contact_name` VARCHAR(100) NULL DEFAULT NULL COMMENT '聯絡人',
  `phone` VARCHAR(32) NULL DEFAULT NULL COMMENT '電話',
  `mobile` VARCHAR(32) NULL DEFAULT NULL COMMENT '手機',
  `tax_id` VARCHAR(8) NULL DEFAULT NULL COMMENT '統一編號',
  `billing_type` VARCHAR(32) NOT NULL DEFAULT 'cash' COMMENT 'cash, monthly, prepaid',
  `default_cash_invoice_mode` VARCHAR(32) NULL DEFAULT 'none' COMMENT 'none | tax_inclusive | tax_exclusive',
  `address_zone_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `affiliated_company_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `credit_limit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `notes` TEXT NULL,
  `standing_remark` TEXT NULL COMMENT '客戶常態備註（列印、開單參考）',
  `barrels_on_site` INT NOT NULL DEFAULT 0 COMMENT '已廢止寫入；API 回傳為各送貨地址加總（相容）',
  `monthly_settlement_day` INT NULL DEFAULT NULL COMMENT '月結：每月幾號對帳參考 1-31',
  `prepaid_barrel_balance` INT NOT NULL DEFAULT 0 COMMENT '預付：可用桶數',
  `allow_prepaid_overdraft` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '預付不足時是否仍允許核銷',
  `line_user_id` VARCHAR(64) NULL DEFAULT NULL COMMENT 'LINE userId（LIFF 綁定）',
  `line_bound_at` DATETIME(3) NULL DEFAULT NULL COMMENT 'LINE 綁定時間',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customers_customer_code` (`customer_code`),
  UNIQUE KEY `uk_customers_line_user_id` (`line_user_id`),
  KEY `idx_customers_name` (`name`),
  KEY `fk_customers_address_zone` (`address_zone_id`),
  KEY `fk_customers_affiliated_company` (`affiliated_company_id`),
  CONSTRAINT `fk_customers_address_zone` FOREIGN KEY (`address_zone_id`) REFERENCES `address_zones` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_customers_affiliated_company` FOREIGN KEY (`affiliated_company_id`) REFERENCES `affiliated_companies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_addresses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `label` VARCHAR(100) NULL DEFAULT NULL COMMENT '例如：總公司、倉庫',
  `address_line` VARCHAR(500) NOT NULL,
  `delivery_floor` SMALLINT NULL DEFAULT NULL COMMENT '送貨樓層（1=一樓, 2=二樓, -1=地下一樓；NULL=未設定）',
  `contact_name` VARCHAR(100) NULL DEFAULT NULL,
  `contact_phone` VARCHAR(32) NULL DEFAULT NULL,
  `contact_mobile` VARCHAR(32) NULL DEFAULT NULL COMMENT '現場手機',
  `notes` TEXT NULL,
  `latitude` DECIMAL(10, 7) NULL DEFAULT NULL COMMENT 'WGS84 緯度',
  `longitude` DECIMAL(10, 7) NULL DEFAULT NULL COMMENT 'WGS84 經度',
  `geocode_status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|ok|ambiguous|failed|manual_confirmed',
  `geocoded_address` VARCHAR(500) NULL DEFAULT NULL COMMENT 'geocode 正規化地址',
  `geocoded_at` DATETIME(3) NULL DEFAULT NULL,
  `location_accuracy` VARCHAR(32) NULL DEFAULT NULL,
  `manual_location_confirmed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理員地圖確認',
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `barrels_on_site` INT NOT NULL DEFAULT 0 COMMENT '此送貨點未收回空桶數：核銷送達時依押桶商品與回桶數自動增減，亦可手動調整',
  `patrol_weekday` TINYINT UNSIGNED NULL DEFAULT NULL COMMENT '巡查星期：1=週一 … 7=週日；NULL=不參加巡查',
  `target_water_level` INT UNSIGNED NULL DEFAULT NULL COMMENT '目標水位（桶）；現場不足時補到此量',
  `patrol_product_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '巡查預設商品',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_addr_customer` (`customer_id`),
  KEY `idx_addr_patrol_weekday` (`patrol_weekday`),
  KEY `idx_addr_geocode_status` (`geocode_status`),
  KEY `fk_addr_patrol_product` (`patrol_product_id`),
  CONSTRAINT `fk_addr_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_code` CHAR(3) NULL DEFAULT NULL COMMENT '商品編號（3碼數字，可自訂）',
  `sku` VARCHAR(50) NULL DEFAULT NULL,
  `name` VARCHAR(200) NOT NULL,
  `unit` VARCHAR(20) NOT NULL DEFAULT '桶',
  `counts_deposit_barrel` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '核銷送達時是否計入客戶未收回空桶（與單位無關）',
  `consumes_prepaid_barrel` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '預付結帳列出貨時是否自預付桶餘額扣桶（與計入押桶無關）',
  `available_on_liff` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否顯示於 LINE LIFF 訂水選單',
  `sale_price` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `cost_price` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '參考成本／加權用',
  `driver_delivery_wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '司機每單位配送薪資',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_products_product_code` (`product_code`),
  UNIQUE KEY `uk_products_sku` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payroll_settings` (
  `id` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `empty_barrel_wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '回收空桶每桶薪資（固定）',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payroll_floor_bonus_rates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `floor` SMALLINT NOT NULL COMMENT '樓層：2=二樓、-1=地下一樓',
  `wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '該樓層每桶獎金',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_payroll_floor_bonus_rates_floor` (`floor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `delivery_addresses`
  ADD CONSTRAINT `fk_addr_patrol_product` FOREIGN KEY (`patrol_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `sales_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no` VARCHAR(40) NOT NULL COMMENT '對外單號',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `delivery_address_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft,confirmed,in_production,ready_to_ship,assigned,delivering,completed,cancelled,exception',
  `scheduled_delivery_date` DATE NULL DEFAULT NULL,
  `delivery_window_start` TIME NULL DEFAULT NULL COMMENT '最早可送',
  `delivery_window_end` TIME NULL DEFAULT NULL COMMENT '最晚可送',
  `preferred_time_note` VARCHAR(200) NULL DEFAULT NULL,
  `service_duration_minutes` INT UNSIGNED NULL DEFAULT NULL,
  `allow_early_delivery` TINYINT(1) NULL DEFAULT NULL,
  `allow_late_delivery` TINYINT(1) NULL DEFAULT NULL,
  `time_window_priority` VARCHAR(16) NULL DEFAULT NULL COMMENT 'required|preferred',
  `order_kind` VARCHAR(24) NULL DEFAULT NULL COMMENT 'general|patrol|replenishment|emergency',
  `dispatch_priority` VARCHAR(16) NULL DEFAULT NULL COMMENT 'normal|urgent|must',
  `earliest_date` DATE NULL DEFAULT NULL,
  `earliest_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm',
  `latest_date` DATE NULL DEFAULT NULL,
  `latest_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm',
  `preferred_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm|any',
  `dispatch_locked` TINYINT(1) NOT NULL DEFAULT 0,
  `preferred_driver_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `required_driver_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `lock_version` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '樂觀鎖：分派／改狀態時＋1',
  `remark` TEXT NULL,
  `billing_type_at_order` VARCHAR(32) NULL DEFAULT NULL COMMENT '下單時結帳方式快照或 mixed',
  `cash_subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '明細現金列合計',
  `monthly_subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '明細月結列合計',
  `order_cash_adjustment` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '已廢止保留欄位；現金應收改 FIFO，見 BILLING.md',
  `billing_period_key` VARCHAR(7) NULL DEFAULT NULL COMMENT '月結曆月 YYYY-MM（報表／相容）',
  `office_settled_at` DATETIME(3) NULL DEFAULT NULL COMMENT '辦公室核銷送達完成時間（月結截止日篩選）',
  `monthly_received_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '月結已沖銷入帳累計',
  `monthly_period_paid` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '月結該筆訂單是否已全額沖完',
  `pending_prepaid_topup_barrels` INT NOT NULL DEFAULT 0 COMMENT '預付桶儲值待入帳桶數（本單現金AR全沖清後入餘額）',
  `cash_invoice_mode` VARCHAR(32) NULL DEFAULT NULL COMMENT 'none | tax_inclusive | tax_exclusive',
  `source` VARCHAR(16) NOT NULL DEFAULT 'admin' COMMENT 'admin | liff',
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sales_order_no` (`order_no`),
  KEY `fk_so_customer` (`customer_id`),
  KEY `fk_so_addr` (`delivery_address_id`),
  KEY `fk_so_creator` (`created_by_user_id`),
  KEY `idx_so_status_date` (`status`, `scheduled_delivery_date`),
  KEY `idx_so_billing_period` (`billing_period_key`, `customer_id`),
  KEY `idx_so_customer_office_settled` (`customer_id`, `office_settled_at`),
  KEY `idx_so_source` (`source`),
  KEY `idx_so_order_kind` (`order_kind`),
  KEY `idx_so_latest_shift` (`latest_date`, `latest_shift`),
  KEY `idx_so_preferred_driver` (`preferred_driver_id`),
  KEY `idx_so_required_driver` (`required_driver_id`),
  CONSTRAINT `fk_so_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_so_addr` FOREIGN KEY (`delivery_address_id`) REFERENCES `delivery_addresses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_so_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_so_preferred_driver` FOREIGN KEY (`preferred_driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_so_required_driver` FOREIGN KEY (`required_driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `promotion_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rule_key` VARCHAR(50) NOT NULL COMMENT '唯一代碼',
  `display_name` VARCHAR(100) NOT NULL,
  `description` TEXT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `config` JSON NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_promotion_rules_rule_key` (`rule_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `promotion_dispenser_gift_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `trigger_product_id` BIGINT UNSIGNED NOT NULL COMMENT '飲水機商品',
  `gift_product_id` BIGINT UNSIGNED NOT NULL COMMENT '贈送商品',
  `gift_qty_per_unit` INT NOT NULL DEFAULT 1 COMMENT '每台贈送桶數',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dispenser_gift_trigger` (`trigger_product_id`),
  KEY `fk_dispenser_gift_trigger` (`trigger_product_id`),
  KEY `fk_dispenser_gift_gift` (`gift_product_id`),
  CONSTRAINT `fk_dispenser_gift_trigger` FOREIGN KEY (`trigger_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_dispenser_gift_gift` FOREIGN KEY (`gift_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sales_order_lines` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `qty_ordered` INT NOT NULL COMMENT '訂購數量',
  `qty_delivered` INT NOT NULL DEFAULT 0 COMMENT '實際配送／銷單結案時寫入',
  `unit_price` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `line_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `billing_type_at_line` VARCHAR(32) NULL DEFAULT NULL COMMENT 'cash|monthly|prepaid',
  `line_purpose` VARCHAR(32) NOT NULL DEFAULT 'delivery' COMMENT 'delivery|prepaid_barrel_topup',
  `invoice_mode` VARCHAR(32) NULL DEFAULT NULL COMMENT 'none | tax_inclusive | tax_exclusive（現金/儲值列）',
  `is_promotion_gift` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否為優惠贈品列',
  `promotion_rule_key` VARCHAR(50) NULL DEFAULT NULL COMMENT '套用優惠規則代碼',
  `promotion_note` VARCHAR(200) NULL DEFAULT NULL COMMENT '贈品說明',
  `is_replenishment` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '補送（破桶補水等）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_sol_order` (`sales_order_id`),
  KEY `fk_sol_product` (`product_id`),
  KEY `idx_sol_replenishment` (`is_replenishment`),
  CONSTRAINT `fk_sol_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_sol_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `production_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `production_no` VARCHAR(40) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft,in_progress,completed,cancelled',
  `scheduled_date` DATE NULL DEFAULT NULL,
  `remark` TEXT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_production_no` (`production_no`),
  KEY `fk_po_creator` (`created_by_user_id`),
  CONSTRAINT `fk_po_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `production_order_lines` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `production_order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `qty_planned` INT NOT NULL,
  `qty_completed` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_pol_po` (`production_order_id`),
  KEY `fk_pol_product` (`product_id`),
  CONSTRAINT `fk_pol_po` FOREIGN KEY (`production_order_id`) REFERENCES `production_orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_pol_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `inventory_balances` (
  `product_id` BIGINT UNSIGNED NOT NULL,
  `qty_on_hand` INT NOT NULL DEFAULT 0,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`product_id`),
  CONSTRAINT `fk_inv_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stock_movements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `movement_type` VARCHAR(32) NOT NULL COMMENT 'in_production,out_sale,in_purchase,adjust,in_return,out_other',
  `qty_delta` INT NOT NULL COMMENT '正數入庫、負數出庫',
  `ref_type` VARCHAR(32) NULL DEFAULT NULL COMMENT 'sales_order,production_order,purchase_order,manual',
  `ref_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_sm_product` (`product_id`),
  KEY `fk_sm_creator` (`created_by_user_id`),
  KEY `idx_sm_ref` (`ref_type`, `ref_id`),
  KEY `idx_sm_created` (`created_at`),
  CONSTRAINT `fk_sm_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_sm_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `suppliers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `phone` VARCHAR(32) NULL DEFAULT NULL,
  `notes` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `purchase_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `po_no` VARCHAR(40) NOT NULL,
  `supplier_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft,received,cancelled',
  `order_date` DATE NOT NULL,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `remark` TEXT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_po_no` (`po_no`),
  KEY `fk_purchase_supplier` (`supplier_id`),
  KEY `fk_purchase_creator` (`created_by_user_id`),
  CONSTRAINT `fk_purchase_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_purchase_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `purchase_order_lines` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purchase_order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '成品或包材皆可掛 products',
  `qty` INT NOT NULL,
  `unit_cost` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `line_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_pol_purchase` (`purchase_order_id`),
  KEY `fk_pol_product` (`product_id`),
  CONSTRAINT `fk_pol_purchase` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_pol_product2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_assignments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `vehicle_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `assignment_date` DATE NOT NULL COMMENT '配送日',
  `status` VARCHAR(32) NOT NULL DEFAULT 'assigned' COMMENT 'assigned,delivering,pending_settlement,completed,cancelled,not_delivered',
  `assigned_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3) NULL DEFAULT NULL COMMENT '辦公室核銷後結案時間（司機回報階段為 NULL）',
  `driver_reported_at` DATETIME(3) NULL DEFAULT NULL COMMENT '司機回報配送結果時間',
  `empty_barrels_returned` INT NOT NULL DEFAULT 0 COMMENT '回收空桶數',
  `cash_received` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現場收款',
  `check_received` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現場收支票',
  `settlement_outcome` VARCHAR(40) NULL DEFAULT NULL COMMENT 'not_delivered,delivered_cash_exact,delivered_cash_short,delivered_cash_over,delivered_no_cash',
  `failure_reason` TEXT NULL COMMENT '未送達原因',
  `expected_amount` DECIMAL(14,2) NULL DEFAULT NULL COMMENT '結案時訂單應收',
  `cash_variance` DECIMAL(14,2) NULL DEFAULT NULL COMMENT '實收-應收',
  `settlement_note` VARCHAR(500) NULL DEFAULT NULL COMMENT '司機備註',
  `office_settled_at` DATETIME(3) NULL DEFAULT NULL COMMENT '辦公室核銷確認時間',
  `estimated_delivery_slot` VARCHAR(120) NULL DEFAULT NULL COMMENT '預計配送時段說明',
  `estimated_delivery_at` DATETIME(3) NULL DEFAULT NULL COMMENT '預計配送時間點',
  `route_stop_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `route_sequence` INT UNSIGNED NULL DEFAULT NULL COMMENT '發布站序；NULL=人工或舊資料',
  `assignment_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_da_order` (`sales_order_id`),
  KEY `fk_da_driver` (`driver_id`),
  KEY `fk_da_vehicle` (`vehicle_id`),
  KEY `fk_da_assigner` (`assigned_by_user_id`),
  KEY `idx_da_driver_date` (`driver_id`, `assignment_date`),
  KEY `idx_da_date_status` (`assignment_date`, `status`),
  KEY `idx_da_route_stop` (`route_stop_id`),
  CONSTRAINT `fk_da_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_da_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_da_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_da_assigner` FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `line_user_id` VARCHAR(64) NULL DEFAULT NULL,
  `channel` VARCHAR(16) NOT NULL DEFAULT 'line',
  `event_type` VARCHAR(40) NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `delivery_assignment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `payload_json` JSON NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `error_message` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_notification_customer_created` (`customer_id`, `created_at`),
  KEY `idx_notification_event_created` (`event_type`, `created_at`),
  KEY `fk_notification_customer` (`customer_id`),
  KEY `fk_notification_so` (`sales_order_id`),
  KEY `fk_notification_da` (`delivery_assignment_id`),
  CONSTRAINT `fk_notification_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_so` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_da` FOREIGN KEY (`delivery_assignment_id`) REFERENCES `delivery_assignments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `line_otp_challenges` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `mobile` VARCHAR(32) NOT NULL,
  `code_hash` VARCHAR(128) NOT NULL,
  `line_user_id` VARCHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_line_otp_mobile_user` (`mobile`, `line_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_assignment_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(32) NOT NULL COMMENT 'depart,arrive,complete,exception',
  `payload_json` JSON NULL COMMENT '備註、座標等擴充',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_de_assignment` (`delivery_assignment_id`),
  CONSTRAINT `fk_de_assignment` FOREIGN KEY (`delivery_assignment_id`) REFERENCES `delivery_assignments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `floor_delivery_bonus_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_assignment_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_line_id` BIGINT UNSIGNED NOT NULL,
  `order_no` VARCHAR(40) NOT NULL,
  `delivery_date` DATE NOT NULL COMMENT '實際配送日（assignment_date）',
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `product_name` VARCHAR(200) NOT NULL COMMENT '商品名稱快照',
  `qty` INT UNSIGNED NOT NULL COMMENT '上樓搬運桶數（使用者填寫）',
  `floor` SMALLINT NOT NULL COMMENT '搬運樓層（>=2 或地下樓）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_floor_bonus_line_assignment_floor` (`delivery_assignment_id`, `sales_order_line_id`, `floor`),
  KEY `idx_floor_bonus_delivery_date` (`delivery_date`),
  KEY `idx_floor_bonus_driver_date` (`driver_id`, `delivery_date`),
  KEY `fk_floor_bonus_assignment` (`delivery_assignment_id`),
  KEY `fk_floor_bonus_order` (`sales_order_id`),
  KEY `fk_floor_bonus_driver` (`driver_id`),
  KEY `fk_floor_bonus_product` (`product_id`),
  CONSTRAINT `fk_floor_bonus_assignment` FOREIGN KEY (`delivery_assignment_id`) REFERENCES `delivery_assignments` (`id`),
  CONSTRAINT `fk_floor_bonus_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`),
  CONSTRAINT `fk_floor_bonus_line` FOREIGN KEY (`sales_order_line_id`) REFERENCES `sales_order_lines` (`id`),
  CONSTRAINT `fk_floor_bonus_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`),
  CONSTRAINT `fk_floor_bonus_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='二樓以上搬運獎金紀錄';

CREATE TABLE `payments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `payment_method` VARCHAR(32) NOT NULL DEFAULT 'cash' COMMENT 'cash,transfer,monthly_writeoff,other',
  `paid_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `recorded_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_pay_customer` (`customer_id`),
  KEY `fk_pay_order` (`sales_order_id`),
  KEY `fk_pay_user` (`recorded_by_user_id`),
  UNIQUE KEY `uk_pay_receipt_voucher` (`receipt_voucher_id`),
  KEY `idx_pay_paid_at` (`paid_at`),
  CONSTRAINT `fk_pay_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_pay_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_pay_user` FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customer_ledger_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `entry_type` VARCHAR(40) NOT NULL COMMENT 'cash_ar_accrual, cash_receipt_alloc, monthly_accrual, monthly_payment, monthly_receipt_alloc, prepaid_topup, prepaid_consumption, ...',
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現金往來：正＝客戶欠公司增加',
  `barrel_delta` INT NOT NULL DEFAULT 0 COMMENT '預付桶：正＝儲值增加',
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `payment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `source_type` VARCHAR(40) NULL DEFAULT NULL,
  `source_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_cle_customer_created` (`customer_id`, `created_at`),
  KEY `fk_cle_order` (`sales_order_id`),
  KEY `fk_cle_payment` (`payment_id`),
  KEY `fk_cle_receipt_voucher` (`receipt_voucher_id`),
  KEY `fk_cle_user` (`created_by_user_id`),
  CONSTRAINT `fk_cle_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customer_prepaid_product_balances` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `balance_barrels` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cppb_customer_product` (`customer_id`, `product_id`),
  KEY `idx_cppb_customer` (`customer_id`),
  KEY `idx_cppb_product` (`product_id`),
  CONSTRAINT `fk_cppb_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_cppb_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `billing_statements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `statement_no` VARCHAR(40) NOT NULL COMMENT '結帳批次編號',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'posted' COMMENT 'posted',
  `cutoff_date` DATE NULL DEFAULT NULL COMMENT '對帳截止日（參考）',
  `untaxed_total` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '月結應收未稅合計（AR 本金）',
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '營業稅（發票彙總）',
  `total_with_tax` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '含稅總額（發票參考）',
  `tax_rate` DECIMAL(8,6) NOT NULL DEFAULT 0.050000,
  `invoice_mode` VARCHAR(32) NOT NULL DEFAULT 'tax_exclusive' COMMENT 'none | tax_inclusive | tax_exclusive',
  `posted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_billing_statements_no` (`statement_no`),
  KEY `fk_bs_customer` (`customer_id`),
  KEY `idx_billing_statements_customer_posted` (`customer_id`, `posted_at`),
  CONSTRAINT `fk_bs_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='月結結帳批次';

CREATE TABLE `billing_statement_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `billing_statement_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `monthly_untaxed_amount` DECIMAL(14,2) NOT NULL COMMENT '該訂單納入本期之月結未稅金額快照',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bso_sales_order` (`sales_order_id`),
  KEY `fk_bso_statement` (`billing_statement_id`),
  CONSTRAINT `fk_bso_statement` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_bso_sales_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ar_documents` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ar_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `billing_statement_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `document_type` VARCHAR(32) NOT NULL DEFAULT 'delivery',
  `billing_type` VARCHAR(32) NOT NULL,
  `document_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `due_date` DATE NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'open',
  `posted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ar_documents_ar_no` (`ar_no`),
  KEY `idx_ar_documents_customer_status` (`customer_id`, `status`),
  KEY `idx_ar_documents_sales_order` (`sales_order_id`),
  KEY `idx_ar_documents_billing_statement` (`billing_statement_id`),
  CONSTRAINT `fk_ar_documents_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_documents_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_documents_billing_statement` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `tax_invoices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `invoice_no` VARCHAR(40) NOT NULL,
  `external_invoice_no` VARCHAR(20) NULL DEFAULT NULL COMMENT '實際發票號碼（財務系統開出）',
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `basis_type` VARCHAR(24) NOT NULL COMMENT 'billing_statement | sales_order | prepayment_topup',
  `billing_statement_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '獨立儲值開票來源',
  `invoice_mode` VARCHAR(32) NOT NULL DEFAULT 'tax_exclusive',
  `untaxed_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `buyer_tax_id` VARCHAR(16) NULL DEFAULT NULL COMMENT '開票當下買方統編',
  `buyer_name` VARCHAR(120) NULL DEFAULT NULL COMMENT '開票當下抬頭',
  `note` TEXT NULL DEFAULT NULL COMMENT '備註（載具、捐贈碼等）',
  `tax_rate` DECIMAL(8,6) NOT NULL DEFAULT 0.050000,
  `status` VARCHAR(24) NOT NULL DEFAULT 'planned' COMMENT 'planned=待開票 | issued=已開票 | voided=作廢',
  `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tax_invoices_no` (`invoice_no`),
  KEY `idx_tax_invoices_customer_issued` (`customer_id`, `issued_at`),
  KEY `idx_tax_invoices_billing_statement` (`billing_statement_id`),
  KEY `idx_tax_invoices_sales_order` (`sales_order_id`),
  KEY `idx_tax_invoices_external_no` (`external_invoice_no`),
  KEY `idx_tax_invoices_status` (`status`),
  KEY `fk_tax_invoices_receipt_voucher` (`receipt_voucher_id`),
  CONSTRAINT `fk_tax_invoices_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_tax_invoices_billing_statement` FOREIGN KEY (`billing_statement_id`) REFERENCES `billing_statements` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_tax_invoices_sales_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_tax_invoices_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='發票主檔（憑證資訊；AR 仍為未稅本金）';

CREATE TABLE `ar_open_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ar_document_id` BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `original_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `allocated_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `outstanding_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `due_date` DATE NULL DEFAULT NULL,
  `expected_collect_date` DATE NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'unpaid',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ar_open_items_customer_status_due` (`customer_id`, `status`, `due_date`),
  KEY `idx_ar_open_items_sales_order` (`sales_order_id`),
  CONSTRAINT `fk_ar_open_items_doc` FOREIGN KEY (`ar_document_id`) REFERENCES `ar_documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_open_items_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_open_items_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `receipt_vouchers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `voucher_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `voucher_type` VARCHAR(24) NOT NULL DEFAULT 'receipt',
  `payment_method` VARCHAR(32) NOT NULL DEFAULT 'cash',
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `unapplied_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(24) NOT NULL DEFAULT 'posted',
  `paid_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_receipt_vouchers_voucher_no` (`voucher_no`),
  KEY `idx_receipt_vouchers_customer_paid` (`customer_id`, `paid_at`),
  CONSTRAINT `fk_receipt_vouchers_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ar_allocation_maps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `receipt_voucher_id` BIGINT UNSIGNED NOT NULL,
  `ar_open_item_id` BIGINT UNSIGNED NOT NULL,
  `allocated_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `allocated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `note` VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ar_alloc_voucher` (`receipt_voucher_id`),
  KEY `idx_ar_alloc_open_item` (`ar_open_item_id`),
  CONSTRAINT `fk_ar_alloc_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_alloc_open_item` FOREIGN KEY (`ar_open_item_id`) REFERENCES `ar_open_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customer_prepayment_wallets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `balance_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customer_wallet_customer` (`customer_id`),
  CONSTRAINT `fk_customer_wallet_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `prepayment_txns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `txn_type` VARCHAR(24) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `balance_after` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_prepayment_txns_customer_created` (`customer_id`, `created_at`),
  KEY `fk_prepayment_txns_voucher` (`receipt_voucher_id`),
  CONSTRAINT `fk_prepayment_txns_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_prepayment_txns_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `credit_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `credit_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `reason` VARCHAR(255) NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'approved',
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_credit_notes_credit_no` (`credit_no`),
  KEY `idx_credit_notes_customer_created` (`customer_id`, `created_at`),
  KEY `fk_credit_notes_order` (`sales_order_id`),
  CONSTRAINT `fk_credit_notes_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_credit_notes_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `credit_note_allocations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `credit_note_id` BIGINT UNSIGNED NOT NULL,
  `ar_open_item_id` BIGINT UNSIGNED NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_credit_alloc_note` (`credit_note_id`),
  KEY `idx_credit_alloc_open_item` (`ar_open_item_id`),
  CONSTRAINT `fk_credit_alloc_note` FOREIGN KEY (`credit_note_id`) REFERENCES `credit_notes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_credit_alloc_open_item` FOREIGN KEY (`ar_open_item_id`) REFERENCES `ar_open_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD CONSTRAINT `fk_pay_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `customer_ledger_entries`
  ADD CONSTRAINT `fk_cle_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI 派單（MVP-A／B）：出勤、設定、方案草稿
-- ---------------------------------------------------------------------------
CREATE TABLE `driver_attendance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `work_date` DATE NOT NULL,
  `shift` VARCHAR(8) NOT NULL DEFAULT 'all' COMMENT 'am|pm|all',
  `is_on_duty` TINYINT(1) NOT NULL DEFAULT 1,
  `work_start_time` TIME NULL DEFAULT NULL,
  `work_end_time` TIME NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `run_zone_ids_json` JSON NULL DEFAULT NULL COMMENT '本班主跑 AddressZone id 陣列',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_driver_attendance_date_shift` (`driver_id`, `work_date`, `shift`),
  KEY `idx_driver_attendance_date` (`work_date`),
  CONSTRAINT `fk_driver_attendance_driver`
    FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_planning_settings` (
  `setting_key` VARCHAR(100) NOT NULL,
  `setting_value` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `updated_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (`setting_key`),
  KEY `idx_dps_updated_by` (`updated_by_user_id`),
  CONSTRAINT `fk_dps_updated_by`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_plans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_date` DATE NOT NULL,
  `shift` VARCHAR(8) NOT NULL DEFAULT 'all' COMMENT 'am|pm|all',
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft|pending_review|published|cancelled',
  `mode` VARCHAR(32) NOT NULL DEFAULT 'suggest_driver' COMMENT 'suggest_driver|full_route',
  `algorithm_version` VARCHAR(64) NULL DEFAULT NULL,
  `weight_profile_key` VARCHAR(100) NULL DEFAULT NULL,
  `total_distance_meters` INT UNSIGNED NULL DEFAULT NULL,
  `total_drive_minutes` INT UNSIGNED NULL DEFAULT NULL,
  `unassigned_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `approved_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `published_at` DATETIME(3) NULL DEFAULT NULL,
  `compute_started_at` DATETIME(3) NULL DEFAULT NULL,
  `compute_finished_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_delivery_plans_date_shift_version` (`plan_date`, `shift`, `version`),
  KEY `idx_delivery_plans_date_status` (`plan_date`, `status`),
  KEY `idx_delivery_plans_created_by` (`created_by_user_id`),
  KEY `idx_delivery_plans_approved_by` (`approved_by_user_id`),
  CONSTRAINT `fk_delivery_plans_created_by`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_delivery_plans_approved_by`
    FOREIGN KEY (`approved_by_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_planning_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `model_version` VARCHAR(64) NULL DEFAULT NULL,
  `prompt_version` VARCHAR(64) NULL DEFAULT NULL,
  `input_summary` JSON NULL DEFAULT NULL,
  `output_summary` JSON NULL DEFAULT NULL,
  `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dpal_plan` (`plan_id`),
  KEY `idx_dpal_action_created` (`action`, `created_at`),
  KEY `idx_dpal_actor` (`actor_user_id`),
  CONSTRAINT `fk_dpal_plan`
    FOREIGN KEY (`plan_id`) REFERENCES `delivery_plans` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_dpal_actor`
    FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_routes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` BIGINT UNSIGNED NOT NULL,
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `vehicle_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sequence_no` INT UNSIGNED NOT NULL DEFAULT 1,
  `departure_at` DATETIME(3) NULL DEFAULT NULL,
  `return_at` DATETIME(3) NULL DEFAULT NULL,
  `total_distance_meters` INT UNSIGNED NULL DEFAULT NULL,
  `total_drive_minutes` INT UNSIGNED NULL DEFAULT NULL,
  `total_barrel_qty` INT UNSIGNED NOT NULL DEFAULT 0,
  `risk_score` DECIMAL(8, 2) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_delivery_routes_plan_driver` (`plan_id`, `driver_id`),
  KEY `idx_delivery_routes_driver` (`driver_id`),
  KEY `idx_delivery_routes_vehicle` (`vehicle_id`),
  CONSTRAINT `fk_delivery_routes_plan`
    FOREIGN KEY (`plan_id`) REFERENCES `delivery_plans` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_delivery_routes_driver`
    FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_delivery_routes_vehicle`
    FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_route_stops` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `route_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `stop_sequence` INT UNSIGNED NOT NULL,
  `eta_at` DATETIME(3) NULL DEFAULT NULL,
  `etd_at` DATETIME(3) NULL DEFAULT NULL,
  `prev_distance_meters` INT UNSIGNED NULL DEFAULT NULL,
  `prev_drive_minutes` INT UNSIGNED NULL DEFAULT NULL,
  `window_start` TIME NULL DEFAULT NULL,
  `window_end` TIME NULL DEFAULT NULL,
  `has_hard_violation` TINYINT(1) NOT NULL DEFAULT 0,
  `violation_codes_json` JSON NULL DEFAULT NULL,
  `ai_explanation` TEXT NULL DEFAULT NULL,
  `manual_adjust_reason` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_route_stop_sequence` (`route_id`, `stop_sequence`),
  UNIQUE KEY `uk_route_stop_order` (`route_id`, `sales_order_id`),
  KEY `idx_route_stops_order` (`sales_order_id`),
  CONSTRAINT `fk_route_stops_route`
    FOREIGN KEY (`route_id`) REFERENCES `delivery_routes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_route_stops_order`
    FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `delivery_plan_unassigned` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `reason_code` VARCHAR(64) NOT NULL,
  `reason_text` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_plan_unassigned_order` (`plan_id`, `sales_order_id`),
  KEY `idx_plan_unassigned_order` (`sales_order_id`),
  CONSTRAINT `fk_plan_unassigned_plan`
    FOREIGN KEY (`plan_id`) REFERENCES `delivery_plans` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_plan_unassigned_order`
    FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `delivery_assignments`
  ADD CONSTRAINT `fk_da_route_stop`
    FOREIGN KEY (`route_stop_id`) REFERENCES `delivery_route_stops` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `delivery_planning_settings` (`setting_key`, `setting_value`)
VALUES
  ('weights.v1', '{"late_minutes":0.35,"drive_time":0.25,"distance":0.15,"workload_balance":0.10,"zone_familiarity":0.05,"fixed_driver":0.05,"high_floor_balance":0.05}'),
  ('service_duration.default_minutes', '10'),
  ('service_duration.per_barrel_minutes', '2'),
  ('service_duration.per_floor_minutes', '1.5'),
  ('shift.am.start', '08:00'),
  ('shift.am.end', '12:00'),
  ('shift.pm.start', '13:00'),
  ('shift.pm.end', '17:30'),
  ('shift.am.cutoff', '15:00'),
  ('shift.pm.cutoff', '10:00'),
  ('sla.general_shifts', '4'),
  ('sla.after_scheduled_shifts', ''),
  ('patrol.early_shifts', '1'),
  ('patrol.late_shifts', '1')
ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`);
