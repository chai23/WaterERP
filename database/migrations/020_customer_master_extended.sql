-- 客戶主檔擴充：聯絡人、手機、統編、預設發票、地址分區、隸屬公司、常態備註
ALTER TABLE `customers`
  ADD COLUMN `contact_name` VARCHAR(100) NULL DEFAULT NULL COMMENT '聯絡人' AFTER `name`,
  ADD COLUMN `mobile` VARCHAR(32) NULL DEFAULT NULL COMMENT '手機' AFTER `phone`,
  ADD COLUMN `tax_id` VARCHAR(8) NULL DEFAULT NULL COMMENT '統一編號' AFTER `mobile`,
  ADD COLUMN `default_cash_invoice_mode` VARCHAR(32) NULL DEFAULT 'none' COMMENT 'none | tax_inclusive | tax_exclusive' AFTER `billing_type`,
  ADD COLUMN `address_zone` VARCHAR(50) NULL DEFAULT NULL COMMENT '地址分區（路線／區域代碼）' AFTER `default_cash_invoice_mode`,
  ADD COLUMN `affiliated_company` VARCHAR(200) NULL DEFAULT NULL COMMENT '隸屬公司' AFTER `address_zone`,
  ADD COLUMN `standing_remark` TEXT NULL COMMENT '客戶常態備註（列印、開單參考）' AFTER `notes`;

ALTER TABLE `delivery_addresses`
  ADD COLUMN `contact_mobile` VARCHAR(32) NULL DEFAULT NULL COMMENT '現場手機' AFTER `contact_phone`;
