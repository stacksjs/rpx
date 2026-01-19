# Custom Middleware

rpx supports custom middleware for request/response interception, modification, and logging.

## Overview

Middleware functions intercept requests and responses, allowing you to:

- Modify request headers
- Transform response bodies
- Add authentication
- Implement rate limiting
- Log request/response data
- Add custom headers

## Basic Middleware

### Request Middleware

Intercept and modify requests:

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  middleware: {
    request: async (req, next) => {
      // Add custom header
      req.headers['X-Proxy-Time'] = Date.now().toString()

      // Continue to next middleware/proxy
      return next(req)
    },
  },
})
```

### Response Middleware

Intercept and modify responses:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  middleware: {
    response: async (res, req, next) => {
      // Add response header
      res.headers['X-Response-Time'] = `${Date.now() - req.startTime}ms`

      return next(res)
    },
  },
})
```

## Middleware Chain

Run multiple middleware in sequence:

```ts
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',

  middleware: {
    request: [
      // Logging middleware
      async (req, next) => {
        console.log(`→ ${req.method} ${req.url}`)
        return next(req)
      },

      // Auth middleware
      async (req, next) => {
        req.headers['Authorization'] = `Bearer ${getToken()}`
        return next(req)
      },

      // Timing middleware
      async (req, next) => {
        req.startTime = Date.now()
        return next(req)
      },
    ],
  },
})
```

## Common Middleware Patterns

### Logging Middleware

```ts
const loggingMiddleware = async (req, next) => {
  const start = Date.now()
  console.log(`→ ${req.method} ${req.url}`)

  const res = await next(req)

  const duration = Date.now() - start
  console.log(`← ${res.status} ${req.url} (${duration}ms)`)

  return res
}

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  middleware: { request: loggingMiddleware },
})
```

### Authentication Middleware

```ts
const authMiddleware = async (req, next) => {
  // Get token from environment or config
  const token = process.env.API_TOKEN

  if (token && req.url.startsWith('/api/')) {
    req.headers['Authorization'] = `Bearer ${token}`
  }

  return next(req)
}
```

### CORS Middleware

```ts
const corsMiddleware = async (res, req, next) => {
  res.headers['Access-Control-Allow-Origin'] = '*'
  res.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
  res.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'

  return next(res)
}

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  middleware: { response: corsMiddleware },
})
```

### Rate Limiting Middleware

```ts
const rateLimits = new Map()

const rateLimitMiddleware = async (req, next) => {
  const ip = req.headers['x-forwarded-for'] || 'unknown'
  const now = Date.now()
  const windowMs = 60000 // 1 minute
  const maxRequests = 100

  const userRequests = rateLimits.get(ip) || []
  const recentRequests = userRequests.filter((t) => now - t < windowMs)

  if (recentRequests.length >= maxRequests) {
    return {
      status: 429,
      body: 'Too Many Requests',
      headers: {
        'Retry-After': '60',
      },
    }
  }

  recentRequests.push(now)
  rateLimits.set(ip, recentRequests)

  return next(req)
}
```

### Caching Middleware

```ts
const cache = new Map()

const cachingMiddleware = async (req, next) => {
  // Only cache GET requests
  if (req.method !== 'GET') {
    return next(req)
  }

  const cacheKey = req.url
  const cached = cache.get(cacheKey)

  if (cached && Date.now() - cached.timestamp < 60000) {
    return cached.response
  }

  const res = await next(req)

  // Cache successful responses
  if (res.status === 200) {
    cache.set(cacheKey, {
      response: res,
      timestamp: Date.now(),
    })
  }

  return res
}
```

### Request Body Transformation

```ts
const transformBodyMiddleware = async (req, next) => {
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    const body = JSON.parse(req.body)

    // Add timestamp to all POST requests
    body.timestamp = Date.now()
    body.source = 'rpx-proxy'

    req.body = JSON.stringify(body)
    req.headers['content-length'] = Buffer.byteLength(req.body).toString()
  }

  return next(req)
}
```

### Response Compression

```ts
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

const compressionMiddleware = async (res, req, next) => {
  // Check if client accepts gzip
  const acceptEncoding = req.headers['accept-encoding'] || ''

  if (!acceptEncoding.includes('gzip')) {
    return next(res)
  }

  // Only compress text responses
  const contentType = res.headers['content-type'] || ''
  if (!contentType.includes('text/') && !contentType.includes('application/json')) {
    return next(res)
  }

  const compressed = await gzipAsync(res.body)

  return next({
    ...res,
    body: compressed,
    headers: {
      ...res.headers,
      'content-encoding': 'gzip',
      'content-length': compressed.length.toString(),
    },
  })
}
```

### Error Handling Middleware

```ts
const errorHandlingMiddleware = async (req, next) => {
  try {
    return await next(req)
  }
  catch (error) {
    console.error('Proxy error:', error)

    return {
      status: 502,
      body: JSON.stringify({
        error: 'Bad Gateway',
        message: 'The upstream server failed to respond',
        timestamp: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
      },
    }
  }
}
```

## Conditional Middleware

Apply middleware based on conditions:

```ts
const conditionalMiddleware = (condition, middleware) => {
  return async (req, next) => {
    if (condition(req)) {
      return middleware(req, next)
    }
    return next(req)
  }
}

// Only apply auth to /api routes
const apiAuthMiddleware = conditionalMiddleware(
  req => req.url.startsWith('/api/'),
  authMiddleware,
)
```

## Middleware Factories

Create reusable middleware with configuration:

```ts
function createLoggingMiddleware(options = {}) {
  const { format = 'simple', output = console.log } = options

  return async (req, next) => {
    const start = Date.now()
    const res = await next(req)
    const duration = Date.now() - start

    if (format === 'json') {
      output(JSON.stringify({
        method: req.method,
        url: req.url,
        status: res.status,
        duration,
      }))
    }
    else {
      output(`${req.method} ${req.url} ${res.status} ${duration}ms`)
    }

    return res
  }
}

// Usage
await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  middleware: {
    request: createLoggingMiddleware({ format: 'json' }),
  },
})
```

## Middleware Composition

Compose multiple middleware into one:

```ts
function compose(...middlewares) {
  return async (req, next) => {
    let index = 0

    async function dispatch(req) {
      if (index >= middlewares.length) {
        return next(req)
      }

      const middleware = middlewares[index++]
      return middleware(req, dispatch)
    }

    return dispatch(req)
  }
}

// Usage
const composedMiddleware = compose(
  loggingMiddleware,
  authMiddleware,
  rateLimitMiddleware,
)

await startProxy({
  from: 'localhost:3000',
  to: 'my-app.localhost',
  middleware: { request: composedMiddleware },
})
```

## Testing Middleware

```ts
import { describe, test, expect } from 'bun:test'

describe('authMiddleware', () => {
  test('adds authorization header', async () => {
    const req = {
      method: 'GET',
      url: '/api/users',
      headers: {},
    }

    const next = async (req) => req

    const result = await authMiddleware(req, next)

    expect(result.headers['Authorization']).toBeDefined()
  })
})
```

## Next Steps

- [Performance](/advanced/performance) - Optimize middleware performance
- [CI/CD Integration](/advanced/ci-cd-integration) - Test middleware in CI
- [Configuration](/advanced/configuration) - Advanced configuration
