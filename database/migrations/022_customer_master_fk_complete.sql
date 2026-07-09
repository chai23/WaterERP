-- 接續 021（若 021 在 INSERT 階段失敗）：匯入文字主檔、建立外鍵、移除舊欄位

INSERT IGNORE INTO `address_zones` (`name`, `sort_order`)
SELECT DISTINCT TRIM(`address_zone`), 0
FROM `customers`
WHERE `address_zone` IS NOT NULL AND TRIM(`address_zone`) <> '';

INSERT IGNORE INTO `affiliated_companies` (`name`, `sort_order`)
SELECT DISTINCT TRIM(`affiliated_company`), 0
FROM `customers`
WHERE `affiliated_company` IS NOT NULL AND TRIM(`affiliated_company`) <> '';

-- 若外鍵欄位尚未建立（021 未完成時）
SET @has_zone_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'address_zone_id'
);

SET @sql_add_cols = IF(
  @has_zone_col = 0,
  'ALTER TABLE `customers`
    ADD COLUMN `address_zone_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `default_cash_invoice_mode`,
    ADD COLUMN `affiliated_company_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `address_zone_id`',
  'SELECT 1'
);
PREPARE stmt FROM @sql_add_cols;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `customers` c
INNER JOIN `address_zones` z ON z.`name` = TRIM(c.`address_zone`)
SET c.`address_zone_id` = z.`id`
WHERE c.`address_zone` IS NOT NULL AND TRIM(c.`address_zone`) <> '';

UPDATE `customers` c
INNER JOIN `affiliated_companies` co ON co.`name` = TRIM(c.`affiliated_company`)
SET c.`affiliated_company_id` = co.`id`
WHERE c.`affiliated_company` IS NOT NULL AND TRIM(c.`affiliated_company`) <> '';

SET @has_old_zone := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'address_zone'
);

SET @sql_drop_old = IF(
  @has_old_zone > 0,
  'ALTER TABLE `customers` DROP COLUMN `address_zone`, DROP COLUMN `affiliated_company`',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql_drop_old;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND CONSTRAINT_NAME = 'fk_customers_address_zone'
);

SET @sql_add_fk = IF(
  @has_fk = 0,
  'ALTER TABLE `customers`
    ADD KEY `fk_customers_address_zone` (`address_zone_id`),
    ADD KEY `fk_customers_affiliated_company` (`affiliated_company_id`),
    ADD CONSTRAINT `fk_customers_address_zone` FOREIGN KEY (`address_zone_id`) REFERENCES `address_zones` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `fk_customers_affiliated_company` FOREIGN KEY (`affiliated_company_id`) REFERENCES `affiliated_companies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt3 FROM @sql_add_fk;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
