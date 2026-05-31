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

To learn more, head over to the [documentation](https://reverse-proxy.sh/).

## Production: multi-app gateway on one server

rpx can front many apps on a single server, routing by `Host`, terminating TLS
with real certificates, proxying WebSockets, and serving static sites — all from
one listener on `:443`.

### WebSocket proxying

WebSocket upgrades are proxied transparently for any upstream route. A request
with `Upgrade: websocket` is upgraded by rpx and piped to the upstream
(`ws://<from><path>`) in both directions — including the control-channel of a
tunnel server that accepts the upgrade on any path. No configuration needed;
it works wherever HTTP proxying works.

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

### Running on a real server (hosts management off + systemd)

On a real server with real DNS, rpx should never touch `/etc/hosts` or set up
local DNS resolvers. Disable all hosts management with `hostsManagement: false`
(or the legacy `cleanup: { hosts: false }`):

```ts
const config: ProxyOptions = {
  proxies: [/_ ... */],
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
