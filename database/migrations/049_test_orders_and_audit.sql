-- =============================================================================
-- WaterERP P4：測試訂單標記 + 操作稽核日誌
-- =============================================================================
-- sales_orders.is_test / test_batch_id：標記可排除於報表、可按批次清除的測試單
-- operation_audit_logs：開單／改配送數量／司機回報／辦公室核銷等操作前後快照
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE `sales_orders`
  ADD COLUMN `is_test` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '測試資料標記；報表預設排除' AFTER `source`,
  ADD COLUMN `test_batch_id` VARCHAR(64) NULL DEFAULT NULL COMMENT '測試批次 ID（可選）' AFTER `is_test`,
  ADD KEY `idx_sales_orders_is_test` (`is_test`),
  ADD KEY `idx_sales_orders_test_batch` (`test_batch_id`, `is_test`);

CREATE TABLE `operation_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL COMMENT 'order_create|line_qty_change|driver_report|office_settlement|test_batch_clear|…',
  `entity_type` VARCHAR(64) NULL DEFAULT NULL COMMENT 'sales_order|delivery_assignment|test_batch|…',
  `entity_id` VARCHAR(64) NULL DEFAULT NULL,
  `before_json` JSON NULL DEFAULT NULL,
  `after_json` JSON NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_oal_action_created` (`action`, `created_at`),
  KEY `idx_oal_entity` (`entity_type`, `entity_id`),
  KEY `idx_oal_actor` (`actor_user_id`),
  CONSTRAINT `fk_oal_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
