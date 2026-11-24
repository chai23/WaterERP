# 專案架構

## 資料流

後台、司機端和 LIFF 以 HTTP `/api` 存取 Express，API 使用 Prisma 讀寫 MySQL。開發時由 Vite 代理 API；正式環境由 Nginx 提供靜態頁面與反向代理。Windows 與 macOS 啟動器負責環境與服務管理。

## 模組責任

| 位置 | 責任 |
| --- | --- |
| `apps/api/src/index.ts` | 啟動、驗證及主要業務端點 |
| `apps/api/src/modules/permissions` | 權限目錄與政策 |
| `apps/api/src/modules/legacy-history` | 舊庫查詢、同步、交接與批次處理 |
| `apps/api/src/modules/delivery-planning` | 候選訂單、地理資訊、排程與發布 |
| `apps/api/src/line` | LINE 訊息、綁定與 LIFF 路由 |
| `apps/web-admin/src/App.tsx` | 後台路由 |
| `apps/web-admin/src/pages` | 訂單、客戶、派單、帳務、報表、設定 |
| `apps/web-admin/src/orderPrint` | 列印版型、預覽與條碼 |
| `apps/web-driver/src` | 配送、退桶與服務單介面 |
| `apps/web-liff/src` | 客戶 LINE 入口 |

AI／班次派單由 `DELIVERY_PLANNING_ENABLED` 控制，見 [設計包](ai-dispatch/README.md)。

## 資料庫規則

- `database/schema.sql`：新庫完整建表入口。
- `database/migrations/001_baseline.sql`：遷移基線；後續編號 SQL 用於既有庫升級。
- `apps/api/scripts/schema-migrate.ts`：掃描 migrations、維護 `schema_migrations` 並套用版本。
- `apps/api/prisma/schema.prisma`：Prisma 模型，變更後執行 `npm run db:generate`。
- `database/maintenance` 與 `rebuild_empty_database.sql`：人工維護，並非自動遷移。
- `docs/ai-dispatch/database`：已併入完整 schema 的設計對照，不是目前遷移入口。

`db:schema-status` 包含追蹤表初始化／校正邏輯，不應視為純唯讀檢查。舊庫資料來源與同步見 [主檔同步指南](LEGACY_MASTER_SYNC.md)。

## 維護原則

新增功能時同步檢查 API 權限、後台路由及操作端需求。保留已套用 migration 的名稱與歷史。沒有 import 的人工維護腳本不一定無用；刪除前需檢查 npm、啟動器、部署腳本與文件引用。環境密鑰留在未追蹤的 `.env`，資料匯出與臨時截圖不要混入程式碼。
