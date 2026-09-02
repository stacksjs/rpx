import type { ProxyOption } from '../src/types'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Start from '../src/start'
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

  it('accepts production SNI cert entries for a shared HTTPS listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rpx-sni-listener-'))
    const keyPath = join(root, 'prod.localhost.key')
    const crtPath = join(root, 'prod.localhost.crt')
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', crtPath, '-days', '1', '-nodes', '-subj', '/CN=prod.localhost'])
    const [key, cert] = await Promise.all([
      Bun.file(keyPath).text(),
      Bun.file(crtPath).text(),
    ])

    const proxies: ProxyOption[] = [
      { from: `127.0.0.1:${up1.port}`, to: 'prod.localhost', cleanUrls: false },
    ]
    const routeEntries = await collectRouteEntries(proxies, false, false)
    const server = createSharedProxyServer({
      routeEntries,
      listenPort: 0,
      sslConfig: [{ serverName: 'prod.localhost', cert, key }],
      originGuard: null,
      verbose: false,
    })
    expect(server).not.toBeNull()

    try {
      const res = await fetch(`https://127.0.0.1:${server!.port}/`, {
        headers: { host: 'prod.localhost' },
        tls: { rejectUnauthorized: false },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('upstream-one')
    }
    finally {
      server!.stop(true)
      await rm(root, { recursive: true, force: true })
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

/**
 * `https: false` as a first-class shared-mode option: a gateway started
 * without TLS must come up on `httpPort` ONLY. Before, `useSharedHttp` also
 * required `singlePortMode`, so `https: false` with several proxies bound :80
 * for the first proxy and :1080, :1081, ... for the rest, and a `productionCerts`
 * directory with PEMs on disk silently turned the listener back into HTTPS.
 */
describe('https: false in shared mode', () => {
  let up: Server
  let tmp: string | undefined

  beforeAll(() => {
    // rpx rewrites Host to the upstream and carries the original in
    // X-Forwarded-Host, so echo that to prove Host-header routing.
    up = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new Response(`plain:${req.headers.get('x-forwarded-host')}`) })
  })

  afterAll(() => {
    up.stop(true)
  })

  afterEach(async () => {
    if (tmp)
      await rm(tmp, { recursive: true, force: true })
    tmp = undefined
  })

  function twoProxies(): ProxyOption[] {
    return [
      { from: `127.0.0.1:${up.port}`, to: 'one.example.com', cleanUrls: false },
      { from: `127.0.0.1:${up.port}`, to: 'two.example.com', cleanUrls: false },
    ]
  }

  it('binds one plain-HTTP listener on httpPort and nothing on the HTTPS port', async () => {
    // Pass-through spy: records the call AND performs the real bind, so the
    // listener the gateway actually created can be exercised and stopped.
    const createSharedSpy = spyOn(Start, 'createSharedProxyServer')
    const redirectSpy = spyOn(Start, 'startHttpRedirectServer').mockImplementation(() => {})
    const startServerSpy = spyOn(Start, 'startServer').mockImplementation(async () => {})
    // Another file may have spied the same export without restoring, in which
    // case spyOn hands back that spy with its history; start from zero.
    createSharedSpy.mockClear()
    redirectSpy.mockClear()
    startServerSpy.mockClear()
    try {
      await Start.startProxies({
        proxies: twoProxies(),
        https: false,
        httpPort: 0, // ephemeral: proves the configured httpPort is the one bound
        httpsPort: 47443,
        cleanup: false,
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
      } as any)

      expect(createSharedSpy).toHaveBeenCalledTimes(1)
      const [opts] = createSharedSpy.mock.calls[0] as [{ listenPort: number, sslConfig: unknown }]
      expect(opts.listenPort).toBe(0)
      expect(opts.sslConfig).toBeNull()
      // No HTTP to HTTPS redirect server and no per-proxy listeners.
      expect(redirectSpy).not.toHaveBeenCalled()
      expect(startServerSpy).not.toHaveBeenCalled()

      const server = createSharedSpy.mock.results[0]!.value as Server
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { host: 'two.example.com' } })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('plain:two.example.com')
        // Nothing listens on the HTTPS port.
        await expect(fetch('https://127.0.0.1:47443/', { tls: { rejectUnauthorized: false } })).rejects.toThrow()
      }
      finally {
        server.stop(true)
      }
    }
    finally {
      createSharedSpy.mockRestore()
      redirectSpy.mockRestore()
      startServerSpy.mockRestore()
    }
  })

  it('stays plain HTTP even when productionCerts has real PEMs on disk', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'rpx-https-false-certs-'))
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(tmp, 'one.example.com.key'), '-out', join(tmp, 'one.example.com.crt'), '-days', '1', '-nodes', '-subj', '/CN=one.example.com'])

    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const redirectSpy = spyOn(Start, 'startHttpRedirectServer').mockImplementation(() => {})
    createSharedSpy.mockClear()
    redirectSpy.mockClear()
    try {
      await Start.startProxies({
        proxies: twoProxies(),
        https: false,
        httpPort: 47081,
        httpsPort: 47444,
        productionCerts: { certsDir: tmp },
        onDemandTls: { enabled: true, allowedSuffixes: ['example.com'] },
        cleanup: false,
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
      } as any)

      expect(createSharedSpy).toHaveBeenCalledTimes(1)
      const [opts] = createSharedSpy.mock.calls[0] as [{ listenPort: number, sslConfig: unknown }]
      expect(opts.listenPort).toBe(47081)
      expect(opts.sslConfig).toBeNull()
      expect(redirectSpy).not.toHaveBeenCalled()
    }
    finally {
      createSharedSpy.mockRestore()
      redirectSpy.mockRestore()
    }
  })

  it('keeps a lone proxy on its own listener unless singlePortMode is set', async () => {
    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const startServerSpy = spyOn(Start, 'startServer').mockImplementation(async () => {})
    createSharedSpy.mockClear()
    startServerSpy.mockClear()
    try {
      const lone = [{ from: `127.0.0.1:${up.port}`, to: 'lone.example.com', cleanUrls: false }]
      await Start.startProxies({ proxies: lone, https: false, httpPort: 47082, cleanup: false, vitePluginUsage: false, verbose: false, cleanUrls: false } as any)
      expect(createSharedSpy).not.toHaveBeenCalled()
      expect(startServerSpy).toHaveBeenCalledTimes(1)
      // The configured port reaches the per-proxy path too.
      expect((startServerSpy.mock.calls[0][0] as { httpPort?: number }).httpPort).toBe(47082)

      await Start.startProxies({ proxies: lone, https: false, singlePortMode: true, httpPort: 47083, cleanup: false, vitePluginUsage: false, verbose: false, cleanUrls: false } as any)
      expect(createSharedSpy).toHaveBeenCalledTimes(1)
      expect((createSharedSpy.mock.calls[0][0] as { listenPort: number }).listenPort).toBe(47083)
    }
    finally {
      createSharedSpy.mockRestore()
      startServerSpy.mockRestore()
    }
  })
})
