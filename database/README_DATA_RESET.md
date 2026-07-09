# 清空業務資料

## 腳本

- **`migrations/004_reset_data_keep_single_admin.sql`**（檔名沿用；行為為**全清空**）

## 會清掉什麼

- 配送事件、派單、收款、進貨、庫存異動、製令、訂單與明細、商品、地址、客戶、司機、車輛、地址分區、隸屬公司，以及 AR／月結／發票／折讓／客戶流水／預收錢包等帳務資料  
- **所有 `users` 列**（清空後**無法登入**，須再執行「轉換使用者資料」建立帳號）

## 會保留什麼

- 無（業務與使用者皆清空）

## 執行前

1. **務必**先做整庫備份：  
   `mysqldump -u... -p water_erp > backup.sql`

## 執行方式

```bash
mysql -u YOUR_USER -p water_erp < database/migrations/004_reset_data_keep_single_admin.sql
```

或在 WaterErpLauncher 按「清空業務資料」，或：

```bash
npm run db:reset -w apps/api
```

## 執行後

```sql
SELECT COUNT(*) FROM users;
-- 應為 0
```

請接著在 Launcher 執行 **轉換使用者資料**，會匯入舊庫人員並建立 **id=1、員編 admin** 的系統管理員（密碼 `admin123`），與 API `DEFAULT_CREATOR_USER_ID=1` 一致。
