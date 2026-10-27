<#
.SYNOPSIS
  VPN 泄漏自检：出口 IP、DNS、IPv6、MTU、默认路由、DoH 可用性。

.DESCRIPTION
  依据 YouTube 上常见的「VPN 安全自检」清单（DNS 泄漏 / WebRTC 泄漏 / IPv6 泄漏 /
  Kill Switch / MTU）在 Windows 本机做可自动化的一部分检查，输出 PASS / WARN / FAIL。

  无法自动化的部分（WebRTC 真实 IP、浏览器指纹）请人工打开：
    https://ipleak.net/          出口 IP + DNS + WebRTC
    https://browserleaks.com/webrtc

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\leak-check.ps1
#>
[CmdletBinding()]
param(
  [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:results = New-Object System.Collections.ArrayList

function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail)
  [void]$script:results.Add([pscustomobject]@{ Check = $Name; Status = $Status; Detail = $Detail })
}

function Invoke-Text {
  param([string]$Url, [int]$Timeout = $TimeoutSec)
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $Timeout -Headers @{ 'User-Agent' = 'dsh-vpn-leak-check/1.0' }
    return ($r.Content | Out-String).Trim()
  } catch {
    return $null
  }
}

function Test-VpnInterface {
  param([string]$Alias)
  return ($Alias -match 'hide\.me|warp|cloudflare|vpn|tun|tap|wireguard|openvpn')
}

# ---------- 1. 默认路由 ----------
$v4route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Sort-Object { $_.RouteMetric + (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).InterfaceMetric } |
  Select-Object -First 1
$v6route = Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue |
  Sort-Object { $_.RouteMetric + (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue).InterfaceMetric } |
  Select-Object -First 1

if ($v4route) {
  $alias = (Get-NetAdapter -InterfaceIndex $v4route.ifIndex -ErrorAction SilentlyContinue).Name
  if (-not $alias) { $alias = "if$($v4route.ifIndex)" }
  if (Test-VpnInterface $alias) { Add-Result 'IPv4 默认路由' 'PASS' "走 VPN 接口 [$alias]" }
  else { Add-Result 'IPv4 默认路由' 'FAIL' "走物理接口 [$alias]，流量未进隧道" }
} else { Add-Result 'IPv4 默认路由' 'FAIL' '未找到默认路由' }

if ($v6route) {
  $alias6 = (Get-NetAdapter -InterfaceIndex $v6route.ifIndex -ErrorAction SilentlyContinue).Name
  if (-not $alias6) { $alias6 = "if$($v6route.ifIndex)" }
  if (Test-VpnInterface $alias6) { Add-Result 'IPv6 默认路由' 'PASS' "走 VPN 接口 [$alias6]" }
  else { Add-Result 'IPv6 默认路由' 'WARN' "走物理接口 [$alias6]，IPv6 可能绕过隧道（IPv6 泄漏）" }
} else {
  Add-Result 'IPv6 默认路由' 'PASS' '无 IPv6 默认路由（不出网，无泄漏面）'
}

# ---------- 2. 出口 IP ----------
$ip4 = Invoke-Text 'https://api.ipify.org?format=json'
$egress4 = $null
if ($ip4 -and $ip4 -match '"ip"\s*:\s*"([^"]+)"') { $egress4 = $Matches[1] }
Add-Result 'IPv4 出口 IP' $(if ($egress4) { 'PASS' } else { 'FAIL' }) $(if ($egress4) { $egress4 } else { '无法获取（网络不可用或站点被拦）' })

$ip6 = Invoke-Text 'https://api6.ipify.org?format=json'
$egress6 = $null
if ($ip6 -and $ip6 -match '"ip"\s*:\s*"([^"]+)"') { $egress6 = $Matches[1] }
if (-not $egress6 -or $egress6 -notmatch ':') {
  Add-Result 'IPv6 出口 IP' 'WARN' '无 IPv6 出口（v6 未使用或不可达；v4-only 隧道不会泄漏 v6）'
} else {
  Add-Result 'IPv6 出口 IP' 'PASS' "$egress6（v6 走隧道；若为 ISP 原生段则为泄漏）"
}

# 出口归属（尽力而为）
if ($egress4) {
  $geo = Invoke-Text "https://ipapi.co/$egress4/json/" 15
  if ($geo -and $geo -match '"country_name"\s*:\s*"([^"]*)"') {
    $country = $Matches[1]
    $org = if ($geo -match '"org"\s*:\s*"([^"]*)"') { $Matches[1] } else { '' }
    Add-Result '出口归属' 'INFO' "$country / $org"
  }
}

