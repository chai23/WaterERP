# Windows 啟動器：資料庫結構檢查與升級 — Cursor 任務說明

> **Mac 端已完成共用腳本**（`apps/api/scripts/schema-migrate.ts`、`npm run db:schema-status|apply`）。Windows 端只需實作啟動器 UI 並呼叫相同 npm 指令。

> **用法**：在 Windows 端用 Cursor 開啟 WaterERP 專案後，將下方「--- 複製開始 ---」到「--- 複製結束 ---」整段貼給 Agent 執行。

---

## --- 複製開始 ---

請在 **Windows 正式環境** 的 WaterERP 專案中，為 `tools/WaterErpLauncher`（WinForms C# 啟動器）新增「**資料庫結構檢查與升級**」功能。

### 背景與目標

- 專案使用 **MySQL 8**，結構定義在：
  - `database/schema.sql`（全新建庫用，含 DROP TABLE，**不可**對已有資料的正式庫執行）
  - `database/migrations/NNN_*.sql`（舊庫**增量升級**用，例如 `028_expense_vouchers.sql`）
  - `apps/api/prisma/schema.prisma`（須與 SQL 一致）
- Mac 端已開發新功能（公司支出等），程式碼 `git pull` 後，Windows 正式機還需**補跑缺的 migration**，資料表／欄位才會出現。
- 現有 Windows 啟動器（`tools/WaterErpLauncher/MainForm.cs`）已有：
  - 啟停服務、建置、`Prisma generate`、清空業務資料
  - **舊庫轉換**（`db:migrate-zones` 等，從遠端 `database` 庫匯入主檔）
- **缺少**：檢查本機 `water_erp` 是否已套用 `database/migrations/` 內各 SQL，並一鍵補跑未執行的 migration。

請實作此功能，讓使用者在 Windows 啟動器上就能完成「檢查 → 確認 → 升級欄位／表」。

---

### 實作範圍（請全部完成）

#### 1. 共用腳本（已由 Mac 端實作，請先 `git pull` 確認存在）

路徑：`apps/api/scripts/schema-migrate.ts`

若檔案已存在，**勿重寫**，直接整合啟動器 UI。若需調整，請保持與 Mac 啟動器相同行為。

**追蹤表**（首次執行時自動建立）：

