-- 服務單結案入帳：一張服務單最多對應一張帳務訂單（NULL 可多筆）
-- 可重跑：索引／商品已存在時略過

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'service_tickets'
    AND index_name = 'uq_service_tickets_sales_order'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE `service_tickets` ADD UNIQUE KEY `uq_service_tickets_sales_order` (`sales_order_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 系統服務費商品（若不存在；應用層 ensureServiceFeeProduct 也會建立）
INSERT INTO `products` (
  `sku`, `name`, `unit`, `counts_deposit_barrel`, `consumes_prepaid_barrel`,
  `available_on_liff`, `sale_price`, `cost_price`, `driver_delivery_wage`, `is_active`,
  `created_at`, `updated_at`
)
SELECT
  'SYS-SERVICE-FEE', '飲水機服務費', '式', 0, 0,
  0, 0, 0, 0, 1,
  NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `products` WHERE `sku` = 'SYS-SERVICE-FEE' LIMIT 1);
