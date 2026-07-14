-- 訂單明細：補送標記（破桶補水；預設免費、仍計未收回空桶）

ALTER TABLE `sales_order_lines`
  ADD COLUMN `is_replenishment` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '補送（破桶補水等）' AFTER `promotion_note`;
