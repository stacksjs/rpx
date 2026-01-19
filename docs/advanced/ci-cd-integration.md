# CI/CD Integration

This guide covers integrating rpx into your CI/CD pipelines for automated testing with production-like SSL and domain configurations.

## Overview

rpx enables CI/CD pipelines to:

- Test with HTTPS and custom domains
- Run end-to-end tests with production-like URLs
- Verify SSL certificate handling
- Test multi-service architectures

## GitHub Actions

### Basic Setup

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Start proxy and run tests
        run: |
          # Start the development server in background
          bun run dev &
          sleep 5

          # Start rpx
          bunx @stacksjs/rpx --from localhost:3000 --to app.localhost &
          sleep 2

          # Run tests
          bun test
```

### With Multiple Services

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Setup services
        run: |
          # Start API server
          PORT=3000 bun run dev:api &

          # Start frontend server
          PORT=5173 bun run dev:frontend &

          # Wait for servers
          sleep 10

      - name: Start rpx
        run: |
          cat > rpx.config.ts << 'EOF'
          export default {
            proxies: [
              { from: 'localhost:3000', to: 'api.localhost' },
              { from: 'localhost:5173', to: 'app.localhost' },
            ],
            https: true,
          }
          EOF

          bunx @stacksjs/rpx start &
          sleep 5

      - name: Run E2E tests
        run: bun run test:e2e
```

### With Docker

```yaml
name: Docker Tests

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1

      - name: Start application
        run: |
          docker-compose up -d
          sleep 10

      - name: Setup rpx
        run: |
          bunx @stacksjs/rpx \
            --from localhost:3000 \
            --to app.localhost &
          sleep 5

      - name: Run tests
        run: bun run test
```

## GitLab CI

### Basic Configuration

```yaml
# .gitlab-ci.yml
stages:
  - test

test:
  stage: test
  image: oven/bun:latest

  script:
    - bun install
    - bun run dev &
    - sleep 5
    - bunx @stacksjs/rpx --from localhost:3000 --to app.localhost &
    - sleep 2
    - bun test
```

### With Services

```yaml
test:
  stage: test
  image: oven/bun:latest

  services:
    - name: postgres:15
      alias: db

  variables:
    DATABASE_URL: postgres://postgres:postgres@db:5432/test

  script:
    - bun install

    # Start servers
    - bun run dev:api &
    - bun run dev:frontend &
    - sleep 10

    # Start rpx
    - |
      cat > rpx.config.ts << 'EOF'
      export default {
        proxies: [
          { from: 'localhost:3000', to: 'api.localhost' },
          { from: 'localhost:5173', to: 'app.localhost' },
        ],
      }
      EOF
    - bunx @stacksjs/rpx start &
    - sleep 5

    # Run tests
    - bun run test:e2e
```

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1

jobs:
  test:
    docker:
      - image: oven/bun:latest
      - image: postgres:15
        environment:
          POSTGRES_PASSWORD: postgres

    steps:
      - checkout

      - run:
          name: Install dependencies
          command: bun install

      - run:
          name: Start servers
          command: |
            bun run dev &
            sleep 5
          background: true

      - run:
          name: Start rpx
          command: |
            bunx @stacksjs/rpx \
              --from localhost:3000 \
              --to app.localhost &
            sleep 2
          background: true

      - run:
          name: Run tests
          command: bun test

workflows:
  test:
    jobs:
      - test
```

## Automated Testing

### E2E Test Configuration

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',

  use: {
    // Use rpx proxy URL
    baseURL: 'https://app.localhost',

    // Ignore SSL errors for self-signed certs
    ignoreHTTPSErrors: true,
  },

  webServer: {
    command: 'bunx @stacksjs/rpx start',
    url: 'https://app.localhost',
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: true,
  },
})
```

### Cypress Configuration

```ts
// cypress.config.ts
import { defineConfig } from 'cypress'

export default defineConfig({
  e2e: {
    baseUrl: 'https://app.localhost',
    chromeWebSecurity: false, // Allow self-signed certs

    setupNodeEvents(on, config) {
      // Start rpx before tests
      on('before:run', async () => {
        const { startProxy } = await import('@stacksjs/rpx')
        await startProxy({
          from: 'localhost:3000',
          to: 'app.localhost',
        })
      })
    },
  },
})
```

### Jest/Vitest Setup

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: './test/setup.ts',
  },
})

// test/setup.ts
import { startProxy } from '@stacksjs/rpx'

let proxy

export async function setup() {
  proxy = await startProxy({
    from: 'localhost:3000',
    to: 'app.localhost',
  })
}

export async function teardown() {
  await proxy?.stop()
}
```

## Container Integration

### Dockerfile

```dockerfile
# Dockerfile.test
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

# Install rpx globally
RUN bun add -g @stacksjs/rpx

# Start script that runs rpx and tests
CMD ["sh", "-c", "rpx start & sleep 5 && bun test"]
```

### Docker Compose

```yaml
# docker-compose.test.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=test

  proxy:
    image: oven/bun:latest
    command: bunx @stacksjs/rpx --from app:3000 --to app.localhost
    depends_on:
      - app
    ports:
      - "443:443"

  test:
    build:
      context: .
      dockerfile: Dockerfile.test
    depends_on:
      - proxy
    environment:
      - BASE_URL=https://proxy
```

## Continuous Deployment

### Pre-deployment Testing

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1

      - name: Test with production-like setup
        run: |
          bun install
          bun run build

          # Start preview server
          bun run preview &
          sleep 5

          # Test with rpx
          bunx @stacksjs/rpx \
            --from localhost:4173 \
            --to staging.myapp.com &
          sleep 2

          # Run smoke tests
          bun run test:smoke

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: echo "Deploy steps here"
```

### Staging Environment

```yaml
staging:
  runs-on: ubuntu-latest
  environment: staging

  steps:
    - uses: actions/checkout@v4

    - name: Deploy to staging
      run: |
        # Deploy application
        ./deploy.sh staging

    - name: Verify with rpx
      run: |
        bunx @stacksjs/rpx \
          --from staging.internal:3000 \
          --to staging.myapp.com &
        sleep 5

        # Run verification tests
        bun run test:verify
```

## Best Practices

### 1. Use Configuration Files

```yaml
# Store rpx config in repo
- name: Setup rpx config
  run: |
    cp .ci/rpx.config.ts ./rpx.config.ts
    bunx @stacksjs/rpx start &
```

### 2. Wait for Services

```yaml
- name: Wait for services
  run: |
    # Use wait-on or similar
    bunx wait-on https://app.localhost --timeout 60000
```

### 3. Cleanup

```yaml
- name: Cleanup
  if: always()
  run: |
    pkill -f rpx || true
    pkill -f "bun run dev" || true
```

### 4. Cache Dependencies

```yaml
- name: Cache node modules
  uses: actions/cache@v3
  with:
    path: ~/.bun/install/cache
    key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lockb') }}
```

## Troubleshooting CI Issues

### Certificate Trust

In CI environments, you may need to skip certificate verification:

```ts
// In tests
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
```

### Port Conflicts

Use unique ports in parallel jobs:

```yaml
strategy:
  matrix:
    port: [3000, 3001, 3002]

steps:
  - run: bunx @stacksjs/rpx --from localhost:${{ matrix.port }}
```

### DNS Resolution

For custom domains in containers:

```yaml
services:
  app:
    extra_hosts:
      - "app.localhost:127.0.0.1"
```

## Next Steps

- [Configuration](/advanced/configuration) - Advanced configuration options
- [Performance](/advanced/performance) - Performance testing in CI
- [Custom Middleware](/advanced/custom-middleware) - Test middleware
