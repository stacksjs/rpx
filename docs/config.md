# Configuration

The Reverse Proxy can be configured using a `rpx.config.ts` _(or `rpx.config.js`)_ file and it will be automatically loaded when running the `reverse-proxy` command.

## Library/CLI Configuration

```ts
// rpx.config.{ts,js}
import type { ReverseProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ReverseProxyOptions = {
  /**

   _ The from URL to proxy from.
   _ Default: localhost:5173

   */
  from: 'localhost:5173',

  /**

   _ The to URL to proxy to.
   _ Default: stacks.localhost

   */
  to: 'stacks.localhost',

  /**

   _ The HTTPS settings.
   _ Default: true
   _ If set to false, the proxy will use HTTP.
   _ If set to true, the proxy will use HTTPS.
   _ If set to an object, the proxy will use HTTPS with the provided settings.

   _/
  https: {
    domain: 'stacks.localhost',
    hostCertCN: 'stacks.localhost',
    caCertPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.ca.crt`),
    certPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt`),
    keyPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt.key`),
    altNameIPs: ['127.0.0.1'],
    altNameURIs: ['localhost'],
    organizationName: 'stacksjs.org',
    countryName: 'US',
    stateName: 'California',
    localityName: 'Playa Vista',
    commonName: 'stacks.localhost',
    validityDays: 180,
    verbose: false,
  },

  /**

   _ The verbose setting.
   _ Default: false
   _ If set to true, the proxy will log more information.

   _/
  verbose: false,

  /**

   _ Rewrite the `Origin` request header to the upstream target.
   _ Default: false
   _ When true, rpx forwards `Origin: http://<from>` to your dev server
   _ instead of the browser's original origin — mirroring the
   _ `changeOrigin` option from `http-proxy`. Useful when the upstream
   _ performs CORS or same-origin checks against the `Origin` header.
   _ Note: rpx always rewrites the `Host` header to the upstream target;
   _ `changeOrigin` additionally rewrites `Origin`.

   _/
  changeOrigin: false,
}

export default config
```

Then run:

```bash
./rpx start
```

### `changeOrigin`

By default rpx leaves the browser's `Origin` header intact when forwarding to your
upstream. Some dev servers (or CORS-sensitive backends) reject requests whose
`Origin` does not match the host they are listening on. Set `changeOrigin: true`
to forward `Origin: http://<from>` to the upstream instead — the same behavior as
[`http-proxy`](https://github.com/http-party/node-http-proxy)'s `changeOrigin`.

```ts
const config: ReverseProxyOptions = {
  from: 'localhost:5173',
  to: 'my-app.localhost',
  changeOrigin: true,
}
```

From the CLI:

```bash
rpx start --from localhost:5173 --to my-app.localhost --change-origin
```

In a multi-proxy config, `changeOrigin` can be set once as a shared default and
overridden per proxy:

```ts
const config: MultiProxyConfig = {
  changeOrigin: true, // shared default
  proxies: [
    { from: 'localhost:3000', to: 'api.localhost' }, // inherits changeOrigin: true
    { from: 'localhost:3001', to: 'web.localhost', changeOrigin: false }, // override
  ],
}
```

### `singlePortMode`

By default rpx binds one listener per proxy (`:443`, then `:8443`, `:8444`, …
when the port is taken). Set `singlePortMode: true` to route every proxy through
a **single shared listener** instead — requests are dispatched to the right
upstream by their `Host` header (and path). The listening port is configurable
via `httpPort` (default `80`) and `httpsPort` (default `443`).

```ts
const config: MultiProxyConfig = {
  https: false,
  singlePortMode: true,
  httpPort: 8080, // shared HTTP listener + redirect port
  httpsPort: 8443, // shared HTTPS listener port
  proxies: [
    { from: 'localhost:3000', to: 'foo.myservice.local' },
    { from: 'localhost:3001', to: 'bar.myservice.local' },
    { from: 'localhost:3002', to: '*.myservice.local' },
  ],
}
```

From the CLI:

```bash
rpx start --single-port-mode --https-port 8443
```

> Note: when HTTPS is enabled and more than one proxy is configured, rpx already
> shares a single `:443` listener automatically. `singlePortMode` extends that to
> the HTTP-only and single-proxy cases and makes the port configurable. See
> [Multiple Proxies](/features/multiple-proxies#single-port-mode) for more.

### `https: false`

`https: false` is a first-class shared-mode setting, not just "skip the dev
cert". With several proxies (or `singlePortMode`), rpx binds ONE plain-HTTP
listener on `httpPort` (default `80`), binds nothing on `httpsPort`, starts no
HTTP to HTTPS redirect, and does no certificate work at all, even when
`productionCerts` or `localCa` are also configured. The daemon honours the same
(`rpx daemon:start` with `https: false` serves its routes on the HTTP port; it
is not available with `--workers > 1`).

```ts
const config: MultiProxyConfig = {
  https: false,
  httpPort: 8080,
  proxies: [
    { from: 'localhost:3000', to: 'one.internal' },
    { from: 'localhost:3001', to: 'two.internal' },
  ],
}
```

### `localCa`

LAN production mode: HTTPS for names a public certificate authority can never
issue for.

A public authority proves control of a name by reaching it. An ACME http-01
challenge is fetched over the internet, and a dns-01 challenge is read from
public DNS. Neither reaches `pi-stacks.local` or `192.168.1.20`, because
nothing on the internet routes to a private network. No public authority can
issue for these names at all. The only way to serve them over HTTPS is to run
an authority the clients on that network trust.

That is what `localCa` does. On start rpx loads or creates a Root CA under
`dir`, mints a single leaf whose SANs name every `hosts` entry (as a dNSName) and
every `ips` entry (as an iPAddress), registers that leaf under each host's SNI
name, and installs it as the listener's default TLS context as well. The
default context is what makes an IP address work: a browser asked for
`<https://192.168.1.20/>` sends no SNI at all, so without a default the listener
answers with whatever certificate happens to be first.

Public domains on the same gateway keep their on-demand ACME certificates. A
host may not appear in both `localCa.hosts` and `onDemandTls.allowedSuffixes`,
and rpx refuses that configuration on start rather than letting the two flows
fight over one SNI name. `hosts` takes hostnames only: wildcards are rejected,
and IP addresses belong in `ips`.

```ts
const config: MultiProxyConfig = {
  https: true,
  hostsManagement: false,
  localCa: {
    dir: '/etc/rpx/local-ca', // rpx-root-ca.crt/.key (0600), rpx-local-host.crt/.key
    hosts: ['pi-stacks.local'],
    ips: ['192.168.1.20'],
    installTrust: true, // tlsx installCA on start, skipped once trusted (needs root)
    validityDays: 825, // default
    renewBeforeDays: 30, // default
  },
  onDemandTls: { enabled: true, allowedSuffixes: ['example.com'] },
  proxies: [
    { from: 'localhost:3000', to: 'pi-stacks.local' },
    { from: 'localhost:3000', to: 'app.example.com' },
  ],
}
```

Four files live under `dir`:

| File | What it is |
| --- | --- |
| `rpx-root-ca.crt` | The Root CA certificate. This is the file every client has to trust. |
| `rpx-root-ca.key` | The CA private key, written with mode `0600`. It never leaves the box. |
| `rpx-local-host.crt` | The leaf covering `hosts` and `ips`. |
| `rpx-local-host.key` | The leaf private key, written with mode `0600`. |

The leaf on disk is re-checked on every start and re-minted when any of these
is true: a host or IP in the config is missing from its SANs, the key does not
match the certificate, it was signed by a different CA (a rotated CA orphans
its leaves), it is not valid yet, or fewer than `renewBeforeDays` remain. A
restart with an unchanged config touches nothing.

`installTrust: true` runs the tlsx `installCA` step on the box itself, and is
skipped when the CA is already trusted. It needs root or `sudo`. A trust store
that cannot be written is a warning, never a failure to start: rpx serves
either way and tells you to trust `rpx-root-ca.crt` by hand.

Other devices on the network trust the same file. rpx produces the CA;
[tlsx](https://github.com/stacksjs/tlsx) is what mints and trusts it, and
`tlsx export-ca` writes it in the form a laptop, phone or Windows machine
wants.

### `maxTlsContexts`

Memory guard for shared listeners (default `256`). Every SNI entry keeps a
parsed certificate and key alive in OpenSSL for the life of the listener, so a
certs directory full of retired-site PEMs costs real memory on a 4 GB box.
When the assembled SNI set exceeds the limit, rpx keeps the first N entries
(a `localCa` leaf always comes first) and logs one warning naming every host
it dropped. On a small board pair it with `RPX_WORKERS=1` and
`RPX_REUSE_PORT=0`, which keep the gateway to one process and stop a second
instance co-binding the port. See the
[low-memory setting](/advanced/configuration#low-memory-setting).

## Gateway mode

`rpx gateway` is the production entry point. It reads every per-app fragment
under a `sites.d` directory (one `<slug>.json` per deploy, the shape ts-cloud
writes), merges them into a single proxy configuration, and serves the result
on `:80` and `:443`.

```bash
rpx gateway --sites-dir /etc/rpx/sites.d
rpx gateway --sites-dir /etc/rpx/sites.d --no-https --http-port 8080
rpx gateway --local-ca-dir /etc/rpx/local-ca --local-ca-hosts pi-stacks.local --local-ca-ips 192.168.1.20 --install-trust
```

### Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--sites-dir <path>` | `/etc/rpx/sites.d` | Directory of per-app `<slug>.json` fragments. |
| `--certs-dir <path>` | `/etc/rpx/certs` | Fallback directory of real PEM certificates, used when no fragment names one. |
| `--no-https` | HTTPS on | Serve plain HTTP on the HTTP port only, and bind nothing on the HTTPS port. |
| `--http-port <port>` | `80` | Shared HTTP port: the redirect and ACME http-01 listener, or the only listener under `--no-https`. |
| `--https-port <port>` | `443` | Shared HTTPS port. |
| `--local-ca-dir <path>` | off | Turns on LAN production mode, and holds the Root CA and its leaf. See [`localCa`](#localca). |
| `--local-ca-hosts <hosts>` | none | Comma-separated LAN hostnames the leaf must cover, for example `pi-stacks.local`. |
| `--local-ca-ips <ips>` | none | Comma-separated IP addresses the leaf must cover, for example `192.168.1.20`. |
| `--install-trust` | off | Install the local Root CA into this box's system trust store on start. Needs root. |
| `--max-tls-contexts <n>` | `256` | Memory guard: the most SNI certificates the listener keeps live. |
| `--verbose` | on | Verbose logging. `RPX_VERBOSE=false` turns it off. |

The three local-CA flags each require `--local-ca-dir`, and `--local-ca-dir`
requires at least one `--local-ca-hosts` entry. Break either rule and the
command prints `Failed to start rpx gateway: <reason>` and exits with status 1.

### What it prints on startup

Everything below goes to stderr, so `journalctl -u <unit>` captures it. The
gateway always prints one line naming the route count, the directory they came
from, the port it bound and the TLS mode:

```
[rpx gateway] 7 route(s) from /etc/rpx/sites.d; listening on :443 (https)
```

That line is the difference between a gateway that came up with no routes and
one that never came up at all, which look identical from the outside. Three
other lines matter:

| Line | Means |
| --- | --- |
| `[rpx gateway] no routes found under <dir>; every request will answer 404 until a fragment is deployed` | The directory is empty or missing. Not printed when a local CA is configured, since serving that host is reason enough to run. |
| `[rpx gateway] SKIPPING malformed fragment <file>; its host(s) will 404 until fixed: <error>` | One fragment failed to read or parse. Every other fragment still loads. |
| `[rpx gateway] failed to start: <error>` | The listeners never bound. The error carries the stack. |

### Merge rules

These are the semantics of ts-cloud's generated assembler, which this command
replaces. Fragments are read in filename order. A malformed fragment is
reported and skipped, never dropped in silence. Routes are concatenated and
deduped by `id` (falling back to `to` plus `path`), the first writer wins, and
the duplicate is logged with its first owner. `onDemandTls.allowedSuffixes` are
unioned, the first non-empty `email` wins, and the ACME directory is production
if any fragment wants production. The last fragment naming
`productionCerts.certsDir` wins, and `certsDirServerNames` is derived from the
merged routes' hosts. The first `acmeChallengeWebroot` wins. The first
origin-guard header and secret win, and hosts are unioned only from fragments
that agree on both, so a tenant whose secret disagrees stays unguarded rather
than rejecting all of its own traffic.

### From code

The same entry point is a function, and takes the flags above as options:

```ts
import { startGateway } from '@stacksjs/rpx'

await startGateway({
  sitesDir: '/etc/rpx/sites.d',
  localCa: { dir: '/etc/rpx/local-ca', hosts: ['pi-stacks.local'], ips: ['192.168.1.20'] },
})
```

`resolveGatewayOptions(options)` returns the merged `startProxies` options
without starting anything, which is the way to see what a `sites.d` directory
actually assembles into.

### Known limitation on Linux

The `rpx` CLI entry point currently hangs at startup on Linux. It produces no
output and never exits, before it reaches any command, so `rpx gateway` cannot
be used there yet. This is tracked as
[stacksjs/rpx#2267](https://github.com/stacksjs/rpx/issues/2267).

The gateway itself is not implicated. The same fragments, host routing and
HTTP-only serving pass in process on both x64 and arm64. Until the entry point
is fixed, run a gateway on Linux from a launcher that calls `startGateway`, as
above, optionally compiled with `bun build --production --compile`. The
standalone binaries attached to a release are built from the same CLI entry
point, so confirm `rpx gateway --help` answers before depending on one.

For a walkthrough of a gateway serving a home network, see
[LAN gateway](/advanced/lan-gateway).

## Bun Plugin Configuration

When using the Bun plugin, you can configure it with these options:

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      /**

       _ The domain to use instead of localhost:port
       _ @example 'my-app.test', 'awesome.localhost'
       _ @default '$projectName.localhost'

       _/
      domain: 'my-app.test',

      /**

       _ Allow HTTPS
       _ @default true

       */
      https: true,

      /**

       _ Enable debug logging
       _ @default false

       */
      verbose: false
    })
  ]
}
```

The plugin will automatically:

1. Read your project's name from package.json if no domain is provided
2. Intercept the Bun server to detect the port
3. Run rpx with the appropriate parameters
4. Clean up when the server is stopped

Within the next section of the documentation, the Showcase section, you will find a list of examples of how to use the Reverse Proxy in different scenarios.
