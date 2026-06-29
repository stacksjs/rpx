# rpx benchmarks

A reproducible benchmark suite comparing rpx's reverse-proxy hot path against
the most popular reverse proxies — **caddy**and**nginx** — plus a raw
`Bun.serve` proxy (the theoretical floor for the fetch-based approach) and a
direct-to-origin baseline.

- **Latency** is measured with [mitata](https://github.com/evanwashere/mitata)

  (single in-flight request → how much latency each proxy adds).

- **Throughput** is measured with [`oha`](https://github.com/hatoo/oha) under

  real concurrency (requests/sec), falling back to a built-in concurrent driver
  if `oha` isn't installed.

Every proxy forwards to the *same* origin over plain HTTP on its own port, so
the comparison isolates request-forwarding overhead. (TLS is a separate axis and
would only add handshake noise to a same-machine proxy comparison.)

## Running

```bash
# from packages/rpx
bun run bench                 # full suite (latency + throughput)
bun run bench:latency         # latency only (mitata)
bun run bench:throughput      # throughput only (oha)

# options
bun run bench -n 100000 -c 100   # 100k requests, 100 concurrent connections
bun run bench --large            # forward ~100 KB bodies instead of ~30 B
bun run bench --no-keepalive     # fresh client connection per request
```

caddy and nginx are auto-detected and **skipped** if not installed:

```bash
brew install caddy nginx oha    # macOS
```

## What's measured

| Target    | What it is                                                              |
|-----------|-------------------------------------------------------------------------|
| `direct`  | Hitting the origin with no proxy — the upper bound.                      |
| `rpx`     | rpx's real production handler (`createProxyFetchHandler` + host routing).|
| `bun-raw` | A bare `Bun.serve` + `fetch` proxy — the floor for this approach.        |
| `caddy`   | `caddy reverse*proxy`.                                                   |
| `nginx`   | `nginx proxy*pass` with upstream keepalive.                             |

`rpx` is driven through the exact same code path the shared `:443` server and
the daemon use, so the numbers reflect real request handling — not a synthetic
stand-in.

## Files

- `lib.ts` — port allocation, readiness probing, child-process helpers.
- `origin.ts` — the shared upstream origin (pre-built static responses).
- `targets.ts` — starts each proxy under test.
- `latency.ts` — mitata latency benchmark.
- `throughput.ts` — oha (or built-in) throughput benchmark.
- `run.ts` — orchestrator + CLI entry point.

## Notes

- Numbers are machine- and load-dependent; treat them as *relative*. The

  `direct` baseline shifts run-to-run with machine noise — always read each
  proxy relative to `direct` and `bun-raw` in the *same* run.

- `nginx` (C, multi-process) leads raw throughput; that's expected and reported

  honestly. rpx's goal is to be the fastest *zero-config, HTTPS-by-default dev
  proxy*, and it lands on par with caddy on throughput while beating it on
  latency, sitting within ~10% of the raw-Bun ceiling.
