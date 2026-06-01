/**
 * Upstream origin shared by every proxy under test. Runs as a small cluster of
 * `reusePort` worker processes so it stays well ahead of the proxies and never
 * becomes the bottleneck (even when the proxies themselves scale across cores).
 *
 * Routes (see `worker.ts`):
 *   GET /        → small JSON body (~30 B)
 *   GET /large   → ~100 KB body
 */
import type { Subprocess } from 'bun'
import type { BenchTarget } from './lib'
import * as path from 'node:path'
import { HOST, killProc, waitForPort } from './lib'

const WORKER = path.join(import.meta.dir, 'worker.ts')

export interface Origin extends BenchTarget {
  port: number
  host: string
}

export async function startOrigin(port: number, workers = 2): Promise<Origin> {
  const procs: Subprocess[] = []
  for (let i = 0; i < workers; i++)
    procs.push(Bun.spawn(['bun', WORKER, 'origin', String(port)], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' }))

  await waitForPort(port)

  return {
    name: 'origin',
    url: `http://${HOST}:${port}`,
    port,
    host: `${HOST}:${port}`,
    stop: async () => { await Promise.all(procs.map(p => killProc(p))) },
  }
}
