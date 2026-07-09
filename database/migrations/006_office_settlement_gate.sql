-- 司機回報與辦公室核銷分離：新增司機回報時間、辦公室核銷時間；任務狀態 pending_settlement = 待辦公室核銷

ALTER TABLE `delivery_assignments`
  MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'assigned'
    COMMENT 'assigned,delivering,pending_settlement,completed,cancelled,not_delivered',
  MODIFY COLUMN `completed_at` DATETIME(3) NULL DEFAULT NULL
    COMMENT '辦公室核銷後結案時間（司機回報階段為 NULL）',
  ADD COLUMN `driver_reported_at` DATETIME(3) NULL DEFAULT NULL COMMENT '司機回報配送結果時間' AFTER `completed_at`,
  ADD COLUMN `office_settled_at` DATETIME(3) NULL DEFAULT NULL COMMENT '辦公室核銷確認時間' AFTER `settlement_note`;

-- 既有已結案資料：視為司機回報與辦公室核銷發生於同一時間（舊行為）
UPDATE `delivery_assignments`
SET
  `driver_reported_at` = COALESCE(`driver_reported_at`, `completed_at`),
  `office_settled_at` = COALESCE(`office_settled_at`, `completed_at`)
WHERE `status` IN ('completed', 'not_delivered')
  AND `completed_at` IS NOT NULL;