# ---------- 3. DNS 是否在隧道内 ----------
$dnsServers = @()
foreach ($ifc in Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue) {
  if ($ifc.ServerAddresses) {
    $alias = (Get-NetAdapter -InterfaceIndex $ifc.InterfaceIndex -ErrorAction SilentlyContinue).Name
    foreach ($s in $ifc.ServerAddresses) { $dnsServers += [pscustomobject]@{ Alias = $alias; Server = $s } }
  }
}
$activeDns = $dnsServers | Where-Object { Test-VpnInterface $_.Alias }
$publicDns = $dnsServers | Where-Object { -not (Test-VpnInterface $_.Alias) }
if ($activeDns) {
  Add-Result 'DNS 服务器' 'PASS' ("VPN 内下发: " + (($activeDns | ForEach-Object { "$($_.Server)" }) -join ', '))
} else {
  Add-Result 'DNS 服务器' 'FAIL' '未发现 VPN 接口下发的 DNS，查询可能走 ISP'
}
if ($publicDns) {
  Add-Result '系统 DNS 列表' 'WARN' ("仍存在物理接口 DNS: " + (($publicDns | ForEach-Object { "$($_.Server)" }) -join ', ') + '（多宿主回退时可能泄漏）')
}

$dnsMs = (Measure-Command { Resolve-DnsName 'www.youtube.com' -Type A -ErrorAction SilentlyContinue | Out-Null }).TotalMilliseconds
Add-Result 'DNS 解析耗时' $(if ($dnsMs -lt 200) { 'PASS' } elseif ($dnsMs -lt 1000) { 'INFO' } else { 'WARN' }) ("{0:N0} ms（www.youtube.com A 记录）" -f $dnsMs)

# ---------- 4. MTU ----------
$vpnIf = Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { Test-VpnInterface (Get-NetAdapter -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue).Name } |
  Select-Object -First 1
if ($vpnIf) {
  $mtu = $vpnIf.NlMtu
  $st = if ($mtu -ge 1280 -and $mtu -le 1420) { 'INFO' } elseif ($mtu -gt 1420) { 'WARN' } else { 'WARN' }
  Add-Result '隧道 MTU' $st "$mtu（1280-1420 较稳；过大易 PMTU 黑洞）"
} else {
  Add-Result '隧道 MTU' 'WARN' '未识别 VPN 接口'
}

# ---------- 5. DoH 可用性（加密 DNS 备选） ----------
$dohHosts = @(
  'https://cloudflare-dns.com/dns-query?name=www.youtube.com&type=A',
  'https://dns.google/resolve?name=www.youtube.com&type=A',
  'https://dns.quad9.net:5053/dns-query?name=www.youtube.com&type=A'
)
$dohOk = @()
foreach ($u in $dohHosts) {
  try {
    $r = Invoke-WebRequest -Uri $u -Headers @{ accept = 'application/dns-json'; 'User-Agent' = 'dsh-vpn-leak-check/1.0' } -UseBasicParsing -TimeoutSec 10
    if ($r.Content -match '"Answer"') { $dohOk += ([uri]$u).Host }
  } catch { }
}
if ($dohOk.Count -gt 0) {
  Add-Result 'DoH 加密 DNS' 'PASS' ("可用: " + ($dohOk -join ', '))
} else {
  Add-Result 'DoH 加密 DNS' 'WARN' '全部不可用（链路拦截 DoH，只能依赖隧道内 DNS）'
}

# ---------- 6. 隧道连通性 ----------
$probe = Invoke-Text 'https://www.youtube.com/' 25
Add-Result 'YouTube 可达' $(if ($probe) { 'PASS' } else { 'FAIL' }) $(if ($probe) { 'HTTP 200' } else { '不可达' })

# ---------- 输出 ----------
Write-Host ''
Write-Host '=== VPN 泄漏自检 ===' -ForegroundColor Cyan
foreach ($r in $script:results) {
  $color = switch ($r.Status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
  Write-Host ("[{0,-4}] {1,-14} {2}" -f $r.Status, $r.Check, $r.Detail) -ForegroundColor $color
}
$failCount = @($script:results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = @($script:results | Where-Object { $_.Status -eq 'WARN' }).Count
$total = @($script:results).Count
$summary = "结论: FAIL=$failCount WARN=$warnCount 共 $total 项"
$summaryColor = if ($failCount -gt 0) { 'Red' } elseif ($warnCount -gt 0) { 'Yellow' } else { 'Green' }
Write-Host ''
Write-Host $summary -ForegroundColor $summaryColor
Write-Host 'Kill Switch: 本脚本无法在不提权的情况下读取防火墙策略；隧道断开后系统会回退到物理网卡（见上表 DNS 列表）。'
Write-Host '需人工验证: https://ipleak.net/ （WebRTC 真实 IP）与 https://browserleaks.com/webrtc'
