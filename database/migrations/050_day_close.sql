-- =============================================================================
-- WaterERP P5：每日關帳鎖定
-- =============================================================================
-- day_close_locks：以營業日為主鍵；unlocked_at IS NULL 表示目前鎖定中
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `day_close_locks` (
  `business_date` DATE NOT NULL COMMENT '營業日（本地日）',
  `locked_at` DATETIME(3) NOT NULL,
  `locked_by_user_id` BIGINT UNSIGNED NOT NULL,
  `unlocked_at` DATETIME(3) NULL DEFAULT NULL,
  `unlocked_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`business_date`),
  KEY `idx_day_close_locked_by` (`locked_by_user_id`),
  KEY `idx_day_close_unlocked_by` (`unlocked_by_user_id`),
  CONSTRAINT `fk_day_close_locked_by` FOREIGN KEY (`locked_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_day_close_unlocked_by` FOREIGN KEY (`unlocked_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
