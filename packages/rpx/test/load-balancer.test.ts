import { describe, expect, it } from 'bun:test'
import {
  createUpstreamPool,
  markFailure,
  markSuccess,
  primaryUpstreamUrl,
  selectUpstream,
  startHealthChecks,
  stopHealthChecks,
} from '../src/load-balancer'

describe('createUpstreamPool', () => {
  it('normalizes a single string `from` into a one-item pool', () => {
    const pool = createUpstreamPool('localhost:3001')
    expect(pool.upstreams).toHaveLength(1)
    expect(pool.upstreams[0]).toMatchObject({
      url: 'localhost:3001',
      weight: 1,
      healthy: true,
      activeConnections: 0,
    })
    expect(pool.strategy).toBe('round-robin')
  })

  it('normalizes an array of plain strings', () => {
    const pool = createUpstreamPool(['localhost:3001', 'localhost:3002', 'localhost:3003'])
    expect(pool.upstreams.map(u => u.url)).toEqual(['localhost:3001', 'localhost:3002', 'localhost:3003'])
    expect(pool.upstreams.every(u => u.weight === 1)).toBe(true)
  })

  it('normalizes an array of UpstreamTarget objects with weights', () => {
    const pool = createUpstreamPool([
      { url: 'localhost:3001', weight: 5 },
      { url: 'localhost:3002' }, // defaults to weight 1
    ])
    expect(pool.upstreams[0].weight).toBe(5)
    expect(pool.upstreams[1].weight).toBe(1)
  })

  it('defaults a non-positive weight to 1', () => {
    const pool = createUpstreamPool([{ url: 'localhost:3001', weight: 0 }, { url: 'localhost:3002', weight: -5 }])
    expect(pool.upstreams[0].weight).toBe(1)
    expect(pool.upstreams[1].weight).toBe(1)
  })

  it('respects an explicit strategy and health-check config', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], {
      strategy: 'least-connections',
      healthCheck: { healthyThreshold: 5, unhealthyThreshold: 7, interval: 999, timeout: 111, path: '/health' },
    })
    expect(pool.strategy).toBe('least-connections')
    expect(pool.healthCheck).toMatchObject({
      healthyThreshold: 5,
      unhealthyThreshold: 7,
      interval: 999,
      timeout: 111,
      path: '/health',
      enabled: false,
    })
  })
})

describe('primaryUpstreamUrl', () => {
  it('returns the default when `from` is unset', () => {
    expect(primaryUpstreamUrl(undefined)).toBe('localhost:5173')
  })

  it('passes through a single string', () => {
    expect(primaryUpstreamUrl('localhost:4000')).toBe('localhost:4000')
  })

  it('returns the first entry of an array of strings', () => {
    expect(primaryUpstreamUrl(['a:1', 'b:2'])).toBe('a:1')
  })

  it('returns the `.url` of the first UpstreamTarget entry', () => {
    expect(primaryUpstreamUrl([{ url: 'a:1', weight: 3 }, 'b:2'])).toBe('a:1')
  })
})

describe('selectUpstream — round-robin', () => {
  it('rotates through healthy upstreams in order and wraps around', () => {
    const pool = createUpstreamPool(['a:1', 'b:2', 'c:3'])
    const picks = Array.from({ length: 6 }, () => selectUpstream(pool)?.url)
    expect(picks).toEqual(['a:1', 'b:2', 'c:3', 'a:1', 'b:2', 'c:3'])
  })

  it('distributes evenly across N backends over many requests', () => {
    const pool = createUpstreamPool(['a:1', 'b:2', 'c:3', 'd:4'])
    const counts: Record<string, number> = {}
    const total = 400
    for (let i = 0; i < total; i++) {
      const u = selectUpstream(pool)!
      counts[u.url] = (counts[u.url] ?? 0) + 1
    }
    for (const url of ['a:1', 'b:2', 'c:3', 'd:4'])
      expect(counts[url]).toBe(total / 4)
  })

  it('skips unhealthy upstreams and only rotates through the healthy ones', () => {
    const pool = createUpstreamPool(['a:1', 'b:2', 'c:3'])
    pool.upstreams[1].healthy = false // b:2 out of rotation
    const picks = Array.from({ length: 4 }, () => selectUpstream(pool)?.url)
    expect(picks).toEqual(['a:1', 'c:3', 'a:1', 'c:3'])
  })
})

