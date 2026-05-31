/* eslint-disable no-console */
/**
 * Throughput benchmark. Uses `oha` (a fast Rust HTTP load generator) when
 * available for credible requests/sec numbers under real concurrency, and
 * falls back to a built-in concurrent driver otherwise. Targets are measured
 * sequentially so they never contend for CPU with each other.
 */
import type { BenchTarget } from './lib'
import { fmt, hasBinary } from './lib'

export interface ThroughputResult {
  name: string
  rps: number
  p50ms: number
  p99ms: number
  errors: number
}

export interface ThroughputOptions {
  requests: number
  concurrency: number
  path: string
  /** Warm-up requests before each measured run (JIT / connection pool). */
  warmup?: number
  /**
   * Reuse client TCP connections (browsers and dev servers do). Default `true`
   * — steady-state throughput. Set `false` to stress the accept loop with a
   * fresh connection per request.
   */
  keepalive?: boolean
}

async function ohaRun(target: BenchTarget, opts: ThroughputOptions): Promise<ThroughputResult> {
  const url = `${target.url}${opts.path}`
  const proc = Bun.spawn([
    'oha',
    '-n', String(opts.requests),
    '-c', String(opts.concurrency),
    '--no-tui',
    '--output-format', 'json',
    ...(opts.keepalive === false ? ['--disable-keepalive'] : []),
    url,
  ], { stdout: 'pipe', stderr: 'pipe' })

  const out = await new Response(proc.stdout).text()
  await proc.exited
  const json = JSON.parse(out)
  const codes: Record<string, number> = json.statusCodeDistribution ?? {}
  const errors = Object.entries(codes)
    .filter(([code]) => !code.startsWith('2'))
    .reduce((a, [, n]) => a + (n as number), 0)
    + Object.values(json.errorDistribution ?? {}).reduce((a: number, n) => a + (n as number), 0)

  return {
    name: target.name,
    rps: json.summary.requestsPerSec,
    p50ms: (json.latencyPercentiles?.p50 ?? json.summary.average) * 1000,
    p99ms: (json.latencyPercentiles?.p99 ?? json.summary.slowest) * 1000,
    errors,
  }
}

/** Built-in fallback driver — keeps `concurrency` requests in flight at once. */
async function builtinRun(target: BenchTarget, opts: ThroughputOptions): Promise<ThroughputResult> {
  const url = `${target.url}${opts.path}`
  const latencies: number[] = []
  let errors = 0
  let issued = 0

  const worker = async () => {
    for (;;) {
      if (issued >= opts.requests)
        return
      issued++
      const t0 = Bun.nanoseconds()
      try {
        const res = await fetch(url)
        await res.arrayBuffer()
        if (res.status >= 300)
          errors++
      }
      catch {
        errors++
      }
      latencies.push((Bun.nanoseconds() - t0) / 1e6)
    }
  }

  const start = Bun.nanoseconds()
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  const elapsedSec = (Bun.nanoseconds() - start) / 1e9
  latencies.sort((a, b) => a - b)
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0

  return {
    name: target.name,
    rps: opts.requests / elapsedSec,
    p50ms: pct(0.5),
    p99ms: pct(0.99),
    errors,
  }
}

export async function runThroughput(targets: BenchTarget[], opts: ThroughputOptions): Promise<ThroughputResult[]> {
  const useOha = hasBinary('oha')
  const ka = opts.keepalive === false ? 'no-keepalive' : 'keepalive'
  console.log(`\n=== Throughput (${fmt(opts.requests)} reqs, ${opts.concurrency} concurrent, ${opts.path}, ${ka}, driver: ${useOha ? 'oha' : 'built-in'}) ===\n`)
  const results: ThroughputResult[] = []
  for (const target of targets) {
    // warm-up
    const warm = opts.warmup ?? Math.min(500, opts.requests)
    await Promise.all(Array.from({ length: Math.min(warm, 64) }, () =>
      fetch(`${target.url}${opts.path}`).then(r => r.arrayBuffer()).catch(() => {})))
    const res = useOha ? await ohaRun(target, opts) : await builtinRun(target, opts)
    results.push(res)
    console.log(
      `  ${res.name.padEnd(9)} ${fmt(res.rps).padStart(9)} req/s   `
      + `p50 ${res.p50ms.toFixed(2)}ms   p99 ${res.p99ms.toFixed(2)}ms`
      + (res.errors ? `   errors ${res.errors}` : ''),
    )
    await Bun.sleep(250)
  }
  return results
}
