-- 部署時先停止 API。保留完整單號與所有 ID、帳務參照；本檔可重跑。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'sales_orders' AND column_name = 'short_order_no') = 0,
  'ALTER TABLE sales_orders ADD COLUMN short_order_no VARCHAR(24) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE()
    AND table_name = 'sales_orders' AND index_name = 'uk_sales_order_short_no') = 0,
  'CREATE UNIQUE INDEX uk_sales_order_short_no ON sales_orders (short_order_no)', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS order_number_sequences (
  day_key CHAR(8) NOT NULL PRIMARY KEY,
  last_number INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 舊 SO 編號含原開單日期，優先保留；非標準舊編號採 created_at 的台灣日期。
-- 已編配的短單號不改動；計數器也不回退。需 MySQL 8（ROW_NUMBER）。
START TRANSACTION;
INSERT INTO order_number_sequences (day_key, last_number)
SELECT CONCAT('20', LEFT(short_order_no, 6)), MAX(CAST(SUBSTRING_INDEX(short_order_no, '-', -1) AS UNSIGNED))
FROM sales_orders WHERE short_order_no REGEXP '^[0-9]{6}-[0-9]+$'
GROUP BY CONCAT('20', LEFT(short_order_no, 6))
ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number));

CREATE TEMPORARY TABLE short_order_backfill AS
SELECT dated.id, dated.day_key,
  COALESCE(seq.last_number, 0) + ROW_NUMBER() OVER (PARTITION BY dated.day_key ORDER BY dated.created_at, dated.id) AS serial
FROM (
  SELECT id, created_at,
    CASE WHEN order_no REGEXP '^SO20[0-9]{6}' THEN SUBSTRING(order_no, 3, 8)
      ELSE DATE_FORMAT(DATE_ADD(created_at, INTERVAL 8 HOUR), '%Y%m%d') END AS day_key
  FROM sales_orders WHERE short_order_no IS NULL
) dated LEFT JOIN order_number_sequences seq ON seq.day_key = dated.day_key;

UPDATE sales_orders so JOIN short_order_backfill b ON so.id = b.id
SET so.short_order_no = CONCAT(SUBSTRING(b.day_key, 3), '-', LPAD(CAST(b.serial AS CHAR), GREATEST(3, CHAR_LENGTH(CAST(b.serial AS CHAR))), '0'))
WHERE so.short_order_no IS NULL;

INSERT INTO order_number_sequences (day_key, last_number)
SELECT day_key, MAX(serial) FROM short_order_backfill GROUP BY day_key
ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number));
DROP TEMPORARY TABLE short_order_backfill;
COMMIT;
