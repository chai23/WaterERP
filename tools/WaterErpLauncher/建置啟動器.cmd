@echo off
chcp 65001 >nul
rem 雙擊即可重新建置並啟動 Windows 端啟動器（會先清除舊版本）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo 建置失敗，請看上方訊息。按任意鍵關閉。
    pause >nul
)
