import assert from 'node:assert/strict'
import { apply, __test } from '../plugin/index.js'
import { assertPublicUrl, isPublicAddress, isSupportedContentType } from '../plugin/lib/net.js'
import { decodeEntities, extractTitle, htmlToText, truncateText } from '../plugin/lib/text.js'
import { detectTunnels, parseWarpSettings, parseWarpStatus } from '../plugin/lib/lines.js'

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

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

function checkSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path} must be a schema object`)
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) throw new Error(`${path}.${key} is not a supported keyword`)
  }
  if (node.properties !== undefined) {
    if (typeof node.properties !== 'object') throw new Error(`${path}.properties must be an object`)
    for (const [key, value] of Object.entries(node.properties)) checkSchema(value, `${path}.properties.${key}`)
  }
  if (node.items !== undefined) checkSchema(node.items, `${path}.items`)
  if (node.oneOf !== undefined) node.oneOf.forEach((value, index) => checkSchema(value, `${path}.oneOf[${index}]`))
}

await test('module exports name/inject/apply', () => {
  assert.equal(__test.tools.vpnStatusTool.name, 'vpn_status')
})

await test('apply registers four tools with renderable output', () => {
  const registered = new Map()
  apply({
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
      },
    },
  })
  assert.deepEqual([...registered.keys()].sort(), ['vpn_check', 'vpn_connect', 'vpn_fetch', 'vpn_status'])
  for (const [toolName, definition] of registered) {
    assert.equal(typeof definition.description, 'string', `${toolName} description`)
    assert.equal(typeof definition.execute, 'function', `${toolName} execute`)
    assert.equal(typeof definition.output.render, 'function', `${toolName} render`)
    checkSchema(definition.parameters, `${toolName}.parameters`)
    checkSchema(definition.output.schema, `${toolName}.output`)
  }
})

await test('argument validation rejects bad arguments', async () => {
  await assert.rejects(() => __test.tools.vpnFetchTool.execute({}, {}), /url must be a non-empty string/)
  await assert.rejects(() => __test.tools.vpnCheckTool.execute({ sites: [] }, {}), /non-empty array/)
  await assert.rejects(
    () => __test.tools.vpnCheckTool.execute({ sites: ['ok', ''] }, {}),
    /each site must be a non-empty string/,
  )
})

await test('private and special addresses are rejected', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('1.1.1.1'), true)
  assert.equal(isPublicAddress('2001:4860:4827:400::'), true)
  assert.equal(isPublicAddress('127.0.0.1'), false)
  assert.equal(isPublicAddress('10.1.2.3'), false)
  assert.equal(isPublicAddress('172.16.0.1'), false)
  assert.equal(isPublicAddress('192.168.1.1'), false)
  assert.equal(isPublicAddress('169.254.169.254'), false)
  assert.equal(isPublicAddress('100.64.0.1'), false)
  assert.equal(isPublicAddress('224.0.0.1'), false)
  assert.equal(isPublicAddress('::1'), false)
  assert.equal(isPublicAddress('fc00::1'), false)
  assert.equal(isPublicAddress('fe80::1'), false)
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true)
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false)
})

await test('assertPublicUrl blocks loopback, private and non-http schemes', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), /not a public unicast address/)
  await assert.rejects(() => assertPublicUrl('http://10.0.0.1/'), /not a public unicast address/)
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /not a public unicast address/)
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /Only http and https/)
  await assert.rejects(() => assertPublicUrl('http://user:pass@example.com/'), /embedded credentials/)
})

await test('html conversion keeps text and drops active content', () => {
  const html =
    '<html><head><title>Hello &amp; Bye</title><script>alert("x")</script><style>.a{}</style></head>' +
    '<body><h1>Head</h1><p>Hello&nbsp;world&nbsp;&amp; friends</p><ul><li>one</li><li>two</li></ul>' +
    '<noscript>no</noscript></body></html>'
  const output = htmlToText(html, { includeTitle: true })
  assert.ok(output.includes('Hello world & friends'), output)
  assert.ok(output.includes('- one'), output)
  assert.ok(!output.includes('alert'), output)
  assert.ok(!output.includes('no'), output)
  assert.equal(extractTitle(html), 'Hello & Bye')
  assert.equal(decodeEntities('&lt;x&gt; &#x27;q&#39;'), "<x> 'q'")
})

await test('truncation respects the cap and surrogate pairs', () => {
  assert.deepEqual(truncateText('abcdef', 3), { text: 'abc', truncated: true })
  assert.deepEqual(truncateText('abc', 3), { text: 'abc', truncated: false })
  const emoji = '\u{1F600}'
  const result = truncateText(`${emoji}${emoji}`, 1)
  assert.equal(result.text, '')
  assert.equal(result.truncated, true)
})

await test('WARP output parsing', () => {
  const status = parseWarpStatus('Status update: Connected\nNetwork: healthy\nTunnel Protocol: MASQUE\nColo: LAX')
  assert.equal(status.connected, true)
  assert.equal(status.colo, 'LAX')
  assert.equal(status.protocol, 'MASQUE')
  const settings = parseWarpSettings('Merged configuration:\n(user set)\tMode: Warp\n(derived)\tAlways On: true')
  assert.equal(settings.mode, 'Warp')
  assert.equal(settings.alwaysOn, 'true')
  assert.equal(parseWarpStatus('Status update: Disconnected').connected, false)
})

await test('hide.me interface detection prefers hide.me and reports other tunnels', () => {
  const tunnels = detectTunnels({
    'CloudflareWARP': [{ address: '172.16.0.2', internal: false }],
    'hide.me': [{ address: '10.0.0.2', internal: false }],
    'WireGuard': [{ address: '10.0.0.3', internal: false }],
    'WLAN': [{ address: '192.168.1.10', internal: false }],
    'Loopback': [{ address: '127.0.0.1', internal: true }],
  })
  assert.deepEqual(tunnels.hideMe, ['hide.me'])
  assert.deepEqual(tunnels.other, ['WireGuard'])
})

await test('content type gate', () => {
  assert.equal(isSupportedContentType('text/html; charset=utf-8'), true)
  assert.equal(isSupportedContentType('application/json'), true)
  assert.equal(isSupportedContentType('application/octet-stream'), false)
  assert.equal(isSupportedContentType(''), false)
})

await test('render helpers produce readable text', () => {
  const statusText = __test.tools.vpnStatusTool.output.render({}, {
    warpConnected: true,
    warpMode: 'Warp',
    warpInstalled: true,
    warpAlwaysOn: 'true',
    warpDetail: '',
    warpError: '',
    hideMeUp: false,
    hideMeInterfaces: [],
    otherTunnels: [],
    activeLine: 'cloudflare-warp',
    conflict: false,
    egressOk: true,
    egressIp: '2a09:bac5::1',
    egressCountry: 'US',
    egressColo: 'LAX',
    egressWarp: 'on',
    egressError: '',
    dnsPoisoned: false,
    dnsAddresses: ['142.251.152.4'],
    hint: '',
  })[0].text
  assert.ok(statusText.includes('Active line: cloudflare-warp'), statusText)
  const fetchText = __test.tools.vpnFetchTool.output.render(
    { url: 'https://example.com' },
    { finalUrl: 'https://example.com/', statusCode: 200, contentType: 'text/html', truncated: false, text: 'body' },
  )[0].text
  assert.ok(fetchText.startsWith('Fetched https://example.com/ (HTTP 200)'), fetchText)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
