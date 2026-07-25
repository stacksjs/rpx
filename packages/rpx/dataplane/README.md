# rpx dataplane

A native reverse-proxy **hot path** in Zig, meant to sit *behind* rpx's existing
TypeScript control plane. **Status: builds and runs on Zig 0.17-dev; a
transparent TCP proxy validated end-to-end (origin → dataplane → client).**

## Why

The HTML benchmark showed Bun's proxy is **body-bound**: every byte is copied
through JS userspace + GC, so even a bare `Bun.serve + fetch` proxy is ~3× behind
nginx on a ~16 KB page. That's a platform ceiling, not an rpx bug.

The thesis: for **reverse proxying**, nginx *also* copies bytes through
userspace (its zero-copy `sendfile` is for static files), so a **no-GC,
no-per-request-alloc** native proxy should already match nginx and crush Bun.

## Architecture: control plane (TS) + dataplane (native)

```
Bun / TypeScript control plane            Zig dataplane (this)
─ zero-config, rpx.config.ts              ─ accept + (later) TLS termination
─ cert issuance / ACME / SNI              ─ TCP proxy, no GC, no per-request alloc
─ /etc/hosts, DNS, clean URLs   ──cert+route config on disk──▶  std.Io task per conn
─ registry, daemon lifecycle      (the cluster-sni.json pattern)
```

This reuses the exact hand-off the daemon's **cluster mode** already uses: the
coordinator provisions certs/config to disk (`cluster-sni.json`) and the workers
consume them. Swap the Bun workers for dataplane workers and the control plane is
unchanged. (This code is plaintext-only and routes to a single upstream — TLS and
host-routing are control-plane / next-phase concerns.)

## What this code does

A transparent **1:1 TCP proxy**: each accepted client connection gets its own
upstream connection, and bytes are pumped in both directions until each side
closes (half-closes propagate independently).

It is built on Zig's **`std.Io`**: one lightweight task per connection, and one
per direction, multiplexed cooperatively by the `Io` backend.

- The default backend is a **thread pool** (`std.Io.Threaded`) — multi-core for
  free, cross-platform (macOS + Linux).
- Swapping it for **`std.Io.Evented`** gives the single-thread **io_uring** loop
  on Linux (kqueue on the BSDs). `std.Io` does the readiness multiplexing;
  there is no hand-rolled `poll()` set or `EAGAIN` bookkeeping.

`std.Io` exposes no socket→socket `splice()` (only file→socket offload via
`Stream.Writer.sendFile`), so bytes move through a 64 KB userspace buffer with a
write-through (unbuffered) writer to avoid a second copy.

```
rpx-dataplane <listenPort> <upstreamHost> <upstreamPort> [bindHost]
```

`bindHost` defaults to `0.0.0.0` (front every interface); pass `127.0.0.1` to
restrict to loopback. `upstreamHost` is an IP literal — the control plane owns
DNS. No HTTP parsing yet: it's a TCP pump, the right *upper bound* for the
single-upstream benchmark. Host routing + `X-Forwarded-*` add parsing on top.

## Build & run

```bash
zig build -Doptimize=ReleaseFast
./zig-out/bin/rpx-dataplane 8443 127.0.0.1 3000        # front :8443 → 127.0.0.1:3000
zig build test                                         # unit tests
```

Needs **Zig 0.17-dev** (the `std.Io` networking API); this is the same toolchain
zig-waf pins, so the dataplane and the WAF engine build against one Zig.

## Integrating the zig-waf WAF

The dataplane is the front-end for [zig-waf](https://github.com/zig-utils/zig-waf):
it links zig-waf's **C connector ABI** (`zig_waf.h`) and runs each request
through the engine's phases before forwarding, blocking on an intervention. The
ABI is toolchain-agnostic, so the two link cleanly. (Wiring in progress.)

## Roadmap

1. **TCP pump on `std.Io`.** *(here — builds, runs, validated end-to-end)*
2. **io_uring backend** (`std.Io.Evented`) for the single-thread Linux loop.
3. **HTTP/1.1 parse** for host routing, `X-Forwarded-*`, and the zig-waf
   inspection hook; then HTTP/2 and WebSocket.
4. **TLS termination** (and kTLS, so encrypted bodies can still offload).
5. Bun↔dataplane handoff hardening (config reload via SIGHUP, like cluster mode).

## Status

- ✅ Builds on Zig 0.17-dev (`std.Io`); unit tests pass.
- ✅ Runtime-validated as a transparent TCP proxy (origin → dataplane → client).
- ⏳ Not yet benchmarked against nginx; no HTTP parsing, TLS, or WAF hook yet.
