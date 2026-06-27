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
