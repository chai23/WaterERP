# WaterERP 正式部署手冊（Windows + 固定 IP + Nginx 單一入口）

本手冊適用情境：

- 部署在 **Windows 電腦**
- 有 **固定公網 IP**，暫無網域
- **Nginx 單一入口**（只對外開 80 埠）
- 司機端走子路徑 **`/driver/`**

## 架構

```
外部使用者
    │
    ▼
http://你的固定IP/          → 後台（web-admin）
http://你的固定IP/driver/   → 司機端（web-driver）
http://你的固定IP/api/...   → API（Node.js，僅本機 127.0.0.1:3000）
```

同一個 IP、同一個埠，瀏覽器視為同源，前端 `fetch('/api/...')` 無需額外 CORS 設定。

---

## 前置需求

| 項目 | 說明 |
|------|------|
| Node.js 18+ | `node -v` 確認 |
| MySQL 8 | 服務設為「自動」啟動 |
| Nginx for Windows | https://nginx.org/en/download.html |
| NSSM（選用） | API 開機自動啟動：https://nssm.cc/download |

---

## 第一步：資料庫

```sql
CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

在 MySQL Workbench 或 CLI 執行 `database/schema.sql`（舊庫升級請依 README 執行對應 migration）。

---

## 第二步：設定 API 環境變數

```powershell
cd C:\Users\gj94e\Desktop\WaterERP\apps\api
copy .env.example .env
notepad .env
```

正式環境建議：

```env
DATABASE_URL="mysql://使用者:密碼@127.0.0.1:3306/water_erp"
PORT=3000
HOST=127.0.0.1
JWT_SECRET="請改成至少32字元的隨機字串"
```

- `HOST=127.0.0.1`：API 只給本機 Nginx 連線，不對外直接暴露 3000 埠
- `JWT_SECRET` 務必改掉預設值
- 走 Nginx 單一入口時，`CORS_ORIGIN` 可省略

---

## 第三步：建置正式版

在**專案根目錄**以系統管理員或一般使用者執行：

```powershell
cd C:\Users\gj94e\Desktop\WaterERP
powershell -ExecutionPolicy Bypass -File deploy\scripts\build-production.ps1
```

會完成：

1. `npm install`
2. `npm run db:generate`
3. `npm run build`（API + 後台 + 司機端）
4. 產生 `deploy\nginx\water-erp.conf`

---

## 第四步：安裝並設定 Nginx

### 4.1 下載解壓

例如解壓到 `C:\nginx`。

### 4.2 套用設定

將 `deploy\nginx\water-erp.conf` 複製到 Nginx 設定目錄，並在 `nginx.conf` 的 `http { }` 區塊內加入：

```nginx
include C:/Users/gj94e/Desktop/WaterERP/deploy/nginx/water-erp.conf;
```

（路徑請依實際專案位置調整，Windows 上建議用正斜線 `/`。）

### 4.3 測試並啟動

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe
```

重新載入設定：

```powershell
.\nginx.exe -s reload
```

---

## 第五步：啟動 API

### 方式 A：手動測試

```powershell
cd C:\Users\gj94e\Desktop\WaterERP\apps\api
node dist\index.js
```

確認：`http://127.0.0.1:3000/api/health`

### 方式 B：NSSM 註冊 Windows 服務（建議）

以**系統管理員**執行：

```powershell
cd C:\Users\gj94e\Desktop\WaterERP
powershell -ExecutionPolicy Bypass -File deploy\scripts\register-api-service.ps1
```

---

## 第六步：Windows 防火牆

以**系統管理員**執行（只開 80，不開 3000）：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\scripts\install-firewall.ps1
```

---

## 第七步：路由器（若有）

若電腦在路由器後方，即使 ISP 給固定 IP，仍可能需在路由器設定 **Port Forwarding**：

| 外部埠 | 內部 IP | 內部埠 |
|--------|---------|--------|
| 80 | 這台電腦區網 IP | 80 |

查區網 IP：

```powershell
ipconfig
```

若固定 IP 直接接在這台電腦網卡上，可跳過 Port Forward。

---

## 第八步：驗證

在本機瀏覽器：

| 網址 | 預期 |
|------|------|
| `http://127.0.0.1/` | 後台登入頁 |
| `http://127.0.0.1/driver/` | 司機端 |
| `http://127.0.0.1/api/health` | API 健康檢查 JSON |

用手機 **4G**（不要連同一 Wi‑Fi）測試：

```
http://你的固定IP/
http://你的固定IP/driver/
http://你的固定IP/api/health
```

---

## 日常維運

### 更新程式後重新部署

```powershell
powershell -ExecutionPolicy Bypass -File deploy\scripts\build-production.ps1
nssm restart WaterERP-API
cd C:\nginx
.\nginx.exe -s reload
```

### 備份資料庫

```powershell
mysqldump -u 使用者 -p water_erp > backup_%date:~0,4%%date:~5,2%%date:~8,2%.sql
```

### 開機自動啟動檢查清單

- [ ] MySQL 服務：自動
- [ ] WaterERP-API（NSSM）：自動
- [ ] Nginx：可用工作排程器或 NSSM 註冊 `nginx.exe`

---

## 安全性提醒

1. 登入後立即修改預設管理員密碼
2. MySQL 只聽 `127.0.0.1`，勿對外開 3306
3. 日後有網域時，建議加 HTTPS（Let's Encrypt 或自簽憑證）
4. 定期備份資料庫與 `apps/api/.env`

---

## 常見問題

### `/driver/` 白畫面或 404

確認已重新 build 司機端（`base: '/driver/'`），且 Nginx 已 reload。

### `/api/` 502 Bad Gateway

API 未啟動。檢查 `node dist/index.js` 或 `nssm status WaterERP-API`。

### 外網連不到、本機可以

檢查 Windows 防火牆 80 埠、路由器 Port Forward、ISP 是否擋 80 埠。

### 司機端靜態資源 404

確認造訪網址結尾有 `/`：`http://IP/driver/`（Nginx 會將 `/driver` 導向 `/driver/`）。

---

## 相關檔案

| 路徑 | 說明 |
|------|------|
| `deploy/nginx/water-erp.conf.template` | Nginx 範本 |
| `deploy/nginx/water-erp.conf` | 建置後產生的實際設定 |
| `deploy/scripts/build-production.ps1` | 一鍵建置 |
| `deploy/scripts/generate-nginx-config.ps1` | 產生 Nginx 設定 |
| `deploy/scripts/install-firewall.ps1` | 開放 80 埠 |
| `deploy/scripts/register-api-service.ps1` | NSSM 註冊 API 服務 |
