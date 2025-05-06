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
   * The from URL to proxy from.
   * Default: localhost:5173
   */
  from: 'localhost:5173',

  /**
   * The to URL to proxy to.
   * Default: stacks.localhost
   */
  to: 'stacks.localhost',

  /**
   * The HTTPS settings.
   * Default: true
   * If set to false, the proxy will use HTTP.
   * If set to true, the proxy will use HTTPS.
   * If set to an object, the proxy will use HTTPS with the provided settings.
   */
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
   * The verbose setting.
   * Default: false
   * If set to true, the proxy will log more information.
   */
  verbose: false,
}

export default config
```

_Then run:_

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
       * The domain to use instead of localhost:port
       * @example 'my-app.test', 'awesome.localhost'
       * @default '$projectName.localhost'
       */
      domain: 'my-app.test',

      /**
       * Allow HTTPS
       * @default true
       */
      https: true,

      /**
       * Enable debug logging
       * @default false
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
