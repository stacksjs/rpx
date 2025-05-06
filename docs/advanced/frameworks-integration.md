# Frameworks Integration

rpx can be integrated with various frontend and backend frameworks to provide custom domains, HTTPS, and other features for your local development environment.

## Bun Projects

For Bun projects, use the dedicated [Bun plugin](/features/bun-plugin):

```ts
// bunfig.toml or server setup
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'myapp.test',
      https: true,
      verbose: false
    })
  ]
}
```

## Vite

To use rpx with Vite, you need to configure both:

### Vite Configuration for HMR

```ts
import react from '@vitejs/plugin-react' // or your framework plugin
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: {
      // Point to your custom domain
      host: 'myapp.test',
      // If using HTTPS
      port: 443,
      protocol: 'wss'
    }
  }
})
```

### Starting rpx

```bash
# Start Vite on its default port (5173)
npm run dev

# In another terminal, start rpx
rpx --from localhost:5173 --to myapp.test
```

Or programmatically:

```ts
// scripts/dev.js
import { spawn } from 'node:child_process'
import { startProxy } from '@stacksjs/rpx'

// Start Vite
const vite = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: true
})

// Start rpx once Vite is ready
setTimeout(() => {
  startProxy({
    from: 'localhost:5173',
    to: 'myapp.test',
    https: true,
    cleanup: { hosts: true }
  })
}, 2000)

// Handle cleanup
process.on('SIGINT', () => {
  vite.kill()
  process.exit(0)
})
```

## Next.js

### Configuration

```ts
// next.config.js
module.exports = {
  async rewrites() {
    return [
      // If you need to rewrite paths
    ]
  },
  // Use a specific port for easier integration with rpx
  server: {
    port: 3000
  }
}
```

### Startup Script

```ts
// scripts/dev.js
import { spawn } from 'node:child_process'
import { startProxy } from '@stacksjs/rpx'

// Start Next.js
const next = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    // If you need environment variables
    HOSTNAME: 'localhost',
    PORT: '3000'
  }
})

// Start rpx
startProxy({
  from: 'localhost:3000',
  to: 'myapp.test',
  https: true,
  cleanup: { hosts: true }
})

// Handle cleanup
process.on('SIGINT', () => {
  next.kill()
  process.exit(0)
})
```

## Express

### Express Server

```ts
// server.js
import express from 'express'

const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`)
})
```

### rpx Configuration

```ts
// rpx.config.ts
export default {
  from: 'localhost:3000',
  to: 'api.myapp.test',
  https: true,
  // Optionally start the Express server automatically
  start: {
    command: 'node server.js',
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'development'
    }
  }
}
```

## NestJS

### Configuration

```ts
// main.ts
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(3000, 'localhost')
}
bootstrap()
```

### rpx Configuration

```ts
// rpx.config.ts
export default {
  from: 'localhost:3000',
  to: 'api.myapp.test',
  https: true,
  start: {
    command: 'npm run start:dev',
    cwd: process.cwd()
  }
}
```

## Vue CLI

### vue.config.js

```js
module.exports = {
  devServer: {
    port: 8080,
    host: 'localhost',
    https: false // Disable Vue's HTTPS, rpx will handle it
  }
}
```

### rpx Configuration

```ts
// rpx.config.ts
export default {
  from: 'localhost:8080',
  to: 'vue-app.test',
  https: true,
  cleanup: { hosts: true }
}
```

## Angular

### angular.json

```json
{
  "projects": {
    "my-app": {
      "architect": {
        "serve": {
          "options": {
            "port": 4200,
            "host": "localhost",
            "ssl": false
          }
        }
      }
    }
  }
}
```

### rpx Configuration

```ts
// rpx.config.ts
export default {
  from: 'localhost:4200',
  to: 'angular-app.test',
  https: true,
  cleanup: { hosts: true }
}
```

## Multiple Frameworks

When working with multiple frameworks (e.g., frontend and backend), configure rpx to handle both:

```ts
// rpx.config.ts
export default {
  https: true,
  cleanup: { hosts: true },
  proxies: [
    {
      from: 'localhost:5173', // Vite frontend
      to: 'app.myproject.test'
    },
    {
      from: 'localhost:3000', // Express API
      to: 'api.myproject.test'
    }
  ]
}
```

## Best Practices

1. **Disable framework HTTPS**: Let rpx handle HTTPS for consistency
2. **Use fixed ports**: Configure your frameworks to use specific ports for easier integration
3. **Consider domain namespacing**: Use subdomains like `app.myproject.test` and `api.myproject.test`
4. **Create startup scripts**: For complex setups, create a single script that starts all services
5. **Enable cleanup**: Configure rpx to clean up hosts file entries when stopping
6. **Configure WebSocket endpoints**: For frameworks that use WebSockets, ensure they're properly configured for your custom domain
