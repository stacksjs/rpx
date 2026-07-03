import type { ProxyRoute } from '../src/proxy-handler'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createUpstreamPool, markSuccess, selectUpstream } from '../src/load-balancer'
import { createProxyFetchHandler } from '../src/proxy-handler'
import { createSharedProxyServer } from '../src/start'

type Server = ReturnType<typeof Bun.serve>

function req(url: string, headers: Record<string, string> = {}): Request {
  const u = new URL(url)
  return new Request(url, { headers: { host: u.host, ...headers } })
}

/**
 * Integration coverage for the multi-upstream load balancer, driven through
 * the same `createProxyFetchHandler`/`createSharedProxyServer` entry points
 * the single-upstream tests use — proves `resolveTarget`'s upstream-pool
 * wiring works for real HTTP requests and WebSocket upgrades, not just the
 * unit-level selection logic in load-balancer.test.ts.
 */
describe('load-balanced proxying', () => {
  let backends: Server[]

  beforeAll(() => {
    // Three tiny backends that each report their own port so we can attribute
    // requests to the backend that actually served them.
    backends = [0, 1, 2].map(() =>
      Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(r) {
          return new Response(String(new URL(r.url).port || r.headers.get('host')), {
            headers: { 'x-backend-port': String((this as unknown as { port: number }).port ?? '') },
          })
        },
      }))
  })

  afterAll(() => {
    for (const b of backends)
      b.stop(true)
  })

  it('backward compat: a single-string `from` still works exactly as before (no pool)', async () => {
    const route: ProxyRoute = { sourceHost: `127.0.0.1:${backends[0].port}` }
    const handler = createProxyFetchHandler(() => route)
    const res = await handler(req('https://legacy.test/'))
    expect(res?.status).toBe(200)
    expect(res?.headers.get('x-backend-port')).toBe(String(backends[0].port))
  })

  it('round-robin distributes requests across all backends roughly evenly', async () => {
    const pool = createUpstreamPool(backends.map(b => `127.0.0.1:${b.port}`))
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    const counts: Record<string, number> = {}
    const total = 60
    for (let i = 0; i < total; i++) {
      const res = await handler(req('https://lb.test/'))
      const port = res?.headers.get('x-backend-port') ?? 'unknown'
      counts[port] = (counts[port] ?? 0) + 1
    }

    for (const b of backends)
      expect(counts[String(b.port)]).toBe(total / backends.length)
  })

  it('least-connections sends traffic to the least-busy backend', async () => {
    const pool = createUpstreamPool(backends.map(b => `127.0.0.1:${b.port}`), { strategy: 'least-connections' })
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    // Simulate backend[0] and [1] already being busy.
    pool.upstreams[0].activeConnections = 5
    pool.upstreams[1].activeConnections = 2
    pool.upstreams[2].activeConnections = 0

    const res = await handler(req('https://lb.test/'))
    expect(res?.headers.get('x-backend-port')).toBe(String(backends[2].port))
  })

  it('weighted-round-robin respects configured weights', async () => {
    const pool = createUpstreamPool(
      [
        { url: `127.0.0.1:${backends[0].port}`, weight: 3 },
        { url: `127.0.0.1:${backends[1].port}`, weight: 1 },
      ],
      { strategy: 'weighted-round-robin' },
    )
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    const counts: Record<string, number> = {}
    const cycles = 20
    for (let i = 0; i < cycles * 4; i++) {
      const res = await handler(req('https://lb.test/'))
      const port = res?.headers.get('x-backend-port') ?? 'unknown'
      counts[port] = (counts[port] ?? 0) + 1
    }
    expect(counts[String(backends[0].port)]).toBe(cycles * 3)
    expect(counts[String(backends[1].port)]).toBe(cycles * 1)
  })

  it('a backend that goes down is marked unhealthy after unhealthyThreshold failures and stops receiving traffic', async () => {
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    const deadPort = dead.port
    dead.stop(true) // now nothing listens on deadPort — connections will be refused

    const alivePort = backends[0].port
    const pool = createUpstreamPool(
      [`127.0.0.1:${alivePort}`, `127.0.0.1:${deadPort}`],
      { healthCheck: { unhealthyThreshold: 2, healthyThreshold: 2 } },
    )
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    // Drive enough requests that round-robin hits the dead backend twice
    // (passive failures accumulate from live traffic, no active health check
    // timer needed).
    for (let i = 0; i < 6; i++)
      await handler(req('https://lb.test/'))

    expect(pool.upstreams.find(u => u.url === `127.0.0.1:${deadPort}`)?.healthy).toBe(false)

    // Once unhealthy, every subsequent request goes to the surviving backend.
    for (let i = 0; i < 5; i++) {
      const res = await handler(req('https://lb.test/'))
      expect(res?.headers.get('x-backend-port')).toBe(String(alivePort))
    }
  })

  it('a recovered backend receives traffic again after healthyThreshold consecutive successes', async () => {
    const pool = createUpstreamPool(
      [`127.0.0.1:${backends[0].port}`, `127.0.0.1:${backends[1].port}`],
      { healthCheck: { healthyThreshold: 2 } },
    )
    const [, second] = pool.upstreams
    second.healthy = false // simulate a prior outage that already tripped unhealthy

    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    // While unhealthy, only backend[0] is selected.
    for (let i = 0; i < 3; i++) {
      const res = await handler(req('https://lb.test/'))
      expect(res?.headers.get('x-backend-port')).toBe(String(backends[0].port))
    }

    // Recovery: mark enough passive successes directly (simulating either
    // live traffic succeeding once it's back, or an active health-check probe).
    markSuccess(pool, second)
    markSuccess(pool, second)
    expect(second.healthy).toBe(true)

    const seenPorts = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const res = await handler(req('https://lb.test/'))
      seenPorts.add(res?.headers.get('x-backend-port') ?? '')
    }
    expect(seenPorts.has(String(backends[1].port))).toBe(true)
  })

  it('every upstream unhealthy in an N>1 pool responds 502', async () => {
    const pool = createUpstreamPool(backends.map(b => `127.0.0.1:${b.port}`))
    for (const u of pool.upstreams) u.healthy = false
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)
    const res = await handler(req('https://lb.test/'))
    expect(res?.status).toBe(502)
  })

  it('selectUpstream is consistent with what the handler actually dispatches to', async () => {
    const pool = createUpstreamPool(backends.map(b => `127.0.0.1:${b.port}`))
    const route: ProxyRoute = { upstreamPool: pool }
    const handler = createProxyFetchHandler(() => route)

    // Reset the pool's cursor state doesn't matter — just prove selection and
    // dispatch agree on the very next pick.
    const expected = selectUpstream(pool)
    // selectUpstream advanced the cursor as a side effect (round-robin), so
    // reset it back before driving the real request through the handler.
    pool.cursor = (pool.cursor - 1 + pool.upstreams.length) % pool.upstreams.length
    const res = await handler(req('https://lb.test/'))
    expect(res?.headers.get('x-backend-port')).toBe(expected?.url.split(':')[1])
  })
})

