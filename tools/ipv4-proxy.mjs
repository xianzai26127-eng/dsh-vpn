/**
 * Minimal local HTTP proxy that forces IPv4 for outbound connections.
 *
 * YouTube's media CDN returns 403 to the Cloudflare WARP IPv6 egress, while the
 * same request over IPv4 succeeds. Chrome prefers IPv6, so the player fails
 * before it can fall back. Pointing Chrome at this proxy makes it resolve only
 * A records and connect over IPv4.
 */
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'

const PORT = Number(process.env.IPV4_PROXY_PORT ?? 8899)
const HOST = '127.0.0.1'

const server = http.createServer((request, response) => {
  if (request.url === '/proxy.pac') {
    const pac = `function FindProxyForURL(url, host) {
  if (host === "youtube.com" || shExpMatch(host, "*.youtube.com") ||
      shExpMatch(host, "*.googlevideo.com") ||
      shExpMatch(host, "*.ytimg.com") ||
      shExpMatch(host, "*.ggpht.com") ||
      shExpMatch(host, "*.youtube-nocookie.com") ||
      shExpMatch(host, "*.googleusercontent.com")) {
    return "PROXY 127.0.0.1:${PORT}";
  }
  return "DIRECT";
}
`
    response.writeHead(200, {
      'content-type': 'application/x-ns-proxy-autoconfig',
      'cache-control': 'no-store',
    })
    response.end(pac)
    return
  }

  // Plain HTTP proxying: request.url is an absolute http:// URL.
  let target
  try {
    target = new URL(request.url)
  } catch {
    response.writeHead(400)
    response.end('Bad request')
    return
  }
  if (target.protocol !== 'http:') {
    response.writeHead(405)
    response.end('Only http and CONNECT are supported')
    return
  }
  const port = Number(target.port || 80)
  dns.lookup(target.hostname, { family: 4 }, (error, address) => {
    if (error) {
      response.writeHead(502)
      response.end(`DNS failed: ${error.code ?? error.message}`)
      return
    }
    const upstream = http.request(
      {
        host: address,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end('Upstream failed')
    })
    request.pipe(upstream)
  })
})

server.on('connect', (request, clientSocket, head) => {
  const separator = request.url.lastIndexOf(':')
  const host = request.url.slice(0, separator).replace(/^\[|\]$/g, '')
  const port = Number(request.url.slice(separator + 1)) || 443

  dns.lookup(host, { family: 4 }, (error, address) => {
    if (error) {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nDNS failed: ${error.code ?? error.message}`)
      return
    }
    const upstream = net.connect(port, address, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
})

server.listen(PORT, HOST, () => {
  console.log(`ipv4 proxy listening on http://${HOST}:${PORT}`)
})
