<p align="center"><img src="https://github.com/stacksjs/rpx/blob/main/.github/art/cover.jpg?raw=true" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# rpx

> A zero-config reverse proxy for local development with SSL support, custom domains, and more—for a better local developer experience.

## Features

- 🔀 Simple, lightweight Reverse Proxy
- ♾️ Custom Domains _(with wildcard host routing)_
- 0️⃣ Zero-Config Setup
- 🔒 SSL Support _(HTTPS by default; per-domain SNI certs in production)_
- 🚀 On-Demand Sites _(boot a project's dev server on first visit, Valet-style)_
- 🔌 WebSocket Proxying _(transparent `Upgrade` pass-through)_
- 📁 Static File Serving _(SPA / clean-URL / flat & directory SSG styles)_
- 🛣️ Auto HTTP-to-HTTPS Redirection
- ✏️ `/etc/hosts` Management _(fully disable-able for real servers)_
- 🧼 Clean URLs _(removes `.html` extension)_
- 🤖 CLI & Library Support

## Install

```bash
bun install -d @stacksjs/rpx
```

<!-- _Alternatively, you can install:_

```bash
brew install rpx # wip
pkgx install rpx # wip
``` -->

## Get Started

There are two ways of using this reverse proxy: _as a library or as a CLI._

### Library

Given the npm package is installed:

```ts
import type { TlsConfig } from '@stacksjs/rpx'
import { startProxy } from '@stacksjs/rpx'

export interface CleanupConfig {
  hosts: boolean // clean up /etc/hosts, defaults to false
  certs: boolean // clean up certificates, defaults to false
}

export interface ProxyConfig {
  from: string // domain to proxy from, defaults to localhost:5173
  to: string // domain to proxy to, defaults to rpx.localhost
  cleanUrls?: boolean // removes the .html extension from URLs, defaults to false
  https: boolean | TlsConfig // automatically uses https, defaults to true, also redirects http to https
  cleanup?: boolean | CleanupConfig // automatically cleans up /etc/hosts, defaults to false
  start?: StartOptions
  verbose: boolean // log verbose output, defaults to false
}

const config: ProxyOptions = {
  from: 'localhost:5173',
  to: 'rpx.localhost',
  cleanUrls: true,
  https: true,
  cleanup: false,
  start: {
    command: 'bun run dev:docs',
    lazy: true,
  }
}

startProxy(config)
```

In case you are trying to start multiple proxies, you may use this configuration:

```ts
// rpx.config.{ts,js}
import type { ProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ProxyOptions = {
  https: { // https: true -> also works with sensible defaults
    caCertPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.ca.crt`),
    certPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.crt`),
    keyPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.crt.key`),
  },

  cleanup: {
    hosts: true,
    certs: false,
  },

  proxies: [
    {
      from: 'localhost:5173',
      to: 'my-app.localhost',
      cleanUrls: true,
      start: {
        command: 'bun run dev',
        cwd: '/path/to/my-app',
        env: {
          NODE_ENV: 'development',
        },
      },
    },
    {
      from: 'localhost:5174',
      to: 'my-api.local',
    },
  ],

  verbose: true,
}

export default config
```

### CLI

```bash
rpx --from localhost:3000 --to my-project.localhost
rpx --from localhost:8080 --to my-project.test --keyPath ./key.pem --certPath ./cert.pem
rpx --help
rpx --version
```

## Configuration

The Reverse Proxy can be configured using a `rpx.config.ts` _(or `rpx.config.js`)_ file and it will be automatically loaded when running the `reverse-proxy` command.

```ts
// rpx.config.{ts,js}
import type { ProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ProxyOptions = {
  from: 'localhost:5173',
  to: 'rpx.localhost',

  https: {
    domain: 'rpx.localhost',
    hostCertCN: 'rpx.localhost',
    caCertPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.ca.crt`),
    certPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.crt`),
    keyPath: path.join(os.homedir(), '.stacks', 'ssl', `rpx.localhost.crt.key`),
    altNameIPs: ['127.0.0.1'],
    altNameURIs: ['localhost'],
    organizationName: 'stacksjs.org',
    countryName: 'US',
    stateName: 'California',
    localityName: 'Playa Vista',
    commonName: 'rpx.localhost',
    validityDays: 180,
    verbose: false,
  },

  verbose: false,
}

