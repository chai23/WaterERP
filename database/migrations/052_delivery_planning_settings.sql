-- =============================================================================
-- WaterERP AI 派單 MVP-A：規劃設定與稽核日誌
-- =============================================================================
-- 設計草案：docs/ai-dispatch/database/
-- 正式套用前複製到 database/migrations/052_delivery_planning_settings.sql
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `delivery_planning_settings` (
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

CREATE TABLE IF NOT EXISTS `delivery_planning_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '無 plan 時可空（如純 parse）',
  `action` VARCHAR(64) NOT NULL,
  `model_version` VARCHAR(64) NULL DEFAULT NULL,
  `prompt_version` VARCHAR(64) NULL DEFAULT NULL,
  `input_summary` JSON NULL DEFAULT NULL COMMENT '最小化個資',
  `output_summary` JSON NULL DEFAULT NULL,
  `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dpal_plan` (`plan_id`),
  KEY `idx_dpal_action_created` (`action`, `created_at`),
  KEY `idx_dpal_actor` (`actor_user_id`),
  CONSTRAINT `fk_dpal_actor`
    FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 預設權重（可之後由設定頁覆寫；JSON 字串）
INSERT INTO `delivery_planning_settings` (`setting_key`, `setting_value`)
VALUES
  ('weights.v1', '{"late_minutes":0.35,"drive_time":0.25,"distance":0.15,"workload_balance":0.10,"zone_familiarity":0.05,"fixed_driver":0.05,"high_floor_balance":0.05}'),
  ('service_duration.default_minutes', '10'),
  ('service_duration.per_barrel_minutes', '2'),
  ('service_duration.per_floor_minutes', '1.5')
ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`);
