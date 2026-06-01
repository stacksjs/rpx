# rpx proxy performance — investigation findings (2026-05-31)

Machine: Apple Silicon, 11 cores, Bun 1.4.0. Origin = Bun.serve cluster (6 workers),
small ~30 B JSON body, oha load generator, keepalive. nginx bench config already uses
`proxy_http_version 1.1` + `Connection ""` + `keepalive 64` (fair, best-case nginx).

## Bench bug (fixed)

`bench/run.ts` did `const origin = startOrigin(...)` without `await` — `startOrigin` is
async, so `origin.url` was `undefined` and nginx failed to start ("host not found in
upstream undefined"). Fixed by awaiting. Added `--cores N` flag to pin every target to
the same core count (apples-to-apples).

## Throughput by concurrency (req/s), 6 cores for JS targets, nginx native all-core

| c   | nginx  | rpx (fetch) | bun-raw (fetch) | pooled-socket (proto) |
|-----|--------|-------------|-----------------|-----------------------|
| 50  | ~90k   | ~75k        | ~82k            | ~75k                  |
| 100 | ~98k   | ~76k        | ~89k            | ~75k                  |
| 200 | ~96k   | **~5k** ⚠️  | (collapses)     | ~44k (no errors)      |
| 400 | ~89k   | **~4k** ⚠️  | (collapses)     | ~67k (zero errors)    |

## Root cause of the high-concurrency collapse (REAL PRODUCTION BUG)

At c≥200 the fetch-based proxy collapses to ~4–5k req/s with ~40% non-2xx. Mid-run
`netstat` showed **10,329 TIME_WAIT** sockets. `fetch()` uses an _unbounded_ upstream
connection pool: under high concurrency it opens hundreds of upstream TCP connections
that churn into TIME_WAIT → ephemeral-port exhaustion → collapse. nginx caps this with a
_bounded_ reused keepalive pool (`keepalive 64`), so it stays flat. rpx falls over under
load today — independent of the benchmark, this is a stability bug worth fixing.

## Key headroom finding

A no-op `Bun.serve` (static response, no upstream) does **178–198k req/s** — ~2× nginx
(95–102k). So the serving half is NOT the bottleneck; the _entire_ gap is the upstream
forwarding path. A lean pooled raw-socket upstream (no `fetch()` object churn, bounded
keepalive pool) is the architecture that can both beat nginx and fix the collapse.

## Prototype status

`bench/pooled2.ts` is a working raw-TCP HTTP/1.1 pooled proxy. It fixes the collapse
(c=400: 67k, zero errors vs rpx 4k) but only ties rpx at low c (~75k) — it needs a
leaner per-request path (byte-level parse, fewer promise hops) and full correctness
(chunked bodies, SSE, HEAD/1xx, `Connection: close`, websockets coexistence, TLS
upstreams) before it can replace the production `fetch()` transport in `proxy-handler.ts`.

## Update — pooled transport landed + macOS reusePort caveat

- The pooled raw-socket transport (`src/proxy-pool.ts`) is integrated into

  `createProxyFetchHandler` with a fetch() fallback. It **eliminates the
  high-concurrency collapse**: rpx now holds ~60k req/s with zero errors at
  c=200/400 (was ~4–5k with ~40% errors). All 259 tests pass.

- **macOS `SO_REUSEPORT` does not load-balance** accepted connections across

  processes the way Linux does — only one worker effectively receives traffic.
  So spawning N `reusePort` workers gives NO scaling on macOS (verified: rpx
  pool x1≈x4≈x8≈62k; the origin cluster doesn't scale either). nginx scales via
  its shared-socket accept model, which works on macOS. ⇒ Multi-core via
  reusePort is a Linux win, not a macOS one. On macOS the contest is
  single-worker JS (≈62k) vs nginx (≈84–93k); the lever is main-thread CPU/req.

- Micro-bench (single reused connection, serial): pool **24µs/req** vs fetch

  **35µs/req** — the pool's per-request CPU is already _lower_ than fetch's; the
  remaining gap to nginx is main-thread work per request under concurrency.

## HTML serving — the core real-world metric (added 2026-05-31)

`--html` serves a representative ~16 KB HTML page (the headline reverse-proxy
workload). Single-machine, c=50, keepalive:

| Target  | req/s  | vs direct |
|---------|-------:|----------:|
| direct  | ~98k   | 100%      |
| nginx   | ~77k   | 79%       |
| caddy   | ~48k   | 49%       |
| bun-raw | ~27k   | 27%       |
| **rpx** | ~23k   | 23%       |

Key insight: with a real HTML-sized body the bottleneck shifts from per-request
overhead to **body copying**. nginx splices kernel→kernel (zero-copy); Bun (both
native `fetch` _and_ our pool) copies the body through userspace, so even
bare `bun-raw` is ~3× behind nginx — a **Bun platform ceiling**, not an rpx bug.
rpx (~23k) trails the Bun ceiling (~27k) by ~15% because the pool copies the body
once more than `fetch` (transient socket chunk → conn buffer → Response). Closing
that gap (a body-passthrough that copies once) brings rpx to ~`bun-raw` parity but
does NOT beat nginx/caddy on bodies — that needs kernel splice Bun doesn't expose.
Tiny-body (routing-bound) workloads are a separate axis where rpx is competitive.
