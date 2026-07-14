# 建置正式版（API + 後台 + 司機端 + LIFF）並產生 Nginx 設定
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
Set-Location $ProjectRoot

Write-Host "==> 安裝依賴..."
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Prisma generate..."
npm run db:generate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 建置 API / 後台 / 司機端 / LIFF..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apiDist = Join-Path $ProjectRoot "apps\api\dist\index.js"
$adminDist = Join-Path $ProjectRoot "apps\web-admin\dist\index.html"
$driverDist = Join-Path $ProjectRoot "apps\web-driver\dist\index.html"
$liffDist = Join-Path $ProjectRoot "apps\web-liff\dist\index.html"

foreach ($path in @($apiDist, $adminDist, $driverDist, $liffDist)) {
    if (-not (Test-Path $path)) {
        throw "建置失敗，缺少檔案：$path"
    }
}

& (Join-Path $PSScriptRoot "generate-nginx-config.ps1") -ProjectRoot $ProjectRoot

Write-Host ""
Write-Host "建置完成。"
Write-Host "  API：      apps\api\dist\index.js"
Write-Host "  後台：     apps\web-admin\dist\"
Write-Host "  司機端：   apps\web-driver\dist\  （子路徑 /driver/）"
Write-Host "  LIFF：     apps\web-liff\dist\  （子路徑 /liff/）"
Write-Host "  Nginx 設定：deploy\nginx\water-erp.conf"
