-- =============================================================================
-- WaterERP AI 派單 MVP-A：地址地理、訂單時窗、司機班表、當日出勤
-- =============================================================================
-- 設計草案：位於 docs/ai-dispatch/database/
-- 正式套用前請複製到 database/migrations/051_delivery_planning_geo.sql
-- 僅加法；不修改既有欄位語意。
-- =============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- delivery_addresses：地理座標（舊列 geocode_status 預設 pending）
-- ---------------------------------------------------------------------------
ALTER TABLE `delivery_addresses`
  ADD COLUMN `latitude` DECIMAL(10, 7) NULL DEFAULT NULL COMMENT 'WGS84 緯度' AFTER `notes`,
  ADD COLUMN `longitude` DECIMAL(10, 7) NULL DEFAULT NULL COMMENT 'WGS84 經度' AFTER `latitude`,
  ADD COLUMN `geocode_status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|ok|ambiguous|failed|manual_confirmed' AFTER `longitude`,
  ADD COLUMN `geocoded_address` VARCHAR(500) NULL DEFAULT NULL COMMENT 'geocode 正規化地址' AFTER `geocode_status`,
  ADD COLUMN `geocoded_at` DATETIME(3) NULL DEFAULT NULL AFTER `geocoded_address`,
  ADD COLUMN `location_accuracy` VARCHAR(32) NULL DEFAULT NULL AFTER `geocoded_at`,
  ADD COLUMN `manual_location_confirmed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理員地圖確認' AFTER `location_accuracy`;

CREATE INDEX `idx_addr_geocode_status` ON `delivery_addresses` (`geocode_status`);

-- ---------------------------------------------------------------------------
-- sales_orders：可空時窗（未填 = 無硬時窗，行為與現況相同）
-- ---------------------------------------------------------------------------
ALTER TABLE `sales_orders`
  ADD COLUMN `delivery_window_start` TIME NULL DEFAULT NULL COMMENT '最早可送' AFTER `scheduled_delivery_date`,
  ADD COLUMN `delivery_window_end` TIME NULL DEFAULT NULL COMMENT '最晚可送' AFTER `delivery_window_start`,
  ADD COLUMN `preferred_time_note` VARCHAR(200) NULL DEFAULT NULL AFTER `delivery_window_end`,
  ADD COLUMN `service_duration_minutes` INT UNSIGNED NULL DEFAULT NULL AFTER `preferred_time_note`,
  ADD COLUMN `allow_early_delivery` TINYINT(1) NULL DEFAULT NULL AFTER `service_duration_minutes`,
  ADD COLUMN `allow_late_delivery` TINYINT(1) NULL DEFAULT NULL AFTER `allow_early_delivery`,
  ADD COLUMN `time_window_priority` VARCHAR(16) NULL DEFAULT NULL COMMENT 'required|preferred' AFTER `allow_late_delivery`;

-- ---------------------------------------------------------------------------
-- drivers：可空班表／depot／區域熟悉（不改 is_active / 容量欄位語意）
-- ---------------------------------------------------------------------------
ALTER TABLE `drivers`
  ADD COLUMN `work_start_time` TIME NULL DEFAULT NULL AFTER `max_barrel_qty`,
  ADD COLUMN `work_end_time` TIME NULL DEFAULT NULL AFTER `work_start_time`,
  ADD COLUMN `depot_latitude` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `work_end_time`,
  ADD COLUMN `depot_longitude` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `depot_latitude`,
  ADD COLUMN `familiar_zone_ids_json` JSON NULL DEFAULT NULL COMMENT 'AddressZone id 陣列' AFTER `depot_longitude`,
  ADD COLUMN `can_high_floor` TINYINT(1) NULL DEFAULT NULL AFTER `familiar_zone_ids_json`;

-- ---------------------------------------------------------------------------
-- driver_attendance：當日出勤（新表，可整表 DROP）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `driver_attendance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `work_date` DATE NOT NULL,
  `is_on_duty` TINYINT(1) NOT NULL DEFAULT 1,
  `work_start_time` TIME NULL DEFAULT NULL,
  `work_end_time` TIME NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_driver_attendance_date` (`driver_id`, `work_date`),
  KEY `idx_driver_attendance_date` (`work_date`),
  CONSTRAINT `fk_driver_attendance_driver`
    FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
