-- =============================================================================
-- WaterERP AI 派單 MVP-B：DeliveryPlan / Route / Stop / Unassigned
-- + delivery_assignments 可空 route 關聯（不影響既有列）
-- =============================================================================
-- 設計草案：docs/ai-dispatch/database/
-- 正式套用前複製到 database/migrations/053_delivery_planning_plans.sql
-- 依賴：建議先套用 051、052（出勤／稽核）；本檔不強制 FK 到 audit
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `delivery_plans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_date` DATE NOT NULL,
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
  UNIQUE KEY `uk_delivery_plans_date_version` (`plan_date`, `version`),
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

CREATE TABLE IF NOT EXISTS `delivery_routes` (
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

CREATE TABLE IF NOT EXISTS `delivery_route_stops` (
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

CREATE TABLE IF NOT EXISTS `delivery_plan_unassigned` (
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

-- 可選：audit.plan_id → delivery_plans（052 可能早於 053；此處補 FK）
-- 若 052 尚未套用可略過；套用順序建議 051 → 052 → 053
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'delivery_planning_audit_logs'
    AND CONSTRAINT_NAME = 'fk_dpal_plan'
);
SET @sql := IF(
  @fk_exists = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delivery_planning_audit_logs') = 1,
  'ALTER TABLE `delivery_planning_audit_logs`
     ADD CONSTRAINT `fk_dpal_plan`
     FOREIGN KEY (`plan_id`) REFERENCES `delivery_plans` (`id`)
     ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- delivery_assignments：可空關聯／順序（既有列維持 NULL）
ALTER TABLE `delivery_assignments`
  ADD COLUMN `route_stop_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `estimated_delivery_at`,
  ADD COLUMN `route_sequence` INT UNSIGNED NULL DEFAULT NULL COMMENT '發布站序；NULL=人工或舊資料' AFTER `route_stop_id`;

ALTER TABLE `delivery_assignments`
  ADD KEY `idx_da_route_stop` (`route_stop_id`),
  ADD CONSTRAINT `fk_da_route_stop`
    FOREIGN KEY (`route_stop_id`) REFERENCES `delivery_route_stops` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
