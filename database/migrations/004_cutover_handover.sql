-- One installation has one audited opening handover. Draft snapshots never post balances.
CREATE TABLE IF NOT EXISTS cutover_handover (
  id INT NOT NULL PRIMARY KEY,
  revision INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'empty',
  snapshot JSON NULL,
  created_by BIGINT UNSIGNED NULL,
  applied_by BIGINT UNSIGNED NULL,
  applied_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO cutover_handover (id) VALUES (1);

CREATE TABLE IF NOT EXISTS cutover_monthly_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_key VARCHAR(128) NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  order_day DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  note TEXT NOT NULL,
  billing_statement_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_cutover_monthly_source (source_key),
  KEY ix_cutover_monthly_pending (customer_id, billing_statement_id, order_day),
  CONSTRAINT fk_cutover_monthly_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_cutover_monthly_statement FOREIGN KEY (billing_statement_id) REFERENCES billing_statements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
