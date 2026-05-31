/**
 * Upstream origin server shared by every proxy under test. It is intentionally
 * as fast as possible (pre-built static responses, no per-request allocation)
 * so the benchmark measures proxy overhead, not backend work.
 *
 * Routes:
 *   GET /            → small JSON body (~30 B)
 *   GET /large       → ~100 KB body (payload-forwarding throughput)
 *   GET /<anything>  → small JSON body
 */
import type { BenchTarget } from './lib'
import { HOST } from './lib'

const SMALL_BODY = JSON.stringify({ ok: true, proxy: 'bench' })
const LARGE_BODY = 'x'.repeat(100 * 1024)

export interface Origin extends BenchTarget {
  port: number
  host: string
}

export function startOrigin(port: number): Origin {
  const server = Bun.serve({
    port,
    hostname: HOST,
    fetch(req: Request): Response {
      const url = new URL(req.url)
      if (url.pathname === '/large') {
        return new Response(LARGE_BODY, {
          headers: { 'content-type': 'text/plain', 'content-length': String(LARGE_BODY.length) },
        })
      }
      return new Response(SMALL_BODY, {
        headers: { 'content-type': 'application/json', 'content-length': String(SMALL_BODY.length) },
      })
    },
  })

  return {
    name: 'origin',
    url: `http://${HOST}:${port}`,
    port,
    host: `${HOST}:${port}`,
    stop: () => server.stop(true),
  }
}
