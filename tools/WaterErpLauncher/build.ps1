# =============================================================================
# 超好企業進銷存系統 Windows 啟動器 — 一鍵重新建置
# =============================================================================
# 功能：
#   1. 清除所有舊建置輸出（bin / obj / publish），確保只留最新版
#   2. 以 dotnet publish 產生單一 exe（self-contained，免安裝 .NET 執行階段）
#   3. 建置完成後自動開啟啟動器
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File tools\WaterErpLauncher\build.ps1
# 或直接雙擊：tools\WaterErpLauncher\建置啟動器.cmd
#
# 參數：
#   -NoLaunch   建置完成後不自動開啟
#   -Runtime    目標執行環境（預設 win-x64）
# =============================================================================
param(
    [switch]$NoLaunch,
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project = Join-Path $ProjectDir "WaterErpLauncher.csproj"
$PublishDir = Join-Path $ProjectDir "publish"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " 超好企業進銷存系統 Windows 啟動器 重新建置" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# 1) 檢查 dotnet
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    Write-Host "找不到 dotnet SDK。請先安裝 .NET 8 SDK：https://dotnet.microsoft.com/download/dotnet/8.0" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Project)) {
    Write-Host "找不到專案檔：$Project" -ForegroundColor Red
    exit 1
}

# 2) 清除舊版建置輸出（只留最新）
Write-Host "`n[1/3] 清除舊建置輸出…" -ForegroundColor Yellow
foreach ($dir in @("bin", "obj", "publish")) {
    $full = Join-Path $ProjectDir $dir
    if (Test-Path $full) {
        Remove-Item -Recurse -Force $full
        Write-Host "  已刪除 $dir/"
    }
}

# 3) 建置單一 exe
Write-Host "`n[2/3] 建置中（Release / $Runtime）…" -ForegroundColor Yellow
& dotnet publish $Project `
    -c Release `
    -r $Runtime `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -o $PublishDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n建置失敗（dotnet publish 回傳 $LASTEXITCODE）。" -ForegroundColor Red
    exit $LASTEXITCODE
}

$Exe = Join-Path $PublishDir "WaterErpLauncher.exe"
if (-not (Test-Path $Exe)) {
    Write-Host "`n建置完成但找不到 exe：$Exe" -ForegroundColor Red
    exit 1
}

Write-Host "`n[3/3] 建置完成！" -ForegroundColor Green
Write-Host "  最新版本：$Exe" -ForegroundColor Green

if (-not $NoLaunch) {
    Write-Host "`n正在開啟啟動器…" -ForegroundColor Cyan
    Start-Process $Exe
}
