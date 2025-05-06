# Multiple Proxies

rpx supports running multiple proxies simultaneously, allowing you to work with several local development servers at once, each with its own custom domain.

## Use Cases

- **Microservices Development**: Run multiple services with different domains
- **Full-Stack Development**: Frontend and backend on different ports with different domains
- **Multi-Project Workflow**: Work on multiple projects simultaneously
- **Component Development**: Test your components in different environments

## Configuration

You can set up multiple proxies in your configuration file:

```ts
// rpx.config.ts
import type { ReverseProxyOptions } from '@stacksjs/rpx'

const config: ReverseProxyOptions = {
  // Shared HTTPS settings for all proxies
  https: true,

  // Cleanup settings applied to all proxies
  cleanup: {
    hosts: true,
    certs: false,
  },

  // Define multiple proxies
  proxies: [
    {
      from: 'localhost:5173', // Frontend
      to: 'app.myproject.test',
      cleanUrls: true,
    },
    {
      from: 'localhost:3000', // Backend API
      to: 'api.myproject.test',
    },
    {
      from: 'localhost:8080', // Admin panel
      to: 'admin.myproject.test',
    },
  ],

  verbose: false,
}

export default config
```

## Launching Multiple Proxies

When you run rpx with a configuration that includes multiple proxies, it will:

1. Start all proxies defined in the configuration
2. Configure hosts file entries for each domain
3. Generate and install SSL certificates if HTTPS is enabled
4. Configure HTTP-to-HTTPS redirection if needed

To start multiple proxies:

```bash
# Using the CLI with config file
rpx start

# Or programmatically
import { startProxies } from '@stacksjs/rpx'
import config from './rpx.config'

startProxies(config)
```

## Wildcard Domains

You can use wildcard domains to handle multiple subdomains with a single configuration:

```ts
const config: ReverseProxyOptions = {
  // ...
  proxies: [
    {
      from: 'localhost:5173',
      to: '*.myproject.test', // Wildcard domain
      // This will handle any subdomain of myproject.test
    },
  ],
}
```

## Different SSL Configurations

You can also specify different SSL configurations for each proxy:

```ts
const config: ReverseProxyOptions = {
  // Default HTTPS settings
  https: true,

  proxies: [
    {
      from: 'localhost:5173',
      to: 'app.myproject.test',
      // Uses the default HTTPS settings
    },
    {
      from: 'localhost:3000',
      to: 'api.myproject.test',
      https: {
        // Custom HTTPS settings for this proxy only
        commonName: 'api.myproject.test',
        validityDays: 90,
        // Other SSL options...
      },
    },
  ],
}
```

## CLI Usage

While the configuration file approach is recommended for multiple proxies, you can also start multiple instances of rpx using different terminal sessions:

```bash
# Terminal 1
rpx --from localhost:5173 --to app.myproject.test

# Terminal 2
rpx --from localhost:3000 --to api.myproject.test

# Terminal 3
rpx --from localhost:8080 --to admin.myproject.test
```
