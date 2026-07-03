/**
 * Multi-upstream load balancing for a single route's `from`.
 *
 * A route's `from` is either a single `host:port` string (the historical,
 * backward-compatible shape — a degenerate one-item pool) or an array of
 * upstreams to distribute traffic across. This module normalizes either shape
 * into an `UpstreamPool`, applies the configured strategy to pick an upstream
 * per request, and tracks passive (and optionally active) health so a failing
 * upstream is taken out of rotation and restored once healthy again.
 *
 * State lives on the pool object itself (not recreated per-request) — callers
 * build one pool per route at route-construction time and reuse it across
 * requests for that route's lifetime.
 */
import type { HealthCheckConfig, LoadBalancerConfig, LoadBalancerStrategy, ProxyFrom, UpstreamTarget } from './types'

/** Per-upstream runtime state tracked across requests. */
export interface UpstreamState {
  /** Upstream `host:port`. */
  url: string
  /** Relative weight for weighted strategies. */
  weight: number
  /** Whether this upstream currently receives traffic. */
  healthy: boolean
  /** In-flight requests currently dispatched to this upstream. */
  activeConnections: number
  /** Consecutive failed outcomes (resets on any success). */
  consecutiveFailures: number
  /** Consecutive successful outcomes (resets on any failure). */
  consecutiveSuccesses: number
}

const DEFAULT_HEALTHY_THRESHOLD = 2
const DEFAULT_UNHEALTHY_THRESHOLD = 3
const DEFAULT_HEALTH_CHECK_PATH = '/'
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000

interface ResolvedHealthCheckConfig {
  enabled: boolean
  path: string
  interval: number
  timeout: number
  healthyThreshold: number
  unhealthyThreshold: number
}

function resolveHealthCheckConfig(config?: HealthCheckConfig): ResolvedHealthCheckConfig {
  return {
    enabled: config?.enabled ?? false,
    path: config?.path ?? DEFAULT_HEALTH_CHECK_PATH,
    interval: config?.interval ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    timeout: config?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    healthyThreshold: config?.healthyThreshold ?? DEFAULT_HEALTHY_THRESHOLD,
    unhealthyThreshold: config?.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD,
  }
}

/** A route's normalized upstream pool + selection/health state. */
export interface UpstreamPool {
  upstreams: UpstreamState[]
  strategy: LoadBalancerStrategy
  healthCheck: ResolvedHealthCheckConfig
  /** Rotation cursor for round-robin / weighted-round-robin. */
  cursor: number
  /** Weighted-round-robin's current weight-cursor state (Nginx smooth WRR). */
  wrrCurrentWeights: number[]
  /** Active health-check interval handle, when running. */
  healthCheckTimer: ReturnType<typeof setInterval> | null
}

function normalizeUpstreams(from: ProxyFrom): UpstreamState[] {
  const list = Array.isArray(from) ? from : [from]
  return list.map((entry): UpstreamState => {
    const target: UpstreamTarget = typeof entry === 'string' ? { url: entry } : entry
    return {
      url: target.url,
      weight: target.weight && target.weight > 0 ? target.weight : 1,
      healthy: true,
      activeConnections: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    }
  })
}

/**
 * The ordered list of upstream `host:port` URLs a {@link ProxyFrom} resolves
 * to, ignoring weight/other per-upstream config. Lets callers cheaply compare
 * "does this pool still match this `from`" without rebuilding a full pool —
 * see `entryToRoute` in daemon.ts, which reconciles a cached pool against a
 * registry entry's current `from` on every call.
 */
export function resolveUpstreamUrls(from: ProxyFrom): string[] {
  const list = Array.isArray(from) ? from : [from]
  return list.map(entry => (typeof entry === 'string' ? entry : entry.url))
}

/**
 * The first upstream's `host:port` from a {@link ProxyFrom}, for call sites
 * that need a single representative address (connection testing before the
 * pool exists, hosts-file checks, id derivation, log lines) rather than the
 * full pool. Defaults to `'localhost:5173'` to match rpx's historical
 * single-upstream default when `from` is unset.
 */
export function primaryUpstreamUrl(from?: ProxyFrom): string {
  if (!from)
    return 'localhost:5173'
  const first = Array.isArray(from) ? from[0] : from
  if (!first)
    return 'localhost:5173'
  return typeof first === 'string' ? first : first.url
}

/**
 * Build a pool from a route's `from` (single string or array) plus optional
 * load-balancer config. Always returns at least one upstream when `from` is
 * set to a non-empty string/array; callers pass `''`/`[]` only for
 * static/redirect routes that carry no upstream at all (in which case use of
 * the pool is skipped entirely).
 */
export function createUpstreamPool(from: ProxyFrom, lbConfig?: LoadBalancerConfig): UpstreamPool {
  return {
    upstreams: normalizeUpstreams(from),
    strategy: lbConfig?.strategy ?? 'round-robin',
    healthCheck: resolveHealthCheckConfig(lbConfig?.healthCheck),
    cursor: 0,
    wrrCurrentWeights: [],
    healthCheckTimer: null,
  }
}

/** Upstreams currently eligible for traffic. */
function healthyUpstreams(pool: UpstreamPool): UpstreamState[] {
  const healthy = pool.upstreams.filter(u => u.healthy)
  // Degenerate single-upstream pool: never fail the request over health state
  // alone — a lone upstream that's "unhealthy" still gets selected, matching
  // rpx's historical behavior of always attempting the only configured
  // upstream and letting the normal error path (502/504) surface failures.
  if (healthy.length === 0 && pool.upstreams.length === 1)
    return pool.upstreams
  return healthy
}

