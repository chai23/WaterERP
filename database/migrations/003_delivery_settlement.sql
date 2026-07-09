-- 配送核銷：未送達／收款差異紀錄（在已存在的 water_erp 上執行）
-- USE water_erp;

ALTER TABLE `delivery_assignments`
  ADD COLUMN `settlement_outcome` VARCHAR(40) NULL DEFAULT NULL COMMENT 'not_delivered,delivered_cash_exact,...' AFTER `cash_received`,
  ADD COLUMN `failure_reason` TEXT NULL COMMENT '未送達原因' AFTER `settlement_outcome`,
  ADD COLUMN `expected_amount` DECIMAL(14,2) NULL DEFAULT NULL COMMENT '結案時訂單應收' AFTER `failure_reason`,
  ADD COLUMN `cash_variance` DECIMAL(14,2) NULL DEFAULT NULL COMMENT '實收-應收' AFTER `expected_amount`,
  ADD COLUMN `settlement_note` VARCHAR(500) NULL DEFAULT NULL COMMENT '司機備註' AFTER `cash_variance`;
