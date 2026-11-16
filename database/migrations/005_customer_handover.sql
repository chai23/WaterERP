-- 舊系統客戶須逐戶完成上線交接後，才能在新系統新增訂單。
SET @handover_col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'handover_completed_at'
);
SET @handover_col_sql := IF(
  @handover_col_exists = 0,
  'ALTER TABLE customers ADD COLUMN handover_completed_at DATETIME(3) NULL DEFAULT NULL COMMENT ''上線交接完成時間；舊系統客戶未完成前不能新增訂單'' AFTER churn_reason_note',
  'SELECT 1'
);
PREPARE handover_col_stmt FROM @handover_col_sql;
EXECUTE handover_col_stmt;
DEALLOCATE PREPARE handover_col_stmt;