export default config
```

### Usage

```bash
./rpx start
```

### Single-port mode

By default rpx binds one listener per proxy (`:443`, then `:8443`, `:8444`, … as
ports are taken). Set `singlePortMode: true` to route **every** proxy through one
shared listener instead — requests are dispatched to the right upstream by their
`Host` header (and path). The port is configurable via `httpPort` (default `80`)
and `httpsPort` (default `443`):

```ts
const config: MultiProxyConfig = {
  https: false,
  singlePortMode: true,
  httpPort: 8080,
  proxies: [
    { from: 'localhost:3000', to: 'foo.localhost' },
    { from: 'localhost:3001', to: 'bar.localhost' },
    { from: 'localhost:3002', to: '*.localhost' },
  ],
}
```

```bash
rpx start --single-port-mode --https-port 8443
```

> When HTTPS is enabled and more than one proxy is configured, rpx already shares
> a single `:443` listener automatically; `singlePortMode` extends that to the
> HTTP-only and single-proxy cases and makes the port configurable.

### `changeOrigin`

Set `changeOrigin: true` to rewrite the `Origin` request header to the upstream
target — mirroring [`http-proxy`](https://github.com/http-party/node-http-proxy)'s
option. Useful when the upstream enforces CORS or same-origin checks.

```ts
const config: ProxyOptions = { from: 'localhost:5173', to: 'my-app.localhost', changeOrigin: true }
```

```bash
rpx start --from localhost:5173 --to my-app.localhost --change-origin
```

To learn more, head over to the [documentation](https://reverse-proxy.sh/).

## Production: multi-app gateway on one server

rpx can front many apps on a single server, routing by `Host`, terminating TLS
with real certificates, proxying WebSockets, and serving static sites — all from
one listener on `:443`.

### WebSocket proxying

WebSocket upgrades are proxied transparently for **every** route and mode —
single proxy, multi-proxy, single-port, and the daemon. A request with
`Upgrade: websocket` is accepted by rpx and piped to the upstream
(`ws://<from><path>`) in both directions, including the control-channel of a
tunnel server that accepts the upgrade on any path. No configuration needed; it
works wherever HTTP proxying works.

This is what makes **dev-server HMR work over HTTPS**: Vite and friends open a
`wss://` connection for hot-module reload, and rpx terminates the TLS and
forwards it to the dev server's `ws://` endpoint. Point rpx at your dev server
and HMR keeps working behind the custom HTTPS domain.

### Static file serving

A route can serve a local directory instead of proxying. Set `static` (and omit
`from`):

```ts
const config: ProxyOptions = {
  proxies: [
    // Proxy an app
    { from: 'localhost:3000', to: 'app.example.com' },

    // Serve a built static site
    {
      to: 'docs.example.com',
      static: {
        dir: '/srv/docs/dist',
        cleanUrls: true, // /about.html -> 301 /about
        pathRewriteStyle: 'directory', // /about -> about/index.html ('flat' -> about.html)
        maxAge: 3600, // Cache-Control: public, max-age=3600
      },
    },

    // Single-page app (client-side routing fallback to index.html)
    { to: 'spa.example.com', static: { dir: '/srv/spa/dist', spa: true } },
  ],
  https: true,
}
```

`static` also accepts a bare string shorthand for the directory:
`{ to: 'site.example.com', static: '/srv/site' }`.

### Wildcard host routing

Register a route for `_.example.com` and any `sub.example.com` matches it at
request time. Lookup prefers an exact host match, then the most-specific
(deepest-suffix) wildcard:

```ts
const config: ProxyOptions = {
  proxies: [
    { from: 'localhost:3002', to: '_.tunnel.example.com' }, // catch-all subdomains
    { from: 'localhost:3000', to: 'api.tunnel.example.com' }, // exact wins over the wildcard
  ],
  https: true,
}
```

A bare apex (`example.com`) is **not** matched by `_.example.com`.

### Per-domain SNI certificates (Let's Encrypt)

In production, serve a different real certificate per domain over SNI on one
listener. Point the daemon at a directory of PEM files following the convention
`<domain>.crt` / `<domain>.key`, with `_wildcard.<apex>.crt` / `.key` mapping to
the SNI server name `_.<apex>`:

```bash
rpx daemon:start --certs-dir /etc/letsencrypt/rpx
```

Programmatically (or via an explicit map):

```ts
import { runDaemon } from '@stacksjs/rpx'

await runDaemon({
  productionCerts: {
    certsDir: '/etc/letsencrypt/rpx',
    // or explicit per-server-name:
    domains: {
      'api.example.com': { certPath: '/etc/ssl/api.crt', keyPath: '/etc/ssl/api.key' },
      '_.example.com': { certPath: '/etc/ssl/wild.crt', keyPath: '/etc/ssl/wild.key' },
    },
  },
})
```

