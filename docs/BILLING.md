# 客戶結帳與帳務規則（三種方式）

本文件對應後台與 API 實作：**現金**、**月結**、**預付（桶）**。

**操作教學（開單／司機／核銷／櫃台）**：請見 [USER_GUIDE_CASH_AND_SETTLEMENT.md](./USER_GUIDE_CASH_AND_SETTLEMENT.md)。

## 1. 客戶主檔

| 欄位 | 說明 |
|------|------|
| `billing_type` | `cash` \| `monthly` \| `prepaid` |
| `monthly_settlement_day` | 月結客戶可選 1–31，作為對帳／溝通**參考日**（實際篩選以「月結對帳」選定之**截止日**為準，見 §4） |
| `prepaid_barrel_balance` | 預付客戶可用桶數（與流水同步；儲值與核銷會更新） |
| `allow_prepaid_overdraft` | 預付不足時是否仍允許辦公室核銷送達（預設否） |

## 2. 訂單欄位

| 欄位 | 說明 |
|------|------|
| `billing_type_at_order` | 下單當下自客戶主檔快照，避免日後改主檔影響舊單解讀 |
| `order_cash_adjustment` | **已廢止**（保留欄位）。現金應收改由 AR open items 與收款沖帳處理。 |
| `billing_period_key` | **月結**：核銷送達完成時寫入，格式 `YYYY-MM`（**報表／相容**，對帳篩選改見 `office_settled_at`） |
| `office_settled_at` | **月結**：與配送任務辦公室核銷時間一致；**對帳截止日**篩選用（見 §4） |
| `monthly_received_amount` | **月結**：已沖銷入帳累計；**已清**＝`>= total_amount` |
| `monthly_period_paid` | 月結該筆訂單是否已**全額**沖完（FIFO 後） |

## 3. 客戶流水帳 `customer_ledger_entries`

此表仍用於**預付桶**等非 AR 金額事件；**現金應收／收款餘額不再以此表為準**。

- **`amount` 正負號**  
  - **正**：客戶欠公司增加（歷史／相容分錄）  
  - **負**：客戶欠公司減少  
- **`barrel_delta`（預付桶）**  
  - **正**：預付桶增加（儲值）  
  - **負**：預付桶減少（核銷扣桶）  

常見 `entry_type`：

| entry_type | 說明 |
|------------|------|
| `cash_ar_accrual` / `cash_receipt_alloc` / `cash_variance_*` / `cash_offset_order` | **已廢止雙寫**（歷史殘留）；現金應收請看 AR |
| `prepaid_topup` | 預付儲值；`barrel_delta > 0` |
| `prepaid_consumption` | 核銷扣桶；`barrel_delta < 0` |
| `ar_credit_note` 等 | 折讓等輔助紀錄 |

**往來餘額**（下單提示、摘要 API）：`Σ(有效 AR outstanding) − 預收錢包`（見 `GET /api/customers/:id/billing-summary` 的 `accountBalance`）。後台「帳務流水」UI 由 AR 立帳／沖帳合成（`ar_accrual` / `ar_receipt_alloc`），非直接列出 `cash_*`。

## 4. 月結：曆月期別 vs. 結帳截止日（FIFO）

- **`billing_period_key`**：訂單於**辦公室核銷送達**結案時寫入，為核銷完成日所屬**曆月** `YYYY-MM`，供報表／舊 API 相容。  
- **對帳與收款**：以 **`office_settled_at`（辦公室核銷完成時間）** 與使用者選擇之 **結帳截止日 `YYYY-MM-DD`** 篩選待結清訂單。語意：**納入** `office_settled_at` **嚴格小於**截止日當日 **00:00:00（本地）** 之訂單（即「不含截止日當天 0 點起」之核銷）。  
- **立帳**：月結對帳批次開立請款單時建立月結 `ar_documents`／`ar_open_items`。  
  - **稅外加**：AR／應收＝未稅＋營業稅（與發票含稅總額一致）  
  - **含稅**：AR＝含稅售價總額  
  - **不開發票**：AR＝訂單月結金額  
- **收款**：於 AR 作業台收款沖帳（可多次）；依 open item 到期日／規則沖銷。短收時僅沖到金額用罄，**不可**將未沖完訂單標為已清。沖帳後會回填 `monthly_received_amount`／`monthly_period_paid`。  
- **`monthly_settlement_day`**（客戶主檔）：仍為溝通／參考日，**不**自動當作系統截止日。

## 5. 未收回空桶 vs 預付扣桶 vs 預付桶儲值

