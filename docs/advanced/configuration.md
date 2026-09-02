# Advanced Configuration

This guide covers advanced configuration options for rpx, including environment-specific settings, programmatic configuration, and optimization strategies.

## Configuration File Locations

rpx searches for configuration files in order:

1. `rpx.config.ts` (TypeScript)
2. `rpx.config.js` (JavaScript)
3. `rpx.config.mjs` (ES Module)
4. `rpx.config.cjs` (CommonJS)

## Complete Configuration Reference

```ts
// rpx.config.ts
import type { ProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ProxyOptions = {
  // Basic proxy settings
  from: 'localhost:3000',
  to: 'my-app.localhost',

  // HTTPS configuration
  https: {
    // Certificate identity
    domain: 'my-app.localhost',
    hostCertCN: 'my-app.localhost',
    commonName: 'my-app.localhost',

    // Certificate paths
    caCertPath: path.join(os.homedir(), '.stacks', 'ssl', 'ca.crt'),
    certPath: path.join(os.homedir(), '.stacks', 'ssl', 'cert.crt'),
    keyPath: path.join(os.homedir(), '.stacks', 'ssl', 'key.pem'),

    // Subject Alternative Names
    altNameIPs: ['127.0.0.1', '::1'],
    altNameURIs: ['localhost', 'my-app.local'],

    // Certificate metadata
    organizationName: 'My Organization',
    countryName: 'US',
    stateName: 'California',
    localityName: 'San Francisco',

    // Validity
    validityDays: 365,

    // Debugging
    verbose: false,
  },

  // URL handling
  cleanUrls: true,

  // Process management
  start: {
    command: 'bun run dev',
    cwd: process.cwd(),
    lazy: false,
    env: {
      NODE_ENV: 'development',
    },
  },

  // Cleanup behavior
  cleanup: {
    hosts: true,
    certs: false,
  },

  // Logging
  verbose: false,
}

export default config
```

## Environment-Specific Configuration

### Using Environment Variables

```ts
// rpx.config.ts
const isDev = process.env.NODE_ENV !== 'production'

export default {
  from: process.env.RPX_FROM || 'localhost:3000',
  to: process.env.RPX_TO || 'my-app.localhost',
  https: isDev,
  verbose: process.env.RPX_VERBOSE === 'true',
}
```

### Multiple Environments

```ts
// rpx.config.ts
const configs = {
  development: {
    from: 'localhost:3000',
    to: 'dev.my-app.localhost',
    https: true,
    verbose: true,
  },
  staging: {
    from: 'localhost:3000',
    to: 'staging.my-app.localhost',
    https: true,
    verbose: false,
  },
  test: {
    from: 'localhost:3000',
    to: 'test.my-app.localhost',
    https: false,
    verbose: false,
  },
}

const env = process.env.APP_ENV || 'development'
export default configs[env]
```

## Environment Variable Reference

Runtime switches rpx reads from the environment. None is required; every one
has a safe default.

| Variable | Default | What it does |
| --- | --- | --- |
| `RPX_WORKERS` | `1` | `rpx daemon:start` cluster size. Above `1` a coordinator spawns that many worker processes that share the HTTPS port (Linux; see [performance](/advanced/performance)). |
| `RPX_REUSE_PORT` | `0` | Set `1` to bind listeners with `SO_REUSEPORT` so several independent rpx instances can share one port behind your own supervisor. Off by default so a stray second instance fails loudly. |
| `RPX_BIND_HOSTNAME` | dual-stack (`::`, or `0.0.0.0` without IPv6) | Force the listener bind address. |
| `RPX_VERBOSE` | `true` for gateways | `RPX_VERBOSE=false` silences the gateway's TLS and routing diagnostics. |
| `RPX_UPSTREAM_TIMEOUT` | off | Seconds of upstream inactivity before a request answers `504`; resets on every byte. |
| `RPX_MAX_UPSTREAM_CONNS` | `256` | Cap on pooled keep-alive connections per upstream host. |
| `RPX_MAX_QUEUED` / `RPX_QUEUE_WAIT_MS` | pool defaults | Depth and wait bound of the per-upstream request queue. |
| `RPX_MAX_WS_PENDING_BYTES` | pool default | Backpressure limit for a proxied WebSocket. |
| `RPX_TLS_RELOAD_STRATEGY` | `restart` under systemd, else `rebind` | How a freshly issued on-demand certificate goes live. |
| `RPX_BYPASS_CONNECTION_TEST` | unset | `true` skips the upstream reachability probe on start. |
| `SUDO_PASSWORD` | unset | Makes trust-store and hosts-file steps non-interactive. |

### Low-memory setting

For a small box (a Raspberry Pi with 4 to 8 GB shared with the apps it fronts)
run rpx as a single process with a bounded certificate set:

```bash
RPX_WORKERS=1 RPX_REUSE_PORT=0 rpx gateway --sites-dir /etc/rpx/sites.d --max-tls-contexts 64
```

`RPX_WORKERS=1` keeps one process (no per-worker heap or duplicated TLS
contexts), `RPX_REUSE_PORT=0` keeps a second instance from co-binding the port,
and `maxTlsContexts` (config key, `--max-tls-contexts` on the CLI, default
`256`) caps how many SNI certificates OpenSSL keeps parsed in memory; the first
N are kept and a warning names the rest. Every TLS context rpx creates already
uses OpenSSL's low-memory mode, which releases per-connection buffers as soon
as they are idle.

