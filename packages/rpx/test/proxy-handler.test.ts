import type { ProxyRoute, ProxyServer } from '../src/proxy-handler'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProxyFetchHandler } from '../src/proxy-handler'
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
})
