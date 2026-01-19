# Load Balancing

rpx supports load balancing across multiple backend servers, useful for testing distributed systems and microservices locally.

## Overview

Load balancing distributes incoming requests across multiple server instances, simulating production environments where traffic is spread across multiple servers.

## Basic Configuration

### Round-Robin Balancing

Distribute requests evenly across servers:

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: ['localhost:3000', 'localhost:3001', 'localhost:3002'],
  to: 'api.localhost',
  https: true,
})
```

Requests are distributed in order:
1. First request → `localhost:3000`
2. Second request → `localhost:3001`
3. Third request → `localhost:3002`
4. Fourth request → `localhost:3000` (cycles back)

## Multiple Services

### Microservices Architecture

Run multiple services with their own domains:

```ts
await startProxy({
  proxies: [
    {
      from: ['localhost:3000', 'localhost:3001'],
      to: 'api.localhost',
    },
    {
      from: ['localhost:4000', 'localhost:4001'],
      to: 'auth.localhost',
    },
    {
      from: 'localhost:5173',
      to: 'app.localhost',
    },
  ],
})
```

### Service Discovery

Combine with auto-start for full microservices setup:

```ts
await startProxy({
  proxies: [
    {
      from: ['localhost:3000', 'localhost:3001'],
      to: 'api.localhost',
      start: {
        command: 'bun run start:api',
        env: { PORT: '3000' },
      },
    },
    {
      from: ['localhost:3002', 'localhost:3003'],
      to: 'api.localhost',
      start: {
        command: 'bun run start:api',
        env: { PORT: '3002' },
      },
    },
  ],
})
```

## Health Checks

rpx monitors backend health and removes unhealthy servers from rotation.

### Automatic Health Checks

```ts
await startProxy({
  from: ['localhost:3000', 'localhost:3001', 'localhost:3002'],
  to: 'api.localhost',
  healthCheck: {
    enabled: true,
    interval: 5000, // Check every 5 seconds
    timeout: 2000, // 2 second timeout
    path: '/health', // Health check endpoint
  },
})
```

### Health Check Response

Your backend should respond to health checks:

```ts
// Express example
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' })
})

// Hono example
app.get('/health', (c) => c.json({ status: 'healthy' }))
```

### Unhealthy Server Handling

When a server fails health checks:

1. Server is removed from rotation
2. Requests are distributed to remaining servers
3. Server is re-added when health checks pass

## Use Cases

### Testing Horizontal Scaling

Test how your app behaves with multiple instances:

```ts
// Run 3 instances of your API
await startProxy({
  from: ['localhost:3000', 'localhost:3001', 'localhost:3002'],
  to: 'api.localhost',
  verbose: true, // See which server handles each request
})
```

### Testing Failover

Simulate server failures by stopping one instance:

```bash
# Terminal 1: Start proxy
rpx --from localhost:3000,localhost:3001 --to api.localhost

# Terminal 2: Start first server
PORT=3000 bun run start

# Terminal 3: Start second server
PORT=3001 bun run start

# Kill one server to test failover
kill %2
```

### Session Affinity Testing

Test session handling across multiple servers:

```ts
await startProxy({
  from: ['localhost:3000', 'localhost:3001'],
  to: 'api.localhost',
  verbose: true,
})

// Make requests and observe session behavior
// Sessions should work regardless of which server handles the request
```

## Weighted Distribution

Distribute traffic unevenly to simulate different server capacities:

```ts
await startProxy({
  from: [
    { address: 'localhost:3000', weight: 3 }, // 3x traffic
    { address: 'localhost:3001', weight: 1 }, // 1x traffic
  ],
  to: 'api.localhost',
})
```

## Sticky Sessions

Keep users on the same server for the duration of their session:

```ts
await startProxy({
  from: ['localhost:3000', 'localhost:3001'],
  to: 'api.localhost',
  sticky: {
    enabled: true,
    cookie: 'server_id', // Cookie name for session affinity
    ttl: 3600, // 1 hour
  },
})
```

## Monitoring

### Verbose Logging

Enable verbose logging to see load balancing in action:

```ts
await startProxy({
  from: ['localhost:3000', 'localhost:3001'],
  to: 'api.localhost',
  verbose: true,
})
```

Output:
```
[rpx] Request /api/users → localhost:3000
[rpx] Request /api/posts → localhost:3001
[rpx] Request /api/users/1 → localhost:3000
```

### Statistics

Get load balancing statistics:

```ts
const proxy = await startProxy({
  from: ['localhost:3000', 'localhost:3001'],
  to: 'api.localhost',
})

// Check stats
console.log(proxy.stats())
// {
//   'localhost:3000': { requests: 150, errors: 2, avgLatency: 45 },
//   'localhost:3001': { requests: 148, errors: 0, avgLatency: 42 },
// }
```

## Best Practices

### Development vs Production

- Use load balancing in development to catch session issues early
- Test with multiple instances to find race conditions
- Verify your app works regardless of which server handles requests

### Stateless Design

When using load balancing, ensure your app is stateless:

- Store sessions in Redis/database, not memory
- Use shared file storage for uploads
- Avoid server-specific caches

### Connection Pooling

For database connections, ensure proper pooling:

```ts
// Each server instance should have its own connection pool
// But the pool size should account for multiple instances
const pool = new Pool({
  max: 10 / numInstances, // Divide connections across instances
})
```

## Next Steps

- [Request Routing](/features/request-routing) - Route requests by path
- [Configuration](/advanced/configuration) - Advanced proxy configuration
- [Performance](/advanced/performance) - Performance tuning
