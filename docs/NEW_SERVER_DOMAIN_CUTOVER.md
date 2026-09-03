# 把現有網域切到新伺服器（固定 IP）

適用情境：

- 新伺服器是 Windows，有**固定公網 IP**
- 舊系統庫 `database` 與新系統庫 `water_erp` **都在新伺服器本機 MySQL**
- 沿用現有網域 `aoshyhcake.com.tw`（含 `www`）
- 用 Windows 啟動器部署（Nginx 單一入口 + HTTPS）

核心做法：網域名稱不變，只把 DNS **A 記錄**改成新 IP。使用者仍開 `https://aoshyhcake.com.tw`。

下文路徑以 `C:\WaterERP` 為例，請依實際位置替換。把 `新固定IP` 換成新伺服器公網 IP。

---

## 切換後網址（不變）

| 用途 | 網址 |
|------|------|
| 後台 | `https://aoshyhcake.com.tw/` |
| 司機端 | `https://aoshyhcake.com.tw/driver/` |
| LIFF 訂水 | `https://aoshyhcake.com.tw/liff/` |
| API 健康檢查 | `https://aoshyhcake.com.tw/api/health` |
| LINE Webhook | `https://aoshyhcake.com.tw/api/line/webhook` |

LINE 若本來就填這些網址，**DNS 改完通常不用改 LINE Developers**。

---

## 總流程（照順序做）

```
A. 舊機先備份／複製憑證與 .env（舊機先不要關）
B. 新機裝軟體、拉程式、建 water_erp
C. 啟動器部署 + Nginx HTTPS
D. 用 hosts 假裝網域已指向新機，測後台／司機端／LINE
E. 轉舊庫主檔 → 切換日開帳
F. 改 DNS
G. 外網複測 → 觀察 24～48 小時 → 再關舊機
```

**在 F 完成之前，對外流量仍走舊伺服器。** 新機可以慢慢測，不會影響現在在用的系統。

---

## A. 舊伺服器：先準備帶走的東西

舊機繼續營運。用 USB 或遠端複製即可（憑證與 `.env` 含密鑰，**不要上傳 GitHub**）。

### A1. 複製這三組檔案

| 來源（舊機） | 用途 |
|--------------|------|
| `deploy\certs\` 整夾（至少 `aoshyhcake.com.tw-chain.pem`、`aoshyhcake.com.tw-key.pem`） | HTTPS |
| `apps\api\.env` | 資料庫、JWT、LINE |
| `apps\web-liff\.env` | `VITE_LIFF_ID` |

### A2. 備份舊系統庫（建議）

在**新機**上已有 `database` 的話，這步是保險；若舊庫還只在舊機，一定要先 dump 再匯入新機：

```powershell
mysqldump -u 使用者 -p --databases database > D:\backup\legacy_database.sql
mysqldump -u 使用者 -p water_erp > D:\backup\old_water_erp_optional.sql
```

新機若已有完整 `database`，不必再從舊機匯入舊庫。

### A3. 記下 DNS 現況

到網域註冊商或 Cloudflare 確認：

- `@`（aoshyhcake.com.tw）目前 A 記錄是哪個 IP
- `www` 是 A 還是 CNAME

先不要改。可把 TTL 先降到 300 秒，切換當天生效較快。

---

## B. 新伺服器：軟體與程式

### B1. 安裝

| 軟體 | 說明 |
|------|------|
| Node.js 18+ | `node -v` |
| Git | `git --version` |
| MySQL 8 | Windows Service，名稱多半是 `MySQL80`，設自動啟動 |
| Nginx for Windows | 例如解壓到 `C:\nginx`（資料夾內要有 `nginx.exe`） |
| .NET 8 SDK | 建啟動器：`dotnet --version` |

MySQL 只聽本機：設定 `bind-address = 127.0.0.1`，**不要對外開 3306**。

### B2. 拉程式

```powershell
cd C:\
git clone https://github.com/chai23/WaterERP.git
cd C:\WaterERP
git checkout main
git pull origin main
```

若 `npm run build` 在後台出現 `TS6133`（未使用變數），代表 GitHub 還沒包含修正，請先在開發機推上 `main` 再 `git pull`。

### B3. 建新庫 `water_erp`

舊庫名稱是 `database`，**不要對它執行** `schema.sql`。

```sql
CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

```powershell
cd C:\WaterERP
mysql -u 使用者 -p water_erp < database\schema.sql
```

### B4. 放入憑證與環境變數

把 A1 的檔案放到新機對應位置：

