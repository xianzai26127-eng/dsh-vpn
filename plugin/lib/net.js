/**
 * HTTP transport and destination policy for `vpn_fetch` / `vpn_check`.
 *
 * Requests leave through the machine's active VPN route (hide.me or Cloudflare
 * WARP); this module only decides what is safe to request. It resolves every
 * host locally, requires every answer to be public unicast, and repeats that
 * check on every redirect hop. That is the same boundary the built-in
 * `web_fetch` enforces, so this tool does not widen the Harness' SSRF surface.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const USER_AGENT = 'deepseek-harness-vpn/0.1 (+local)'
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_REDIRECTS = 5

const V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function parseIPv4(input) {
  const parts = String(input).split('.')
  if (parts.length !== 4) return null
  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value < 0 || value > 255) return null
    octets.push(value)
  }
  return octets
}

function ipv4ToNumber(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function parseIPv6(input) {
  let value = String(input).replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (value === '') return null

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4 = parseIPv4(value.slice(lastColon + 1))
    if (v4 === null) return null
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }

  const doubleColon = value.indexOf('::')
  let head = value
  let tail = ''
  if (doubleColon !== -1) {
    head = value.slice(0, doubleColon)
    tail = value.slice(doubleColon + 2)
    if (tail.includes('::')) return null
  }

  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  if (doubleColon === -1 && missing !== 0) return null
  if (doubleColon !== -1 && missing < 1) return null

  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts].map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN
    return Number.parseInt(part, 16)
  })
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group))) return null
  return groups
}

function isPublicIPv4(octets) {
  const address = ipv4ToNumber(octets)
  for (const [range, bits] of V4_RANGES) {
    const base = ipv4ToNumber(parseIPv4(range))
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((address & mask) === (base & mask)) return false
  }
  return true
}

/**
 * Whether an IP literal is a public unicast address.
 *
 * Private, loopback, link-local, multicast, unspecified, documentation and
 * carrier-grade NAT ranges are rejected.
 */
export function isPublicAddress(input) {
  const address = String(input).replace(/^\[|\]$/g, '').split('%')[0]
  const family = isIP(address)
  if (family === 4) {
    const octets = parseIPv4(address)
    return octets === null ? false : isPublicIPv4(octets)
  }
  if (family === 6) {
    const groups = parseIPv6(address)
    if (groups === null) return false
    if (groups.every((group) => group === 0)) return false
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false
    const mapped =
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
    if (mapped) {
      return isPublicIPv4([(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff])
    }
    if ((groups[0] & 0xfe00) === 0xfc00) return false
    if ((groups[0] & 0xffc0) === 0xfe80) return false
    if ((groups[0] & 0xff00) === 0xff00) return false
    return true
  }
  return false
}

/**
 * Resolve one hostname and require all answers to be public.
 *
 * @param {string} urlString
 * @returns {Promise<{ url: URL, addresses: string[] }>}
 */
export async function assertPublicUrl(urlString) {
  let url
  try {
    url = new URL(urlString)
  } catch {
    throw new Error(`Invalid URL: ${urlString}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are supported, got ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('URLs with embedded credentials are not allowed')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Blocked destination: ${host || '(empty host)'} is not a public host`)
  }

  let addresses
  if (isIP(host)) {
    addresses = [host]
    if (!isPublicAddress(host)) {
      throw new Error(`Blocked destination ${host}: not a public unicast address`)
    }
    return { url, addresses }
  }

  try {
    addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DNS_ERROR'
    throw new Error(
      `DNS lookup failed for ${host} (${code}). The VPN may be disconnected or DNS is being poisoned; run vpn_connect and retry.`,
    )
  }

  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${host}`)
  }

  const blocked = addresses.filter((address) => !isPublicAddress(address))
  if (blocked.length > 0) {
    throw new Error(
      `Blocked destination ${host}: resolves to non-public address(es) ${blocked.join(', ')}. ` +
        'This usually means DNS poisoning or that the VPN is off; run vpn_connect and retry.',
    )
  }

  return { url, addresses }
}

/**
 * Parse a charset from a Content-Type header.
 *
 * @param {string} contentType
 * @returns {string | undefined}
 */
export function charsetOf(contentType) {
  if (typeof contentType !== 'string') return undefined
  const match = /charset\s*=\s*"?([^;"'\s]+)"?/i.exec(contentType)
  return match === null ? undefined : match[1]
}

/**
 * Whether the response body can be represented as text.
 *
 * @param {string} contentType
 * @returns {boolean}
 */
export function isSupportedContentType(contentType) {
  const mediaType = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType === '') return false
  if (mediaType.startsWith('text/')) return true
  return (
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/rss+xml' ||
    mediaType === 'application/atom+xml' ||
    mediaType === 'application/ld+json' ||
    mediaType === 'image/svg+xml'
  )
}

async function readCappedBody(response, maxBytes) {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return { buffer: Buffer.alloc(0), truncated: false }
  }
  const chunks = []
  let total = 0
  let truncated = false
  for (;;) {
    let step
    try {
      step = await reader.read()
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      break
    }
    if (step.done) break
    const chunk = Buffer.from(step.value)
    if (total + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total))
      total = maxBytes
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // Cancellation is best-effort.
      }
      break
    }
    chunks.push(chunk)
    total += chunk.length
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

/**
 * Fetch a public URL through the machine's network route, following redirects
 * manually so cross-origin hops (YouTube/Google consent) work while every hop
 * is re-validated.
 *
 * @param {string} urlString
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, maxRedirects?: number, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ url: string, status: number, contentType: string, buffer: Buffer, truncated: boolean, addresses: string[] }>}
 */
export async function fetchPublic(urlString, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Math.trunc(options.timeoutMs)) : 30000
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Math.trunc(options.maxBytes)) : MAX_RESPONSE_BYTES
  const maxRedirects = Number.isFinite(options.maxRedirects) ? Math.max(0, Math.trunc(options.maxRedirects)) : MAX_REDIRECTS
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (options.signal !== undefined) signals.push(options.signal)
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]

  let current = urlString
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertPublicUrl(current)
    let response
    try {
      response = await fetch(validated.url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
          ...options.headers,
        },
      })
    } catch (error) {
      const name = error?.name
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new Error(`Request timed out or was cancelled after ${timeoutMs}ms: ${validated.url.toString()}`)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Request failed for ${validated.url.toString()}: ${message}`)
    }

    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('location')
      try {
        await response.body?.cancel()
      } catch {
        // Nothing else to release.
      }
      if (location === null || location === '') {
        throw new Error(`Redirect ${response.status} without a Location header from ${validated.url.toString()}`)
      }
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (limit ${maxRedirects}) starting at ${urlString}`)
      }
      current = new URL(location, validated.url).toString()
      continue
    }

    const { buffer, truncated } = await readCappedBody(response, maxBytes)
    return {
      url: validated.url.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      buffer,
      truncated,
      addresses: validated.addresses,
    }
  }
  throw new Error(`Too many redirects (limit ${maxRedirects}) starting at ${urlString}`)
}
