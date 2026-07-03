/**
 * Regression coverage for a real bug found deploying stacksjs/status#1
 * (Phase 9 e2e verification) to a live Hetzner box: a single-site gateway
 * (one entry in `proxies`, the common one-app-per-box shape ts-cloud
 * generates) completely ignored `productionCerts` — real Let's Encrypt PEMs
 * on disk — and always served a local dev self-signed cert instead. Even
 * manually placing a real cert at the exact `<domain>.crt`/`.key` convention
 * path didn't help, because `useSharedHttps` (the only path that consults
 * `productionTlsConfig`) required more than one proxy or `singlePortMode`;
 * a single entry fell through to `startServer`, which never receives
 * `productionTlsConfig` at all and unconditionally mints/uses a dev cert.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as Start from '../src/start'

describe('startProxies single-proxy production certs', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir)
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    dir = undefined
  })

  it('routes a single-entry `proxies` array through the shared HTTPS listener when real production certs exist', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-single-proxy-prod-certs-'))
    const keyPath = path.join(dir, 'app.example.com.key')
    const crtPath = path.join(dir, 'app.example.com.crt')
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', crtPath, '-days', '1', '-nodes', '-subj', '/CN=app.example.com'])

    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const startServerSpy = spyOn(Start, 'startServer').mockImplementation(async () => {})

    // Explicit, almost-certainly-free high ports: the real 443/80 defaults
    // require root and (more importantly for this test) are shared, mutable
    // state across the full suite — another file's leftover listener on 443
    // would make `isPortInUse` report busy and short-circuit before ever
    // reaching `createSharedProxyServer`, independent of this fix.
    await Start.startProxies({
      proxies: [
        { from: 'localhost:3000', to: 'app.example.com' },
      ],
      https: true,
      httpsPort: 48443,
      httpPort: 48080,
      productionCerts: { certsDir: dir },
      cleanup: false,
      vitePluginUsage: false,
      verbose: false,
      cleanUrls: false,
    } as any)

    expect(createSharedSpy).toHaveBeenCalled()
    const [{ sslConfig }] = createSharedSpy.mock.calls[createSharedSpy.mock.calls.length - 1] as [{ sslConfig: unknown }]
    expect(Array.isArray(sslConfig)).toBe(true)
    expect((sslConfig as Array<{ serverName: string }>).some(e => e.serverName === 'app.example.com')).toBe(true)

    // The individual (dev-cert-only) path must NOT have been used — that's
    // exactly the path that was silently dropping the real production cert.
    expect(startServerSpy).not.toHaveBeenCalled()

    createSharedSpy.mockRestore()
    startServerSpy.mockRestore()
  })
})
