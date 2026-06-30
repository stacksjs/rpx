import type { ProxyRoute } from '../src/proxy-handler'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProxyFetchHandler } from '../src/proxy-handler'
import { resolveStaticRoute } from '../src/static-files'

function get(url: string): Request {
  return new Request(url, { headers: { host: new URL(url).host } })
}

describe('createProxyFetchHandler — onNoRoute fallback', () => {
  it('serves a Response returned by onNoRoute (the splash)', async () => {
    const handler = createProxyFetchHandler(
      () => undefined,
      false,
      async host => new Response(`booting ${host}`, { status: 503 }),
    )
    const res = await handler(get('http://myapp.localhost/'))
    expect(res?.status).toBe(503)
    expect(await res?.text()).toBe('booting myapp.localhost')
  })

  it('falls through to 404 when onNoRoute returns undefined', async () => {
    const handler = createProxyFetchHandler(() => undefined, false, async () => undefined)
    const res = await handler(get('http://ghost.localhost/'))
    expect(res?.status).toBe(404)
  })

  it('re-resolves and proxies when onNoRoute signals retry', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-retry-'))
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>live</h1>')
    try {
      // First lookup misses; after onNoRoute "publishes" a route, the second
      // lookup finds a static route and serves it.
      let published = false
      const route: ProxyRoute = { static: resolveStaticRoute(dir, false), cleanUrls: false, basePath: '/' }
      const handler = createProxyFetchHandler(
        () => (published ? route : undefined),
        false,
        async () => {
          published = true
          return { retry: true }
        },
      )
      const res = await handler(get('http://myapp.localhost/'))
      expect(res?.status).toBe(200)
      expect(await res?.text()).toContain('live')
    }
    finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('still 404s when retry is signalled but the route is still missing', async () => {
    const handler = createProxyFetchHandler(
      () => undefined,
      false,
      async () => ({ retry: true }),
    )
    const res = await handler(get('http://myapp.localhost/'))
    expect(res?.status).toBe(404)
  })
})
