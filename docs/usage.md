# Get Started

There are three ways of using this reverse proxy: _as a library, as a CLI, or as a Bun plugin_.

## Library

Given the npm package is installed:

```ts
import type { TlsConfig } from '@stacksjs/rpx'
import { startProxy } from '@stacksjs/rpx'

export interface CleanupConfig {
  hosts: boolean // clean up /etc/hosts, defaults to false
  certs: boolean // clean up certificates, defaults to false
}

export interface ReverseProxyConfig {
  from: string // domain to proxy from, defaults to localhost:3000
  to: string // domain to proxy to, defaults to stacks.localhost
  cleanUrls?: boolean // removes the .html extension from URLs, defaults to false
  https: boolean | TlsConfig // automatically uses https, defaults to true, also redirects http to https
  cleanup?: boolean | CleanupConfig // automatically cleans up /etc/hosts, defaults to false
  verbose: boolean // log verbose output, defaults to false
}

const config: ReverseProxyOptions = {
  from: 'localhost:3000',
  to: 'my-docs.localhost',
  cleanUrls: true,
  https: true,
  cleanup: false,
}

startProxy(config)
```

In case you are trying to start multiple proxies, you may use this configuration:

```ts
// rpx.config.{ts,js}
import type { ReverseProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ReverseProxyOptions = {
  https: { // https: true -> also works with sensible defaults
    caCertPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.ca.crt`),
    certPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt`),
    keyPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt.key`),
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

## CLI

```bash
rpx --from localhost:3000 --to my-project.localhost
rpx --from localhost:8080 --to my-project.test --keyPath ./key.pem --certPath ./cert.pem
rpx --help
rpx --version
```

## Bun Plugin

If you're using Bun for your project, you can use the `bun-plugin-rpx` for seamless integration:

```ts
// bunfig.toml or in your Bun server setup
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'my-awesome-app.test', // Optional custom domain
      https: true, // Optional, defaults to true
      verbose: false // Optional debug logging
    })
  ]
}
```

The plugin will automatically:
- Map your Bun dev server port to your custom domain
- Set up HTTPS if enabled
- Handle hosts file entries
- Clean up when the server stops

See the [Bun Plugin](/features/bun-plugin) documentation for more details.

## HMR

In order to use Hot Module Replacement (HMR) with Vite and `rpx`, you need to set these HMR options:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    hmr: {
      host: 'stacks.localhost',
      port: 443,
    },
  },
})
```

We are soon looking to improve `rpx` to seamlessly work with Vite and other tools. Stay tuned & follow along on [GitHub](https://github.com/stacksjs/rpx/issues/26).

Continue reading the documentation to learn more about the [configuration](./config.md) options.
