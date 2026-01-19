# Request Routing

rpx supports flexible request routing, allowing you to direct traffic based on paths, hosts, and custom rules.

## Overview

Request routing lets you:

- Route different paths to different backends
- Split traffic between frontend and API servers
- Implement path-based microservices routing
- Create custom routing rules

## Path-Based Routing

### Basic Path Routing

Route specific paths to different servers:

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  to: 'my-app.localhost',
  routes: [
    { path: '/api/*', from: 'localhost:3000' },
    { path: '/admin/*', from: 'localhost:3001' },
    { path: '/*', from: 'localhost:5173' }, // Default/fallback
  ],
})
```

Requests are routed as:
- `https://my-app.localhost/api/users` → `localhost:3000/api/users`
- `https://my-app.localhost/admin/dashboard` → `localhost:3001/admin/dashboard`
- `https://my-app.localhost/about` → `localhost:5173/about`

### Path Rewriting

Rewrite paths when forwarding:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/api/v1/*',
      from: 'localhost:3000',
      rewrite: '/api/$1', // /api/v1/users → /api/users
    },
    {
      path: '/legacy/*',
      from: 'localhost:3001',
      rewrite: '/$1', // /legacy/old-endpoint → /old-endpoint
    },
  ],
})
```

## Host-Based Routing

### Multiple Domains

Route different domains to different backends:

```ts
await startProxy({
  proxies: [
    { from: 'localhost:3000', to: 'api.localhost' },
    { from: 'localhost:3001', to: 'admin.localhost' },
    { from: 'localhost:5173', to: 'app.localhost' },
  ],
})
```

### Wildcard Subdomains

Route wildcard subdomains:

```ts
await startProxy({
  proxies: [
    {
      from: 'localhost:3000',
      to: '*.api.localhost',
      // v1.api.localhost → localhost:3000
      // v2.api.localhost → localhost:3000
    },
  ],
})
```

### Dynamic Subdomain Routing

Route based on subdomain:

```ts
await startProxy({
  to: '*.tenant.localhost',
  routes: [
    {
      subdomain: '*',
      from: 'localhost:3000',
      headers: {
        'X-Tenant-ID': '$subdomain', // Pass subdomain as header
      },
    },
  ],
})
```

## Method-Based Routing

Route based on HTTP method:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/api/*',
      method: 'GET',
      from: 'localhost:3000', // Read replica
    },
    {
      path: '/api/*',
      method: ['POST', 'PUT', 'DELETE'],
      from: 'localhost:3001', // Write server
    },
  ],
})
```

## Header-Based Routing

Route based on request headers:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/api/*',
      headers: { 'X-API-Version': 'v2' },
      from: 'localhost:3001',
    },
    {
      path: '/api/*',
      headers: { 'X-API-Version': 'v1' },
      from: 'localhost:3000',
    },
    {
      path: '/api/*',
      from: 'localhost:3000', // Default
    },
  ],
})
```

## Routing Priority

Routes are matched in order of specificity:

1. Exact path matches first
2. Longer path prefixes before shorter
3. Routes with more conditions (headers, methods) before general routes
4. First matching route wins

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    // Most specific first
    { path: '/api/users/:id', from: 'localhost:3001' },
    { path: '/api/users', from: 'localhost:3000' },
    { path: '/api/*', from: 'localhost:3002' },
    { path: '/*', from: 'localhost:5173' }, // Fallback
  ],
})
```

## Common Patterns

### Frontend + API

Typical SPA setup with separate frontend and API:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    // API routes
    { path: '/api/*', from: 'localhost:3000' },
    // WebSocket
    { path: '/ws', from: 'localhost:3000' },
    // Frontend (SPA)
    { path: '/*', from: 'localhost:5173' },
  ],
})
```

### Microservices

Route to different microservices:

```ts
await startProxy({
  to: 'app.localhost',
  routes: [
    { path: '/api/users/*', from: 'localhost:3001' },
    { path: '/api/products/*', from: 'localhost:3002' },
    { path: '/api/orders/*', from: 'localhost:3003' },
    { path: '/api/payments/*', from: 'localhost:3004' },
    { path: '/*', from: 'localhost:5173' },
  ],
})
```

### Blue-Green Deployment Testing

Test new versions before full deployment:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    // 10% of traffic to new version
    {
      path: '/*',
      from: 'localhost:3001', // New version
      weight: 1,
    },
    // 90% of traffic to current version
    {
      path: '/*',
      from: 'localhost:3000', // Current version
      weight: 9,
    },
  ],
})
```

### A/B Testing

Route different users to different versions:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/*',
      headers: { 'X-AB-Group': 'B' },
      from: 'localhost:3001', // Version B
    },
    {
      path: '/*',
      from: 'localhost:3000', // Version A (default)
    },
  ],
})
```

## Request Modification

### Adding Headers

Add headers to proxied requests:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/api/*',
      from: 'localhost:3000',
      addHeaders: {
        'X-Proxy': 'rpx',
        'X-Request-Time': '$timestamp',
      },
    },
  ],
})
```

### Removing Headers

Remove headers before forwarding:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [
    {
      path: '/api/*',
      from: 'localhost:3000',
      removeHeaders: ['X-Internal-Token'],
    },
  ],
})
```

## Debugging Routes

Enable verbose logging to see routing decisions:

```ts
await startProxy({
  to: 'my-app.localhost',
  routes: [...],
  verbose: true,
})
```

Output:
```
[rpx] GET /api/users → localhost:3000 (matched: /api/*)
[rpx] GET /dashboard → localhost:5173 (matched: /*)
[rpx] POST /api/users → localhost:3000 (matched: /api/*)
```

## Route Testing

Test your routing configuration:

```bash
# Test API route
curl https://my-app.localhost/api/users

# Test with headers
curl -H "X-API-Version: v2" https://my-app.localhost/api/users

# Test method routing
curl -X POST https://my-app.localhost/api/users
```

## Next Steps

- [Configuration](/advanced/configuration) - Advanced configuration options
- [Custom Middleware](/advanced/custom-middleware) - Add custom middleware
- [Performance](/advanced/performance) - Optimize routing performance