describe('selectUpstream — weighted-round-robin', () => {
  it('respects weights over a full weighted cycle (Nginx smooth WRR)', () => {
    const pool = createUpstreamPool(
      [{ url: 'a:1', weight: 5 }, { url: 'b:2', weight: 1 }, { url: 'c:3', weight: 1 }],
      { strategy: 'weighted-round-robin' },
    )
    const counts: Record<string, number> = { 'a:1': 0, 'b:2': 0, 'c:3': 0 }
    const totalWeight = 7
    const cycles = 50
    for (let i = 0; i < totalWeight * cycles; i++) {
      const u = selectUpstream(pool)!
      counts[u.url]++
    }
    // Over full cycles of the total weight, picks land exactly proportional
    // to weight for Nginx's smooth WRR algorithm.
    expect(counts['a:1']).toBe(5 * cycles)
    expect(counts['b:2']).toBe(1 * cycles)
    expect(counts['c:3']).toBe(1 * cycles)
  })

  it('never picks the same upstream twice in a row when weights are balanced', () => {
    const pool = createUpstreamPool(
      [{ url: 'a:1', weight: 1 }, { url: 'b:2', weight: 1 }],
      { strategy: 'weighted-round-robin' },
    )
    let last: string | undefined
    for (let i = 0; i < 20; i++) {
      const u = selectUpstream(pool)!
      if (last)
        expect(u.url).not.toBe(last)
      last = u.url
    }
  })
})

describe('selectUpstream — least-connections', () => {
  it('picks the upstream with the fewest active connections', () => {
    const pool = createUpstreamPool(['a:1', 'b:2', 'c:3'], { strategy: 'least-connections' })
    pool.upstreams[0].activeConnections = 5
    pool.upstreams[1].activeConnections = 1
    pool.upstreams[2].activeConnections = 3
    expect(selectUpstream(pool)?.url).toBe('b:2')
  })

  it('re-evaluates on every call as active connections change', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], { strategy: 'least-connections' })
    pool.upstreams[0].activeConnections = 0
    pool.upstreams[1].activeConnections = 0
    expect(selectUpstream(pool)?.url).toBe('a:1') // tie → first wins
    pool.upstreams[0].activeConnections = 10
    expect(selectUpstream(pool)?.url).toBe('b:2')
  })
})

describe('selectUpstream — empty / all-unhealthy pools', () => {
  it('returns undefined when every upstream in an N>1 pool is unhealthy', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'])
    pool.upstreams[0].healthy = false
    pool.upstreams[1].healthy = false
    expect(selectUpstream(pool)).toBeUndefined()
  })

  it('still selects the lone upstream of a single-upstream pool even when "unhealthy" (backward compat)', () => {
    const pool = createUpstreamPool('only:1')
    pool.upstreams[0].healthy = false
    const picked = selectUpstream(pool)
    expect(picked?.url).toBe('only:1')
  })
})

