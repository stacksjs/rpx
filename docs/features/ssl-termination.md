# SSL Termination

rpx provides automatic SSL/TLS termination, enabling HTTPS by default for all your local development domains.

## Overview

SSL termination means rpx handles the encryption and decryption of HTTPS traffic, forwarding plain HTTP to your development server. This simplifies your setup while providing production-like HTTPS support.

## Default Behavior

HTTPS is enabled by default:

```ts
import { startProxy } from '@stacksjs/rpx'

// HTTPS enabled automatically
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
})
```

Your app is now accessible at `https://my-app.localhost`.

## How It Works

```
Browser                    rpx                     Dev Server
   │                        │                          │
   │ ──── HTTPS Request ────► │                          │
   │      (encrypted)       │                          │
   │                        │ ─── HTTP Request ────────►│
   │                        │     (unencrypted)        │
   │                        │                          │
   │                        │ ◄── HTTP Response ────────│
   │                        │                          │
   │ ◄── HTTPS Response ─── │                          │
   │      (encrypted)       │                          │
```

## Certificate Generation

rpx automatically generates SSL certificates:

### Automatic Generation

```ts
startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  https: true, // Generates certificates automatically
})
```

Certificates are stored in `~/.stacks/ssl/` by default.

### Certificate Details

Generated certificates include:

- **Root CA**: Trusted authority for all certificates
- **Host Certificate**: Specific to your domain
- **Private Key**: For TLS handshake

### Certificate Validity

Default validity is 180 days. Configure with:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  https: {
    validityDays: 365, // One year
  },
})
```

## Custom Certificates

Use your own certificates:

```ts
import path from 'node:path'
import os from 'node:os'

startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  https: {
    caCertPath: path.join(os.homedir(), '.ssl', 'ca.crt'),
    certPath: path.join(os.homedir(), '.ssl', 'cert.crt'),
    keyPath: path.join(os.homedir(), '.ssl', 'key.pem'),
  },
})
```

## System Trust Store

rpx automatically adds certificates to your system's trust store, eliminating browser warnings.

### Automatic Trust

When you first run rpx, it will:

1. Generate a root CA certificate
2. Add it to your system trust store (requires sudo/admin)
3. Generate a host certificate signed by the CA

### Manual Trust

If automatic trust fails, run:

```bash
bun scripts/fix-certs.js
```

### Platform-Specific Trust

| Platform | Trust Store |
|----------|-------------|
| macOS | Keychain Access |
| Linux | /etc/ssl/certs or NSS |
| Windows | Certificate Manager |

## HTTP to HTTPS Redirect

rpx automatically redirects HTTP to HTTPS:

```
GET http://my-app.localhost/
→ 301 Redirect
→ https://my-app.localhost/
```

## Certificate Configuration

### Full Configuration

```ts
startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  https: {
    domain: 'my-app.localhost',
    hostCertCN: 'my-app.localhost',
    caCertPath: '/path/to/ca.crt',
    certPath: '/path/to/cert.crt',
    keyPath: '/path/to/key.pem',
    altNameIPs: ['127.0.0.1', '192.168.1.100'],
    altNameURIs: ['localhost', 'my-app.local'],
    organizationName: 'My Company',
    countryName: 'US',
    stateName: 'California',
    localityName: 'San Francisco',
    commonName: 'my-app.localhost',
    validityDays: 365,
    verbose: false,
  },
})
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `domain` | string | Primary domain for the certificate |
| `hostCertCN` | string | Common name for the host certificate |
| `caCertPath` | string | Path to CA certificate |
| `certPath` | string | Path to host certificate |
| `keyPath` | string | Path to private key |
| `altNameIPs` | string[] | Alternative IP addresses |
| `altNameURIs` | string[] | Alternative domain names |
| `organizationName` | string | Organization name in certificate |
| `countryName` | string | Country code (2 letters) |
| `stateName` | string | State or province name |
| `localityName` | string | City name |
| `commonName` | string | Common name (usually domain) |
| `validityDays` | number | Certificate validity in days |

## Wildcard Certificates

Generate certificates for wildcard domains:

```ts
startProxy({
  from: 'localhost:3000',
  to: '*.my-app.localhost',
  https: {
    domain: '*.my-app.localhost',
    altNameURIs: ['my-app.localhost', '*.my-app.localhost'],
  },
})
```

Now all subdomains work:
- `https://api.my-app.localhost`
- `https://admin.my-app.localhost`
- `https://staging.my-app.localhost`

## Troubleshooting

### Browser Shows "Not Secure"

1. Run the certificate fix utility:
   ```bash
   bun scripts/fix-certs.js
   ```

2. Restart your browser

3. If still failing, manually add the CA to your browser:
   - Chrome: Settings → Privacy → Security → Manage certificates
   - Firefox: Settings → Privacy → View Certificates

### Certificate Expired

Delete old certificates and regenerate:

```bash
rm -rf ~/.stacks/ssl/
rpx --from localhost:3000 --to my-app.localhost
```

### Firefox-Specific Issues

Firefox maintains its own certificate store. Add the CA manually:

1. Open Firefox Preferences
2. Search for "certificates"
3. Click "View Certificates"
4. Import the CA from `~/.stacks/ssl/`

## Security Considerations

- Generated certificates are for **development only**
- Never use generated certificates in production
- The root CA private key is stored locally
- Certificates are self-signed, not from a public CA

## Next Steps

- [Load Balancing](/features/load-balancing) - Distribute requests
- [Request Routing](/features/request-routing) - Route by path
- [Custom Certificates](/advanced/custom-certificates) - Advanced certificate options
