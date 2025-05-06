# API Reference

This page documents the available APIs, functions, and types in the rpx library.

## Core Functions

### `startProxy(options)`

Starts a single reverse proxy.

```ts
import { startProxy } from '@stacksjs/rpx'

startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: true
})
```

### `startProxies(options)`

Starts multiple reverse proxies.

```ts
import { startProxies } from '@stacksjs/rpx'

startProxies({
  https: true,
  proxies: [
    { from: 'localhost:3000', to: 'api.myapp.test' },
    { from: 'localhost:5173', to: 'app.myapp.test' }
  ]
})
```

### `cleanup(options)`

Cleans up resources like hosts file entries and certificates.

```ts
import { cleanup } from '@stacksjs/rpx'

// Clean up everything
cleanup({
  hosts: true,
  certs: true,
  domains: ['myapp.test', 'api.myapp.test'],
  verbose: true
})
```

## Utility Functions

### `addHosts(hosts, verbose?)`

Adds entries to the hosts file.

```ts
import { addHosts } from '@stacksjs/rpx'

// Add entries to the hosts file
await addHosts(['myapp.test', 'api.myapp.test'], true)
```

### `removeHosts(hosts, verbose?)`

Removes entries from the hosts file.

```ts
import { removeHosts } from '@stacksjs/rpx'

// Remove entries from the hosts file
await removeHosts(['myapp.test', 'api.myapp.test'], true)
```

### `checkHosts(hosts, verbose?)`

Checks if hosts exist in the hosts file.

```ts
import { checkHosts } from '@stacksjs/rpx'

// Check if hosts exist in the hosts file
const exists = await checkHosts(['myapp.test', 'api.myapp.test'], true)
// Returns an array of booleans, e.g. [true, false]
```

### `generateCertificate(options)`

Generates SSL certificates for the given domains.

```ts
import { generateCertificate } from '@stacksjs/rpx'

// Generate certificates
await generateCertificate({
  to: 'myapp.test',
  https: {
    commonName: 'myapp.test',
    validityDays: 365
  }
})
```

### `cleanupCertificates(domain, verbose?)`

Cleans up certificates for a specific domain.

```ts
import { cleanupCertificates } from '@stacksjs/rpx'

// Clean up certificates
await cleanupCertificates('myapp.test', true)
```

## Types

### `ProxyOptions`

Options for configuring a single proxy.

```ts
interface ProxyOptions {
  from?: string // The source URL to proxy from (e.g., 'localhost:3000')
  to?: string // The destination URL to proxy to (e.g., 'myapp.test')
  https?: boolean | TlsOption // HTTPS configuration
  cleanup?: boolean | { // Cleanup configuration
    hosts?: boolean // Whether to clean up hosts file
    certs?: boolean // Whether to clean up certificates
  }
  verbose?: boolean // Whether to log verbose output
  cleanUrls?: boolean // Whether to clean URLs (remove .html extension)
  start?: { // Command to start the proxied server
    command: string // Command to run
    cwd?: string // Working directory
    env?: Record<string, string> // Environment variables
  }
}
```

### `MultiProxyOptions`

Options for configuring multiple proxies.

```ts
interface MultiProxyOptions {
  https?: boolean | TlsOption // Shared HTTPS configuration
  cleanup?: boolean | { // Shared cleanup configuration
    hosts?: boolean
    certs?: boolean
  }
  proxies: Array<{ // Array of proxy configurations
    from: string
    to: string
    cleanUrls?: boolean
    start?: {
      command: string
      cwd?: string
      env?: Record<string, string>
    }
  }>
  verbose?: boolean // Whether to log verbose output
}
```

### `TlsOption`

Options for configuring TLS/SSL.

```ts
interface TlsOption {
  domain?: string // Domain name
  hostCertCN?: string // Host certificate common name
  caCertPath?: string // Path to CA certificate
  certPath?: string // Path to certificate
  keyPath?: string // Path to key
  altNameIPs?: string[] // Alternative IP addresses
  altNameURIs?: string[] // Alternative URIs
  organizationName?: string // Organization name
  countryName?: string // Country name
  stateName?: string // State/province name
  localityName?: string // Locality/city name
  commonName?: string // Common name
  validityDays?: number // Validity period in days
  verbose?: boolean // Whether to log verbose output
}
```

## Bun Plugin

### `rpxPlugin(options)`

Creates a Bun plugin for reverse proxy with pretty domains.

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test', // Domain to use (optional, defaults to package.json name)
      https: true, // Whether to use HTTPS (optional, defaults to true)
      verbose: false // Whether to log verbose output (optional, defaults to false)
    })
  ]
}
```
