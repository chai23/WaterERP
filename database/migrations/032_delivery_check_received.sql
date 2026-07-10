-- 司機配送回報：現場收取支票金額（與 cash_received 分開，供日結核對）
ALTER TABLE `delivery_assignments`
  ADD COLUMN `check_received` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '現場收支票' AFTER `cash_received`;