When no usable production certs are found, rpx falls back to its local-CA /
dev self-signed flow, so development is unchanged.

### On-demand TLS (lazy Let's Encrypt for unknown hosts)

rpx can issue a real Let's Encrypt certificate for an **unknown host the first
time it's needed** — handy for wildcard/tunnel setups where you don't know every
subdomain ahead of time. Issuance is **gated** by an `ask` callback and/or an
`allowedSuffixes` allowlist so it can't be abused into minting certs for
arbitrary hostnames.

```ts
import { runDaemon } from '@stacksjs/rpx'

const daemon = await runDaemon({
  // Seed the SNI set from any certs already on disk.
  productionCerts: { certsDir: '/etc/letsencrypt/rpx' },
  onDemandTls: {
    enabled: true,
    email: 'admin@example.com',
    // Fast-path allowlist: any host under these suffixes is auto-issued.
    allowedSuffixes: ['apps.example.com'],
    // And/or decide dynamically (e.g. check a DB of registered tenants).
    ask: async host => isRegisteredTenant(host),
    // Where issued PEMs are written (<host>.crt / <host>.key). Defaults to the
    // productionCerts certsDir so issued certs survive restarts.
    certsDir: '/etc/letsencrypt/rpx',
    // staging: true,  // use Let's Encrypt staging while testing
  },
})

// Pre-warm a cert programmatically (e.g. a tunnel server registering a new
// subdomain) so the cert exists before the first browser hit:
await daemon.ensureCert('alice.apps.example.com')
```

A host is approved for issuance when **either**`allowedSuffixes` matches**or**
`ask(host)` resolves truthy. With neither configured, on-demand issuance refuses
every host (fail-closed). Concurrent requests for the same host are de-duped so
exactly one ACME order runs; failures are negatively cached briefly so rpx
doesn't hammer Let's Encrypt's rate limits.

#### How it works (and the Bun limitation it works around)

The challenge is served over HTTP-01: when the ACME CA fetches
`http://<host>/.well-known/acme-challenge/<token>`, rpx answers it from its own
`:80` listener (same process, so the token is reachable the instant issuance
registers it).

> **Important:** Bun cannot mint a certificate _during_ the TLS handshake.
> `Bun.serve` has no working `SNICallback`, and `server.reload({ tls })` does
> **not** update certificates at runtime (verified on Bun 1.3.14 and 1.4.0). So
> rpx implements on-demand TLS as **ask-gated issuance + listener recreate**,
> not at-handshake issuance:
>
> 1. The first plaintext request for an approved-but-uncovered host on `:80`
> triggers `ensureCert(host)` (fire-and-forget) before the HTTP→HTTPS
> redirect.
> 2. Once the cert is obtained and written, rpx rebuilds the `:443` listener
> with the augmented SNI set — a sub-second `server.stop()` + re-`Bun.serve()`
> (the rebind is retried briefly while the OS frees the port; in-flight
> requests on the old listener drain first).
> 3. The browser's subsequent HTTPS request finds the freshly-issued cert.
>
> For a host you know about ahead of time, call `daemon.ensureCert(host)` to
> pre-warm the cert so even the very first HTTPS request is already covered.

On-demand TLS is fully opt-in (`onDemandTls.enabled`); existing deployments are
unaffected.

### On-demand sites (lazy dev servers, Valet-style)

Stop running dev servers by hand. rpx can boot a project's dev server the **first
time you open its URL** — visit `myapp.localhost` and rpx finds `~/Code/myapp`,
runs its dev command (frontend + API + docs), shows a "starting…" page that
reloads itself, and switches to the live app the moment it's ready. After the
site goes idle it's stopped again, so a machine can "have" dozens of sites but
only run the ones you're using.

```sh
# Start the daemon once in on-demand mode (reads `onDemand` from rpx.config.ts)
# then just open https://<project>.localhost in the browser
rpx daemon:start --on-demand

# See everything rpx can boot (and what's currently live)
rpx sites
```

A host resolves to a project two ways: an explicit `onDemand.sites` entry (exact
host, then `_.suffix` wildcard), or by convention — `<name>.<tld>` →
`<root>/<name>` for each root (default `~/Code`) and dev TLD (`localhost`,
`test`). A Stacks app (a `./buddy` launcher or `@stacksjs/_` dependency) boots
frontend/`/api`/`/docs`; any project with a `dev` script boots `bun run dev`.

