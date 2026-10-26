#Requires -Version 5.1
<#
.SYNOPSIS
    Install the dsh-vpn plugin into a DeepSeek Harness profile.

.DESCRIPTION
    Copies the plugin below <ProfileDir>\plugins\dsh-vpn, backs up
    cordis.patch.yml, and appends one loader insert row that points at the
    installed entry file. With HMR enabled the running Harness picks the row up
    without a restart; otherwise restart the application.

.PARAMETER ProfileDir
    The profile to modify. Defaults to the Desktop profile.

.PARAMETER Source
    Plugin source directory. Defaults to ..\plugin beside this script.

.PARAMETER DryRun
    Print the planned changes without writing anything.
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$Source,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $Text, $encoding)
    }
    catch {
        Set-Content -LiteralPath $Path -Value $Text -Encoding UTF8 -NoNewline
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = Join-Path $repoRoot 'plugin'
}

$profilePath = [System.IO.Path]::GetFullPath($ProfileDir)
$sourcePath = [System.IO.Path]::GetFullPath($Source)
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$destPath = Join-Path $profilePath 'plugins\dsh-vpn'
$entryId = 'dsh-vpn'

foreach ($path in @($profilePath, $sourcePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required path does not exist: $path"
    }
}
foreach ($file in @($patchPath, (Join-Path $sourcePath 'index.js'))) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Required file does not exist: $file"
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$patchPath.bak-$timestamp"
$indexPath = Join-Path $destPath 'index.js'
$fileUrl = 'file:///' + ($indexPath -replace '\\', '/')

Write-Host "Profile:  $profilePath"
Write-Host "Source:   $sourcePath"
Write-Host "Target:   $destPath"
Write-Host "Patch:    $patchPath"

if ($DryRun) {
    Write-Host 'Dry run: no files were changed.'
    return
}

$content = Get-Content -LiteralPath $patchPath -Raw
$alreadyPresent = $content -match '(?m)^\s*-\s*id:\s*dsh-vpn\s*\r?$'

if ($alreadyPresent) {
    Write-Host 'Plugin row already present; only the installed files are refreshed.'
}
else {
    Copy-Item -LiteralPath $patchPath -Destination $backupPath -Force
    Write-Host "Patch backup: $backupPath"
}

if (Test-Path -LiteralPath $destPath) {
    Remove-Item -LiteralPath $destPath -Recurse -Force
}
New-Item -ItemType Directory -Path $destPath -Force | Out-Null
Copy-Item -Path (Join-Path $sourcePath '*') -Destination $destPath -Recurse -Force

if (-not $alreadyPresent) {
    if (-not $content.EndsWith("`n")) {
        $content += "`n"
    }
    $content += "`n- insert:`n    - id: dsh-vpn`n      name: `"$fileUrl`"`n"
    Write-Utf8NoBom -Path $patchPath -Text $content
    Write-Host "Appended loader row for '$entryId' to the profile patch."
}

$verified = Get-Content -LiteralPath $patchPath -Raw
if ($verified -notmatch [regex]::Escape($fileUrl)) {
    throw "Verification failed: the installed file URL is absent from $patchPath"
}
if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Verification failed: $indexPath is missing"
}

Write-Host ''
Write-Host 'Installed. HMR should load the plugin; the vpn_* tools appear on the next model turn.'
Write-Host 'If they do not appear, restart DeepSeek Harness (the profile patch stays valid).'
Write-Host ''
Write-Host "Rollback: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'uninstall.ps1')`" -ProfileDir `"$profilePath`" -Restore"

