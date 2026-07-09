# AR SOP 重構說明

本版將收款流程調整為 SOP 導向：物流（配送）與金流（收款）解耦，並新增標準 AR 單據與 N:M 沖帳映射。

## 新增核心模型

- `ar_documents`: 每筆出貨拋轉的 AR 主單（含 `ar_no`）。
- `ar_open_items`: 可被沖帳的未清項，狀態 `unpaid/partially_paid/paid/overdue`。
- `receipt_vouchers`: 收款憑證主檔。
- `ar_allocation_maps`: 收款憑證對應應收項目的沖帳明細（支援 N:M）。
- `customer_prepayment_wallets` + `prepayment_txns`: 金額型預收款帳戶（與既有押桶並行）。
- `credit_notes` + `credit_note_allocations`: 折讓（紅字沖銷）流程。

## 新增 API

- `GET /api/ar/open-items`
- `POST /api/ar/receipt-vouchers`
- `GET /api/ar/receipt-vouchers`
- `POST /api/customers/:customerId/prepayment-topup-money`
- `POST /api/ar/prepayment-apply`
- `POST /api/ar/credit-notes`
- `GET /api/reports/ar-aging`
- `GET /api/reports/ar-exceptions`
- `GET /api/reports/driver-cash-close`
- `GET /api/billing/statements`

## 流程調整摘要

1. 建立訂單時同時產生 `ArDocument + ArOpenItem`（AR_ID 與訂單號分離）。
2. 收款一律先建 `ReceiptVoucher`，再經 `ArAllocationMap` 沖帳。
3. 溢收自動轉入金額型預收款錢包。
4. 折讓以 `CreditNote` 沖帳，不刪除原始單據。
5. 分派前檢查客戶逾期與信用額度，必要時鎖單。

## 切換與驗證

1. 套用 migration：`database/migrations/012_ar_sop_rebuild.sql`
2. 回填舊單 AR：`npm run ar:backfill -w apps/api`
3. 對帳驗證：`npm run ar:reconcile -w apps/api`
