# rpx dataplane (prototype)

A native reverse-proxy **hot path** in Zig, meant to sit *behind* rpx's existing
TypeScript control plane. **Status: prototype — cross-compiles to Linux; not yet
runtime-validated or benchmarked (needs a Linux host or Zig 0.17-dev).**

## Why

The HTML benchmark showed Bun's proxy is **body-bound**: every byte is copied
through JS userspace + GC, so even a bare `Bun.serve + fetch` proxy is ~3× behind
nginx on a ~16 KB page. That's a platform ceiling, not an rpx bug.

The thesis this prototype tests:

- For **reverse proxying**, nginx *also* copies bytes through userspace (its
  zero-copy `sendfile` is for static files). So a **no-GC, no-per-request-alloc**
  native proxy should already *match* nginx and crush Bun.
- On Linux, **`splice()`** moves bytes **kernel→kernel** (zero-copy), so it goes
  *past* nginx — we stop doing the copy nginx still does.

## Architecture: control plane (TS) + dataplane (native)

```
Bun / TypeScript control plane            Zig dataplane (this)
─ zero-config, rpx.config.ts              ─ accept + (later) TLS termination
─ cert issuance / ACME / SNI              ─ splice/copy proxy, no GC, no alloc
─ /etc/hosts, DNS, clean URLs   ──cert+route config on disk──▶  reusePort shards
─ registry, daemon lifecycle      (the cluster-sni.json pattern)  poll/io_uring loop
```

This reuses the exact hand-off the daemon's **cluster mode** already uses: the
coordinator provisions certs/config to disk (`cluster-sni.json`) and the workers
consume them. Swap the Bun workers for dataplane workers and the control plane is
unchanged. (v0 below is plaintext-only and routes to a single upstream — TLS and
host-routing are control-plane/next-phase concerns.)

## v0 (this code)

A transparent **1:1 TCP proxy**: each accepted client connection gets its own
upstream connection, driven by a single-threaded non-blocking `poll()` loop. Run
N copies with `SO_REUSEPORT` for multi-core (the bench spawns them, exactly like
the Bun workers). Byte movement is abstracted behind `Direction`:

- **copy path** (portable): `read()`/`write()` through a 64 KB userspace buffer.
- **splice path** (Linux, `comptime`): `splice()` socket→pipe→socket, zero-copy.

```
rpx-dataplane <listenPort> <upstreamHost> <upstreamPort>
```

No HTTP parsing in v0 — it's a TCP pump, which is the right *upper bound* for the
single-upstream benchmark (isolates the data-path cost). Host routing + header
rewrite (`X-Forwarded-*`) come in v1 and add parsing cost back on top.

## Build & run

```bash
# Linux (the real perf target — splice path):
zig build -Doptimize=ReleaseFast
./zig-out/bin/rpx-dataplane 8443 127.0.0.1 3000

# Cross-compile-verify from anywhere (no run):
zig build-exe src/main.zig -O ReleaseFast -target x86_64-linux-musl -femit-bin=/tmp/rpx-dp
```

**Toolchain note:** building/running natively on **macOS 26 SDK** needs **Zig
≥ 0.17-dev** (0.15.x can't link libSystem against the new SDK). On Linux, any
recent Zig works. The splice path requires Linux ≥ 2.6.17 (any modern kernel).

## Benchmarking against nginx

The rpx bench grows a `zig` target (when the binary builds) that spawns N copies
with `reusePort` and forwards to the shared origin — head-to-head with `nginx`,
`caddy`, `rpx`, and `bun-raw` on the same origin:

```bash
cd .. && bun run bench --html        # serve a ~16 KB page (the body-bound metric)
```

Expectation on Linux: the **copy path** should land near nginx and far above Bun;
the **splice path** should edge past nginx on bodies.

## Roadmap

1. **v0** — splice/copy TCP pump, reusePort, poll loop. *(here)*
2. **io_uring** event loop (Linux 5.x): multishot accept, batched SQEs, registered
   buffers — replaces poll, cuts syscalls.
3. **kTLS** — terminate TLS in-kernel so encrypted bodies can *still* splice; this
   is what beats nginx on HTTPS body throughput.
4. HTTP/1.1 parse for host routing + `X-Forwarded-*`; HTTP/2; WebSocket.
5. Bun↔dataplane handoff hardening (config reload via SIGHUP, like cluster mode).

Longer term this is a natural fit for the **Home** language runtime work
(`~/Code/Home/lang`): the `Direction` data-move primitive and the event loop are
exactly the kind of zero-cost, no-GC systems code Home targets — Home (or its
io_uring/splice bindings) can slot in where stock Zig is used here.

## Honest status

- ✅ Compiles for Linux (incl. the `splice` path) via cross-compilation.
- ⏳ **Not runtime-tested or benchmarked** — this macOS host can't build/run native
  Zig (SDK 26 + Zig 0.15) and has no Linux/container. Run on Linux (or with
  0.17-dev) to validate correctness and get the nginx comparison.
- The proxy logic (poll loop, EOF/half-close, splice state machine) is
  correct-by-inspection but unproven until run.
