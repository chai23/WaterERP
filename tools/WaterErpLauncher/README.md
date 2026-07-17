# 超好企業進銷存系統 Windows 啟動器

## 一鍵重新建置

每次 `git pull` 拿到新版程式碼後，重新建置啟動器：

- **雙擊**：`tools/WaterErpLauncher/建置啟動器.cmd`
- 或 PowerShell：`powershell -ExecutionPolicy Bypass -File tools\WaterErpLauncher\build.ps1`
- 或在專案根目錄：`npm run win:launcher`

建置腳本會：

1. **先清除**舊建置輸出（`bin/`、`obj/`、`publish/`），確保磁碟上只留最新版
2. 以 `dotnet publish` 產生**單一 exe**（self-contained，免另裝 .NET 執行階段）
3. 完成後自動開啟啟動器

產出位置：`tools/WaterErpLauncher/publish/WaterErpLauncher.exe`

> 需求：本機安裝 **.NET 8 SDK**（`dotnet --version` 可確認）。
> 這三個輸出資料夾已列入 `.gitignore`，不會被提交；舊版本只會出現在本機磁碟，靠上述腳本每次清理。

參數：`-NoLaunch`（建置後不自動開啟）、`-Runtime win-x64`（預設）。

---

# 資料庫結構升級

## 與「舊庫轉換」的差別

| 功能 | 用途 |
|------|------|
| **資料庫結構升級** | 在本機 `water_erp` 補上新表／新欄位（執行 `database/migrations/*.sql`） |
| **舊庫轉換** | 從遠端舊庫 `database` **唯讀**匯入客戶、商品等主檔資料 |

## 指令（專案根目錄）

```bash
npm run db:schema-status   # 檢查已套用／待升級的 migration
npm run db:schema-apply    # 套用所有待升級 migration
npm run db:generate        # 升級後更新 Prisma Client
```

## 注意事項

1. **正式環境升級前務必備份**（`mysqldump`）
2. **不要**對已有資料的庫執行整份 `database/schema.sql`（會 DROP TABLE）
3. 清空資料的腳本（`004_reset_*`、`008_clear_*`、`019_clear_*` 等）不會被自動升級執行
   - 啟動器另有「清空交易資料（保留主檔）」→ `npm run db:clear-transactions`
   - 「清空全部業務資料」→ `npm run db:reset`
4. 若資料庫是用 `schema.sql` 建的，腳本會自動偵測既有結構並寫入 `schema_migrations` 追蹤表，避免重複執行

## 啟動器操作

Mac 與 Windows 啟動器在「舊庫轉換」區塊**上方**皆有 **檢查結構**／**升級結構** 按鈕，共用上述 npm 指令。

1. 按 **檢查結構** 查看已套用與待升級的 migration
2. 若有待升級項目，先 `mysqldump` 備份後按 **升級結構**
3. 升級完成後啟動器會執行 `db:generate`；若 API 已在跑，請重啟 API
