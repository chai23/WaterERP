-- 搬運獎金：依樓層設定不同單價

CREATE TABLE IF NOT EXISTS `payroll_floor_bonus_rates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `floor` SMALLINT NOT NULL COMMENT '樓層：2=二樓、-1=地下一樓（與搬運紀錄 floor 一致）',
  `wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '該樓層每桶獎金',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_payroll_floor_bonus_rates_floor` (`floor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 若先前有全域搬運單價，預設帶入 3、2、-1 樓
INSERT INTO `payroll_floor_bonus_rates` (`floor`, `wage`)
SELECT f.floor_no, COALESCE((SELECT `floor_bonus_wage` FROM `payroll_settings` WHERE `id` = 1), 0)
FROM (
  SELECT 3 AS floor_no UNION ALL SELECT 2 UNION ALL SELECT -1
) AS f
WHERE NOT EXISTS (SELECT 1 FROM `payroll_floor_bonus_rates` LIMIT 1);
