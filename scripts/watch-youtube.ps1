#Requires -Version 5.1
<#
.SYNOPSIS
    Open a YouTube URL in Chrome through a local IPv4-only proxy.

.DESCRIPTION
    YouTube's media CDN returns 403 to the Cloudflare WARP IPv6 egress. Chrome
    prefers IPv6, so the watch page loads but the player reports "视频无法播放".
    This launcher ensures WARP is connected, starts a small local proxy that
    resolves A records only, and opens Chrome with a PAC that sends YouTube
    domains through that proxy. The rest of the browsing traffic stays direct.

.PARAMETER Url
    The YouTube URL to open. Defaults to The Egg.
#>
[CmdletBinding()]
param(
    [string]$Url = 'https://www.youtube.com/watch?v=h6fcK_fRYaI'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$proxyScript = Join-Path $root 'tools\ipv4-proxy.mjs'
$profileDir = Join-Path $root 'chrome-profile'
$pidFile = Join-Path $root 'tools\ipv4-proxy.pid'
$port = 8899

$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    $node = 'node'
}

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) {
    $chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path -LiteralPath $chrome)) {
    throw 'Google Chrome was not found.'
}
if (-not (Test-Path -LiteralPath $proxyScript)) {
    throw "Proxy script not found: $proxyScript"
}

function Test-LocalPort {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

# 1. Make sure WARP is connected: YouTube needs the tunnel, and the proxy
#    resolves A records through the system resolver.
$warp = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe'
if (Test-Path -LiteralPath $warp) {
    & $warp connect 2>&1 | Out-Null
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $status = & $warp status 2>&1 | Out-String
        if ($status -match 'Status update:\s*Connected') { break }
        Start-Sleep -Milliseconds 700
    }
    if ($status -notmatch 'Status update:\s*Connected') {
        Write-Warning 'Cloudflare WARP did not report Connected; YouTube may still fail.'
    }
}

# 2. Start the IPv4 proxy when it is not already listening.
if (-not (Test-LocalPort -Port $port)) {
    $proxy = Start-Process -FilePath $node -ArgumentList @("`"$proxyScript`"") -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $pidFile -Value $proxy.Id -Encoding ASCII
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        if (Test-LocalPort -Port $port) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-LocalPort -Port $port)) {
        throw "IPv4 proxy did not start on port $port."
    }
    Write-Host "Started IPv4 proxy (PID $($proxy.Id)) on http://127.0.0.1:$port"
}
else {
    Write-Host "IPv4 proxy already listening on http://127.0.0.1:$port"
}

# 3. Open Chrome with a dedicated profile and the PAC that matches YouTube only.
if (-not (Test-Path -LiteralPath $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}
$pacUrl = "http://127.0.0.1:$port/proxy.pac"
$arguments = @(
    "--user-data-dir=$profileDir",
    "--proxy-pac-url=$pacUrl",
    '--no-first-run',
    '--no-default-browser-check',
    $Url
)
Start-Process -FilePath $chrome -ArgumentList $arguments | Out-Null

Write-Host ''
Write-Host "Opened in Chrome: $Url"
Write-Host "Only YouTube domains go through the IPv4 proxy; other sites stay direct."
Write-Host "Stop the proxy: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'stop-youtube-proxy.ps1')`""