```sql
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` VARCHAR(64) NOT NULL,
  `applied_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Migration 清單來源**：掃描 `database/migrations/` 下符合 `^\d{3}_.+\.sql$` 的檔案，依檔名前綴數字排序（003 → 028）。

**排除**（不可納入自動升級）：
- `004_reset_data_keep_single_admin.sql`（清空業務資料，啟動器另有按鈕）
- `008_clear_all_sales_orders.sql`
- `019_clear_transaction_data_keep_masters.sql`
- 任何檔名含 `clear` 的腳本

**子命令**（透過 CLI 參數）：

| 參數 | 行為 |
|------|------|
| `--status`（預設） | 輸出 JSON：`{ ok, applied: string[], pending: string[], latest: string \| null }` |
| `--apply` | 依序執行所有 `pending` migration；每支成功後寫入 `schema_migrations`；失敗則停止並回傳錯誤 |
| `--apply --dry-run` | 只列出將執行的檔案，不寫入 DB |

**執行方式**：使用與 `reset-data` 相同模式：

```bash
npx prisma db execute --schema prisma/schema.prisma --file <migration.sql>
```

從 `apps/api` 目錄執行；讀取 `DATABASE_URL`（`.env`）。

**輸出**：`--status` 與 `--apply` 結束時印出單行 JSON 到 stdout（方便 C# 解析）；錯誤訊息印 stderr，exit code 非 0。

**注意**：
- 不要執行 `database/schema.sql`
- `--apply` 前若 `schema_migrations` 不存在，先建立追蹤表
- 已存在於 `schema_migrations.id` 的檔名（如 `028_expense_vouchers.sql`）視為已套用，跳過

#### 2. 註冊 npm scripts

**`apps/api/package.json`** 新增：

```json
"db:schema-status": "tsx scripts/schema-migrate.ts --status",
"db:schema-apply": "tsx scripts/schema-migrate.ts --apply"
```

**根目錄 `package.json`** 新增：

```json
"db:schema-status": "npm run db:schema-status -w apps/api",
"db:schema-apply": "npm run db:schema-apply -w apps/api"
```

`--apply` 完成後，啟動器應再呼叫 `npm run db:generate`（更新 Prisma Client）。

#### 3. 修改 Windows 啟動器 UI（`tools/WaterErpLauncher/MainForm.cs`）

在「舊庫轉換」區塊**上方**新增一區「**資料庫結構**」：

| 控制項 | 行為 |
|--------|------|
| 標籤 | `資料庫結構（water_erp 欄位／資料表升級）` |
| 按鈕「檢查結構」 | 執行 `npm run db:schema-status`，解析 JSON，在 MessageBox 或 Log 顯示：已套用 N 支、待升級 M 支；列出 `pending` 檔名 |
| 按鈕「升級結構」 | 若有 pending：先 MessageBox 警告「建議先備份資料庫」+ 列出將執行的檔案，確認後：若 API 在跑則詢問是否先停止 → `npm run db:schema-apply` → 成功後 `npm run db:generate` → 提示重啟 API |
| 狀態標籤（選用） | 顯示最近一次檢查結果，例如「結構：已最新」或「待升級 1 支 (028_...)」 |

**實作慣例**（請沿用現有程式風格）：
- 使用既有 `ValidateProjectRoot()`、`RunNpmCommandAsync()`、`AppendLog()`、`SetBusy()`、`IsAnyServiceRunning()`、`StopAllAsync()`
- 檢查 `apps/api/.env` 是否存在（與舊庫轉換相同）
- 將啟動器版本號 bump（例如 `v1.3.4` → `v1.3.5`）

**C# 解析 JSON**：可用 `System.Text.Json`；若 npm 輸出混有其它 log，只取最後一行合法 JSON 或讓腳本保證 stdout 僅輸出 JSON。

#### 4. 可選：啟動時自動檢查

啟動器 `OnLoad` 時**靜默**執行一次 `--status`；若 `pending.length > 0`，在 Log 區塊顯示黃色提示：「資料庫結構落後，請按『檢查結構』或『升級結構』」。不要自動執行 `--apply`。

#### 5. 文件

在 `tools/WaterErpLauncher/README.md`（若無則新建）簡述：
- 「舊庫轉換」vs「資料庫結構升級」差異
- 升級前務必 `mysqldump` 備份
- 全新建庫仍用 `database/schema.sql`，不是本功能

---

### 驗收標準

1. 在**尚未執行** `028_expense_vouchers.sql` 的 Windows 正式庫上：
   - 「檢查結構」顯示 `028_expense_vouchers.sql` 為 pending
   - 「升級結構」成功後，`expense_categories`、`expense_vouchers`、`expense_lines` 表存在
   - 再次檢查顯示 pending 為空
2. 已套用的 migration 不會重複執行
3. `004_reset_data_keep_single_admin.sql` 不會出現在自動升級清單
4. 升級完成後 `npm run db:generate` 有執行，API 重啟後支出功能可用
5. 不修改 Mac 啟動器（`tools/WaterErpMacLauncher`），僅 Windows + 共用 npm 腳本

---

### 請勿

- 不要對正式庫執行 `database/schema.sql`
- 不要把業務資料 dump 上傳 Git
- 不要 over-engineer（不需要 Prisma Migrate 全套，維持現有 SQL migration 慣例即可）
- 不要大幅重構 `MainForm.cs` 無關區塊

---

### 參考檔案

- `tools/WaterErpLauncher/MainForm.cs` — 現有 UI 與 `RunNpmCommandAsync`
- `apps/api/package.json` — `reset-data` 的 `prisma db execute` 用法
- `database/migrations/028_expense_vouchers.sql` — 近期範例
- `README.md` — Prisma 與手動 SQL 說明

完成後請簡述：改了哪些檔案、如何在 Windows 啟動器操作、以及如何驗證。

## --- 複製結束 ---

---

## 給操作者的補充（不用貼給 Cursor）

### Git 與資料庫分工

| 項目 | 做法 |
|------|------|
| 程式碼 | Mac 改完 → `git push` → Windows `git pull` |
| 表結構定義 | 隨 Git 一起（`database/migrations/*.sql`、`schema.sql`、`schema.prisma`） |
| 正式庫實際欄位 | Windows 啟動器「升級結構」或手動跑 migration SQL |
| 業務資料 | **不**跟 Git；各環境各自維護 |

### 手動升級（啟動器完成前可先用）

```powershell
cd C:\...\WaterERP\apps\api
npx prisma db execute --schema prisma/schema.prisma --file ../../database/migrations/028_expense_vouchers.sql
cd ..\..
npm run db:generate
```

### 備份（升級前必做）

```powershell
mysqldump -u 使用者 -p water_erp > backup_%date:~0,4%%date:~5,2%%date:~8,2%.sql
```
