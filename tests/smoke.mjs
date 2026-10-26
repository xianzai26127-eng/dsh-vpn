/**
 * Network smoke test for the VPN plugin.
 *
 * Runs the registered tools against the current machine VPN line. Requires a
 * working tunnel (Cloudflare WARP or hide.me) and public internet access.
 */
import assert from 'node:assert/strict'
import { apply } from '../plugin/index.js'

const tools = new Map()
apply({
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
    },
  },
})

const exec = { signal: new AbortController().signal }
let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error instanceof Error ? error.stack : error)
  }
}

await test('vpn_status reports a usable line', async () => {
  const value = await tools.get('vpn_status').execute({}, exec)
  console.log(
    `  active=${value.activeLine} warp=${value.warpConnected} hide=${value.hideMeUp} egress=${value.egressIp} ${value.egressCountry}/${value.egressColo} dnsPoisoned=${value.dnsPoisoned}`,
  )
  if (value.hint) console.log(`  hint: ${value.hint}`)
  assert.equal(value.hint.includes('Neither hide.me nor Cloudflare WARP'), false)
  assert.ok(value.hideMeUp || value.warpConnected, 'no VPN line is active')
  assert.equal(value.egressOk, true, `egress check failed: ${value.egressError}`)
  assert.equal(value.dnsPoisoned, false, 'DNS for the probe host is poisoned')
})

await test('vpn_check reaches blocked sites', async () => {
  const value = await tools.get('vpn_check').execute({ timeoutMs: 20000 }, exec)
  const summary = value.results.map((item) => `${item.url}:${item.ok ? item.status : item.error}`).join(', ')
  console.log(`  ${summary}`)
  const ok = value.results.filter((item) => item.ok)
  assert.ok(ok.length >= 3, `expected at least 3 reachable sites, got ${ok.length}`)
  assert.ok(value.results.find((item) => item.url.includes('youtube'))?.ok, 'youtube is not reachable')
  assert.ok(value.results.find((item) => item.url.includes('google'))?.ok, 'google is not reachable')
})

await test('vpn_fetch follows cross-origin redirects on youtube', async () => {
  const value = await tools.get('vpn_fetch').execute({ url: 'https://www.youtube.com', maxChars: 5000 }, exec)
  console.log(`  ${value.statusCode} ${value.finalUrl} (${value.text.length} chars, truncated=${value.truncated})`)
  assert.ok(value.statusCode >= 200 && value.statusCode < 400, `HTTP ${value.statusCode}`)
  assert.ok(value.text.length > 0, 'empty body')
  assert.ok(/youtube/i.test(value.text), 'body does not mention youtube')
})

await test('vpn_fetch enforces the character cap', async () => {
  const value = await tools.get('vpn_fetch').execute({ url: 'https://www.youtube.com', maxChars: 1000 }, exec)
  assert.ok(value.text.length <= 1000, `text length ${value.text.length}`)
})

await test('vpn_fetch rejects private and loopback destinations', async () => {
  await assert.rejects(
    () => tools.get('vpn_fetch').execute({ url: 'http://127.0.0.1:1/' }, exec),
    /not a public unicast address/,
  )
  await assert.rejects(
    () => tools.get('vpn_fetch').execute({ url: 'http://169.254.169.254/latest/meta-data/' }, exec),
    /not a public unicast address/,
  )
})

await test('vpn_connect is idempotent when a line is up', async () => {
  const value = await tools.get('vpn_connect').execute({}, exec)
  console.log(`  active=${value.activeLine} connected=${value.connected}`)
  assert.equal(value.connected, true, value.message)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
