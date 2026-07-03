import type { MultiProxyConfig } from '../src/types'
import { describe, expect, it, spyOn } from 'bun:test'
import * as Start from '../src/start'

/**
 * Regression coverage for a real bug found during Hetzner-fleet e2e
 * verification: `startProxies`'s non-shared-listener fallback (a single
 * `proxies: [...]` entry, or plain HTTP with no `singlePortMode` — see the
 * `else` branch after the `useSharedHttps`/`useSharedHttp` checks) rebuilt a
 * fresh options object per-proxy to hand to `startServer`, listing only a
 * handful of fields (`from`, `to`, `cleanUrls`, `https`, `cleanup`,
 * `vitePluginUsage`, `verbose`, `changeOrigin`) — silently dropping
 * `loadBalancer` (and `auth`/`path`/`pathRewrites`). A route with a
 * multi-upstream `from` + `loadBalancer.healthCheck.enabled: true` would
 * still load-balance (round-robin over the pool works independent of this),
 * but active health checks never started and passive-only recovery never
 * ran — a failed-then-recovered upstream stayed excluded from rotation
 * forever. Confirmed live against a real 2-app-box Hetzner fleet before the
 * fix (only `loadBalancer` shown here; `auth`/`path`/`pathRewrites` are
 * dropped by the exact same code path and are exercised by the existing
 * single-proxy-in-multi-array tests once this passthrough is corrected).
 */
describe('startProxies non-shared-listener fallback passes loadBalancer through', () => {
  it('a single-entry `proxies` array (no shared listener) forwards loadBalancer to startServer', async () => {
    // Matches this file's established convention (see start.test.ts): re-spy
    // immediately before the call and inspect the most recent call, since
    // `startServer` is a shared module export other test files also spy on
    // without restoring — asserting a specific call count would be fragile
    // to full-suite run order.
    const startServerSpy = spyOn(Start, 'startServer').mockImplementation(async () => {})

    const config: MultiProxyConfig = {
      proxies: [
        {
          from: ['localhost:3001', 'localhost:3002'],
          to: 'app.example.com',
          cleanUrls: false,
          loadBalancer: {
            strategy: 'round-robin',
            healthCheck: { enabled: true, interval: 1000, healthyThreshold: 2, unhealthyThreshold: 2 },
          },
        },
      ],
      https: false,
      cleanup: false,
      vitePluginUsage: false,
      verbose: false,
      cleanUrls: false,
    }

    await Start.startProxies(config)

    expect(startServerSpy).toHaveBeenCalled()
    const lastCall = startServerSpy.mock.calls[startServerSpy.mock.calls.length - 1]
    const passedOptions = lastCall[0] as { loadBalancer?: { strategy?: string, healthCheck?: { enabled?: boolean } } }
    expect(passedOptions.loadBalancer).toBeDefined()
    expect(passedOptions.loadBalancer?.strategy).toBe('round-robin')
    expect(passedOptions.loadBalancer?.healthCheck?.enabled).toBe(true)
  })
})
