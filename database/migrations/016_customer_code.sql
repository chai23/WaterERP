ALTER TABLE `customers`
  ADD COLUMN `customer_code` CHAR(6) NULL DEFAULT NULL COMMENT '客戶編號（6碼數字，可自訂）' AFTER `id`,
  ADD UNIQUE KEY `uk_customers_customer_code` (`customer_code`);