- **計入押桶**（`counts_deposit_barrel`）：核銷送達時，該明細出貨量是否納入該訂單**送貨地址**的「未收回空桶」與司機回報回桶之計算（例如紙箱水可不計入）。**不**代表是否從預付桶餘額扣桶。
- 桶數儲存於 `delivery_addresses.barrels_on_site`（**依送貨點分開**）；API 回傳之 `customers.barrels_on_site` 為各地址加總（相容舊欄位，不再寫入）。
- **預付扣桶**（`consumes_prepaid_barrel`）：僅當該明細結帳為 **預付（桶）** 時，核銷送達是否自 `prepaid_barrel_balance` 扣減 `qty_ordered`。與是否計入押桶無關。
- **預付桶儲值明細**（`sales_order_lines.line_purpose = prepaid_barrel_topup`）：開單時加一筆商品×數量×售價，該列為**現金應收**；**不出庫**。核銷送達後與一般現金單相同會**立帳／欠款**（司機未收足亦可核銷，差額為應收）。**桶數不立即入帳**：核銷時將待入帳桶數寫入 `sales_orders.pending_prepaid_topup_barrels`；僅當本訂單在 **AR 上之現金應收**全部沖清（現場收款、匯款沖帳、預收扣抵、折讓沖銷等使該單現金 open items 之 `outstanding_amount` 皆為 0）時，才將桶數加進 `prepaid_barrel_balance` 並寫入 `prepaid_topup` 流水。

**不足時**：若 `prepaid_barrel_balance < 應扣桶數` 且 `allow_prepaid_overdraft = false`，API **拒絕核銷**（400）；若允許透支則餘額可為負。

## 6. 現金：應收立帳與收款沖銷（AR-only）

與 ERP 一致：**應收（AR）**與**收款（receipt voucher／allocation）**分開；司機只報**實收**，沖帳以 AR 為唯一來源。

### 6.1 立帳時機

- **開單／司機確認配送數量／樓層費變更**：寫入或重建 `ar_documents` + `ar_open_items`（現金份額；稅外加時為含稅）。
- **不再**於辦公室核銷時寫 `cash_ar_accrual`／`cash_receipt_alloc` 到 `customer_ledger_entries`。

### 6.2 司機畫面與 `expected_amount`

- **建議收款總額**（`driverBillingHints.cashDue`）＝  
  **本單未清 AR** ＋ **可催收舊欠 AR** − **預收錢包**（見 `calcCashDueByUnifiedRule`）。  
- 月結份額一般不列入當場應收（依客戶／明細結帳方式）；月結貨款以對帳批次為準。

`delivery_assignments.expected_amount` 於司機回報時與上述一致；差額＝實收 − 建議收款。

### 6.3 辦公室核銷時入帳順序

1. 結案配送／出庫／預付扣桶等營運動作。  
2. 若有現金／支票實收 → `postSettlementReceiptByMethod`：建立收款單，**本單 AR 優先**，再依到期日 FIFO 沖可催收舊欠。  
3. 沖完仍有剩餘 → 轉入**預收錢包**（可再自動抵扣）。

### 6.4 辦公室核銷時間（可自訂）

`POST /api/settlements/approve` 可選：

- **`officeSettledAt`**：ISO 日期時間（後台「核銷訂單」頁以 `datetime-local` 傳送）。  
- **`officeSettledAtYmd`**：僅 `YYYY-MM-DD`（本地該日 00:00）；未傳 `officeSettledAt` 時使用。

兩者皆未傳時，辦公室核銷完成時間為**伺服器當下時間**。自訂時間會寫入配送任務與訂單之 **`office_settled_at`**／**`completed_at`**、月結之 **`billing_period_key`**，並用於現金 **`payments.paid_at`**、相關出庫紀錄之時間戳（測試或補登用）。

---

## 7. 核銷送達時分支（摘要）

| 結帳方式 | 現金 `Payment`／收款單 | AR／其他 |
|----------|------------------------|----------|
| 現金 | 實收 &gt; 0 時建立收款單並沖 AR（本單優先） | 開單時已立現金 AR；溢收進預收錢包 |
| 月結 | **不**建立當場全額現金收款 | 寫 `billing_period_key`、`office_settled_at`；月結 AR 於結帳批次立帳 |
| 預付 | 訂單**無現金列**時不建立當場收款；若有「預付桶儲值」等**現金列**則依 §6 沖 AR | 預付列出貨扣 `prepaid_barrel_balance`、`prepaid_consumption`；儲值桶數待本單現金 AR 沖清後 `prepaid_topup` |

## 8. 月結對帳後台

- `GET /api/billing/monthly-unsettled?customerId=`：尚未開立批次的已完成月結訂單（不限截止日），回傳尚欠合計。後台對帳頁使用此端點。  
- ~~`GET /api/billing/monthly-pending`~~：**已移除**；改用 `monthly-unsettled` 與請款單／statements 流程。  
- ~~`GET /api/billing/monthly-orders`~~：**已移除**；改用 `monthly-unsettled` 與請款單／statements 流程。  
- ~~`POST /api/billing/monthly-receive`~~：**已移除**（回傳 HTTP 410）；改由一般請款單／收款沖帳流程處理。  
- ~~`POST /api/billing/monthly-mark-paid`~~：**已移除**（回傳 HTTP 410）；改由一般請款單／收款沖帳流程處理。

## 9. 客戶查詢帳務明細（後台）

- `GET /api/customers/:customerId/billing-summary`：往來餘額等摘要。  
- `GET /api/customers/:customerId/billing-ledger?limit=`（預設 200，上限 500）：**帳務流水**分錄列表，新→舊排列，每筆含 `balanceAfter`（本筆入帳後往來餘額）。  
- `GET /api/customers/:customerId/payments?limit=`：**銷單收款**（`payments` 表），與流水互補對照。

---

若與現場作業不一致，請以本檔為準更新程式或反向更新本檔。
