-- 套印標語：供新增訂單快速選取寫入備註（非商品主檔）
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

INSERT INTO `print_slogans` (`title`, `body`, `sort_order`) VALUES
  ('保管提醒', '本單據為重要依據，請妥善保管', 10),
  ('調漲通知', '調漲通知', 20),
  ('押金提醒', 'PC未收押金，如遺失每只300', 30),
  ('預付用畢', '預付之水費含此次已用畢', 40),
  ('結束標記', '結束', 90);
