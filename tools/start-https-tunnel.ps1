# 啟動暫用 HTTPS 隧道（需先啟動 Nginx + API）
# 用法：powershell -File tools\start-https-tunnel.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot "tunnel-out.txt"
$err = Join-Path $PSScriptRoot "tunnel-err.txt"
$urlFile = Join-Path $PSScriptRoot "tunnel-url.txt"
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath "ssh" -ArgumentList @(
  "-o","StrictHostKeyChecking=accept-new",
  "-o","ServerAliveInterval=30",
  "-o","ExitOnForwardFailure=yes",
  "-T","-R","80:127.0.0.1:80","nokey@localhost.run"
) -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 8
$text = (Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue)
$m = [regex]::Match($text, "https://[a-zA-Z0-9.-]+\.lhr\.life")
if (-not $m.Success) { throw "無法取得隧道網址，請查看 tools\tunnel-out.txt" }
$url = $m.Value
Set-Content $urlFile $url -NoNewline
Write-Host "隧道已啟動 PID=$($p.Id)"
Write-Host "HTTPS 網址：$url"
Write-Host "Webhook：$url/api/line/webhook"
Write-Host "LIFF：$url/liff/"
