# Reverse Proxy

rpx provides a lightweight, high-performance reverse proxy designed specifically for local development workflows.

## Overview

A reverse proxy sits between your browser and your development server, forwarding requests and responses while providing additional functionality like SSL termination, custom domains, and request routing.

## Basic Usage

### CLI

```bash
rpx --from localhost:3000 --to my-app.localhost
```

### Library

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
})
```

## How It Works

```
Browser Request                          Your Dev Server
     │                                        │
     │  https://my-app.localhost/api/users    │
     │                                        │
     ▼                                        │
┌─────────────────────────────────────────┐   │
│              rpx Proxy                   │   │
│                                         │   │
│  1. Receives HTTPS request              │   │
│  2. Terminates SSL                      │   │
│  3. Forwards to localhost:3000          │   │
│  4. Returns response                    │   │
└─────────────────────────────────────────┘   │
     │                                        │
     │  http://localhost:3000/api/users       │
     │                                        │
     └────────────────────────────────────────┘
```

## Features

### Transparent Proxying

rpx transparently proxies all HTTP methods:

- GET, POST, PUT, DELETE, PATCH
- OPTIONS (CORS preflight)
- HEAD
- WebSocket upgrades

### Header Preservation

All headers are preserved and forwarded, including:

- Authorization headers
- Custom headers
- Cookies
- Content-Type

### WebSocket Support

WebSocket connections are automatically upgraded and proxied:

```ts
// Your client code works unchanged
const ws = new WebSocket('wss://my-app.localhost/ws')
ws.onmessage = (event) => console.log(event.data)
```

### Request Body Streaming

Large request bodies are streamed efficiently without buffering the entire body in memory.

## Configuration Options

### Basic Proxy

```ts
startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
})
```

### With Verbose Logging

```ts
startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  verbose: true, // Log all requests
})
```

### Multiple Targets

```ts
startProxy({
  proxies: [
    { from: 'localhost:3000', to: 'frontend.localhost' },
    { from: 'localhost:3001', to: 'api.localhost' },
    { from: 'localhost:3002', to: 'admin.localhost' },
  ],
})
```

## Performance

rpx is designed for development environments with:

- **Low latency**: Minimal overhead added to requests
- **Efficient memory usage**: Streaming instead of buffering
- **Fast startup**: Ready in milliseconds
- **Zero external dependencies**: Built on native APIs

## Common Use Cases

### Frontend Development

Proxy your Vite/webpack dev server:

```ts
startProxy({
  from: 'localhost:5173', // Vite default
  to: 'app.localhost',
  https: true,
})
```

### API Development

Proxy your backend API:

```ts
startProxy({
  from: 'localhost:3000',
  to: 'api.localhost',
  https: true,
})
```

### Full-Stack Development

Run frontend and backend together:

```ts
startProxy({
  proxies: [
    {
      from: 'localhost:5173',
      to: 'app.localhost',
      start: { command: 'bun run dev:frontend' },
    },
    {
      from: 'localhost:3000',
      to: 'api.localhost',
      start: { command: 'bun run dev:backend' },
    },
  ],
})
```

## Error Handling

rpx provides clear error messages for common issues:

### Target Unavailable

If your dev server isn't running:

```
[rpx] Error: Connection refused to localhost:3000
[rpx] Hint: Make sure your development server is running
```

### Port Conflicts

If the proxy port is already in use:

```
[rpx] Error: Port 443 is already in use
[rpx] Hint: Stop the other process or use a different port
```

## Next Steps

- [SSL Termination](/features/ssl-termination) - Learn about HTTPS support
- [Load Balancing](/features/load-balancing) - Distribute requests across servers
- [Request Routing](/features/request-routing) - Route requests based on path or host
