-- 月結：截止日篩選（office_settled_at）、FIFO 沖銷進度（monthly_received_amount）
-- 執行前請備份資料庫

SET NAMES utf8mb4;

ALTER TABLE `sales_orders`
  ADD COLUMN `office_settled_at` DATETIME(3) NULL DEFAULT NULL COMMENT '辦公室核銷送達完成時間（月結截止日篩選）' AFTER `billing_period_key`,
  ADD COLUMN `monthly_received_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '月結已沖銷入帳累計' AFTER `office_settled_at`;

-- 歷史訂單：由配送任務帶回最大 office_settled_at
UPDATE `sales_orders` so
INNER JOIN (
  SELECT `sales_order_id`, MAX(`office_settled_at`) AS `mx`
  FROM `delivery_assignments`
  WHERE `office_settled_at` IS NOT NULL
  GROUP BY `sales_order_id`
) da ON da.`sales_order_id` = so.`id`
SET so.`office_settled_at` = da.`mx`
WHERE so.`status` = 'completed';

-- 已標記月結已付者：沖銷進度視為全額（舊流程未拆單）
UPDATE `sales_orders` so
INNER JOIN `customers` c ON c.`id` = so.`customer_id`
SET so.`monthly_received_amount` = so.`total_amount`
WHERE so.`monthly_period_paid` = 1
  AND (so.`billing_type_at_order` = 'monthly' OR (so.`billing_type_at_order` IS NULL AND c.`billing_type` = 'monthly'));

ALTER TABLE `sales_orders`
  ADD KEY `idx_so_customer_office_settled` (`customer_id`, `office_settled_at`);
