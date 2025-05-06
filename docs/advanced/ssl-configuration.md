# Advanced SSL Configuration

rpx provides robust SSL support with sensible defaults, but also offers advanced configuration options for specific needs.

## Custom SSL Certificate Paths

By default, rpx generates SSL certificates in the user's home directory, but you can specify custom paths for your certificates:

```ts
import path from 'node:path'

startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: {
    caCertPath: path.join('./certs', 'ca.crt'),
    certPath: path.join('./certs', 'server.crt'),
    keyPath: path.join('./certs', 'server.key'),
  }
})
```

## Certificate Details

You can customize the information in your generated certificates:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: {
    organizationName: 'My Company Ltd',
    countryName: 'US',
    stateName: 'California',
    localityName: 'San Francisco',
    commonName: 'myapp.test',
    validityDays: 365, // Default is 180 days
  }
})
```

## Alternative Names and IPs

For more complex setups, you can add alternative names and IPs to your certificate:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: {
    altNameIPs: ['127.0.0.1', '192.168.1.100'],
    altNameURIs: ['localhost', 'myapp.local'],
  }
})
```

## Using Existing Certificates

If you already have certificates you want to use:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: {
    certPath: '/path/to/existing/cert.crt',
    keyPath: '/path/to/existing/key.key',
    // Note: If these exist, rpx will use them instead of generating new ones
  }
})
```

## Trusting Certificates in Your Browser

### Automatically Trusted

rpx attempts to add its CA certificate to your system trust store automatically, but this requires administrative privileges.

### Manual Trust Process

If you see certificate warnings in your browser, you'll need to manually trust the CA certificate:

#### macOS

1. Open Keychain Access
2. Import the CA certificate (found at the path specified in your config or in `~/.stacks/ssl/`)
3. Find the imported certificate, double-click it
4. Expand the "Trust" section
5. Set "When using this certificate" to "Always Trust"

#### Windows

1. Open PowerShell or Command Prompt as Administrator
2. Run: `certutil -addstore "Root" <path-to-ca.crt>`

#### Linux (Ubuntu/Debian)

1. Copy the CA certificate to `/usr/local/share/ca-certificates/`
2. Run: `sudo update-ca-certificates`

#### Firefox

Firefox uses its own certificate store:

1. Open Firefox Preferences
2. Search for "Certificates" and click "View Certificates"
3. Go to the "Authorities" tab
4. Click "Import" and select your CA certificate
5. Check "Trust this CA to identify websites"

## Debugging SSL Issues

If you encounter SSL-related issues:

```bash
# Enable verbose logging
rpx --from localhost:3000 --to myapp.test --verbose
```

This will show detailed information about the SSL setup process, including:

- Certificate generation steps
- Path where certificates are stored
- Certificate trust status
- Any errors that occur during setup

## Performance Considerations

SSL handshakes add some overhead to each connection. For most development scenarios, this is negligible, but if you're working with a high volume of requests, consider:

1. Using longer-lived certificates (increase `validityDays`)
2. Pre-generating certificates to avoid generation overhead on startup
3. Using HTTP instead of HTTPS if performance is critical and you don't need features that require secure contexts
