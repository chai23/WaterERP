# 清空業務資料

本專案有兩種清空方式，請依需求選擇。

## 1. 清空交易資料（保留主檔）— 建議日常測試用

腳本：`maintenance/clear_transaction_data_keep_masters.sql`

### 會清掉什麼

- 訂單／配送／收空桶／服務單、庫存異動、收款／AR／月結／發票／折讓
- 支出單據、上樓獎金紀錄、通知／OTP 暫存等交易流水
- 庫存現量、客戶與送貨地址空桶數、預付桶餘額歸零

### 會保留什麼

- 客戶、送貨地址、商品、司機、車輛、使用者、供應商
- 地址分區、隸屬公司、支出類別、優惠活動、印刷標語、訂單公告
- 薪資／樓層費率、客戶搬運費率等設定

### 執行方式

啟動器按「清空交易資料（保留主檔）」，或：

```bash
npm run db:clear-transactions
```

---

## 2. 清空全部業務資料（含主檔／使用者）

腳本：`maintenance/reset_data_keep_single_admin.sql`

### 會清掉什麼

- 配送事件、派單、收款、進貨、庫存異動、製令、訂單與明細、商品、地址、客戶、司機、車輛、地址分區、隸屬公司，以及 AR／月結／發票／折讓／客戶流水／預收錢包等帳務資料
- **所有 `users` 列**（清空後**無法登入**，須再執行「轉換使用者資料」建立帳號）

### 會保留什麼

- 無（業務與使用者皆清空）

### 執行前

1. **務必**先做整庫備份：
   `mysqldump -u... -p water_erp > backup.sql`

### 執行方式

```bash
mysql -u YOUR_USER -p water_erp < database/maintenance/reset_data_keep_single_admin.sql
```

或在啟動器按「清空全部業務資料」，或：

```bash
npm run db:reset
```

### 執行後

```sql
SELECT COUNT(*) FROM users;
-- 應為 0
```

請接著在 Launcher 執行 **轉換使用者資料**，會匯入舊庫人員並建立 **id=1、員編 admin** 的系統管理員（密碼 `admin123`），與 API `DEFAULT_CREATOR_USER_ID=1` 一致。
