-- LINE LIFF 訂水：客戶綁定、訂單來源、派車 ETA、推播／OTP 紀錄

ALTER TABLE `customers`
  ADD COLUMN `line_user_id` VARCHAR(64) NULL DEFAULT NULL COMMENT 'LINE userId（LIFF 綁定）' AFTER `allow_prepaid_overdraft`,
  ADD COLUMN `line_bound_at` DATETIME(3) NULL DEFAULT NULL COMMENT 'LINE 綁定時間' AFTER `line_user_id`,
  ADD UNIQUE KEY `uk_customers_line_user_id` (`line_user_id`);

ALTER TABLE `sales_orders`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'admin' COMMENT 'admin | liff' AFTER `cash_invoice_mode`,
  ADD KEY `idx_so_source` (`source`);

ALTER TABLE `delivery_assignments`
  ADD COLUMN `estimated_delivery_slot` VARCHAR(120) NULL DEFAULT NULL COMMENT '預計配送時段說明' AFTER `office_settled_at`,
  ADD COLUMN `estimated_delivery_at` DATETIME(3) NULL DEFAULT NULL COMMENT '預計配送時間點' AFTER `estimated_delivery_slot`;

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