function selectRoundRobin(pool: UpstreamPool, candidates: UpstreamState[]): UpstreamState {
  const idx = pool.cursor % candidates.length
  pool.cursor = (pool.cursor + 1) % candidates.length
  return candidates[idx]
}

/**
 * Smooth weighted round-robin (Nginx's algorithm): each upstream accumulates
 * its weight every pick; the highest accumulator is chosen and then reduced by
 * the total weight. Distributes picks proportionally to weight while avoiding
 * bursts of the same heavy upstream in a row.
 */
function selectWeightedRoundRobin(pool: UpstreamPool, candidates: UpstreamState[]): UpstreamState {
  if (pool.wrrCurrentWeights.length !== candidates.length)
    pool.wrrCurrentWeights = candidates.map(() => 0)

  const totalWeight = candidates.reduce((sum, u) => sum + u.weight, 0)
  let bestIdx = 0
  for (let i = 0; i < candidates.length; i++) {
    pool.wrrCurrentWeights[i] += candidates[i].weight
    if (pool.wrrCurrentWeights[i] > pool.wrrCurrentWeights[bestIdx])
      bestIdx = i
  }
  pool.wrrCurrentWeights[bestIdx] -= totalWeight
  return candidates[bestIdx]
}

function selectLeastConnections(candidates: UpstreamState[]): UpstreamState {
  let best = candidates[0]
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].activeConnections < best.activeConnections)
      best = candidates[i]
  }
  return best
}

/**
 * Pick the next upstream per the pool's configured strategy, considering only
 * currently-healthy upstreams (unless the pool is a degenerate single-upstream
 * pool — see {@link healthyUpstreams}). Returns `undefined` when the pool has
 * no upstreams at all, or every upstream (in an N>1 pool) is unhealthy — the
 * caller should respond with a 502 in that case.
 */
export function selectUpstream(pool: UpstreamPool): UpstreamState | undefined {
  const candidates = healthyUpstreams(pool)
  if (candidates.length === 0)
    return undefined
  if (candidates.length === 1)
    return candidates[0]

  switch (pool.strategy) {
    case 'weighted-round-robin':
      return selectWeightedRoundRobin(pool, candidates)
    case 'least-connections':
      return selectLeastConnections(candidates)
    case 'round-robin':
    default:
      return selectRoundRobin(pool, candidates)
  }
}

/** Record a successful outcome for `upstream` — passive health-check bookkeeping. */
export function markSuccess(pool: UpstreamPool, upstream: UpstreamState): void {
  upstream.consecutiveFailures = 0
  upstream.consecutiveSuccesses += 1
  if (!upstream.healthy && upstream.consecutiveSuccesses >= pool.healthCheck.healthyThreshold)
    upstream.healthy = true
}

/** Record a failed outcome for `upstream` — passive health-check bookkeeping. */
export function markFailure(pool: UpstreamPool, upstream: UpstreamState): void {
  upstream.consecutiveSuccesses = 0
  upstream.consecutiveFailures += 1
  if (upstream.healthy && upstream.consecutiveFailures >= pool.healthCheck.unhealthyThreshold)
    upstream.healthy = false
}

/** Split `host:port` into fetch-able parts, defaulting to port 80. */
function splitHostPort(hostPort: string): { hostname: string, port: number } {
  const idx = hostPort.lastIndexOf(':')
  if (idx === -1)
    return { hostname: hostPort, port: 80 }
  const port = Number(hostPort.slice(idx + 1))
  return { hostname: hostPort.slice(0, idx), port: Number.isFinite(port) ? port : 80 }
}

/** Probe a single upstream once via HTTP GET and report the outcome to the pool. */
async function probeUpstream(pool: UpstreamPool, upstream: UpstreamState): Promise<void> {
  const { hostname, port } = splitHostPort(upstream.url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), pool.healthCheck.timeout)
  try {
    const res = await fetch(`http://${hostname}:${port}${pool.healthCheck.path}`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    // Any response at all (even an error status) means the upstream is up and
    // talking HTTP — that's enough to count as a successful liveness probe.
    // Only a network-level failure (connection refused, timeout) should count
    // against it.
    void res.body?.cancel().catch(() => {})
    markSuccess(pool, upstream)
  }
  catch {
    markFailure(pool, upstream)
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Start active health checking for `pool` when `healthCheck.enabled` — probes
 * every upstream on `healthCheck.interval`, independent of live traffic. No-op
 * (and idempotent) when active checks are disabled or already running. Always
 * pair with {@link stopHealthChecks} on server shutdown so the interval
 * doesn't leak.
 */
export function startHealthChecks(pool: UpstreamPool): void {
  if (!pool.healthCheck.enabled || pool.healthCheckTimer || pool.upstreams.length < 2)
    return
  const timer = setInterval(() => {
    for (const upstream of pool.upstreams)
      void probeUpstream(pool, upstream)
  }, pool.healthCheck.interval)
  timer.unref?.()
  pool.healthCheckTimer = timer
}

/** Stop active health checking for `pool`, if running. Safe to call repeatedly. */
export function stopHealthChecks(pool: UpstreamPool): void {
  if (pool.healthCheckTimer) {
    clearInterval(pool.healthCheckTimer)
    pool.healthCheckTimer = null
  }
}