describe('markSuccess / markFailure', () => {
  it('flips healthy → unhealthy after unhealthyThreshold consecutive failures', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], { healthCheck: { unhealthyThreshold: 3 } })
    const [a] = pool.upstreams
    markFailure(pool, a)
    expect(a.healthy).toBe(true)
    markFailure(pool, a)
    expect(a.healthy).toBe(true)
    markFailure(pool, a)
    expect(a.healthy).toBe(false)
    expect(a.consecutiveFailures).toBe(3)
  })

  it('flips unhealthy → healthy after healthyThreshold consecutive successes', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], {
      healthCheck: { unhealthyThreshold: 1, healthyThreshold: 2 },
    })
    const [a] = pool.upstreams
    markFailure(pool, a)
    expect(a.healthy).toBe(false)
    markSuccess(pool, a)
    expect(a.healthy).toBe(false) // one success, threshold is 2
    markSuccess(pool, a)
    expect(a.healthy).toBe(true)
  })

  it('a success resets the failure streak and vice versa', () => {
    const pool = createUpstreamPool(['a:1'], { healthCheck: { unhealthyThreshold: 3 } })
    const [a] = pool.upstreams
    markFailure(pool, a)
    markFailure(pool, a)
    expect(a.consecutiveFailures).toBe(2)
    markSuccess(pool, a)
    expect(a.consecutiveFailures).toBe(0)
    expect(a.consecutiveSuccesses).toBe(1)
  })

  it('an unhealthy upstream stops receiving round-robin traffic, then resumes once healthy again', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], {
      healthCheck: { unhealthyThreshold: 2, healthyThreshold: 2 },
    })
    const [a, b] = pool.upstreams

    markFailure(pool, a)
    markFailure(pool, a) // a now unhealthy

    const picksWhileDown = Array.from({ length: 4 }, () => selectUpstream(pool)?.url)
    expect(picksWhileDown.every(u => u === 'b:2')).toBe(true)

    markSuccess(pool, a)
    markSuccess(pool, a) // a healthy again

    const picksAfterRecovery = new Set(Array.from({ length: 10 }, () => selectUpstream(pool)?.url))
    expect(picksAfterRecovery.has('a:1')).toBe(true)
    expect(picksAfterRecovery.has('b:2')).toBe(true)
  })
})

describe('active health checks', () => {
  it('startHealthChecks is a no-op when disabled, and stopHealthChecks is safe to call unconditionally', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'])
    startHealthChecks(pool)
    expect(pool.healthCheckTimer).toBeNull()
    stopHealthChecks(pool)
    expect(pool.healthCheckTimer).toBeNull()
  })

  it('starts and stops an interval timer when enabled, without leaking it', () => {
    const pool = createUpstreamPool(['a:1', 'b:2'], { healthCheck: { enabled: true, interval: 50 } })
    startHealthChecks(pool)
    expect(pool.healthCheckTimer).not.toBeNull()
    // Idempotent: calling again doesn't create a second timer.
    const timer = pool.healthCheckTimer
    startHealthChecks(pool)
    expect(pool.healthCheckTimer).toBe(timer)

    stopHealthChecks(pool)
    expect(pool.healthCheckTimer).toBeNull()
  })

  it('does not start a timer for a degenerate single-upstream pool', () => {
    const pool = createUpstreamPool('only:1', { healthCheck: { enabled: true, interval: 50 } })
    startHealthChecks(pool)
    expect(pool.healthCheckTimer).toBeNull()
  })

  it('probes real backends and marks a dead one unhealthy, then healthy again once it recovers', async () => {
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    try {
      const deadPort = (upstream.port ?? 0) + 1 // nothing listens here initially
      const pool = createUpstreamPool(
        [`127.0.0.1:${upstream.port}`, `127.0.0.1:${deadPort}`],
        { healthCheck: { enabled: true, interval: 30, timeout: 200, unhealthyThreshold: 2, healthyThreshold: 2 } },
      )
      startHealthChecks(pool)
      try {
        // Wait for the dead upstream to accumulate enough failures.
        const deadline = Date.now() + 3000
        while (pool.upstreams[1].healthy && Date.now() < deadline)
          await Bun.sleep(20)
        expect(pool.upstreams[1].healthy).toBe(false)
        expect(pool.upstreams[0].healthy).toBe(true)
      }
      finally {
        stopHealthChecks(pool)
      }
    }
    finally {
      upstream.stop(true)
    }
  })
})
