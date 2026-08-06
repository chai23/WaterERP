-- 客戶生命週期：流失原因、狀態、事件稽核

CREATE TABLE `customer_churn_reasons` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(40) NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_churn_reason_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `customer_churn_reasons` (`code`, `label`, `sort_order`) VALUES
  ('competitor', '轉用他牌', 10),
  ('business_closed', '歇業／倒閉', 20),
  ('relocated', '搬遷（超出配送範圍）', 30),
  ('price', '價格因素', 40),
  ('service', '服務不滿意', 50),
  ('no_demand', '無需求／改喝自來水', 60),
  ('credit', '帳款／信用問題', 70),
  ('internal', '公司整併／內部調整', 80),
  ('other', '其他', 90);

ALTER TABLE `customers`
  ADD COLUMN `lifecycle_status` VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT 'active|churned' AFTER `line_bound_at`,
  ADD COLUMN `churned_at` DATE NULL DEFAULT NULL COMMENT '決定不再服務日' AFTER `lifecycle_status`,
  ADD COLUMN `churn_reason_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `churned_at`,
  ADD COLUMN `churn_reason_note` VARCHAR(500) NULL DEFAULT NULL AFTER `churn_reason_id`,
  ADD KEY `idx_customers_lifecycle` (`lifecycle_status`, `churned_at`),
  ADD KEY `fk_customers_churn_reason` (`churn_reason_id`),
  ADD CONSTRAINT `fk_customers_churn_reason` FOREIGN KEY (`churn_reason_id`) REFERENCES `customer_churn_reasons` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `customer_lifecycle_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(24) NOT NULL COMMENT 'created|churned|reactivated',
  `effective_at` DATE NOT NULL COMMENT '事件生效日',
  `churn_reason_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `recorded_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_cle_customer_effective` (`customer_id`, `effective_at`),
  KEY `idx_cle_event_effective` (`event_type`, `effective_at`),
  KEY `fk_cle_churn_reason` (`churn_reason_id`),
  KEY `fk_cle_user` (`recorded_by_user_id`),
  CONSTRAINT `fk_cle_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_churn_reason` FOREIGN KEY (`churn_reason_id`) REFERENCES `customer_churn_reasons` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_cle_user` FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 既有客戶補一筆建檔事件（生效日＝建檔日）
INSERT INTO `customer_lifecycle_events` (`customer_id`, `event_type`, `effective_at`, `note`)
SELECT `id`, 'created', DATE(`created_at`), '系統補登（migration 047）'
FROM `customers`;
