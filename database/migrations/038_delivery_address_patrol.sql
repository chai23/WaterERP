-- 送貨點週期巡查：星期、目標水位、預設商品

ALTER TABLE `delivery_addresses`
  ADD COLUMN `patrol_weekday` TINYINT UNSIGNED NULL DEFAULT NULL COMMENT '巡查星期：1=週一 … 7=週日；NULL=不參加巡查' AFTER `barrels_on_site`,
  ADD COLUMN `target_water_level` INT UNSIGNED NULL DEFAULT NULL COMMENT '目標水位（桶）；現場不足時補到此量' AFTER `patrol_weekday`,
  ADD COLUMN `patrol_product_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '巡查預設商品' AFTER `target_water_level`,
  ADD KEY `idx_addr_patrol_weekday` (`patrol_weekday`),
  ADD KEY `fk_addr_patrol_product` (`patrol_product_id`),
  ADD CONSTRAINT `fk_addr_patrol_product` FOREIGN KEY (`patrol_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
