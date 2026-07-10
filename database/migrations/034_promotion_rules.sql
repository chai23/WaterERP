-- 優惠活動：規則主檔、飲水機贈品規則、訂單明細追溯欄位

CREATE TABLE `promotion_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rule_key` VARCHAR(50) NOT NULL COMMENT '唯一代碼',
  `display_name` VARCHAR(100) NOT NULL,
  `description` TEXT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `config` JSON NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_promotion_rules_rule_key` (`rule_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `promotion_dispenser_gift_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `trigger_product_id` BIGINT UNSIGNED NOT NULL COMMENT '飲水機商品',
  `gift_product_id` BIGINT UNSIGNED NOT NULL COMMENT '贈送商品',
  `gift_qty_per_unit` INT NOT NULL DEFAULT 1 COMMENT '每台贈送桶數',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dispenser_gift_trigger` (`trigger_product_id`),
  KEY `fk_dispenser_gift_trigger` (`trigger_product_id`),
  KEY `fk_dispenser_gift_gift` (`gift_product_id`),
  CONSTRAINT `fk_dispenser_gift_trigger` FOREIGN KEY (`trigger_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_dispenser_gift_gift` FOREIGN KEY (`gift_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `sales_order_lines`
  ADD COLUMN `is_promotion_gift` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否為優惠贈品列' AFTER `invoice_mode`,
  ADD COLUMN `promotion_rule_key` VARCHAR(50) NULL DEFAULT NULL COMMENT '套用優惠規則代碼' AFTER `is_promotion_gift`,
  ADD COLUMN `promotion_note` VARCHAR(200) NULL DEFAULT NULL COMMENT '贈品說明' AFTER `promotion_rule_key`;

INSERT INTO `promotion_rules` (`rule_key`, `display_name`, `description`, `is_enabled`, `config`, `sort_order`)
VALUES
  (
    'prepaid_topup_bonus',
    '預收滿額贈桶',
    '預付桶儲值滿 N 桶贈送 M 桶（同商品，可累計）',
    0,
    JSON_OBJECT('minBarrels', 10, 'bonusBarrels', 2),
    1
  ),
  (
    'dispenser_purchase_gift',
    '購買飲水機贈商品',
    '購買指定飲水機商品，每台贈送指定桶裝水',
    0,
    JSON_OBJECT(),
    2
  );