```ts
// rpx.config.ts
import type { OnDemandSitesConfig } from '@stacksjs/rpx'

const onDemand: OnDemandSitesConfig = {
  enabled: true,
  roots: ['~/Code', '~/work'],     // where to look for <name>.localhost projects
  idleTimeoutMs: 30 _ 60_000,      // stop a site after 30 min idle
  sites: [
    // Explicit site for a project outside the roots / with a custom command.
    { to: 'api.localhost', dir: '~/services/api', command: 'bun run start', routes: [{ path: '/', portEnv: 'PORT', defaultPort: 4000 }] },
  ],
}

export default { onDemand }
```

rpx picks a free port per backend, injects it into the command's env
(`PORT`/`PORT_API`/`PORT_DOCS`), waits for the ready-gate ports to answer, then
publishes the routes. Failed boots render a `502` with the site's log tail; a
browser refresh retries. A booting host is added to the dev cert's SAN before
its splash is served, so it's trusted HTTPS from the first hit. On-demand sites
are opt-in for raw rpx (`--on-demand`) and run on the single-process daemon only
(ignored with `--workers > 1`) — but **on by default in Stacks projects**.

Define a project's startup by hand with a `rpx.site.json` (or a `"rpx"` key in
its `package.json`) — `command`, `env`, and `routes` — which wins over
auto-detection. See [the on-demand sites guide](./docs/features/on-demand-sites.md)
for the full reference.

### Running on a real server (hosts management off + systemd)

On a real server with real DNS, rpx should never touch `/etc/hosts` or set up
local DNS resolvers. Disable all hosts management with `hostsManagement: false`
(or the legacy `cleanup: { hosts: false }`):

```ts
const config: ProxyOptions = {
  proxies: [/_ ... _/],
  https: true,
  hostsManagement: false, // no /etc/hosts reads/writes, no dev DNS
}
```

Under systemd, run the daemon directly as root — when the process is already
root it binds `:443`/`:80` without re-executing through `sudo`:

```ini
# /etc/systemd/system/rpx.service
[Service]
ExecStart=/usr/local/bin/rpx daemon:start --certs-dir /etc/letsencrypt/rpx
User=root
Restart=always
```

## Benchmarks

