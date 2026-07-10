-- 搬運紀錄改為司機回報階段填寫；同一訂單明細可依不同樓層建立多筆紀錄

ALTER TABLE `floor_delivery_bonus_records`
  ADD KEY `idx_floor_bonus_line` (`sales_order_line_id`);

ALTER TABLE `floor_delivery_bonus_records`
  DROP INDEX `uk_floor_bonus_line_assignment`,
  ADD KEY `idx_floor_bonus_line_assignment_floor` (`delivery_assignment_id`, `sales_order_line_id`, `floor`);
