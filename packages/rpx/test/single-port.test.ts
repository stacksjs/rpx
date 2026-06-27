import type { ProxyOption } from '../src/types'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { collectRouteEntries, createSharedProxyServer } from '../src/start'

type Server = ReturnType<typeof Bun.serve>

/**
 * Single-port mode (issue #54): instead of one listener per proxy, all proxies
 * share a single port and are routed to the right upstream by the request
 * `Host` header (and path). These tests exercise the shared-listener building
 * blocks (`collectRouteEntries` + `createSharedProxyServer`) directly so they
 * bind only ephemeral, non-privileged ports and tear down deterministically.
 */
describe('single-port mode', () => {
  let up1: Server
  let up2: Server
  let up3: Server

  beforeAll(() => {
    up1 = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('upstream-one') })
    up2 = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('upstream-two') })
    // Echoes the path so path-based routing within a host is verifiable.
    up3 = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new Response(`api:${new URL(req.url).pathname}`) })
  })

  afterAll(() => {
    up1.stop(true)
    up2.stop(true)
    up3.stop(true)
  })

  it('routes multiple domains through one shared HTTP listener by Host header', async () => {
    const proxies: ProxyOption[] = [
      { from: `127.0.0.1:${up1.port}`, to: 'app1.localhost', cleanUrls: false },
      { from: `127.0.0.1:${up2.port}`, to: 'app2.localhost', cleanUrls: false },
    ]
    // hostsEnabled=false so the test never touches /etc/hosts.
    const routeEntries = await collectRouteEntries(proxies, false, false)
    const server = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    expect(server).not.toBeNull()

    try {
      const base = `http://127.0.0.1:${server!.port}/`
      const r1 = await fetch(base, { headers: { host: 'app1.localhost' } })
      expect(await r1.text()).toBe('upstream-one')

      const r2 = await fetch(base, { headers: { host: 'app2.localhost' } })
      expect(await r2.text()).toBe('upstream-two')

      // A host with no route returns 404 from the same listener.
      const r3 = await fetch(base, { headers: { host: 'unknown.localhost' } })
      expect(r3.status).toBe(404)
    }
    finally {
      server!.stop(true)
    }
  })

  it('routes by path within a single shared host', async () => {
    // Two routes share one domain: `/api/*` → the api upstream, `/` → app one.
    const proxies: ProxyOption[] = [
      { from: `127.0.0.1:${up1.port}`, to: 'site.localhost', path: '/', cleanUrls: false },
      { from: `127.0.0.1:${up3.port}`, to: 'site.localhost', path: '/api', cleanUrls: false },
    ]
    const routeEntries = await collectRouteEntries(proxies, false, false)
    const server = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    expect(server).not.toBeNull()

    try {
      const root = await fetch(`http://127.0.0.1:${server!.port}/`, { headers: { host: 'site.localhost' } })
      expect(await root.text()).toBe('upstream-one')

      // Proxy routes preserve their mount prefix by default, so the api upstream
      // still sees `/api/users`.
      const api = await fetch(`http://127.0.0.1:${server!.port}/api/users`, { headers: { host: 'site.localhost' } })
      expect(await api.text()).toBe('api:/api/users')
    }
    finally {
      server!.stop(true)
    }
  })

  it('reports the configured listen port (one server, not one-per-proxy)', async () => {
    const proxies: ProxyOption[] = [
      { from: `127.0.0.1:${up1.port}`, to: 'a.localhost', cleanUrls: false },
      { from: `127.0.0.1:${up2.port}`, to: 'b.localhost', cleanUrls: false },
    ]
    const routeEntries = await collectRouteEntries(proxies, false, false)
    // Two proxies, one listener.
    const server = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    try {
      expect(typeof server!.port).toBe('number')
      expect(server!.port).toBeGreaterThan(0)
    }
    finally {
      server!.stop(true)
    }
  })
})