rpx ships a reproducible benchmark suite that pits its real request-handling hot
path against **caddy**and**nginx**, a raw `Bun.serve` proxy (the floor for the
fetch-based approach), and a direct-to-origin baseline. Latency is measured with
[mitata](https://github.com/evanwashere/mitata); throughput with
[`oha`](https://github.com/hatoo/oha) under real concurrency.

```bash
# from packages/rpx
bun run bench                 # full suite (latency + throughput)
bun run bench:latency         # latency only
bun run bench:throughput      # throughput only
bun run bench -n 100000 -c 100 --large   # tune load / forward 100 KB bodies

brew install caddy nginx oha  # caddy & nginx are auto-skipped if absent
```

Representative single-machine run (Apple Silicon, plain HTTP, 50 concurrent,
keepalive — your numbers will vary, read each proxy _relative to_ `direct` and
`bun-raw` in the same run):

Tiny-payload run (routing-bound — measures per-request overhead):

| Target   | Throughput     | Latency (avg) |
|----------|---------------:|--------------:|
| direct   | ~171,000 req/s | ~24 µs        |
| nginx    | ~96,000 req/s  | ~49 µs        |
| bun-raw  | ~84,000 req/s  | ~54 µs        |
| **rpx**|**~80,000 req/s**|**~59 µs** |
| caddy    | ~59,000 req/s  | ~72 µs        |

At low concurrency rpx beats caddy and does real host routing + `X-Forwarded-*`
on top; nginx (C) and a bare `Bun.serve` + `fetch` proxy lead raw throughput.

HTML run (`bun run bench:html`, a ~16 KB page — the core real-world workload,
body-bound):

| Target   | Throughput    |
|----------|--------------:|
| direct   | ~98,000 req/s |
| nginx    | ~77,000 req/s |
| caddy    | ~38,000 req/s |
| bun-raw  | ~27,000 req/s |
| **rpx**|**~25,000 req/s**|

On body-heavy responses the picture changes: nginx splices kernel→kernel
(zero-copy), while Bun copies bodies through userspace — so **even a bare
`Bun.serve` + `fetch` proxy (`bun-raw`) is ~3× behind nginx**. That gap is a Bun
platform ceiling, not rpx-specific; rpx tracks right under it (~0.9× of bare
fetch). See [`bench/FINDINGS.md`](./packages/rpx/bench/FINDINGS.md).

### Forwarding transport: a bounded keepalive pool

rpx forwards upstream over a **pooled raw-socket HTTP/1.1 client**
([`src/proxy-pool.ts`](./packages/rpx/src/proxy-pool.ts)) rather than `fetch()`.
Bun's `fetch()` churns upstream connections under load: even with a concurrency
cap it opens and closes connections faster than the OS recycles ephemeral ports,
they pile into `TIME_WAIT`, and throughput collapses ~15× (measured: ~11k
`TIME_WAIT`, 45% errors at 400 concurrent). The pool caps the **total** open
connections per host (`RPX_MAX_UPSTREAM_CONNS`, default 256) and **queues** excess
requests, reusing a fixed set of keepalive sockets indefinitely — so there is no
churn. The payoff is staying flat under load where a `fetch` proxy falls over:

| Concurrency | `fetch`-based     | **rpx** (pool)   |
|-------------|------------------:|-----------------:|
| 50          | ~85,000 req/s     | ~80,000 req/s    |
| 400         | ~4,800 req/s 💥 (45% errors) | ~34,000 req/s ✅ (0 errors) |

(At 400 concurrent the pool held **10** `TIME_WAIT` sockets vs fetch's ~11,000.)
The pool declines what it can't cleanly handle — streaming/large uploads,
`Expect:`, protocol upgrades — falling back to `fetch()` transparently. Optional
`RPX_UPSTREAM_TIMEOUT=<seconds>` (default off) bounds a stalled upstream → `504`,
resetting on every byte so it never severs a live stream (SSE/HMR/long-poll).

See [`bench/README.md`](./packages/rpx/bench/README.md) and
[`bench/FINDINGS.md`](./packages/rpx/bench/FINDINGS.md) for methodology, the
apples-to-apples `--cores N` mode, and the full investigation.

### Scaling across cores (opt-in)

A single rpx instance already serves ~80k small req/s on one core — far beyond
any local workload — so single-process is the default. For production load on
**Linux**, the daemon can run as a**multi-core cluster**:

```bash
rpx daemon:start --workers 4     # or RPX_WORKERS=4
```

A **coordinator** process owns the singletons — the lock, certs, on-demand ACME
issuance, DNS, `/etc/hosts`, and the `:80` listener — and spawns N **worker**
processes that bind `:443` with `reusePort` and serve traffic. The kernel
load-balances accepted connections across the workers; when the coordinator
issues a new on-demand cert it republishes the SNI set and `SIGHUP`s the workers
to reload. Crashed workers are respawned; `SIGTERM` drains them all.

> On **macOS**, `SO_REUSEPORT` doesn't load-balance across processes, so the
> cluster falls back to effectively one active worker (correct, just not
> parallel) — clustering is a Linux production feature.

For a hand-rolled setup (or non-daemon `rpx start`), `RPX_REUSE_PORT=1` lets you
run several independent instances behind your own supervisor (systemd / pm2 / a
container replica set) sharing `:443`. It's **off by default** so a stray second
instance still fails loudly with "port in use" rather than silently co-binding.

## Testing

```bash
bun test
```

## Troubleshooting

### SSL Certificate Issues

If you're experiencing SSL certificate issues when using RPX (like "Your connection is not private" browser warnings):

1. **Automatic Certificate Trust**:

  RPX automatically attempts to trust certificates during setup with a single password prompt. This works for most users.

2. **Use the certificate fix utility**:

  If you still see certificate warnings, run our automated certificate fixer:

  ```bash
  bun scripts/fix-certs.js
  ```

  This script will:

  - Detect your operating system
  - Find all RPX certificates
  - Install them to the appropriate system trust stores
  - Provide browser-specific instructions

3. **Browser Workaround**:
  - **Chrome/Edge/Arc**: Type `thisisunsafe` on the warning page (you won't see what you're typing)
  - **Firefox**: Click "Advanced" then "Accept the Risk and Continue"
  - **Safari**: Click "Show Details", then "visit this website"

> **Note**: After trusting certificates, restart your browser for changes to take effect.

## Changelog

Please see our [releases](https://github.com/stacksjs/stacks/releases) page for more information on what has changed recently.

## Contributing

Please review the [Contributing Guide](https://github.com/stacksjs/contributing) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/stacks/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

"Software that is free, but hopes for a postcard." We love receiving postcards from around the world showing where `rpx` is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## Credits

- [Chris Breuer](https://github.com/chrisbbreuer)
- [All Contributors](../../contributors)

## License

The MIT License (MIT). Please see [LICENSE](https://github.com/stacksjs/stacks/tree/main/LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/@stacksjs/rpx?style=flat-square
[npm-version-href]: https://npmjs.com/package/@stacksjs/rpx
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/stacksjs/rpx/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/stacksjs/rpx/actions?query=workflow%3Aci

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/rpx/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/rpx -->
