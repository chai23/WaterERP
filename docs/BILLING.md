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
| `order_cash_adjustment` | **已廢止**（保留欄位）。現金應收不再由此欄加減；改見 §6「立帳＋FIFO」。 |
| `billing_period_key` | **月結**：核銷送達完成時寫入，格式 `YYYY-MM`（**報表／相容**，對帳篩選改見 `office_settled_at`） |
| `office_settled_at` | **月結**：與配送任務辦公室核銷時間一致；**對帳截止日**篩選用（見 §4） |
| `monthly_received_amount` | **月結**：已沖銷入帳累計；**已清**＝`>= total_amount` |
| `monthly_period_paid` | 月結該筆訂單是否已**全額**沖完（FIFO 後） |

## 3. 客戶流水帳 `customer_ledger_entries`

- **`amount` 正負號（現金／月結金額）**  
  - **正**：客戶欠公司**增加**（現金應收立帳、月結應收等）  
  - **負**：客戶欠公司**減少**（現金收款沖銷、多收、月結收款等）  
- **`barrel_delta`（預付桶）**  
  - **正**：預付桶增加（儲值）  
  - **負**：預付桶減少（核銷扣桶）  

常見 `entry_type`（現金／ERP 沖銷）：

| entry_type | 說明 |
|------------|------|
| `cash_ar_accrual` | 現金客戶核銷送達時，**本張訂單**應收立帳；`amount = 訂單 total_amount` |
| `cash_receipt_alloc` | 將司機實收依 **FIFO**（`sales_order_id` 由小到大）沖最舊未結清應收；`amount` 為負 |
| `cash_variance_over` | 實收經 FIFO 沖完所有未清應收後**仍有剩餘**（多收）；`amount` 為負 |
| `cash_variance_short` / `cash_offset_order` | **舊版**核銷遺留分錄；仍納入「現金應收」加總以利舊資料銜接 |
| `monthly_accrual` | 月結核銷時應收；`amount = 訂單應收` |
| `monthly_payment` | **舊版**整期一筆沖帳；`amount = -收款金額`（新流程改 `monthly_receipt_alloc`） |
| `monthly_receipt_alloc` | 月結對帳收款依 **FIFO** 沖各訂單；`amount` 為負；帶 `sales_order_id`、`payment_id` |
| `prepaid_topup` | 預付儲值；`barrel_delta > 0` |
| `prepaid_consumption` | 核銷扣桶；`barrel_delta < 0` |

**往來餘額**（下單提示、摘要 API）：`SUM(amount)`（可與 `GET /api/customers/:id/billing-summary` 的 `accountBalance` 對照；含月結等非現金項目）。

## 4. 月結：曆月期別 vs. 結帳截止日（FIFO）

- **`billing_period_key`**：訂單於**辦公室核銷送達**結案時寫入，為核銷完成日所屬**曆月** `YYYY-MM`，供報表／舊 API 相容。  
- **對帳與收款**：以 **`office_settled_at`（辦公室核銷完成時間）** 與使用者選擇之 **結帳截止日 `YYYY-MM-DD`** 篩選待結清訂單。語意：**納入** `office_settled_at` **嚴格小於**截止日當日 **00:00:00（本地）** 之訂單（即「不含截止日當天 0 點起」之核銷）。  
- **收款**：可多次入帳；依 **`office_settled_at` 早→晚**，再 **`id` 小→大** **FIFO** 沖銷；寫入 `monthly_receipt_alloc`。短收時僅沖到金額用罄，**不可**將未沖完訂單標為已清。  
- **`monthly_settlement_day`**（客戶主檔）：仍為溝通／參考日，**不**自動當作系統截止日。

## 5. 未收回空桶 vs 預付扣桶 vs 預付桶儲值

