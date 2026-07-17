-- 移除已廢止欄位 payroll_settings.floor_bonus_wage
-- 搬運獎金自 040/041 起改依樓層單價（payroll_floor_bonus_rates），此欄位不再使用
-- 可重跑：欄位不存在時略過

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'payroll_settings'
    AND column_name = 'floor_bonus_wage'
);
SET @sql := IF(
  @col_exists = 1,
  'ALTER TABLE `payroll_settings` DROP COLUMN `floor_bonus_wage`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
