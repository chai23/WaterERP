-- 送貨點樓層主檔 + 二樓以上搬運獎金紀錄

ALTER TABLE `delivery_addresses`
  ADD COLUMN `delivery_floor` SMALLINT NULL DEFAULT NULL
  COMMENT '送貨樓層（1=一樓, 2=二樓, -1=地下一樓；NULL=未設定）'
  AFTER `address_line`;

CREATE TABLE `floor_delivery_bonus_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_assignment_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_line_id` BIGINT UNSIGNED NOT NULL,
  `order_no` VARCHAR(40) NOT NULL,
  `delivery_date` DATE NOT NULL COMMENT '實際配送日（assignment_date）',
  `driver_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `product_name` VARCHAR(200) NOT NULL COMMENT '商品名稱快照',
  `qty` INT UNSIGNED NOT NULL COMMENT '上樓搬運桶數（使用者填寫）',
  `floor` SMALLINT NOT NULL COMMENT '搬運樓層（>=2 或地下樓）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_floor_bonus_line_assignment` (`sales_order_line_id`, `delivery_assignment_id`),
  KEY `idx_floor_bonus_delivery_date` (`delivery_date`),
  KEY `idx_floor_bonus_driver_date` (`driver_id`, `delivery_date`),
  KEY `fk_floor_bonus_assignment` (`delivery_assignment_id`),
  KEY `fk_floor_bonus_order` (`sales_order_id`),
  KEY `fk_floor_bonus_driver` (`driver_id`),
  KEY `fk_floor_bonus_product` (`product_id`),
  CONSTRAINT `fk_floor_bonus_assignment` FOREIGN KEY (`delivery_assignment_id`) REFERENCES `delivery_assignments` (`id`),
  CONSTRAINT `fk_floor_bonus_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`),
  CONSTRAINT `fk_floor_bonus_line` FOREIGN KEY (`sales_order_line_id`) REFERENCES `sales_order_lines` (`id`),
  CONSTRAINT `fk_floor_bonus_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`),
  CONSTRAINT `fk_floor_bonus_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='二樓以上搬運獎金紀錄';
