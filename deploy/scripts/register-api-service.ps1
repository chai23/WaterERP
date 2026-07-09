# 使用 NSSM 將 API 註冊為 Windows 服務（需以系統管理員執行）
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$ServiceName = "WaterERP-API",
    [string]$NssmPath = "nssm"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    throw "請以系統管理員身分執行 PowerShell。"
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw "找不到 node.exe，請確認 Node.js 已安裝並加入 PATH。"
}

$apiDir = Join-Path $ProjectRoot "apps\api"
$apiScript = Join-Path $apiDir "dist\index.js"
if (-not (Test-Path $apiScript)) {
    throw "找不到 $apiScript，請先執行 deploy\scripts\build-production.ps1"
}

$nssm = (Get-Command $NssmPath -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
    throw @"
找不到 NSSM。請先下載並解壓到 PATH，例如：
  https://nssm.cc/download
然後以系統管理員執行：
  nssm install $ServiceName `"$node`" `"$apiScript`"
  nssm set $ServiceName AppDirectory `"$apiDir`"
  nssm set $ServiceName DisplayName `"WaterERP API`"
  nssm set $ServiceName Start SERVICE_AUTO_START
  nssm start $ServiceName
"@
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "服務已存在：$ServiceName，正在重啟..."
    & $nssm restart $ServiceName
} else {
    & $nssm install $ServiceName $node $apiScript
    & $nssm set $ServiceName AppDirectory $apiDir
    & $nssm set $ServiceName DisplayName "WaterERP API"
    & $nssm set $ServiceName Start SERVICE_AUTO_START
    & $nssm start $ServiceName
    Write-Host "已註冊並啟動服務：$ServiceName"
}

Write-Host "健康檢查：http://127.0.0.1:3000/api/health"
