#Requires -Version 5.1
<#
.SYNOPSIS
    Stop the local IPv4 proxy used by watch-youtube.ps1.
#>
[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'tools\ipv4-proxy.pid'
$port = 8899

if (Test-Path -LiteralPath $pidFile) {
    $proxyId = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($proxyId -match '^\d+$') {
        Stop-Process -Id ([int]$proxyId) -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped IPv4 proxy process $proxyId."
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
else {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $listener) {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped process $($listener.OwningProcess) listening on port $port."
    }
    else {
        Write-Host "No IPv4 proxy is running on port $port."
    }
}
