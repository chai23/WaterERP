# 超好企業進銷存系統 Mac 啟動器（原生 SwiftUI 應用程式）

macOS 專用的原生桌面啟動器，用於管理超好企業進銷存系統開發環境。

## 功能

- **服務管理**：MySQL、API、後台、司機端 一鍵啟停與個別控制
- **狀態監控**：每 3 秒自動檢查埠與 API 健康狀態
- **Git 同步**：拉取最新程式碼、提交並推送到 GitHub
- **執行日誌**：即時顯示服務輸出與操作紀錄

## 啟動方式

### 方式一：雙擊（推薦）

```
tools/WaterErpMacLauncher/start.command
```

首次執行會自動建置 `.app`，之後直接開啟。

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
