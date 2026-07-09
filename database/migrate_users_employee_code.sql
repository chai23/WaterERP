-- 既有資料庫升級：登入改為「員編」、phone 改為聯絡手機（可空、可不唯一）
-- 執行前請備份。適用於舊版 users 以 phone 為唯一登入欄位之結構。
-- 用法：mysql -u... -p water_erp < database/migrate_users_employee_code.sql

SET NAMES utf8mb4;

ALTER TABLE `users`
  ADD COLUMN `employee_code` VARCHAR(50) NULL COMMENT '登入帳號（員編）' AFTER `id`;

UPDATE `users` SET `employee_code` = `phone` WHERE `employee_code` IS NULL;

ALTER TABLE `users`
  MODIFY COLUMN `employee_code` VARCHAR(50) NOT NULL COMMENT '登入帳號（員編）',
  ADD UNIQUE KEY `uk_users_employee_code` (`employee_code`);

ALTER TABLE `users` DROP INDEX `uk_users_phone`;

ALTER TABLE `users`
  MODIFY COLUMN `phone` VARCHAR(32) NULL DEFAULT NULL COMMENT '聯絡手機';

-- 司機檔 employee_code 與 users.employee_code 對齊（供列表／舊查詢一致）
UPDATE `drivers` d
INNER JOIN `users` u ON u.`id` = d.`user_id`
SET d.`employee_code` = u.`employee_code`;