describe('WebSocket load balancing (shared resolveTarget logic)', () => {
  let backends: Server[]

  beforeAll(() => {
    backends = [0, 1].map(() =>
      Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(r, server) {
          if (server.upgrade(r, { data: undefined }))
            return undefined
          return new Response('expected websocket upgrade', { status: 426 })
        },
        websocket: {
          open(ws) {
            ws.send(`hello-from-${(ws.data as unknown as { port?: number })?.port ?? 'backend'}`)
          },
          message(ws, msg) {
            ws.send(`echo:${typeof msg === 'string' ? msg : '(binary)'}`)
          },
        },
      }))
  })

  afterAll(() => {
    for (const b of backends)
      b.stop(true)
  })

  it('load-balances websocket upgrades across the pool via the shared resolveTarget path', async () => {
    const pool = createUpstreamPool(backends.map(b => `127.0.0.1:${b.port}`))
    const routeEntries = [{ host: '127.0.0.1', route: { upstreamPool: pool } }]
    const proxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    expect(proxy).not.toBeNull()

    try {
      const seenBackends = new Set<number>()
      for (let i = 0; i < backends.length; i++) {
        const before = pool.cursor
        const messages: string[] = []
        const ws = new WebSocket(`ws://127.0.0.1:${proxy!.port}/`)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('websocket proxy timed out')), 5000)
          ws.addEventListener('open', () => ws.send('ping'))
          ws.addEventListener('message', (ev: MessageEvent) => {
            messages.push(String(ev.data))
            if (messages.length >= 2) {
              clearTimeout(timer)
              ws.close()
              resolve()
            }
          })
          ws.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('websocket proxy errored'))
          })
        })
        expect(messages).toContain('echo:ping')
        seenBackends.add(before)
      }
      // Round-robin selection advanced the cursor across the two upgrades —
      // proves the pool (not a single static sourceHost) drove the picks.
      expect(seenBackends.size).toBe(backends.length)
    }
    finally {
      proxy!.stop(true)
    }
  })
})