```
C:\WaterERP\deploy\certs\
C:\WaterERP\apps\api\.env
C:\WaterERP\apps\web-liff\.env
```

編輯 `apps\api\.env`，確認：

```env
DATABASE_URL="mysql://使用者:密碼@127.0.0.1:3306/water_erp"
HOST=127.0.0.1
PORT=3000
```

- 舊新庫都在本機：**不要填** `LEGACY_DATABASE_URL`（會自動連同一台的 `database`）
- LINE 三個值從舊 `.env` 原樣保留（`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_LOGIN_CHANNEL_ID`）
- 正式機**不要**開 `LIFF_DEV_BYPASS`、`LINE_OTP_DEV_MODE`、`LINE_OTP_SKIP`
- 走網域 + Nginx 時可拿掉 `CORS_ORIGIN`，或維持空白
- `JWT_SECRET` 可沿用舊值；想重簽所有登入就改成新的長隨機字串

`apps\web-liff\.env` 只要有正式的 `VITE_LIFF_ID`，且不要開 `VITE_LIFF_DEV_BYPASS`。

---

## C. 啟動器、防火牆、Nginx

### C1. 建啟動器

以系統管理員開 PowerShell：

```powershell
cd C:\WaterERP
npm run win:launcher
```

之後請**以系統管理員身分**執行：

`C:\WaterERP\tools\WaterErpLauncher\publish\WaterErpLauncher.exe`

### C2. 啟動器「設定」分頁

| 項目 | 填入 |
|------|------|
| 專案根目錄 | `C:\WaterERP` |
| Nginx 目錄 | `C:\nginx` |
| MySQL 服務名稱 | `MySQL80`（不對就改成實際名稱） |
| 網站 / API URL | `https://aoshyhcake.com.tw` |
| 後台 URL | `https://aoshyhcake.com.tw/` |
| 司機端 URL | `https://aoshyhcake.com.tw/driver/` |
| LIFF URL | `https://aoshyhcake.com.tw/liff/` |
| Git 分支 | `main` |

按「儲存設定」。

### C3. 防火牆（80 + 443）

```powershell
cd C:\WaterERP
powershell -ExecutionPolicy Bypass -File deploy\scripts\install-firewall.ps1
powershell -ExecutionPolicy Bypass -File deploy\scripts\install-firewall.ps1 -Port 443 -RuleName "WaterERP HTTPS"
```

若在路由器後方，再做 Port Forward：

| 外部埠 | 內部 |
|--------|------|
| 80 | 新伺服器區網 IP:80 |
| 443 | 新伺服器區網 IP:443 |

固定 IP 若直接接在這台網卡上，不必做 Port Forward。

### C4. 讓 Nginx 讀專案設定

用記事本開 `C:\nginx\conf\nginx.conf`，在 `http { }` 裡加一行（路徑用正斜線）：

```nginx
include C:/WaterERP/deploy/nginx/water-erp.conf;
```

存檔。啟動器之後會自動產生／更新 `deploy\nginx\water-erp.conf`（網域 + HTTPS）。

### C5. 第一次「更新並部署」

啟動器 → 服務總覽 → **更新並部署**。

若跳出 LINE 設定警告，設定已從舊機複製齊就可繼續；沒齊可先選「是」把後台拉起來，但 LINE 訂水會不完整。

完成後，啟動器上 MySQL / API / Nginx 應為綠燈。

本機先測（此時 DNS 仍指舊機，所以用 IP 測 API 即可）：

```
http://127.0.0.1:3000/api/health
```

用瀏覽器直接開 `http://新固定IP/` 可能會被導去 `https://aoshyhcake.com.tw`（仍是舊機）。**正式測試請用下一節 hosts。**

---

## D. 用 hosts 測試新機（DNS 還沒改）

在**測試用電腦**（或新伺服器自己）以系統管理員編輯：

`C:\Windows\System32\drivers\etc\hosts`

加兩行：

```
新固定IP    aoshyhcake.com.tw
新固定IP    www.aoshyhcake.com.tw
```

存檔後瀏覽器開：

1. `https://aoshyhcake.com.tw/` → 新機後台登入
2. `https://aoshyhcake.com.tw/driver/` → 司機端
3. `https://aoshyhcake.com.tw/api/health` → JSON 正常
4. 憑證應顯示網域有效（因為已把舊機憑證放到新機）

測完若還要繼續用舊站，把這兩行 hosts **刪掉或註解**，否則這台電腦會一直連新機。

---

## E. 資料：舊庫轉換 + 切換日開帳

