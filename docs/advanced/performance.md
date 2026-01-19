# Performance

This guide covers performance optimization techniques for rpx, including connection pooling, caching strategies, and monitoring.

## Performance Characteristics

rpx is designed for development environments with:

- **Low latency**: < 1ms overhead per request
- **High throughput**: Handles thousands of requests per second
- **Minimal memory**: ~50MB base memory usage
- **Fast startup**: Ready in < 100ms

## Connection Optimization

### Keep-Alive Connections

Enable HTTP keep-alive for connection reuse:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  connection: {
    keepAlive: true,
    keepAliveTimeout: 30000, // 30 seconds
  },
})
```

### Connection Pooling

Configure connection pool settings:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  connection: {
    maxSockets: 100, // Max concurrent connections
    maxFreeSockets: 10, // Keep idle connections
    freeSocketTimeout: 30000, // Idle timeout
  },
})
```

### Timeout Configuration

Set appropriate timeouts:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  timeouts: {
    connect: 5000, // Connection timeout
    socket: 60000, // Socket idle timeout
    request: 120000, // Total request timeout
  },
})
```

## Request Optimization

### Streaming

Enable streaming for large requests/responses:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  streaming: {
    enabled: true,
    threshold: 1024 * 1024, // Stream responses > 1MB
  },
})
```

### Body Buffering

Control request body buffering:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  buffer: {
    maxSize: '50mb', // Max buffered size
    streaming: true, // Stream large bodies
  },
})
```

### Header Optimization

Minimize header processing:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  headers: {
    // Remove unnecessary headers
    remove: ['X-Powered-By', 'Server'],

    // Don't forward certain headers
    stripHopByHop: true,
  },
})
```

## SSL/TLS Optimization

### Session Caching

Enable TLS session caching:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  https: {
    sessionTimeout: 300, // 5 minutes
    sessionCache: true,
  },
})
```

### OCSP Stapling

For production-like testing:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  https: {
    ocsp: {
      enabled: true,
      cache: true,
    },
  },
})
```

## Caching

### Response Caching

Cache static responses:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  cache: {
    enabled: true,
    maxAge: 3600, // 1 hour
    patterns: ['/static/*', '*.js', '*.css', '*.png'],
  },
})
```

### DNS Caching

Cache DNS lookups:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  dns: {
    cache: true,
    ttl: 300, // 5 minutes
  },
})
```

## Monitoring

### Request Metrics

Enable request metrics:

```ts
const proxy = await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  metrics: {
    enabled: true,
    detailed: true,
  },
})

// Get metrics
setInterval(() => {
  const stats = proxy.getMetrics()
  console.log(stats)
}, 10000)
```

Metrics include:
- Total requests
- Requests per second
- Average response time
- Error rate
- Active connections

### Health Endpoint

Expose a health endpoint:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  health: {
    enabled: true,
    path: '/__health',
  },
})
```

Access at `https://my-app.localhost/__health`:

```json
{
  "status": "healthy",
  "uptime": 3600,
  "requests": {
    "total": 10000,
    "perSecond": 50
  },
  "connections": {
    "active": 10,
    "idle": 5
  }
}
```

### Performance Logging

Log slow requests:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  logging: {
    slowThreshold: 1000, // Log requests > 1 second
    slowLogger: (req, duration) => {
      console.warn(`Slow request: ${req.url} (${duration}ms)`)
    },
  },
})
```

## Benchmarking

### Built-in Benchmarking

Run performance tests:

```bash
# Run built-in benchmark
rpx benchmark --duration 30 --concurrency 10

# Output:
# Requests:      10,000
# Duration:      30.0s
# RPS:           333.33
# Latency (avg): 2.5ms
# Latency (p99): 15ms
# Errors:        0
```

### External Benchmarking

Use external tools:

```bash
# Using wrk
wrk -t12 -c400 -d30s https://my-app.localhost/

# Using autocannon
autocannon -c 100 -d 30 https://my-app.localhost/

# Using ab (Apache Bench)
ab -n 10000 -c 100 https://my-app.localhost/
```

## Memory Optimization

### Memory Limits

Set memory limits:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  memory: {
    maxHeap: '256mb',
    gcInterval: 60000, // Force GC every minute
  },
})
```

### Memory Monitoring

Monitor memory usage:

```ts
const proxy = await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
})

setInterval(() => {
  const usage = process.memoryUsage()
  console.log({
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
  })
}, 10000)
```

## Common Performance Issues

### High Latency

**Symptoms**: Requests take longer than expected

**Solutions**:
1. Enable keep-alive connections
2. Increase connection pool size
3. Check target server performance
4. Enable DNS caching

### Memory Leaks

**Symptoms**: Memory usage grows over time

**Solutions**:
1. Limit request body buffering
2. Enable streaming for large responses
3. Set connection timeouts
4. Monitor with `--inspect` flag

### Connection Exhaustion

**Symptoms**: "EMFILE: too many open files"

**Solutions**:
1. Increase ulimit: `ulimit -n 65536`
2. Reduce keepAliveTimeout
3. Limit maxSockets

## Production-like Testing

Test with production-like settings:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  // Production-like settings
  connection: {
    keepAlive: true,
    maxSockets: 100,
  },
  timeouts: {
    connect: 5000,
    request: 30000,
  },
  https: {
    minVersion: 'TLSv1.2',
  },
  verbose: false,
})
```

## Best Practices

1. **Use keep-alive**: Reduces connection overhead
2. **Enable streaming**: For large files and responses
3. **Set timeouts**: Prevent hanging connections
4. **Monitor metrics**: Track performance over time
5. **Test under load**: Before deploying changes
6. **Profile regularly**: Identify bottlenecks early

## Next Steps

- [CI/CD Integration](/advanced/ci-cd-integration) - Performance testing in CI
- [Configuration](/advanced/configuration) - Full configuration reference
- [Custom Middleware](/advanced/custom-middleware) - Middleware performance
