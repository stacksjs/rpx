import type { ProxyOption } from '../src/types'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  it('serves the Stacks deployment shape and Very Good AdBlock from one listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rpx-stacks-layout-'))
    const publicDir = join(root, 'public')
    const docsDir = join(root, 'docs')
    const blogDir = join(root, 'blog')
    const adblockDir = join(root, 'very-good-adblock')

    await mkdir(join(publicDir, 'assets'), { recursive: true })
    await mkdir(join(docsDir, 'guide'), { recursive: true })
    await mkdir(blogDir, { recursive: true })
    await mkdir(adblockDir, { recursive: true })

    await writeFile(join(publicDir, 'index.html'), '<h1>Stacks</h1>')
    await writeFile(join(publicDir, 'assets', 'app.css'), 'body { color: #123; }')
    await writeFile(join(docsDir, 'index.html'), '<h1>Docs</h1>')
    await writeFile(join(docsDir, 'guide', 'index.html'), '<h1>Guide</h1>')
    await writeFile(join(blogDir, 'index.html'), '<h1>Blog</h1>')
    await writeFile(join(adblockDir, 'index.html'), '<h1>Very Good AdBlock</h1>')

    const proxies: ProxyOption[] = [
      { static: publicDir, to: 'stacksjs.com', path: '/', cleanUrls: true },
      { static: docsDir, to: 'stacksjs.com', path: '/docs', cleanUrls: true },
      { static: blogDir, to: 'stacksjs.com', path: '/blog', cleanUrls: true },
      { from: `127.0.0.1:${up3.port}`, to: 'stacksjs.com', path: '/api', cleanUrls: false },
      { static: adblockDir, to: 'verygoodadblock.org', path: '/', cleanUrls: true },
    ]

    const routeEntries = await collectRouteEntries(proxies, false, false)
    const server = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    expect(server).not.toBeNull()

    try {
      const base = `http://127.0.0.1:${server!.port}`

      const stacksHome = await fetch(`${base}/`, { headers: { host: 'stacksjs.com' } })
      expect(await stacksHome.text()).toContain('Stacks')

      const docsGuide = await fetch(`${base}/docs/guide`, { headers: { host: 'stacksjs.com' } })
      expect(await docsGuide.text()).toContain('Guide')

      const blogHome = await fetch(`${base}/blog`, { headers: { host: 'stacksjs.com' } })
      expect(await blogHome.text()).toContain('Blog')

      const api = await fetch(`${base}/api/ping`, { headers: { host: 'stacksjs.com' } })
      expect(await api.text()).toBe('api:/api/ping')

      const adblockHome = await fetch(`${base}/`, { headers: { host: 'verygoodadblock.org' } })
      expect(await adblockHome.text()).toContain('Very Good AdBlock')
    }
    finally {
      server!.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