- **計入押桶**（`counts_deposit_barrel`）：核銷送達時，該明細出貨量是否納入該訂單**送貨地址**的「未收回空桶」與司機回報回桶之計算（例如紙箱水可不計入）。**不**代表是否從預付桶餘額扣桶。
- 桶數儲存於 `delivery_addresses.barrels_on_site`（**依送貨點分開**）；API 回傳之 `customers.barrels_on_site` 為各地址加總（相容舊欄位，不再寫入）。
- **預付扣桶**（`consumes_prepaid_barrel`）：僅當該明細結帳為 **預付（桶）** 時，核銷送達是否自 `prepaid_barrel_balance` 扣減 `qty_ordered`。與是否計入押桶無關。
- **預付桶儲值明細**（`sales_order_lines.line_purpose = prepaid_barrel_topup`）：開單時加一筆商品×數量×售價，該列為**現金應收**；**不出庫**。核銷送達後與一般現金單相同會**立帳／欠款**（司機未收足亦可核銷，差額為應收）。**桶數不立即入帳**：核銷時將待入帳桶數寫入 `sales_orders.pending_prepaid_topup_barrels`；僅當本訂單在 **AR 上之現金應收**全部沖清（現場收款、匯款沖帳、預收扣抵、折讓沖銷等使該單現金 open items 之 `outstanding_amount` 皆為 0）時，才將桶數加進 `prepaid_barrel_balance` 並寫入 `prepaid_topup` 流水。

**不足時**：若 `prepaid_barrel_balance < 應扣桶數` 且 `allow_prepaid_overdraft = false`，API **拒絕核銷**（400）；若允許透支則餘額可為負。

## 6. 現金：應收立帳與收款沖銷（FIFO）

與常見進銷存／ERP 一致：**應收（立帳）**與**收款（沖帳）**分開；司機只報**實收總額**，沖帳由系統依 **FIFO**（先沖最舊訂單之未清應收）分配。

### 6.1 司機畫面與 `expected_amount`

- **前期未清現金欠款**＝加總下列分錄之 `amount`：`cash_ar_accrual`、`cash_receipt_alloc`、`cash_variance_short`、`cash_variance_over`、`cash_offset_order`（**不含**月結／預付分錄）。  
- **本次送貨訂單金額**＝本單 `total_amount`。  
- **建議收款總額（應收現金）**（`GET /api/driver/today` 之 `driverBillingHints.cashDue`）＝  
  - **現金客戶**：前期未清現金欠款 **＋** 本次訂單金額。  
  - **月結客戶**：**0**（月結不列入司機當場應收；貨款以辦公室核銷後月結對帳為準）。  
  - **預付客戶**：仍為本單 `total_amount`（司機端作為參考；實務以扣桶為主）。  

`delivery_assignments.expected_amount` 於司機回報時與上述一致；差額＝實收 − 應收現金（月結時應收為 0，若司機仍填實收則可能顯示為多收，供補登參考）。

### 6.2 辦公室核銷時入帳順序

1. 為本單寫入 **`cash_ar_accrual`（＋訂單總額）**。  
2. 將司機實收依 **FIFO** 沖銷各訂單之未清餘額（多筆 **`cash_receipt_alloc`**，`amount` 為負）。  
3. 若實收沖完所有應收後仍有剩餘 → **`cash_variance_over`**（多收）。

月結／預付：仍以訂單總額為業務比對基準（與是否當場收款之規則一致）。

### 6.3 辦公室核銷時間（可自訂）

`POST /api/settlements/approve` 可選：

- **`officeSettledAt`**：ISO 日期時間（後台「核銷訂單」頁以 `datetime-local` 傳送）。  
- **`officeSettledAtYmd`**：僅 `YYYY-MM-DD`（本地該日 00:00）；未傳 `officeSettledAt` 時使用。

兩者皆未傳時，辦公室核銷完成時間為**伺服器當下時間**。自訂時間會寫入配送任務與訂單之 **`office_settled_at`**／**`completed_at`**、月結之 **`billing_period_key`**，並用於現金 **`payments.paid_at`**、相關流水與出庫紀錄之時間戳（測試或補登用）。

---

## 7. 核銷送達時分支（摘要）

| 結帳方式 | 現金 `Payment` | 流水／其他 |
|----------|----------------|------------|
| 現金 | 實收 &gt; 0 時建立一般現金收款 | `cash_ar_accrual` ＋ `cash_receipt_alloc`（FIFO）；必要時 `cash_variance_over` |
| 月結 | **不**建立當場全額現金收款 | 寫 `billing_period_key`、`office_settled_at`、`monthly_accrual` |
| 預付 | 訂單**無現金列**時不建立當場收款；若有「預付桶儲值」等**現金列**則依 §6 立帳／收款 | 預付列出貨扣 `prepaid_barrel_balance`、`prepaid_consumption`；儲值桶數待本單現金 AR 沖清後 `prepaid_topup` |

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
