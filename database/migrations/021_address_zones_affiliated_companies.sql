-- 地址分區、隸屬公司主檔；客戶改以外鍵關聯

CREATE TABLE `address_zones` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_address_zones_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `affiliated_companies` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_affiliated_companies_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 將既有文字欄位匯入為主檔（若欄位存在）
INSERT INTO `address_zones` (`name`, `sort_order`)
SELECT DISTINCT TRIM(`address_zone`), 0
FROM `customers`
WHERE `address_zone` IS NOT NULL AND TRIM(`address_zone`) <> ''
ON DUPLICATE KEY UPDATE `sort_order` = `sort_order`;

INSERT INTO `affiliated_companies` (`name`, `sort_order`)
SELECT DISTINCT TRIM(`affiliated_company`), 0
FROM `customers`
WHERE `affiliated_company` IS NOT NULL AND TRIM(`affiliated_company`) <> ''
ON DUPLICATE KEY UPDATE `sort_order` = `sort_order`;

ALTER TABLE `customers`
  ADD COLUMN `address_zone_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `default_cash_invoice_mode`,
  ADD COLUMN `affiliated_company_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `address_zone_id`,
  ADD KEY `fk_customers_address_zone` (`address_zone_id`),
  ADD KEY `fk_customers_affiliated_company` (`affiliated_company_id`),
  ADD CONSTRAINT `fk_customers_address_zone` FOREIGN KEY (`address_zone_id`) REFERENCES `address_zones` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_customers_affiliated_company` FOREIGN KEY (`affiliated_company_id`) REFERENCES `affiliated_companies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `customers` c
INNER JOIN `address_zones` z ON z.`name` = TRIM(c.`address_zone`)
SET c.`address_zone_id` = z.`id`
WHERE c.`address_zone` IS NOT NULL AND TRIM(c.`address_zone`) <> '';

UPDATE `customers` c
INNER JOIN `affiliated_companies` co ON co.`name` = TRIM(c.`affiliated_company`)
SET c.`affiliated_company_id` = co.`id`
WHERE c.`affiliated_company` IS NOT NULL AND TRIM(c.`affiliated_company`) <> '';

ALTER TABLE `customers`
  DROP COLUMN `address_zone`,
  DROP COLUMN `affiliated_company`;
