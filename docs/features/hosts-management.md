# Hosts Management

rpx includes intelligent `/etc/hosts` file management to seamlessly map your custom domains to your local machine without requiring manual configuration.

## What is the Hosts File?

The hosts file is a system file that maps hostnames to IP addresses. It's one of the first places your computer checks when resolving a domain name, even before querying DNS servers.

- On macOS and Linux: `/etc/hosts`
- On Windows: `C:\Windows\System32\drivers\etc\hosts`

## How rpx Manages the Hosts File

When you start rpx with a custom domain, it:

1. **Checks** if your custom domain (e.g., `myapp.test`) already exists in the hosts file
2. **Adds** entries for both IPv4 and IPv6 if they don't exist:
   ```
   # Added by rpx
   127.0.0.1 myapp.test
   ::1 myapp.test
   ```
3. **Cleans up** these entries when you stop rpx (if cleanup is enabled)

## Benefits

- **Zero Configuration**: No need to manually edit the hosts file
- **Multiple Domains**: Easily work with multiple domains simultaneously
- **Clean Environment**: Entries are removed when no longer needed
- **Cross-Platform**: Works on macOS, Linux, and Windows

## Configuration

Hosts file management is enabled by default. You can control this behavior:

### CLI

```bash
# Default behavior - adds hosts entries
rpx --from localhost:3000 --to myapp.test

# Cleanup when stopping rpx (removes hosts entries)
rpx --from localhost:3000 --to myapp.test --cleanup
```

### Library

```ts
import { startProxy } from '@stacksjs/rpx'

// Default behavior
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
})

// With explicit cleanup
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  cleanup: {
    hosts: true, // Clean up hosts entries when stopping
    certs: false // Don't clean up certificates
  }
})
```

### Bun Plugin

The Bun plugin automatically handles hosts file management and cleanup.

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test',
      // Hosts management is automatic
    })
  ]
}
```

## Permissions

Modifying the hosts file requires administrative privileges on most systems:

- **macOS/Linux**: rpx will use `sudo` to request elevated permissions
- **Windows**: You'll need to run the terminal as Administrator

If rpx cannot modify the hosts file due to permission issues, it will display the entries you need to add manually.

## Manual Mode

If you prefer to manage your hosts file manually, you can do so by adding the appropriate entries yourself:

```
# For a domain myapp.test
127.0.0.1 myapp.test
::1 myapp.test
```

Then use rpx without hosts file management:

```bash
# Tell rpx not to modify the hosts file (coming in a future version)
rpx --from localhost:3000 --to myapp.test --no-hosts-management
```
