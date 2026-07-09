-- 司機負荷上限：最高訂單數、最大運送桶數
ALTER TABLE `drivers`
  ADD COLUMN `max_order_count` INT UNSIGNED NOT NULL DEFAULT 20 COMMENT '可負荷最高訂單數' AFTER `employee_code`,
  ADD COLUMN `max_barrel_qty` INT UNSIGNED NOT NULL DEFAULT 150 COMMENT '可運送最大桶數' AFTER `max_order_count`;