在新機啟動器「資料維護」操作。過程會停 API／Nginx，**MySQL 保持運行**。舊機不受影響。

### E1. 結構

1. 檢查結構
2. 若有待升級 → 先備份 `water_erp` → 升級結構

### E2. 主檔轉換（順序固定）

1. 轉換地址分區
2. 轉換隸屬公司
3. 轉換客戶資料
4. 轉換使用者資料
5. 轉換司機資料
6. 轉換商品資料

**不要轉換訂單。** 歷史單之後在後台「舊系統歷史訂單」看。

轉換使用者後會有系統管理員（員編 `admin`，預設密碼 `admin123`）。請立刻登入後台改密碼。司機預設密碼 `888888`，上線前請更換。

若轉錯，可用「清空全部資料」後重轉（會刪主檔與使用者，無法登入直到再轉使用者）。只想清測試訂單用「清空交易資料」。

### E3. 切換日開帳

後台：**主檔資料 → 切換日開帳**

用來帶入舊系統未收款，並同步空桶／預付桶。這是上線日帳務起點，**不要**把舊訂單灌進新系統。

建議在 DNS 切換當天、開始用新系統前執行（hosts 測通後也可以先做，確認數字）。

---

## F. 改 DNS（真正切流量）

確認 D、E 都 OK，選離峰時間。

到網域 DNS：

| 主機名稱 | 類型 | 值 |
|----------|------|-----|
| `@` | A | **新固定IP** |
| `www` | A 或 CNAME | 新固定IP，或指到 `@` |

存檔。TTL 短的話約數分鐘；有人可能要幾小時。

這段期間：

- 舊機 Nginx／API **先不要關**
- 新機保持「啟動全部」

手機請開 **4G**（不要連公司 Wi‑Fi）測 `https://aoshyhcake.com.tw/`，避免還快取舊 IP。

可用 [https://dnschecker.org](https://dnschecker.org) 查 `aoshyhcake.com.tw` 的 A 記錄是否已變新 IP。

---

## G. 切換後檢查

- [ ] 外網後台可登入
- [ ] `https://aoshyhcake.com.tw/driver/` 正常
- [ ] `https://aoshyhcake.com.tw/api/health` 正常
- [ ] LINE 官方帳號選單／LIFF 訂水仍可開
- [ ] LINE Developers → Messaging API → Webhook 仍是 `https://aoshyhcake.com.tw/api/line/webhook`，驗證成功
- [ ] 後台打一筆測試單、司機端看得到

LINE 網址本來就是這個網域的話，通常**不用改**。若以前填舊 IP，改成上面的 HTTPS 網域。

觀察 **24～48 小時**沒問題，再停舊機的 Nginx／API。舊機 MySQL 若已不再被使用，可再晚幾天關，方便緊急切回。

緊急切回：把 DNS A 記錄改回舊 IP 即可（舊機那時還要能開）。

---

## 日常（新機）

更新程式：啟動器「更新並部署」（會 `git pull`、建置、升級結構、重啟 API／Nginx）。

備份：

```powershell
mysqldump -u 使用者 -p water_erp > D:\backup\water_erp_yyyyMMdd.sql
```

也請備份 `apps\api\.env` 與 `deploy\certs\`。

---

## 常見問題

### 改 DNS 後瀏覽器還進舊站

本機 DNS／瀏覽器快取。試無痕、手機 4G，或 `ipconfig /flushdns`。

### HTTPS 憑證錯誤

新機 `deploy\certs\` 不完整，或啟動器產生的 conf 路徑不對。對照 Nginx 錯誤日誌，確認 pem 檔存在後重載 Nginx。

### 開 `http://新IP` 卻跳到舊站

正常：80 會 301 到 `https://aoshyhcake.com.tw`。DNS 未改前請用 **hosts** 測，不要用裸 IP 當正式驗證。

### `/api/` 502

API 沒起來。啟動器看 API 日誌，或本機開 `http://127.0.0.1:3000/api/health`。

### 外網連不到、本機可以

防火牆 80/443、路由器轉送、ISP 是否擋 80/443。

### LINE LIFF 白畫面或無法登入

確認已建置 LIFF（`apps\web-liff\dist`）、`VITE_LIFF_ID` 正確且建置後才生效、正式 `.env` 沒開 bypass。LIFF Endpoint 必須是 HTTPS 網域。

### 轉換主檔失敗／連不到舊庫

確認本機 MySQL 有 `database` 庫，且 `DATABASE_URL` 帳號對 `database` 有讀取權。不必設 `LEGACY_DATABASE_URL`。
