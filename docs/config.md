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

LAN production mode. A Raspberry Pi serving `pi-stacks.local` and a private IP
cannot get a public certificate, so rpx runs its own Root CA under `dir`, mints
one leaf whose SANs name every `hosts` entry (dNSName) and every `ips` entry
(iPAddress), and serves it under each host's SNI name AND as the listener's
default TLS context, so `<https://192.168.1.20/>` (no SNI at all) gets it too.
The leaf is re-minted when a host or IP is added, or when fewer than
`renewBeforeDays` remain. Public domains on the same gateway keep their
on-demand ACME certificates; a host may not appear in both `localCa.hosts` and
`onDemandTls.allowedSuffixes` (rpx refuses the config).

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

Clients trust `dir/rpx-root-ca.crt` once (on the Pi itself `installTrust`
does it; copy the file to laptops and phones on the LAN).

### `maxTlsContexts`

Memory guard for shared listeners (default `256`). Every SNI entry keeps a
parsed certificate and key alive in OpenSSL for the life of the listener, so a
certs directory full of retired-site PEMs costs real memory on a 4 GB box.
When the assembled SNI set exceeds the limit, rpx keeps the first N entries
(a `localCa` leaf always comes first) and logs one warning naming every host
it dropped. See the [low-memory setting](/advanced/configuration#low-memory-setting)
for the process-level knobs that go with it.

## Gateway mode

`rpx gateway` is the production entry a box runs from the prebuilt binary (the
linux-x64 and linux-arm64 zips on every release). It merges every per-app
fragment under a `sites.d` directory (one `<slug>.json` per deploy, the shape
ts-cloud writes) and serves them on `:80` / `:443`:

```bash
rpx gateway --sites-dir /etc/rpx/sites.d
rpx gateway --sites-dir /etc/rpx/sites.d --no-https --http-port 8080
rpx gateway --local-ca-dir /etc/rpx/local-ca --local-ca-hosts pi-stacks.local --local-ca-ips 192.168.1.20 --install-trust
```

Merge rules (identical to ts-cloud's generated assembler): fragments are read
in filename order; a malformed fragment is logged and skipped, never dropped
silently; routes are deduped by `id` (first writer wins); on-demand suffixes
are unioned and production wins over staging; the last `productionCerts.certsDir`
wins and `certsDirServerNames` is derived from the routed hosts; the first
`acmeChallengeWebroot` and the first origin-guard secret win. The same entry is
available from code as `startGateway({ sitesDir, certsDir, https, localCa })`.

Then run:

```bash
./rpx start
```

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
