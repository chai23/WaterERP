# 暫時 HTTPS 測試隧道（方案 C）
# 需先：ngrok 帳號 + authtoken 已設定；本機 Nginx 監聽 80；API 已啟動
#
# 固定免費網域（此帳號）：gawk-luckiness-freeing.ngrok-free.dev
# Webhook: https://gawk-luckiness-freeing.ngrok-free.dev/api/line/webhook
# LIFF:    https://gawk-luckiness-freeing.ngrok-free.dev/liff/
# LIFF URL: https://liff.line.me/2010707717-Z1PnsVQn

$ErrorActionPreference = "Stop"
$ngrok = Join-Path $PSScriptRoot "ngrok\ngrok.exe"
if (-not (Test-Path $ngrok)) { throw "找不到 $ngrok" }

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $ngrok -ArgumentList @(
  "http", "80",
  "--url=gawk-luckiness-freeing.ngrok-free.dev"
) -WorkingDirectory (Split-Path $ngrok) -WindowStyle Minimized

Write-Host "已啟動 ngrok → https://gawk-luckiness-freeing.ngrok-free.dev"
Write-Host "儀表板：http://127.0.0.1:4040"
