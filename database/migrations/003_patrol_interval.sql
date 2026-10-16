ALTER TABLE `delivery_addresses`
  ADD COLUMN `patrol_interval_weeks` TINYINT UNSIGNED NULL DEFAULT NULL COMMENT '巡查頻率：1=每週、2/3/4=每N週；NULL=不參加' AFTER `patrol_weekday`,
  ADD COLUMN `patrol_weekdays` VARCHAR(16) NULL DEFAULT NULL COMMENT '巡查星期，逗號分隔 1=週一…7=週日' AFTER `patrol_interval_weeks`,
  ADD COLUMN `patrol_cycle_anchor` DATE NULL DEFAULT NULL COMMENT '頻率>=2 的起始週週一' AFTER `patrol_weekdays`;

UPDATE `delivery_addresses`
SET
  `patrol_interval_weeks` = 1,
  `patrol_weekdays` = CAST(`patrol_weekday` AS CHAR)
WHERE `patrol_weekday` IS NOT NULL
  AND (`patrol_weekdays` IS NULL OR `patrol_weekdays` = '');
