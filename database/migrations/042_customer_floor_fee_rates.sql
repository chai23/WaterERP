-- 客戶樓層搬運費（向客戶收費；與司機獎金 payroll_floor_bonus_rates 分離）

CREATE TABLE IF NOT EXISTS `customer_floor_fee_rates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `floor` SMALLINT NOT NULL COMMENT '樓層：2=二樓、3=三樓、-1=地下一樓',
  `unit_price` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '該樓層每桶向客戶收取金額',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customer_floor_fee_rates_floor` (`floor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `customer_floor_fee_rates` (`floor`, `unit_price`)
SELECT f.floor_no, f.price
FROM (
  SELECT 2 AS floor_no, 10.00 AS price
  UNION ALL SELECT 3, 20.00
  UNION ALL SELECT -1, 10.00
) AS f
WHERE NOT EXISTS (SELECT 1 FROM `customer_floor_fee_rates` LIMIT 1);

-- 系統商品：訂單搬運費明細掛此商品（不出庫、不計押桶）
INSERT INTO `products` (
  `sku`, `name`, `unit`, `counts_deposit_barrel`, `consumes_prepaid_barrel`,
  `available_on_liff`, `sale_price`, `cost_price`, `driver_delivery_wage`, `is_active`,
  `created_at`, `updated_at`
)
SELECT
  'SYS-FLOOR-FEE', '樓層搬運費', '桶', 0, 0, 0, 0.00, 0.00, 0.00, 1,
  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `products` WHERE `sku` = 'SYS-FLOOR-FEE' LIMIT 1);
