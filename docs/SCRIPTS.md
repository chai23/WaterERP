# 腳本與維護指南

npm 指令從根目錄執行；完整定義以根目錄及 `apps/api/package.json` 為準。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm ci` | 依 lockfile 安裝所有 workspace 依賴 |
| `npm run dev:api` | API 開發模式 |
| `npm run dev:admin` / `dev:driver` / `dev:liff` | 前端開發模式 |
| `npm run build` | 編譯全部應用 |
| `npm run db:generate` | 產生 Prisma Client |
| `npm run deploy:build` / `deploy:nginx` | Windows 正式建置／Nginx 設定產生 |
| `npm run win:launcher` / `mac:launcher` | 建置平台啟動器 |

## 資料庫指令

| 指令 | 用途 |
| --- | --- |
| `npm run db:schema-status` | 遷移狀態；可能初始化或校正追蹤表 |
| `npm run db:schema-apply` | 套用未完成的遷移 |
| `npm run db:schema-repair` | schema 修復 |
| `npm run ensure-admin -w apps/api` | 建立／校正管理員 |
| `npm run db:migrate-legacy-masters` | 舊庫主檔匯入 |
| `npm run db:migrate-orders -- <參數>` | 舊訂單匯入 |
| `npm run db:clear-transactions` | 清空交易、保留主檔 |
| `npm run db:reset` | 重設資料、保留單一管理員 |
| `npm run db:rebuild-empty` | 重建空庫 |

匯入、修復、清空與重建會寫入或刪除資料。先確認目標環境及備份，並閱讀 [資料重設](../database/README_DATA_RESET.md)、[主檔同步](LEGACY_MASTER_SYNC.md) 或 [交接指南](CUTOVER_HANDOVER.md)。

## API 腳本分類

沒有 npm 別名不代表未使用。直接執行時先切到 `apps/api`，以 `npx tsx scripts/<檔名>.ts` 啟動，確保 dotenv 載入正確環境。

| 腳本 | 用途 |
| --- | --- |
| `test-*.ts` | 權限、短單號、交接與業務回歸 |
| `api-full-smoke.ts`、`cash-e2e-smoke.ts`、`e2e-*.ts` | API 整合情境，可能寫入資料 |
| `debug-order.ts`、`inspect-order-flow.ts` | 訂單診斷；明確傳入訂單編號，不沿用預設歷史範例 |
| `seed-report-orders.ts` | 報表測試資料，僅供測試庫 |
| `ar-backfill.ts`、`ar-reconcile.ts`、`void-cancelled-order-ar.ts` | 帳務回補、對帳與作廢 |
| `backfill-barrel-movements.ts`、`reconcile-barrel-movements.ts` | 桶數異動回補與核對 |
| `clear-sales-orders.ts` | 清空訂單維護入口 |
| `schema-migrate.ts`、`rebuild-empty-db.ts`、`migrate-legacy-*.ts`、`ensure-admin-user*.ts` | npm 與啟動器使用的環境／轉換工具 |

## 驗證

```powershell
npm run build
npm run test:short-orders -w apps/api
npm run test:permissions -w apps/api
npm run test:cutover -w apps/api
```

三個 npm 測試入口需要本機 MySQL 與建立隔離測試庫的權限。其他測試未必具有相同隔離機制，執行前先讀腳本。文件及未引用檔案整理先以建置和引用檢查驗證，無需執行資料寫入測試。

`test:permissions` 檢查後台角色與選單的權限映射；略過 `/api/print-agent/` 路由，因為列印助手使用 `X-Print-Station` 工作站憑證，不使用後台角色選單授權。這只調整測試範圍，不停用 API 本身的憑證驗證；`/api/order-print/` 後台列印管理路由仍在檢查範圍內。

## Windows 建置拒絕存取排查

先在專案根目錄的一般 PowerShell 執行 `npm run build`。這個指令會依序編譯 API、後台、司機端與 LIFF；成功時三個前端各自產生 `dist/index.html` 與靜態資源。TypeScript 檢查通過並不代表 Vite 已完成打包。

若出現 `EPERM` 或 `EACCES`，保留完整錯誤中的操作（例如 `scandir`、`open` 或 `spawn`）與路徑，再比較一般終端與受限執行環境的結果。同一專案在一般終端成功、僅在受限環境失敗時，先檢查該環境的檔案或子程序存取限制；兩者都失敗時，再依實際路徑檢查 Windows 存取權、安全軟體紀錄或檔案占用。不要僅憑錯誤碼就遞迴放寬整個使用者目錄的權限。

2026-11-24 在目前環境執行根目錄 `npm run build` 已全部成功，未重現先前對 `C:\Users\gj94e` 的拒絕存取。沒有先前的完整錯誤與執行環境紀錄，無法確定當時根因；本次未修改 Windows ACL 或 Vite 設定。建置成功不等同於完成瀏覽器業務流程驗證。
