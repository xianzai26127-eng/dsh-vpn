#Requires -Version 5.1
<#
.SYNOPSIS
    Remove the dsh-vpn plugin from a DeepSeek Harness profile.

.PARAMETER ProfileDir
    The profile to modify. Defaults to the Desktop profile.

.PARAMETER Restore
    Restore the newest earlier cordis.patch.yml backup instead of editing the row out.

.PARAMETER DryRun
    Print the planned changes without writing anything.
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [switch]$Restore,
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

$profilePath = [System.IO.Path]::GetFullPath($ProfileDir)
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$destPath = Join-Path $profilePath 'plugins\dsh-vpn'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$patchPath.bak-$timestamp"

if (-not (Test-Path -LiteralPath $profilePath)) {
    throw "Profile does not exist: $profilePath"
}
if (-not (Test-Path -LiteralPath $patchPath)) {
    throw "Profile patch does not exist: $patchPath"
}

Write-Host "Profile: $profilePath"
Write-Host "Plugin:  $destPath"

if ($DryRun) {
    Write-Host 'Dry run: no files were changed.'
    return
}

Copy-Item -LiteralPath $patchPath -Destination $backupPath -Force

if ($Restore) {
    $latest = Get-ChildItem -LiteralPath $profilePath -Filter 'cordis.patch.yml.bak-*' |
        Sort-Object Name -Descending |
        Where-Object {
            $candidate = Get-Content -LiteralPath $_.FullName -Raw
            $candidate -notmatch '(?m)^\s*-\s*id:\s*dsh-vpn\s*\r?$'
        } |
        Select-Object -First 1
    if ($null -eq $latest) {
        Write-Warning 'No earlier patch backup without the plugin row was found; only the plugin directory is removed.'
    }
    else {
        Copy-Item -LiteralPath $latest.FullName -Destination $patchPath -Force
        Write-Host "Restored $($latest.Name) over the profile patch."
    }
}
else {
    $lines = @(Get-Content -LiteralPath $patchPath)
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $isInsert = $lines[$index] -match '^- insert:\s*$'
        $isTarget = ($index + 1) -lt $lines.Count -and $lines[$index + 1] -match '^\s+-\s*id:\s*dsh-vpn\s*$'
        if ($isInsert -and $isTarget) {
            if ($kept.Count -gt 0 -and $kept[$kept.Count - 1] -eq '') {
                $kept.RemoveAt($kept.Count - 1)
            }
            $index += 2
            $removed = $true
            continue
        }
        $kept.Add($lines[$index])
    }

    if (-not $removed) {
        Write-Host 'No dsh-vpn loader row found; leaving the patch unchanged.'
    }
    else {
        $text = ($kept -join "`n")
        if (-not $text.EndsWith("`n")) {
            $text += "`n"
        }
        Write-Utf8NoBom -Path $patchPath -Text $text
        Write-Host 'Removed the dsh-vpn loader row.'
    }
}

if (Test-Path -LiteralPath $destPath) {
    Remove-Item -LiteralPath $destPath -Recurse -Force
    Write-Host "Removed $destPath"
}

Write-Host ''
Write-Host 'Uninstalled. HMR reloads the composition; restart DeepSeek Harness if the vpn_* tools remain visible.'
Write-Host "Patch backup for this run: $backupPath"
