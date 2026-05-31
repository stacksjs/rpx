/* eslint-disable no-console */
/**
 * Per-request latency benchmark via mitata. This measures single-request
 * round-trip overhead (one request in flight at a time) — i.e. how much latency
 * each proxy adds on top of hitting the origin directly. Throughput under
 * concurrency is measured separately in `throughput.ts`.
 */
import type { BenchTarget } from './lib'
import { bench, run, summary } from 'mitata'

export async function runLatency(targets: BenchTarget[], reqPath: string): Promise<void> {
  console.log(`\n=== Latency (single in-flight request, ${reqPath}) ===\n`)

  summary(() => {
    for (const target of targets) {
      const url = `${target.url}${reqPath}`
      bench(target.name, async () => {
        const res = await fetch(url)
        await res.arrayBuffer()
      })
    }
  })

  await run()
}
