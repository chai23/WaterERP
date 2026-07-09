# 開放 Windows 防火牆 HTTP 埠（需以系統管理員執行）
param(
    [int]$Port = 80,
    [string]$RuleName = "WaterERP HTTP"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    throw "請以系統管理員身分執行 PowerShell。"
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "防火牆規則已存在：$RuleName"
} else {
    New-NetFirewallRule `
        -DisplayName $RuleName `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $Port `
        -Action Allow | Out-Null
    Write-Host "已新增防火牆規則：$RuleName（TCP $Port）"
}
