# 超好企業進銷存系統 Mac 啟動器（原生 SwiftUI 應用程式）

macOS 專用的原生桌面啟動器，用於管理超好企業進銷存系統開發環境。

## 功能

- **服務管理**：MySQL、API、後台、司機端、LIFF 訂水 一鍵啟停與個別控制
- **狀態監控**：每 3 秒自動檢查埠與 API 健康狀態
- **Git 同步**：拉取最新程式碼、提交並推送到 GitHub
- **資料清空**：「清空交易資料（保留主檔）」或「清空全部業務資料（含主檔／使用者）」
- **執行日誌**：即時顯示服務輸出與操作紀錄

## 開發服務對照

| 服務 | npm script | 網址 |
|------|------------|------|
| API | `dev:api` | http://localhost:3000 |
| 後台 | `dev:admin` | http://localhost:5173 |
| 司機端 | `dev:driver` | http://localhost:5174 |
| LIFF 訂水 | `dev:liff` | http://localhost:5175/liff/ |

## 啟動方式

### 方式一：雙擊（推薦）

```
tools/WaterErpMacLauncher/start.command
```

首次會建置 `.app`；之後若 Swift 原始碼有更新，也會**自動重新建置**再開啟。

若畫面沒更新，或剛改完啟動器功能，可強制重建：

- 雙擊 `tools/WaterErpMacLauncher/rebuild.command`
- 或在專案根目錄執行 `npm run mac:launcher`

### 方式二：終端機

```bash
cd ~/Projects/WaterERP
npm run mac:launcher
```

### 方式三：Xcode

開啟 `WaterErpMacLauncher.xcodeproj`，按 ▶ 執行。

## 系統需求

- macOS 13 (Ventura) 或以上
- Xcode Command Line Tools 或 Xcode
- Node.js 18+（執行 dev 服務用）
- MySQL 8（預設 `~/mysql/current`）

## 設定

設定檔：`~/Library/Application Support/WaterErpMacLauncher/settings.json`

可在應用程式「設定」分頁修改專案路徑與 MySQL 路徑。

## 與 Windows 啟動器差異

| 功能 | Windows (WinForms) | Mac (SwiftUI) |
|------|-------------------|---------------|
| 介面 | 原生 Windows | 原生 macOS |
| Nginx 正式部署 | ✅ | ❌ |
| Vite 開發模式 | 可選 | ✅ 預設 |
| Git pull/push | 手動 | ✅ 內建 |
