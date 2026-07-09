-- 預付桶儲值：核銷後先記「待入帳桶數」，待本單現金應收沖清後再入 prepaid_barrel_balance

ALTER TABLE `sales_orders`
  ADD COLUMN `pending_prepaid_topup_barrels` INT NOT NULL DEFAULT 0 COMMENT '預付桶儲值待入帳桶數（本單現金 AR 全沖清後入餘額）' AFTER `monthly_period_paid`;
