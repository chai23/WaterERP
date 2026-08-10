-- =============================================================================
-- WaterERP：班次制一鍵排程（上午／下午）
-- 加法；不改既有人工派單語意。
-- =============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- sales_orders：訂單種類、SLA 班次、鎖定／偏好司機
-- ---------------------------------------------------------------------------
ALTER TABLE `sales_orders`
  ADD COLUMN `order_kind` VARCHAR(24) NULL DEFAULT NULL COMMENT 'general|patrol|replenishment|emergency' AFTER `time_window_priority`,
  ADD COLUMN `dispatch_priority` VARCHAR(16) NULL DEFAULT NULL COMMENT 'normal|urgent|must' AFTER `order_kind`,
  ADD COLUMN `earliest_date` DATE NULL DEFAULT NULL AFTER `dispatch_priority`,
  ADD COLUMN `earliest_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm' AFTER `earliest_date`,
  ADD COLUMN `latest_date` DATE NULL DEFAULT NULL AFTER `earliest_shift`,
  ADD COLUMN `latest_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm' AFTER `latest_date`,
  ADD COLUMN `preferred_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm|any' AFTER `latest_shift`,
  ADD COLUMN `dispatch_locked` TINYINT(1) NOT NULL DEFAULT 0 AFTER `preferred_shift`,
  ADD COLUMN `preferred_driver_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `dispatch_locked`,
  ADD COLUMN `required_driver_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `preferred_driver_id`;

ALTER TABLE `sales_orders`
  ADD KEY `idx_so_order_kind` (`order_kind`),
  ADD KEY `idx_so_latest_shift` (`latest_date`, `latest_shift`),
  ADD KEY `idx_so_preferred_driver` (`preferred_driver_id`),
  ADD KEY `idx_so_required_driver` (`required_driver_id`),
  ADD CONSTRAINT `fk_so_preferred_driver`
    FOREIGN KEY (`preferred_driver_id`) REFERENCES `drivers` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_so_required_driver`
    FOREIGN KEY (`required_driver_id`) REFERENCES `drivers` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 舊巡單：備註開頭為週期巡查
UPDATE `sales_orders`
  SET `order_kind` = 'patrol'
  WHERE `order_kind` IS NULL AND `remark` LIKE '【週期巡查】%';

-- ---------------------------------------------------------------------------
-- driver_attendance：班別（舊列 shift=all 表示全日）
-- ---------------------------------------------------------------------------
ALTER TABLE `driver_attendance`
  ADD COLUMN `shift` VARCHAR(8) NOT NULL DEFAULT 'all' COMMENT 'am|pm|all' AFTER `work_date`;

ALTER TABLE `driver_attendance`
  DROP INDEX `uk_driver_attendance_date`,
  ADD UNIQUE KEY `uk_driver_attendance_date_shift` (`driver_id`, `work_date`, `shift`);

-- ---------------------------------------------------------------------------
-- delivery_plans.shift
-- ---------------------------------------------------------------------------
ALTER TABLE `delivery_plans`
  ADD COLUMN `shift` VARCHAR(8) NOT NULL DEFAULT 'all' COMMENT 'am|pm|all' AFTER `plan_date`;

ALTER TABLE `delivery_plans`
  DROP INDEX `uk_delivery_plans_date_version`,
  ADD UNIQUE KEY `uk_delivery_plans_date_shift_version` (`plan_date`, `shift`, `version`);

-- ---------------------------------------------------------------------------
-- delivery_assignments.assignment_shift（可空；人工舊單維持 NULL）
-- ---------------------------------------------------------------------------
ALTER TABLE `delivery_assignments`
  ADD COLUMN `assignment_shift` VARCHAR(8) NULL DEFAULT NULL COMMENT 'am|pm' AFTER `route_sequence`;

-- ---------------------------------------------------------------------------
-- 預設班次／SLA 設定
-- ---------------------------------------------------------------------------
INSERT INTO `delivery_planning_settings` (`setting_key`, `setting_value`)
VALUES
  ('shift.am.start', '08:00'),
  ('shift.am.end', '12:00'),
  ('shift.pm.start', '13:00'),
  ('shift.pm.end', '17:30'),
  ('shift.am.cutoff', '15:00'),
  ('shift.pm.cutoff', '10:00'),
  ('sla.general_shifts', '4'),
  ('sla.after_scheduled_shifts', ''),
  ('patrol.early_shifts', '1'),
  ('patrol.late_shifts', '1')
ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`);
