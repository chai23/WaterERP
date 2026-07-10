-- 發票紀錄擴充：實際發票號碼、買方快照、獨立儲值來源、planned/issued 狀態

ALTER TABLE `tax_invoices`
  ADD COLUMN `external_invoice_no` VARCHAR(20) NULL DEFAULT NULL COMMENT '實際發票號碼（財務系統開出）' AFTER `invoice_no`,
  ADD COLUMN `buyer_tax_id` VARCHAR(16) NULL DEFAULT NULL COMMENT '開票當下買方統編' AFTER `total_amount`,
  ADD COLUMN `buyer_name` VARCHAR(120) NULL DEFAULT NULL COMMENT '開票當下抬頭' AFTER `buyer_tax_id`,
  ADD COLUMN `note` TEXT NULL DEFAULT NULL COMMENT '備註（載具、捐贈碼等）' AFTER `buyer_name`,
  ADD COLUMN `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '獨立儲值開票來源' AFTER `sales_order_id`,
  MODIFY COLUMN `basis_type` VARCHAR(24) NOT NULL COMMENT 'billing_statement | sales_order | prepayment_topup',
  MODIFY COLUMN `status` VARCHAR(24) NOT NULL DEFAULT 'planned' COMMENT 'planned=待開票 | issued=已開票 | voided=作廢';

ALTER TABLE `tax_invoices`
  ADD KEY `idx_tax_invoices_external_no` (`external_invoice_no`),
  ADD KEY `idx_tax_invoices_status` (`status`),
  ADD KEY `fk_tax_invoices_receipt_voucher` (`receipt_voucher_id`),
  ADD CONSTRAINT `fk_tax_invoices_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 舊資料無實際發票號碼，改為待開票
UPDATE `tax_invoices` SET `status` = 'planned' WHERE `status` = 'issued' AND (`external_invoice_no` IS NULL OR `external_invoice_no` = '');
