# 依專案路徑產生 Nginx 設定檔
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$ApiPort = 3000,
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$templatePath = Join-Path $PSScriptRoot "..\nginx\water-erp.conf.template"
if (-not (Test-Path $templatePath)) {
    throw "找不到範本：$templatePath"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $ProjectRoot "deploy\nginx\water-erp.conf"
}

$rootForNginx = ($ProjectRoot -replace "\\", "/")
$template = Get-Content -Path $templatePath -Raw -Encoding UTF8
$config = $template `
    -replace "\{\{PROJECT_ROOT\}\}", $rootForNginx `
    -replace "\{\{API_PORT\}\}", [string]$ApiPort

$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

[System.IO.File]::WriteAllText($OutputPath, $config, [System.Text.UTF8Encoding]::new($false))
Write-Host "已產生 Nginx 設定：$OutputPath"
Write-Host "專案路徑：$rootForNginx"
Write-Host "API 埠：$ApiPort"
