-- 客戶主檔：客戶端桶數（手動維護）
ALTER TABLE `customers`
  ADD COLUMN `barrels_on_site` INT NOT NULL DEFAULT 0 COMMENT '客戶端留置／欠桶數' AFTER `notes`;
