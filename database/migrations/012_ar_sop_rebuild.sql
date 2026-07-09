-- AR SOP 重構：新增標準 AR 單據、沖帳映射、金額型預收與折讓模型

ALTER TABLE `payments`
  ADD COLUMN `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `recorded_by_user_id`,
  ADD UNIQUE KEY `uk_payments_receipt_voucher` (`receipt_voucher_id`);

ALTER TABLE `customer_ledger_entries`
  ADD COLUMN `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `payment_id`,
  ADD COLUMN `source_type` VARCHAR(40) NULL DEFAULT NULL AFTER `receipt_voucher_id`,
  ADD COLUMN `source_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `source_type`,
  ADD KEY `fk_cle_receipt_voucher` (`receipt_voucher_id`);

CREATE TABLE `ar_documents` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ar_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `document_type` VARCHAR(32) NOT NULL DEFAULT 'delivery',
  `billing_type` VARCHAR(32) NOT NULL,
  `document_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `due_date` DATE NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'open',
  `posted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ar_documents_ar_no` (`ar_no`),
  KEY `idx_ar_documents_customer_status` (`customer_id`, `status`),
  KEY `idx_ar_documents_sales_order` (`sales_order_id`),
  CONSTRAINT `fk_ar_documents_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_documents_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ar_open_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ar_document_id` BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `original_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `allocated_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `outstanding_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `due_date` DATE NULL DEFAULT NULL,
  `expected_collect_date` DATE NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'unpaid',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ar_open_items_customer_status_due` (`customer_id`, `status`, `due_date`),
  KEY `idx_ar_open_items_sales_order` (`sales_order_id`),
  KEY `fk_ar_open_items_doc` (`ar_document_id`),
  CONSTRAINT `fk_ar_open_items_doc` FOREIGN KEY (`ar_document_id`) REFERENCES `ar_documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_open_items_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_open_items_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `receipt_vouchers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `voucher_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `voucher_type` VARCHAR(24) NOT NULL DEFAULT 'receipt',
  `payment_method` VARCHAR(32) NOT NULL DEFAULT 'cash',
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `unapplied_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(24) NOT NULL DEFAULT 'posted',
  `paid_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_receipt_vouchers_voucher_no` (`voucher_no`),
  KEY `idx_receipt_vouchers_customer_paid` (`customer_id`, `paid_at`),
  CONSTRAINT `fk_receipt_vouchers_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ar_allocation_maps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `receipt_voucher_id` BIGINT UNSIGNED NOT NULL,
  `ar_open_item_id` BIGINT UNSIGNED NOT NULL,
  `allocated_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `allocated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `note` VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ar_alloc_voucher` (`receipt_voucher_id`),
  KEY `idx_ar_alloc_open_item` (`ar_open_item_id`),
  CONSTRAINT `fk_ar_alloc_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_ar_alloc_open_item` FOREIGN KEY (`ar_open_item_id`) REFERENCES `ar_open_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customer_prepayment_wallets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `balance_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customer_wallet_customer` (`customer_id`),
  CONSTRAINT `fk_customer_wallet_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `prepayment_txns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `receipt_voucher_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `txn_type` VARCHAR(24) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `balance_after` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_prepayment_txns_customer_created` (`customer_id`, `created_at`),
  KEY `fk_prepayment_txns_voucher` (`receipt_voucher_id`),
  CONSTRAINT `fk_prepayment_txns_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_prepayment_txns_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `credit_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `credit_no` VARCHAR(40) NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `sales_order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `reason` VARCHAR(255) NULL DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'approved',
  `created_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_credit_notes_credit_no` (`credit_no`),
  KEY `idx_credit_notes_customer_created` (`customer_id`, `created_at`),
  KEY `fk_credit_notes_order` (`sales_order_id`),
  CONSTRAINT `fk_credit_notes_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_credit_notes_order` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `credit_note_allocations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `credit_note_id` BIGINT UNSIGNED NOT NULL,
  `ar_open_item_id` BIGINT UNSIGNED NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_credit_alloc_note` (`credit_note_id`),
  KEY `idx_credit_alloc_open_item` (`ar_open_item_id`),
  CONSTRAINT `fk_credit_alloc_note` FOREIGN KEY (`credit_note_id`) REFERENCES `credit_notes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_credit_alloc_open_item` FOREIGN KEY (`ar_open_item_id`) REFERENCES `ar_open_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD CONSTRAINT `fk_pay_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `customer_ledger_entries`
  ADD CONSTRAINT `fk_cle_receipt_voucher` FOREIGN KEY (`receipt_voucher_id`) REFERENCES `receipt_vouchers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
