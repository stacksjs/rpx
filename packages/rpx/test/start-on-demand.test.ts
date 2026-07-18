/**
 * Regression coverage for the production-gateway gap behind the rpx 0.11.30
 * incident: `OnDemandCertManager` was only constructed on the daemon path
 * (daemon.ts), so a gateway launched via `startProxies` directly (ts-cloud's
 * launcher) with `onDemandTls` configured NEVER issued a cert — no ACME
 * attempt, no log line — and externally-placed certs were only adopted after
 * a restart. These tests pin the wiring: `startProxies` builds the manager
 * from `onDemandTls` (same config shape as the daemon), hands it to the `:80`
 * redirect server (challenge store + reactive issuance kick), and serves the
 * manager's live SNI set on the shared :443 listener.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { OnDemandCertManager } from '../src/on-demand'
import * as Start from '../src/start'

/** Explicit high ports — 443/80 defaults need root and are shared suite state. */
const HTTPS_PORT = 49443
const HTTP_PORT = 49080
const REDIRECT_PORT = 49081

describe('startProxies on-demand TLS wiring', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir)
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    dir = undefined
  })

  async function seedProductionCert(host: string): Promise<void> {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-start-ondemand-'))
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, `${host}.key`), '-out', path.join(dir, `${host}.crt`), '-days', '1', '-nodes', '-subj', `/CN=${host}`])
  }

  function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proxies: [
        { from: 'localhost:3000', to: 'app.example.com' },
      ],
      https: true,
      httpsPort: HTTPS_PORT,
      httpPort: HTTP_PORT,
      productionCerts: { certsDir: dir },
      cleanup: false,
      vitePluginUsage: false,
      verbose: false,
      cleanUrls: false,
      ...extra,
    }
  }

  it('constructs the on-demand manager, seeds it from productionCerts, and hands it to the :80 server', async () => {
    await seedProductionCert('app.example.com')
    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const redirectSpy = spyOn(Start, 'startHttpRedirectServer').mockImplementation(() => {})

    await Start.startProxies(baseOptions({
      onDemandTls: { enabled: true, allowedSuffixes: ['example.com'] },
    }) as any)

    expect(redirectSpy).toHaveBeenCalled()
    const onDemand = redirectSpy.mock.calls[0][4] as OnDemandCertManager | null
    expect(onDemand).toBeInstanceOf(OnDemandCertManager)
    expect(onDemand).not.toBeNull()
    // Seeded from the production SNI set — no ACME needed for known hosts.
    expect(onDemand!.hasCert('app.example.com')).toBe(true)

    // The shared listener serves the manager's live SNI set.
    expect(createSharedSpy).toHaveBeenCalled()
    const [{ sslConfig }] = createSharedSpy.mock.calls[createSharedSpy.mock.calls.length - 1] as [{ sslConfig: unknown }]
    expect(Array.isArray(sslConfig)).toBe(true)
    expect((sslConfig as Array<{ serverName: string }>).some(e => e.serverName === 'app.example.com')).toBe(true)

    createSharedSpy.mockRestore()
    redirectSpy.mockRestore()
  })

  it('passes no manager to the :80 server when onDemandTls is not enabled', async () => {
    await seedProductionCert('app.example.com')
    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const redirectSpy = spyOn(Start, 'startHttpRedirectServer').mockImplementation(() => {})

    await Start.startProxies(baseOptions() as any)

    expect(redirectSpy).toHaveBeenCalled()
    expect(redirectSpy.mock.calls[0][4] ?? null).toBeNull()

    createSharedSpy.mockRestore()
    redirectSpy.mockRestore()
  })
})

describe('startHttpRedirectServer with on-demand TLS', () => {
  const kicks: string[] = []
  const store = new Map<string, string>([['/.well-known/acme-challenge/tok123', 'keyauth123']])
  const fakeManager = {
    challengeStore: { handlePath: (p: string) => store.get(p) },
    hasCert: (h: string) => h === 'covered.example.com',
    ensureCert: async (h: string) => {
      kicks.push(h)
      return false
    },
  } as unknown as OnDemandCertManager

  afterEach(async () => {
    await Start.cleanup({ hosts: false, certs: false, verbose: false })
  })

  async function get(pathname: string, host?: string): Promise<Response> {
    // `connection: close` so server.close() in cleanup never waits on an idle
    // keep-alive socket.
    const headers: Record<string, string> = { connection: 'close', ...(host ? { host } : {}) }
    // The node listener is created without a listen callback — retry briefly.
    let lastErr: unknown
    for (let i = 0; i < 20; i++) {
      try {
        return await fetch(`http://127.0.0.1:${REDIRECT_PORT}${pathname}`, { headers, redirect: 'manual' })
      }
      catch (err) {
        lastErr = err
        await new Promise(r => setTimeout(r, 25))
      }
    }
    throw lastErr
  }

  it('serves the in-memory challenge store, 404s challenge misses, and kicks issuance on plaintext hits', async () => {
    Start.startHttpRedirectServer(false, REDIRECT_PORT, 443, undefined, fakeManager)

    // Challenge hit → 200 key authorization from the manager's store.
    const hit = await get('/.well-known/acme-challenge/tok123')
    expect(hit.status).toBe(200)
    expect(await hit.text()).toBe('keyauth123')

    // Challenge miss → 404 (Let's Encrypt must not be redirected for a token
    // we never registered).
    const miss = await get('/.well-known/acme-challenge/unknown')
    expect(miss.status).toBe(404)

    // First plaintext hit for an uncovered host → 301 + issuance kicked.
    kicks.length = 0
    const redirect = await get('/some/page', 'new.example.com')
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('https://new.example.com/some/page')
    expect(kicks).toEqual(['new.example.com'])

    // A host the manager already covers is redirected without a kick.
    const covered = await get('/', 'covered.example.com')
    expect(covered.status).toBe(301)
    expect(kicks).toEqual(['new.example.com'])
  })

  it('keeps legacy behavior with no manager: challenge paths redirect when no webroot is set', async () => {
    Start.startHttpRedirectServer(false, REDIRECT_PORT, 443)
    const res = await get('/.well-known/acme-challenge/tok123', 'app.example.com')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://app.example.com/.well-known/acme-challenge/tok123')
  })
})
