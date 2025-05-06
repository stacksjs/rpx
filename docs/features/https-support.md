# HTTPS Support

rpx provides robust HTTPS support for your local development environment. This enables you to develop and test features that require secure connections without the complexity of manually setting up certificates.

## Key Features

- **Automatic HTTPS Configuration**: Enabled by default with zero configuration
- **Automatic Certificate Generation**: Self-signed certificates created and installed automatically
- **Certificate Authority**: Creates and installs a local CA certificate for trusted connections
- **HTTP to HTTPS Redirection**: Automatically redirects HTTP requests to HTTPS
- **Flexible Configuration**: Use the default settings or customize as needed

## Why Use HTTPS Locally?

Using HTTPS in your local development environment is beneficial for several reasons:

1. **Testing Secure-Only Features**: Some features like service workers, secure cookies, and certain browser APIs only work in secure contexts
2. **More Accurate Testing**: Your production environment likely uses HTTPS, so testing in a similar environment catches issues earlier
3. **Modern Browser APIs**: Many modern APIs require secure contexts
4. **Security Headers Testing**: Test security headers like HSTS, CSP, etc., in a realistic environment

## Configuration

HTTPS is enabled by default with rpx. You can use it with minimal configuration:

### Simple Configuration

```ts
// Enabled by default
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: true // This is the default, so it's optional
})
```

### Advanced Configuration

For more control, you can specify certificate paths and details:

```ts
import os from 'node:os'
import path from 'node:path'

startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: {
    domain: 'myapp.test',
    caCertPath: path.join(os.homedir(), '.rpx', 'ssl', 'myapp.test.ca.crt'),
    certPath: path.join(os.homedir(), '.rpx', 'ssl', 'myapp.test.crt'),
    keyPath: path.join(os.homedir(), '.rpx', 'ssl', 'myapp.test.key'),
    altNameIPs: ['127.0.0.1'],
    altNameURIs: ['localhost'],
    organizationName: 'My Organization',
    countryName: 'US',
    stateName: 'California',
    localityName: 'San Francisco',
    commonName: 'myapp.test',
    validityDays: 365,
  }
})
```

## CLI Usage

```bash
# HTTPS is enabled by default
rpx --from localhost:3000 --to myapp.test

# Disable HTTPS if needed
rpx --from localhost:3000 --to myapp.test --no-https

# Specify custom certificate paths
rpx --from localhost:3000 --to myapp.test --keyPath ./certs/key.pem --certPath ./certs/cert.pem
```

## Bun Plugin

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test',
      https: true // Default is true, so this is optional
    })
  ]
}
```

## Certificate Trust

When rpx generates certificates, it attempts to add them to your system's trust store. You may need to approve this operation, which typically requires administrative privileges.

If you encounter certificate warnings in your browser, you may need to manually trust the generated CA certificate. See [Advanced SSL Configuration](/advanced/ssl-configuration) for more details.
