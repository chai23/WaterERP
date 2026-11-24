# WaterERP — 桶裝水進銷存系統

npm workspaces 專案，涵蓋客戶、商品、訂單、派單、司機回報、收款核銷、應收帳款、發票、費用、舊系統交接與 LINE LIFF 客戶入口。

## 專案結構

| 目錄 | 用途 | 開發網址 |
| --- | --- | --- |
| `apps/api` | Express、TypeScript、Prisma、MySQL API | http://localhost:3000/api/health |
| `apps/web-admin` | React 19 + Vite 管理後台 | http://localhost:5173 |
| `apps/web-driver` | React 19 + Vite 司機端 | http://localhost:5174/driver/ |
| `apps/web-liff` | React 19 + LINE LIFF 客戶端 | http://localhost:5175/liff/ |
| `database` | 完整 schema、版本遷移、人工維護 SQL | — |
| `deploy` | Windows 部署腳本與 Nginx 範本 | — |
| `tools` | Windows WinForms、macOS Swift 啟動器 | — |
| `docs` | 操作、架構、交接與設計文件 | — |

## 本機開發

需要 Node.js（專案宣告 `>=18`，建議 Node.js 22）、npm 與 MySQL 8。以下 PowerShell 指令從根目錄執行：

```powershell
npm ci
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web-liff/.env.example apps/web-liff/.env
```

僅首次設定時複製，避免覆蓋既有環境檔。編輯 API 的 `DATABASE_URL`、`JWT_SECRET`；使用 LIFF 時另外設定 LINE 參數及 `VITE_LIFF_ID`。參考 [API 環境範本](apps/api/.env.example)、[LIFF 環境範本](apps/web-liff/.env.example)。

先在 MySQL 建立空資料庫：

```sql
CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

透過 MySQL Workbench 或 CLI 將 [database/schema.sql](database/schema.sql) 匯入新建的空庫，再執行：

```powershell
npm run db:generate
npm run db:schema-status
npm run db:schema-apply
npm run ensure-admin -w apps/api
```

`ensure-admin` 在帳號不存在時建立 `admin / admin123`，建立後立即登入修改密碼。既有庫升級請先備份，再檢查並套用 migrations，不要重新匯入完整建庫 SQL。舊版使用 `users.phone` 登入的資料庫，另見 [員編遷移 SQL](database/migrate_users_employee_code.sql)。

各開一個終端機啟動需要的服務：

```powershell
npm run dev:api
npm run dev:admin
npm run dev:driver
npm run dev:liff
```

前端將 `/api` 代理到本機 3000。LIFF 正式登入仍需 LINE 平台設定。

## 建置與部署

```powershell
npm run build
```

依序編譯四個 app，輸出至各自的 `dist`。正式機使用 Node.js API 與 Nginx 靜態服務，詳見 [部署指南](deploy/DEPLOY.md)。啟動器建置指令為 `npm run win:launcher` 與 `npm run mac:launcher`。

## 文件入口

- [完整文件索引](docs/README.md)
- [專案架構](docs/ARCHITECTURE.md)
- [腳本與維護指南](docs/SCRIPTS.md)

資料模型變更須同步檢查 `database/schema.sql`、`database/migrations/` 與 `apps/api/prisma/schema.prisma`，再重新產生 Prisma Client。資料清空、重建、舊庫匯入不是一般啟動步驟。
