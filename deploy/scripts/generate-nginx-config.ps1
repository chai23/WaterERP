# 依本機專案路徑產生 Nginx 設定檔（輸出檔含絕對路徑，不要提交到 Git）。
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$ApiPort = 3000,
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$localFlag = Join-Path $ProjectRoot "deploy\nginx\.use-local-test"
$useLocalTest = Test-Path $localFlag
$templatePath = if ($useLocalTest) {
    Join-Path $PSScriptRoot "..\nginx\water-erp.local.conf.template"
} else {
    Join-Path $PSScriptRoot "..\nginx\water-erp.conf.template"
}
if (-not (Test-Path $templatePath)) {
    throw "找不到範本：$templatePath"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = if ($useLocalTest) {
        Join-Path $ProjectRoot "deploy\nginx\water-erp.local.conf"
    } else {
        Join-Path $ProjectRoot "deploy\nginx\water-erp.conf"
    }
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
if ($useLocalTest) {
    Write-Host "模式：本機測試（不轉正式網域）"
}
