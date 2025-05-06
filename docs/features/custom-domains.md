# Custom Domains

One of the most powerful features of rpx is the ability to use custom domains for your local development environment. Instead of accessing your applications through `localhost:3000` or similar URLs, you can use domains like `my-app.test` or `api.local`.

## Benefits

- **Better Multi-Project Workflow**: Work with multiple projects simultaneously, each with its own domain
- **Cookie Isolation**: Test cookie-based authentication properly with real domain boundaries
- **Realistic Environment**: Create a development environment that more closely matches production
- **Subdomain Testing**: Test multi-subdomain applications like `api.myapp.test` and `admin.myapp.test`

## Domain Formats

You can use various domain formats:

- **Simple domain**: `myapp.test`
- **Subdomain format**: `api.myapp.local`
- **.localhost domains**: `myapp.localhost` (automatically resolves in modern browsers)
- **Wildcard domains**: Support for `*.myapp.test` to handle any subdomain

## Common TLDs for Local Development

While you can use any domain format, these top-level domains are commonly used for local development:

- `.localhost`: Built-in browser support, no DNS resolution needed
- `.test`: Reserved for testing purposes
- `.local`: Often used for local network services (Note: may conflict with mDNS on some systems)
- `.example`: Reserved domain that will never be registered
- `.internal`: Commonly used for internal services

## Configuration

You can set up custom domains in several ways:

### CLI

```bash
rpx --from localhost:3000 --to myapp.test
```

### Library

```ts
import { startProxy } from '@stacksjs/rpx'

startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: true
})
```

### Bun Plugin

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test'
    })
  ]
}
```

## Multiple Domains

rpx supports configuring multiple domains simultaneously. See the [Multiple Proxies](/features/multiple-proxies) documentation for details.

## Hosts File Management

rpx automatically manages your system's hosts file, adding the necessary entries to resolve your custom domains to 127.0.0.1 and removing them on shutdown.

For more details on how this works, see the [Hosts Management](/features/hosts-management) documentation.
