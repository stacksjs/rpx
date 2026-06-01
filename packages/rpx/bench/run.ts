/* eslint-disable no-console */
/**
 * Benchmark orchestrator. Boots the origin and every available proxy target,
 * runs the mitata latency benchmark and the oha throughput benchmark, prints a
 * summary table, then tears everything down.
 *
 * Usage:
 *   bun run bench                      # full suite (latency + throughput)
 *   bun run bench --html               # serve a ~16 KB HTML page (core workload)
 *   bun run bench --latency            # latency only
 *   bun run bench --throughput         # throughput only
 *   bun run bench --large              # forward ~100 KB bodies instead of ~30 B
 *   bun run bench -n 50000 -c 100      # tune throughput request count / concurrency
 *   bun run bench --cores 1            # pin every target to N cores (apples-to-apples)
 */
import type { BenchTarget } from './lib'
import type { ThroughputResult } from './throughput'
import { freePort } from './lib'
import { runLatency } from './latency'
import { startOrigin } from './origin'
import { startAllTargets } from './targets'
import { runThroughput } from './throughput'

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1])
    return Number(process.argv[i + 1])
  return fallback
}

function printSummary(thr: ThroughputResult[]): void {
  if (thr.length === 0)
    return
  const baseline = thr.find(t => t.name === 'direct')?.rps
  console.log('\n=== Summary (req/s, higher is better) ===\n')
  const sorted = [...thr].sort((a, b) => b.rps - a.rps)
  const rpx = thr.find(t => t.name === 'rpx')?.rps
  for (const r of sorted) {
    const vsDirect = baseline ? `${((r.rps / baseline) * 100).toFixed(0)}% of direct` : ''
    const vsRpx = rpx && r.name !== 'rpx' ? `   rpx is ${(rpx / r.rps).toFixed(2)}x` : ''
    console.log(`  ${r.name.padEnd(9)} ${r.rps.toFixed(0).padStart(9)} req/s   ${vsDirect}${vsRpx}`)
  }
}

async function main(): Promise<void> {
  const onlyLatency = process.argv.includes('--latency')
  const onlyThroughput = process.argv.includes('--throughput')
  const large = process.argv.includes('--large')
  const html = process.argv.includes('--html')
  // Serving HTML is the core reverse-proxy workload, so `--html` is the headline
  // mode; `--large` forwards a ~100 KB body; default is a tiny JSON payload.
  const reqPath = html ? '/html' : large ? '/large' : '/'
  const requests = arg('-n', 50_000)
  const concurrency = arg('-c', 50)
  const keepalive = !process.argv.includes('--no-keepalive')
  const coresArg = arg('--cores', 0)
  const cores = coresArg > 0 ? coresArg : undefined

  const originPort = await freePort()
  const origin = await startOrigin(originPort)
  console.log(`origin listening on ${origin.url}`)

  const targets: BenchTarget[] = await startAllTargets(origin, { cores })
  console.log(`targets: ${targets.map(t => t.name).join(', ')}`)

  let thr: ThroughputResult[] = []
  try {
    if (!onlyThroughput)
      await runLatency(targets, reqPath)
    if (!onlyLatency)
      thr = await runThroughput(targets, { requests, concurrency, path: reqPath, keepalive })
    printSummary(thr)
  }
  finally {
    for (const t of targets)
      await t.stop()
    origin.stop()
  }

  // Bun keeps the loop alive on lingering fetch keep-alive sockets; force exit.
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
