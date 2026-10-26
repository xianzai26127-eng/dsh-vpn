# dsh-vpn

VPN status, diagnostics, and proxy-aware fetch tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin does not create a tunnel. It makes the machine's existing VPN lines usable by the model:

- **Cloudflare WARP** can be inspected and connected through `warp-cli`.
- **hide.me** is detected through its `hide.me` tunnel interface and preferred when it is connected.
- `vpn_fetch` follows cross-origin redirects (YouTube/Google consent pages) and reports actionable DNS/VPN errors, while still allowing public destinations only.

## Tools

| Tool | Purpose |
|---|---|
| `vpn_status` | WARP/hide.me state, active line, egress IP and Cloudflare trace metadata, DNS health |
| `vpn_check` | Probe YouTube, Google, X, Wikipedia for DNS/reachability failures |
| `vpn_fetch` | Fetch a public HTTP(S) URL through the active VPN route; follow redirects; return readable text |
| `vpn_connect` | Start Cloudflare WARP when hide.me is not active; never disconnects a tunnel |

`vpn_fetch` rejects loopback, private, link-local, CGNAT, multicast and metadata addresses on every redirect hop.

## Requirements

- Windows 10/11
- DeepSeek Harness with profile/HMR support (tested with `0.2.1-rc.2`)
- Node 24 (the runtime bundled with DSH works)
- Cloudflare WARP installed and registered for `vpn_connect`
- Optional: hide.me client for the "prefer hide.me" path

## Install

Copy `plugin/` into the profile and add one loader row to `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-vpn
      name: "file:///C:/Users/<you>/.dsh/profiles/desktop/plugins/dsh-vpn/index.js"
```

`scripts/install.ps1` automates backup, copy and patch insertion; `scripts/uninstall.ps1` removes them. Both are PowerShell 5.1 compatible.

## YouTube playback note

On some WARP networks the `googlevideo.com` media CDN returns HTTP 403 to the IPv6 egress while the same request over IPv4 succeeds. The browser player then shows "video unavailable" even though the page loads.

`tools/ipv4-proxy.mjs` is a loopback-only proxy that resolves A records and connects over IPv4. `scripts/watch-youtube.ps1` starts it and opens Chrome with a PAC that sends only YouTube domains through it. This is a separate convenience script, not required by the VPN tools.

## Layout

```
plugin/
  index.js          tool registration, validation and rendering
  lib/exec.js       child-process helper for warp-cli
  lib/lines.js      WARP/hide.me/egress/DNS probes
  lib/net.js        public-destination checks, fetch, redirects
  lib/text.js       HTML-to-text and truncation
scripts/
  install.ps1
  uninstall.ps1
  watch-youtube.ps1
  stop-youtube-proxy.ps1
tools/
  ipv4-proxy.mjs
tests/
  unit.mjs
  smoke.mjs
```

## Security

- Public destinations only: the fetch path rejects private/loopback addresses and re-validates every redirect.
- No system proxy or DNS changes are made by the plugin.
- `vpn_connect` only connects; it never tears down a tunnel.
- MCP/extension credentials and user profiles are never committed to this repository.

## Tests

```powershell
node tests/unit.mjs
node tests/smoke.mjs
```

`unit.mjs` is offline. `smoke.mjs` needs a working VPN line and public internet access.
