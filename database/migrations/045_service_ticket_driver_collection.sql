-- 服務單：司機收款歸屬（日收款核對用）
-- 可重跑：欄位／索引／外鍵已存在時略過

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'service_tickets'
    AND column_name = 'collector_driver_id'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `service_tickets`
     ADD COLUMN `collector_driver_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT ''負責跟客戶收服務費的司機'' AFTER `sales_order_id`,
     ADD COLUMN `collection_date` DATE NULL DEFAULT NULL COMMENT ''司機日收款核對歸屬日'' AFTER `collector_driver_id`,
     ADD COLUMN `driver_cash_received` DECIMAL(14,2) NULL DEFAULT NULL COMMENT ''該司機回報帶回現金'' AFTER `collection_date`,
     ADD COLUMN `driver_check_received` DECIMAL(14,2) NULL DEFAULT NULL COMMENT ''該司機回報帶回支票'' AFTER `driver_cash_received`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'service_tickets'
    AND index_name = 'idx_service_tickets_collector_date'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE `service_tickets` ADD KEY `idx_service_tickets_collector_date` (`collector_driver_id`, `collection_date`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'service_tickets'
    AND constraint_name = 'fk_service_tickets_collector_driver'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE `service_tickets`
     ADD CONSTRAINT `fk_service_tickets_collector_driver`
     FOREIGN KEY (`collector_driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 既有已結案現金單：推估歸屬司機／日期；若已有 Payment 視為當場收現
UPDATE `service_tickets` st
LEFT JOIN `payments` p ON p.sales_order_id = st.sales_order_id AND p.payment_method = 'cash'
SET
  st.collector_driver_id = COALESCE(st.collector_driver_id, st.return_driver_id, st.assess_driver_id),
  st.collection_date = COALESCE(st.collection_date, st.return_date, st.assess_date, DATE(st.closed_at)),
  st.driver_cash_received = CASE
    WHEN st.driver_cash_received IS NOT NULL THEN st.driver_cash_received
    WHEN st.billing_type = 'cash' AND p.id IS NOT NULL THEN COALESCE(st.charge_amount, 0)
    WHEN st.billing_type = 'cash' THEN 0
    ELSE NULL
  END,
  st.driver_check_received = CASE
    WHEN st.driver_check_received IS NOT NULL THEN st.driver_check_received
    WHEN st.billing_type = 'cash' THEN 0
    ELSE NULL
  END
WHERE st.status = 'closed' AND st.charge_amount IS NOT NULL AND st.charge_amount > 0;
