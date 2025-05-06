# Cleanup Strategies

rpx creates various resources like hosts file entries and SSL certificates. Understanding and configuring how these resources are cleaned up is important for maintaining a tidy development environment.

## Default Behavior

By default:

- Hosts file entries are added but not automatically removed
- SSL certificates are generated and kept for reuse
- Process cleanup happens when rpx is terminated with Ctrl+C or when the process ends

## Configuring Cleanup

You can configure cleanup behavior in several ways:

### Library Configuration

```ts
import { startProxy } from '@stacksjs/rpx'

startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  cleanup: {
    hosts: true, // Clean up hosts file entries on exit
    certs: false // Keep certificates for future use
  }
})
```

### CLI Configuration

```bash
# Enable hosts cleanup
rpx --from localhost:3000 --to myapp.test --cleanup

# Specify which resources to clean up (future version)
rpx --from localhost:3000 --to myapp.test --cleanup-hosts --no-cleanup-certs
```

### Bun Plugin

The Bun plugin automatically handles cleanup when the server is stopped:

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test'
      // Cleanup is handled automatically
    })
  ]
}
```

## Signal Handling

rpx handles the following signals for cleanup:

- `SIGINT` (Ctrl+C)
- `SIGTERM` (process termination)
- Uncaught exceptions

When these signals are received, rpx will:

1. Stop any watched processes it started
2. Close all proxy servers
3. Clean up hosts file entries (if configured)
4. Clean up certificates (if configured)

## Manual Cleanup

You can manually clean up resources:

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

## Cleanup Strategies

Consider these cleanup strategies for different scenarios:

### Development Machine

For your primary development machine:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  cleanup: {
    hosts: true, // Clean up hosts entries to avoid conflicts
    certs: false // Keep certificates for faster startup next time
  }
})
```

### CI/CD Environment

For continuous integration or deployment environments:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  cleanup: {
    hosts: true, // Clean up hosts entries
    certs: true // Clean up certificates to avoid accumulation
  }
})
```

### Shared Development Environments

For environments shared by multiple developers:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  cleanup: {
    hosts: true, // Clean up hosts entries to avoid conflicts
    certs: true // Clean up certificates to avoid conflicts
  }
})
```

## Orphaned Resources

If rpx exits unexpectedly (e.g., process killed), it might leave orphaned resources. You can clean these up:

### Hosts File

Entries in your hosts file will look like this:

```
# Added by rpx
127.0.0.1 myapp.test
::1 myapp.test
```

You can manually remove these or run:

```bash
# Clean up specific domains
rpx cleanup --domains myapp.test,api.myapp.test --hosts

# Clean up all domains added by rpx (future version)
rpx cleanup --all --hosts
```

### Certificates

Certificates are stored in specific locations:

- Default: `~/.stacks/ssl/`
- Custom: Locations specified in your configuration

You can manually delete these or run:

```bash
# Clean up certificates for specific domains
rpx cleanup --domains myapp.test,api.myapp.test --certs

# Clean up all certificates (future version)
rpx cleanup --all --certs
```

## Best Practices

1. **Enable hosts cleanup** for most scenarios to avoid hosts file pollution
2. **Keep certificates** for domains you use regularly (faster startup)
3. **Clean up certificates** for temporary or rarely used domains
4. **Use descriptive domain names** to make it clear which certificates and hosts entries belong to which projects
5. **Consider domain namespacing** (e.g., `project1.test`, `project2.test`) to organize your development environment
