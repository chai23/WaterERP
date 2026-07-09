ALTER TABLE `products`
  ADD COLUMN `product_code` CHAR(3) NULL DEFAULT NULL COMMENT '商品編號（3碼數字，可自訂）' AFTER `id`,
  ADD UNIQUE KEY `uk_products_product_code` (`product_code`);
