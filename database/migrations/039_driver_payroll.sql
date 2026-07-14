-- 司機月薪資：底薪、商品配送單價、空桶／搬運單價設定

ALTER TABLE `drivers`
  ADD COLUMN `base_salary` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '月基本底薪' AFTER `max_barrel_qty`;

ALTER TABLE `products`
  ADD COLUMN `driver_delivery_wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '司機每單位配送薪資' AFTER `cost_price`;

CREATE TABLE IF NOT EXISTS `payroll_settings` (
  `id` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `empty_barrel_wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '回收空桶每桶薪資（固定）',
  `floor_bonus_wage` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '上樓搬運每桶獎金',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `payroll_settings` (`id`, `empty_barrel_wage`, `floor_bonus_wage`)
VALUES (1, 0.00, 0.00)
ON DUPLICATE KEY UPDATE `id` = `id`;
