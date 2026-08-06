-- 現金應收改以 AR 為唯一來源：清除舊版 cash_* 雙寫流水（測試／歷史殘留）

DELETE FROM `customer_ledger_entries`
WHERE `entry_type` IN (
  'cash_ar_accrual',
  'cash_receipt_alloc',
  'cash_variance_over',
  'cash_variance_short',
  'cash_offset_order'
);
