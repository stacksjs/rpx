/**
 * A single benchmark worker process. Multiple copies are spawned on the same
 * port with `reusePort: true` so the kernel load-balances accepted connections
 * across CPU cores — the same multi-core model nginx (`worker_processes`) and
 * caddy (`GOMAXPROCS`) use. This is what lets the rpx/bun-raw/origin targets
 * scale past a single core.
 *
 * Usage: bun worker.ts <mode> <port> [originHost]
 *   mode = origin | rpx | bun
 */
import type { ProxyServer } from '../src/proxy-handler'
import { buildHostRoutes, createProxyFetchHandler, matchHostRoute } from '../src'

const HOST = '127.0.0.1'
const mode = process.argv[2]
const port = Number(process.argv[3])
const originHost = process.argv[4] // for proxy modes: `127.0.0.1:<port>`

const SMALL_BODY = JSON.stringify({ ok: true, proxy: 'bench' })
const LARGE_BODY = 'x'.repeat(100 * 1024)

/**
 * A representative ~16 KB HTML page (doctype, head with meta/preload links, a
 * nav, an article of paragraphs, a footer). Serving HTML is the core real-world
 * reverse-proxy workload, so `--html` is the headline benchmark mode.
 */
function buildHtml(): string {
  const para = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>'
  const articles: string[] = []
  for (let i = 0; i < 40; i++)
    articles.push(`<section id="s${i}"><h2>Section ${i}</h2>${para}${para}</section>`)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rpx benchmark page</title>
<link rel="preload" href="/assets/app.css" as="style">
<link rel="stylesheet" href="/assets/app.css">
<link rel="modulepreload" href="/assets/app.js">
<meta name="description" content="A representative HTML page used to benchmark rpx as a reverse proxy.">
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav></header>
<main><h1>Benchmarking rpx</h1>${articles.join('\n')}</main>
<footer><p>&copy; rpx</p></footer>
</body>
</html>`
}
const HTML_BODY = buildHtml()

if (mode === 'origin') {
  Bun.serve({
    port,
    hostname: HOST,
    reusePort: true,
    fetch(req: Request): Response {
      const url = new URL(req.url)
      if (url.pathname === '/large') {
        return new Response(LARGE_BODY, {
          headers: { 'content-type': 'text/plain', 'content-length': String(LARGE_BODY.length) },
        })
      }
      if (url.pathname === '/html') {
        return new Response(HTML_BODY, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(HTML_BODY.length) },
        })
      }
      return new Response(SMALL_BODY, {
        headers: { 'content-type': 'application/json', 'content-length': String(SMALL_BODY.length) },
      })
    },
  })
}
else if (mode === 'rpx') {
  // rpx's real production handler + routing table, one instance per core.
  const table = buildHostRoutes([{ host: HOST, route: { sourceHost: originHost } }])
  const handler = createProxyFetchHandler((host, pathname) => matchHostRoute(table, host, pathname))
  Bun.serve({
    port,
    hostname: HOST,
    reusePort: true,
    // Bun's `Server` data generic isn't assignable to `ProxyServer`'s `unknown`
    // upgrade data, so route it through `unknown` (not `any`); the handler only
    // touches `.upgrade`. Coerce the handler's `Response | undefined` to a
    // Response since a fetch handler without a websocket must always respond.
    fetch: async (req, srv) => (await handler(req, srv as unknown as ProxyServer)) ?? new Response('not found', { status: 502 }),
  })
}
else if (mode === 'bun') {
  const base = `http://${originHost}`
  Bun.serve({
    port,
    hostname: HOST,
    reusePort: true,
    fetch(req: Request) {
      const url = new URL(req.url)
      return fetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
      })
    },
  })
}
else {
  console.error(`unknown worker mode: ${mode}`)
  process.exit(1)
}
