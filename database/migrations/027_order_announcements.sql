-- 訂單套印公告：全站常態 + 特定期間
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
