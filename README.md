# 超好企業進銷存系統 — 桶裝水進銷存

## 技術棧

- **MySQL 8**：手動建庫後執行 [`database/schema.sql`](database/schema.sql)
- **後端**：`apps/api` — Node.js + Express + TypeScript + Prisma
- **前端**：`apps/web-admin`（後台）、`apps/web-driver`（司機端）— React + Vite + TypeScript

## 快速開始

### 1. 資料庫（手動）

1. 在 MySQL 建立資料庫，例如：`CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. 執行 `database/schema.sql`（可於 Workbench / CLI：`mysql -u... -p water_erp < database/schema.sql`）
3. **若為舊庫升級**（原本 `users.phone` 為登入帳號）：請先備份後執行 [`database/migrate_users_employee_code.sql`](database/migrate_users_employee_code.sql)，將登入改為 `employee_code`（員編）、`phone` 改為聯絡手機。

### 2. 安裝依賴（專案根目錄）

```bash
npm install
```

### 3. API

```bash
cd apps/api
copy .env.example .env
REM 編輯 .env 填入正確的 DATABASE_URL、JWT_SECRET
npm run prisma:generate
npm run dev
```

預設：<http://localhost:3000>，健康檢查：`GET /api/health`

### 4. 前端（另開終端機，仍在專案根目錄）

```bash
npm install
npm run dev:admin    # http://localhost:5173
npm run dev:driver   # http://localhost:5174
```

根目錄 `npm install` 會安裝所有 workspace 依賴。

## 目錄說明

| 路徑 | 說明 |
|------|------|
| `database/schema.sql` | MySQL 建表與索引（手動執行） |
| `database/migrate_users_employee_code.sql` | 舊庫：`users` 改為員編登入 + 獨立聯絡手機 |
| `apps/api` | REST API、Prisma Client |
| `apps/web-admin` | 後台 React |
| `apps/web-driver` | 司機端 React |

## 文件

| 路徑 | 說明 |
|------|------|
| [`docs/BILLING.md`](docs/BILLING.md) | 三種結帳、流水帳、核銷規則（技術向） |
| [`docs/USER_GUIDE_CASH_AND_SETTLEMENT.md`](docs/USER_GUIDE_CASH_AND_SETTLEMENT.md) | **現金往來／司機收款／櫃台沖帳**操作教學 |
| [`tools/WaterErpLauncher/README.md`](tools/WaterErpLauncher/README.md) | Windows 正式機啟動器、服務管理與建置說明 |
| [`docs/NEW_SERVER_DOMAIN_CUTOVER.md`](docs/NEW_SERVER_DOMAIN_CUTOVER.md) | **把現有網域切到新伺服器**（固定 IP、舊庫轉換、改 DNS） |

## Windows 正式機啟動器

`tools/WaterErpLauncher` 提供分頁式 WinForms 管理介面，每 3 秒監控 MySQL、API、Nginx，
以及後台、司機端與 LIFF 網站端點。正式機固定使用 API `dist` 與 Nginx 靜態網站，不啟動
Vite 開發伺服器。

MySQL 預設以 Windows Service **`MySQL80`** 管理，可在啟動器「設定」分頁修改服務名稱。
啟停 Windows Service 通常需要以系統管理員身分執行啟動器。「停止應用」只停止 API 與
Nginx，不會停止 MySQL；資料維護與一鍵部署因此可持續使用資料庫。

## Prisma 與手動 SQL

`schema.sql` 與 `apps/api/prisma/schema.prisma` 欄位應保持一致。若你**只改資料庫**而不改 Prisma，請同步修改 `schema.prisma` 後執行 `npm run prisma:generate -w apps/api`。
