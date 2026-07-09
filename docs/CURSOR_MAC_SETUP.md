# WaterERP — Mac 開發環境建置指引（給 Cursor 執行）

> **用途**：在 Mac 上從零建立 WaterERP 開發環境，用於修改程式與本地測試。  
> **正式部署在 Windows 伺服器**，Mac 只做開發，不跑 Nginx／啟動器。  
> **請 Cursor 依本文件逐步執行、檢查、回報結果。**

---

## 專案資訊

| 項目 | 值 |
|------|-----|
| GitHub 倉庫 | `https://github.com/chai23/WaterERP.git` |
| 分支 | `main` |
| Node.js | >= 18（建議 20 LTS） |
| 資料庫 | MySQL 8，本機庫名 `water_erp` |
| API 埠 | 3000 |
| 後台 dev 埠 | 5173 |
| 司機端 dev 埠 | 5174 |

---

## Cursor 任務清單（請全部完成）

- [ ] 1. 檢查 Mac 是否已安裝必要工具
- [ ] 2. 缺少則安裝（Homebrew / Node / MySQL / Git）
- [ ] 3. Clone 程式碼
- [ ] 4. 建立本機 MySQL 資料庫
- [ ] 5. 建立 `apps/api/.env`（Mac 專用，勿從 Windows 複製）
- [ ] 6. `npm install` 與 Prisma generate
- [ ] 7. 初始化資料庫結構與管理員帳號
- [ ] 8. 驗證 dev 服務可啟動
- [ ] 9. 回報結果與後續日常指令

---

## 步驟 1：檢查必要工具

在終端機執行：

```bash
node -v
npm -v
git --version
mysql --version
```

**預期**：
- `node -v` → v18 或以上
- `git` 有版本號
- `mysql` 有版本號（8.x）

若 `node` 或 `mysql` 不存在，進入步驟 2。

---

## 步驟 2：安裝缺少的工具（Homebrew）

若未安裝 Homebrew，先執行（官網：https://brew.sh）：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

安裝依賴：

```bash
brew install node@20 mysql git
brew services start mysql
```

安裝後重新檢查：

```bash
node -v
npm -v
mysql --version
```

---

## 步驟 3：Clone 程式碼

建議放在使用者目錄下：

```bash
cd ~
git clone https://github.com/chai23/WaterERP.git
cd WaterERP
git checkout main
git pull
```

**注意**：
- 不要複製 Windows 的 `node_modules`
- 不要複製 Windows 的 `apps/api/.env`（Mac 要自建）

---

## 步驟 4：建立本機 MySQL 資料庫

```bash
# 若 root 無密碼（Homebrew 預設常為空），直接：
mysql -u root -e "CREATE DATABASE IF NOT EXISTS water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 若有密碼：
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

確認：

```bash
mysql -u root -e "SHOW DATABASES LIKE 'water_erp';"
```

---

## 步驟 5：建立 Mac 專用 `.env`

```bash
cd ~/WaterERP/apps/api
cp .env.example .env
```

編輯 `apps/api/.env`，內容如下（**依 Mac 本機 MySQL 密碼調整**）：

```env
DATABASE_URL="mysql://root:@127.0.0.1:3306/water_erp"
PORT=3000
HOST=127.0.0.1
CORS_ORIGIN="http://localhost:5173,http://localhost:5174"
JWT_SECRET="mac-dev-only-change-me-to-random-string"
```

說明：
- `root:` 後面若 MySQL 有密碼，改成 `root:你的密碼`
- **不要**設定 `LEGACY_DATABASE_URL`（除非使用者明確要測舊庫轉換）
- 此檔案已在 `.gitignore`，**不可 commit**

---

## 步驟 6：安裝依賴與 Prisma

在專案根目錄：

```bash
cd ~/WaterERP
npm install
npm run db:generate
```

若有錯誤，記錄完整錯誤訊息並嘗試修復。

---

## 步驟 7：初始化資料庫

### 方式 A（建議）：Prisma 同步結構

```bash
cd ~/WaterERP/apps/api
npx prisma db push
npm run ensure-admin
```

會建立資料表，並建立管理員：
- 帳號：`admin`
- 密碼：`admin123`

### 方式 B：若 `prisma db push` 失敗，改用手動 SQL

```bash
cd ~/WaterERP
mysql -u root water_erp < database/schema.sql
```

若 `schema.sql` 因外鍵順序失敗，仍用方式 A。

---

## 步驟 8：啟動開發服務並驗證

需要 **3 個終端機**（或背景執行）：

**終端 1 — API**

```bash
cd ~/WaterERP
npm run dev:api
```

**終端 2 — 後台**

```bash
cd ~/WaterERP
npm run dev:admin
```

**終端 3 — 司機端**

```bash
cd ~/WaterERP
npm run dev:driver
```

### 驗證指令

```bash
curl -s http://localhost:3000/api/health
```

預期 JSON：`{"ok":true,"db":"connected"}`

### 瀏覽器開啟

| 服務 | 網址 |
|------|------|
| 後台 | http://localhost:5173 |
| 司機端 | http://localhost:5174 |
| API 健康檢查 | http://localhost:3000/api/health |

後台登入測試：`admin` / `admin123`

---

## Mac 上不要做的事

| 不要做 | 原因 |
|--------|------|
| 跑 `npm run deploy:build` | 那是 Windows PowerShell 腳本 |
| 跑 WaterErpLauncher | 僅 Windows 用 |
| 安裝／設定 Nginx | 正式部署在 Windows |
| commit `apps/api/.env` | 含密碼，已在 gitignore |
| 在 Mac build 後把 dist 丟上 Windows | 應在 Windows 伺服器 build |

---

## 日常開發流程（Mac）

```bash
cd ~/WaterERP
git pull                    # 開工前先拉最新
# ... 修改程式 ...
git status
git add .
git commit -m "描述修改內容"
git push
```

改完推上 GitHub 後，到 **Windows 伺服器** 執行 `git pull` 再建置部署。

---

## 若要使用與正式機相同的資料（選用）

在 Windows 匯出：

```powershell
mysqldump -u root -p water_erp > water_erp_backup.sql
```

拷貝到 Mac 後：

```bash
mysql -u root -p -e "DROP DATABASE IF EXISTS water_erp; CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p water_erp < water_erp_backup.sql
cd ~/WaterERP && npm run db:generate
```

---

## 常見問題排除

### `npm install` 失敗
- 確認 Node >= 18：`node -v`
- 刪除 `node_modules` 與 `package-lock.json` 後重試 `npm install`

### API 健康檢查 `db: error`
- 檢查 MySQL 是否啟動：`brew services list`
- 檢查 `.env` 的 `DATABASE_URL` 帳密是否正確
- 確認 `water_erp` 資料庫存在

### 前端白畫面 / API 401
- 確認 API（3000）有在跑
- 確認 `CORS_ORIGIN` 含 5173、5174

### `git push` 要登入
- GitHub 已不支援密碼，需瀏覽器登入或 Personal Access Token
- Username：`chai23`

---

## Cursor 完成後請回報

請向使用者回報以下資訊：

1. Node / MySQL / Git 版本
2. 專案路徑（例如 `~/WaterERP`）
3. `curl http://localhost:3000/api/health` 結果
4. 後台、司機端網址是否可開
5. 有無錯誤與如何修復
6. 日常啟動三個 dev 服務的指令摘要

---

## 參考文件（專案內）

- `README.md` — 快速開始
- `deploy/DEPLOY.md` — Windows 正式部署（Mac 不需執行）
- `docs/BILLING.md` — 帳務規則
