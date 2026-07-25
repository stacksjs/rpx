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
it links zig-waf's **C connector ABI** (`zig_waf.h`) and runs each request head
through the engine before forwarding, replying **403** and dropping the
connection on an enforced intervention. It's opt-in at build time:

```bash
# 1. build zig-waf so its C library exists (zig-out/lib/libzig-waf.a)
(cd /path/to/zig-waf && zig build)

# 2. build the dataplane against it, then front an origin with a rules file
zig build -Dwaf=/path/to/zig-waf -Doptimize=ReleaseFast
./zig-out/bin/rpx-dataplane 8443 127.0.0.1 3000 0.0.0.0 rules.conf
```

Now `?q=attack` (matched by a `SecRule ARGS "@rx attack" "...,deny"`) returns
`403 Forbidden`, while benign requests proxy through untouched. Without `-Dwaf`
the dataplane builds as a plain proxy with **zero** zig-waf dependency (the
inspection hook compiles to a no-op), so `zig build` / `zig build test` need no
zig-waf checkout. The compiled rule plan is immutable, so evaluating it from
many connection tasks concurrently is safe. A single WAF transaction spans a
connection's request and response, so anomaly scores accumulate across the
phases (as CRS's blocking-evaluation stages expect). Inspection covers the
request-headers phase (query args, headers) and the request-body phase (a
Content-Length body up to 128 KB is buffered and run through the body
processors — URL-encoded / JSON / multipart / XML — into `ARGS_POST` etc.),
then the **response** phases: the origin's response head and, when it is
Content-Length-framed and within the 128 KB cap, its body are buffered and run
through the response-headers and response-body phases (e.g. CRS data-leakage
rules), replacing the response with `403` on an enforced intervention. Larger,
chunked, or close-framed bodies stream through with only their head inspected.
**Every** request on a keep-alive connection is inspected (each gets a fresh WAF
transaction), so follow-up requests cannot bypass the WAF; a message we cannot
delimit (chunked, close-framed, oversize, or an `Upgrade`/WebSocket tunnel)
falls back to a transparent pump for the remainder. The real client address is
passed to the engine (`REMOTE_ADDR`/`REMOTE_PORT`, so `@ipMatch`/RBL rules work)
and `X-Forwarded-For`/`-Proto` are added to the forwarded request.

## TLS termination

Build with `-Dtls=/path/to/zig-tls` (a pure-Zig TLS 1.2/1.3 stack) and pass
`--tls-cert <abs.pem> --tls-key <abs.pem>` to terminate TLS at the dataplane:
each connection is decrypted, run through the WAF (and HTTP handling) exactly as
plaintext, and forwarded to the plaintext upstream. The key is ECDSA P-256.

```bash
zig build -Dwaf=/path/to/zig-waf -Dtls=/path/to/zig-tls -Doptimize=ReleaseFast
./zig-out/bin/rpx-dataplane 8443 127.0.0.1 3000 0.0.0.0 rules.conf \
  --tls-cert /etc/rpx/cert.pem --tls-key /etc/rpx/key.pem
```

Now `https://…?q=attack` is decrypted, blocked with `403`, and never reaches the
origin. Without `-Dtls` the dataplane is plaintext-only (no TLS dependency).
IPv6 clients currently fall back to a placeholder `REMOTE_ADDR`.

## Roadmap

1. **TCP pump on `std.Io`.** *(here — builds, runs, validated end-to-end)*
2. **io_uring backend** (`std.Io.Evented`) for the single-thread Linux loop.
3. **HTTP/1.1 parse** for host routing, `X-Forwarded-*`, and the zig-waf
   inspection hook. *(done — response inspection, keep-alive, XFF, REMOTE_ADDR)*
4. **TLS termination** via zig-tls. *(done — `-Dtls`; see above)* kTLS next.
5. Bun↔dataplane handoff hardening (config reload via SIGHUP, like cluster mode).

## Status

- ✅ Builds on Zig 0.17-dev (`std.Io`); unit tests pass.
- ✅ Runtime-validated as a transparent TCP proxy (origin → dataplane → client).
- ⏳ Not yet benchmarked against nginx; no HTTP parsing, TLS, or WAF hook yet.
