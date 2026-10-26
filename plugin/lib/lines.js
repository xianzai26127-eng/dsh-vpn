/**
 * VPN line detection and control.
 *
 * Cloudflare WARP is the only line this plugin can drive (`warp-cli`). The
 * hide.me client has no command-line interface, so a connected hide.me tunnel
 * is detected and preferred, never started or stopped from here.
 */
import os from 'node:os'
import { lookup } from 'node:dns/promises'
import { findWarpCli, run } from './exec.js'
import { isPublicAddress } from './net.js'

export const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace'
export const DEFAULT_DNS_HOST = 'www.youtube.com'

export function parseWarpStatus(text) {
  const source = String(text ?? '')
  const connected = /Status update:\s*Connected\b/i.test(source)
  const protocol = /Tunnel Protocol:\s*(.+)/i.exec(source)?.[1]?.trim() ?? ''
  const colo = /Colo:\s*([A-Za-z0-9]+)/i.exec(source)?.[1]?.trim() ?? ''
  const detail = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 8)
    .join(' | ')
  return { connected, protocol, colo, detail }
}

export function parseWarpSettings(text) {
  const source = String(text ?? '')
  const mode = /^\s*(?:\([^)]*\)\s*)?Mode:\s*([A-Za-z0-9+_-]+)/im.exec(source)?.[1] ?? ''
  const alwaysOn = /Always On:\s*(true|false)/i.exec(source)?.[1]?.toLowerCase() ?? ''
  return { mode, alwaysOn }
}

/** Read the WARP CLI state without throwing. */
export async function readWarpState() {
  const cli = findWarpCli()
  const [statusResult, settingsResult] = await Promise.all([
    run(cli.command, ['status'], { timeoutMs: 6000 }),
    run(cli.command, ['settings'], { timeoutMs: 6000 }),
  ])

  const spawnFailed =
    statusResult.spawnError === true &&
    (statusResult.error.includes('ENOENT') || statusResult.error.includes('not found'))
  const installed = cli.explicit || !spawnFailed

  const status = parseWarpStatus(`${statusResult.stdout}\n${statusResult.stderr}`)
  const settings = parseWarpSettings(`${settingsResult.stdout}\n${settingsResult.stderr}`)
  const error = statusResult.ok
    ? ''
    : String(statusResult.error || statusResult.stderr || `warp-cli exited with ${statusResult.code}`).trim()

  return {
    installed,
    connected: status.connected,
    mode: settings.mode,
    alwaysOn: settings.alwaysOn,
    protocol: status.protocol,
    colo: status.colo,
    detail: status.detail,
    error: installed ? error : 'Cloudflare WARP is not installed or warp-cli is not runnable',
  }
}

/**
 * Detect tunnel-like network interfaces.
 *
 * @param {ReturnType<typeof os.networkInterfaces>} [interfaces]
 */
export function detectTunnels(interfaces = os.networkInterfaces()) {
  const hideMe = []
  const other = []
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    const live = Array.isArray(addresses) && addresses.some((address) => address && address.internal !== true)
    if (!live) continue
    if (/cloudflare/i.test(name)) continue
    if (/hide\.?me/i.test(name)) {
      hideMe.push(name)
      continue
    }
    if (/wireguard|wintun|openvpn|tap|tun\d|vpn/i.test(name)) other.push(name)
  }
  return { hideMe, other }
}

/** Read the public egress IP/country through the active route. */
export async function readEgress(timeoutMs = 8000) {
  try {
    const signals = [AbortSignal.timeout(timeoutMs)]
    const response = await fetch(TRACE_URL, {
      signal: signals[0],
      headers: { 'user-agent': 'deepseek-harness-vpn/0.1 (+local)', accept: 'text/plain' },
    })
    if (!response.ok) {
      return { ok: false, ip: '', country: '', colo: '', warp: '', error: `HTTP ${response.status}` }
    }
    const text = await response.text()
    const fields = new Map()
    for (const line of text.split(/\r?\n/)) {
      const index = line.indexOf('=')
      if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
    }
    return {
      ok: true,
      ip: fields.get('ip') ?? '',
      country: fields.get('loc') ?? '',
      colo: fields.get('colo') ?? '',
      warp: fields.get('warp') ?? '',
      error: '',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, ip: '', country: '', colo: '', warp: '', error: message }
  }
}

/** Resolve a hostname and report whether its answers are public unicast. */
export async function dnsHealth(host = DEFAULT_DNS_HOST) {
  try {
    const answers = await lookup(host, { all: true, verbatim: true })
    const addresses = answers.map((answer) => answer.address)
    const publicCount = addresses.filter((address) => isPublicAddress(address)).length
    return {
      host,
      addresses,
      poisoned: addresses.length === 0 || publicCount !== addresses.length,
      error: '',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { host, addresses: [], poisoned: true, error: message }
  }
}

/**
 * Tell `warp-cli` to connect and wait for the service to report Connected.
 *
 * @param {{ timeoutMs?: number }} [options]
 */
export async function connectWarp(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(5000, Math.trunc(options.timeoutMs)) : 20000
  const cli = findWarpCli()
  const start = await run(cli.command, ['connect'], { timeoutMs: 10000 })
  if (!start.ok) {
    const message = String(start.error || start.stderr || start.stdout || `exit ${start.code}`).trim()
    return { ok: false, message: message || 'warp-cli connect failed' }
  }

  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const status = await run(cli.command, ['status'], { timeoutMs: 4000 })
    last = `${status.stdout}\n${status.stderr}`.trim()
    if (/Status update:\s*Connected\b/i.test(last)) return { ok: true, message: last }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return { ok: false, message: `WARP did not report Connected within ${timeoutMs}ms. Last status: ${last}` }
}