On Linux the `rpx` CLI hangs at startup today
([stacksjs/rpx#2267](https://github.com/stacksjs/rpx/issues/2267)), so run a
gateway there from a launcher that calls `startGateway` and set the two
variables above in its service unit. [LAN gateway](/advanced/lan-gateway) walks
through a full box, certificate authority included.

## Programmatic Configuration

### Dynamic Configuration

```ts
import { startProxy, loadConfig } from '@stacksjs/rpx'

async function main() {
  // Load from file with overrides
  const config = await loadConfig({
    overrides: {
      verbose: true,
    },
  })

  // Start with dynamic modifications
  await startProxy({
    ...config,
    from: await detectPort(),
    start: {
      command: config.start?.command,
      env: {
        ...config.start?.env,
        TIMESTAMP: Date.now().toString(),
      },
    },
  })
}
```

### Factory Pattern

```ts
// proxy-factory.ts
import type { ProxyOptions } from '@stacksjs/rpx'
import { startProxy } from '@stacksjs/rpx'

export function createProxy(name: string, port: number): ProxyOptions {
  return {
    from: `localhost:${port}`,
    to: `${name}.localhost`,
    https: {
      domain: `${name}.localhost`,
      commonName: `${name}.localhost`,
    },
    start: {
      command: `bun run dev:${name}`,
      env: { PORT: port.toString() },
    },
  }
}

// Usage
await startProxy(createProxy('api', 3000))
await startProxy(createProxy('frontend', 5173))
```

## Multi-Project Configuration

### Workspace Configuration

```ts
// rpx.config.ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Auto-discover packages in monorepo
const packagesDir = join(process.cwd(), 'packages')
const packages = readdirSync(packagesDir)

const proxies = packages.map((pkg, index) => ({
  from: `localhost:${3000 + index}`,
  to: `${pkg}.localhost`,
  start: {
    command: 'bun run dev',
    cwd: join(packagesDir, pkg),
    env: { PORT: (3000 + index).toString() },
  },
}))

export default {
  https: true,
  cleanup: { hosts: true },
  proxies,
}
```

### Shared Configuration

```ts
// shared-config.ts
export const sharedHttps = {
  organizationName: 'My Company',
  countryName: 'US',
  stateName: 'California',
  validityDays: 365,
}

// rpx.config.ts
import { sharedHttps } from './shared-config'

export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',
  https: {
    ...sharedHttps,
    domain: 'my-app.localhost',
  },
}
```

## Performance Tuning

### Connection Settings

```ts
export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',

  // Connection tuning
  connection: {
    keepAlive: true,
    keepAliveTimeout: 30000,
    maxSockets: 100,
    timeout: 60000,
  },
}
```

### Buffer Settings

```ts
export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',

  // Buffer tuning for large requests
  buffer: {
    maxRequestSize: '50mb',
    streaming: true,
  },
}
```

## Logging Configuration

### Log Levels

```ts
export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',

  logging: {
    level: 'debug', // 'error' | 'warn' | 'info' | 'debug'
    timestamp: true,
    colorize: true,
    requests: true,
    responses: true,
    errors: true,
  },
}
```

### Custom Logger

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  logger: {
    info: (msg) => console.log(`[INFO] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    debug: (msg) => console.debug(`[DEBUG] ${msg}`),
  },
})
```

## Security Configuration

### TLS Settings

```ts
export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',

  https: {
    // TLS version
    minVersion: 'TLSv1.2',

    // Cipher suites (for advanced users)
    ciphers: [
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ].join(':'),
  },
}
```

### Host Restrictions

```ts
export default {
  from: 'localhost:3000',
  to: 'my-app.localhost',

  security: {
    // Only allow these hosts
    allowedHosts: ['localhost', '127.0.0.1'],

    // Block certain paths
    blockedPaths: ['/admin/_', '/.env'],
  },
}
```

## Hooks and Lifecycle

### Lifecycle Hooks

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  hooks: {
    onStart: async () => {
      console.log('Proxy starting...')
    },

    onReady: async (proxy) => {
      console.log(`Proxy ready at ${proxy.url}`)
    },

    onRequest: async (req) => {
      console.log(`Request: ${req.method} ${req.url}`)
    },

    onResponse: async (res) => {
      console.log(`Response: ${res.status}`)
    },

    onError: async (error) => {
      console.error('Proxy error:', error)
    },

    onStop: async () => {
      console.log('Proxy stopped')
    },
  },
})
```

## Validation

### Config Validation

```ts
import { validateConfig, startProxy } from '@stacksjs/rpx'

const config = {
  from: 'localhost:3000',
  to: 'my-app.localhost',
}

// Validate before starting
const errors = validateConfig(config)
if (errors.length > 0) {
  console.error('Invalid config:', errors)
  process.exit(1)
}

await startProxy(config)
```

## Troubleshooting

### Debug Mode

```bash
# Enable all debug output
DEBUG=rpx:_ rpx start

# Enable specific debug output
DEBUG=rpx:ssl,rpx:proxy rpx start
```

### Config Dump

```bash
# Print resolved configuration
rpx config --print

# Validate configuration
rpx config --validate
```

## Next Steps

- [Custom Middleware](/advanced/custom-middleware) - Add custom request handling
- [Performance](/advanced/performance) - Optimize proxy performance
- [CI/CD Integration](/advanced/ci-cd-integration) - Use in pipelines
