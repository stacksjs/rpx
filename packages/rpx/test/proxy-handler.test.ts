import type { ProxyRoute, ProxyServer } from '../src/proxy-handler'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProxyFetchHandler, stripBasePath } from '../src/proxy-handler'
import { resolveStaticRoute } from '../src/static-files'

function req(url: string, headers: Record<string, string> = {}): Request {
  const u = new URL(url)
  return new Request(url, { headers: { host: u.host, ...headers } })
}

describe('createProxyFetchHandler routing', () => {
  it('404s when no route matches', async () => {
    const handler = createProxyFetchHandler(() => undefined)
    const res = await handler(req('https://nope.test/'))
    expect(res?.status).toBe(404)
  })

  it('serves a static route from disk', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-ph-test-'))
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>')

    const route: ProxyRoute = { static: resolveStaticRoute(dir, false), cleanUrls: false }
    const handler = createProxyFetchHandler(() => route)

    const res = await handler(req('https://site.test/'))
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res?.text()).toBe('<h1>hi</h1>')

    const missing = await handler(req('https://site.test/nope'))
    expect(missing?.status).toBe(404)

    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('upgrades websocket requests when a server is supplied', async () => {
    const route: ProxyRoute = { sourceHost: 'localhost:3002' }
    const handler = createProxyFetchHandler(() => route)

    let upgradedData: any
    const server: ProxyServer = {
      upgrade(_req, opts) {
        upgradedData = opts?.data
        return true
      },
    }

    const res = await handler(
      req('https://api.test/socket', { upgrade: 'websocket', connection: 'Upgrade' }),
      server,
    )
    // undefined return tells Bun the handshake was taken over.
    expect(res).toBeUndefined()
    expect(upgradedData.targetUrl).toBe('ws://localhost:3002/socket')
    expect(upgradedData.forwardHeaders.host).toBe('localhost:3002')
    expect(upgradedData.forwardHeaders['x-forwarded-host']).toBe('api.test')
  })

  it('400s a websocket upgrade with no server (no fetch transport for it)', async () => {
    const route: ProxyRoute = { sourceHost: 'localhost:3002' }
    const handler = createProxyFetchHandler(() => route)
    const res = await handler(req('https://api.test/socket', { upgrade: 'websocket' }))
    expect(res?.status).toBe(400)
  })

  it('rewrites the origin to the upstream when changeOrigin is set', async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(r) {
        return new Response(JSON.stringify({ origin: r.headers.get('origin'), host: r.headers.get('host') }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const sourceHost = `127.0.0.1:${upstream.port}`
    try {
      const onRoute: ProxyRoute = { sourceHost, changeOrigin: true }
      const onHandler = createProxyFetchHandler(() => onRoute)
      const onRes = await onHandler(req('https://api.test/', { origin: 'https://client.example' }))
      const onGot = await onRes?.json() as { origin: string, host: string }
      // changeOrigin rewrites the origin header to the upstream target.
      expect(onGot.origin).toBe(`http://${sourceHost}`)
      expect(onGot.host).toBe(sourceHost)

      // Without changeOrigin, the client's origin passes through untouched.
      const offRoute: ProxyRoute = { sourceHost }
      const offHandler = createProxyFetchHandler(() => offRoute)
      const offRes = await offHandler(req('https://api.test/', { origin: 'https://client.example' }))
      const offGot = await offRes?.json() as { origin: string }
      expect(offGot.origin).toBe('https://client.example')
    }
    finally {
      upstream.stop(true)
    }
  })
})

describe('stripBasePath', () => {
  it('no-ops for the root or unset base', () => {
    expect(stripBasePath('/a/b', '/')).toBe('/a/b')
    expect(stripBasePath('/a/b', undefined)).toBe('/a/b')
  })

  it('strips an exact match to "/"', () => {
    expect(stripBasePath('/docs', '/docs')).toBe('/')
    expect(stripBasePath('/docs/', '/docs')).toBe('/')
  })

  it('strips the prefix at a segment boundary', () => {
    expect(stripBasePath('/docs/guide', '/docs')).toBe('/guide')
    expect(stripBasePath('/api/users/1', '/api')).toBe('/users/1')
  })

  it('leaves non-matching paths untouched', () => {
    expect(stripBasePath('/apidocs', '/api')).toBe('/apidocs')
  })
})

describe('createProxyFetchHandler path-based routing within a host', () => {
  it('mixes a static dir and a proxy under one host by path', async () => {
    const docsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-ph-docs-'))
    await fsp.writeFile(path.join(docsDir, 'index.html'), '<h1>docs</h1>')

    // Routing table built with the path-aware lookup: /docs* → static dir,
    // everything else (/) → an upstream proxy.
    const docsRoute: ProxyRoute = { static: resolveStaticRoute(docsDir, false), cleanUrls: false, basePath: '/docs' }
    const appRoute: ProxyRoute = { sourceHost: 'localhost:65999' }
    const getRoute = (host: string, pathname: string): ProxyRoute | undefined => {
      if (host !== 'stacksjs.com')
        return undefined
      if (pathname === '/docs' || pathname.startsWith('/docs/'))
        return docsRoute
      return appRoute
    }
    const handler = createProxyFetchHandler(getRoute)

    // /docs is served from disk by the static route.
    const docs = await handler(req('https://stacksjs.com/docs/'))
    expect(docs?.status).toBe(200)
    expect(await docs?.text()).toBe('<h1>docs</h1>')

    // A non-/docs path resolves to the proxy route (502 because the upstream is
    // not listening — proves it picked the proxy route, not the static one).
    const app = await handler(req('https://stacksjs.com/anything'))
    expect(app?.status).toBe(502)

    await fsp.rm(docsDir, { recursive: true, force: true }).catch(() => {})
  })
})
