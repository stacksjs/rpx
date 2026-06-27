import type * as http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { createSharedProxyServer } from '../src/start'
import { debugLog } from '../src/utils'

/**
 * Integration test suite for the changeOrigin feature
 *
 * This file focuses on testing the changeOrigin feature in real-world scenarios
 * with actual HTTP servers and proxies.
 */
describe('changeOrigin feature integration', () => {
  describe('Header modification with live HTTP servers', () => {
    // Use high port number to avoid conflicts
    const targetPort = 49001
    let targetServer: http.Server | null = null

    // Store received headers for verification
    let receivedHeaders: http.IncomingHttpHeaders = {}

    // Setup target server that logs received headers
    beforeAll(async () => {
      return new Promise<void>((resolve) => {
        targetServer = createServer((req: IncomingMessage, res: ServerResponse) => {
          // Store headers for verification
          receivedHeaders = req.headers

          // Send a response with the headers we received
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            receivedHost: req.headers.host,
            allHeaders: req.headers,
          }))
        })

        targetServer.listen(targetPort, '127.0.0.1', () => {
          debugLog('test', `Target server listening on port ${targetPort}`, true)
          resolve()
        })
      })
    })

    // Clean up server after tests
    afterAll(async () => {
      return new Promise<void>((resolve) => {
        if (targetServer) {
          targetServer.close(() => {
            debugLog('test', 'Target server closed', true)
            resolve()
          })
        }
        else {
          resolve()
        }
      })
    })

    // Reset headers between tests
    afterEach(() => {
      receivedHeaders = {}
    })

    it('should preserve custom host headers in direct requests', async () => {
      // This test verifies baseline behavior without a proxy
      const customHost = 'example.test.host'

      // Make a direct request to our target server with a custom host header
      const response = await fetch(`http://127.0.0.1:${targetPort}/test-path`, {
        headers: {
          Host: customHost,
        },
      })

      const data = await response.json() as { receivedHost: string }

      // Verify the target server received our custom host header
      expect(data.receivedHost).toBe(customHost)
      expect(receivedHeaders.host).toBe(customHost)
    })

    // This test simulates what would happen in the actual proxy code
    it('should simulate changeOrigin behavior using the actual header modification', async () => {
      // Test with changeOrigin=true
      const customHost = 'original.host.header'
      const targetUrlHostname = '127.0.0.1'

      // First, make a request that simulates changeOrigin=false (preserves host)
      const responseWithoutChange = await fetch(`http://127.0.0.1:${targetPort}/test-path`, {
        headers: {
          Host: customHost,
        },
      })

      const dataWithoutChange = await responseWithoutChange.json() as { receivedHost: string }

      // Verify host is preserved (like changeOrigin=false would do)
      expect(dataWithoutChange.receivedHost).toBe(customHost)

      // Now simulate what happens with changeOrigin=true by setting the header to match the target
      const responseWithChange = await fetch(`http://127.0.0.1:${targetPort}/test-path`, {
        headers: {
          Host: `${targetUrlHostname}:${targetPort}`,
        },
      })

      const dataWithChange = await responseWithChange.json() as { receivedHost: string }

      // Verify host is changed to match the target (like changeOrigin=true would do)
      expect(dataWithChange.receivedHost).toBe(`${targetUrlHostname}:${targetPort}`)
      expect(receivedHeaders.host).toBe(`${targetUrlHostname}:${targetPort}`)
    })

    // Test preserving other headers when changing the host
    it('should preserve all other request headers when changing host header', async () => {
      const targetUrlHostname = '127.0.0.1'

      // Make a request with multiple custom headers
      const _ = await fetch(`http://127.0.0.1:${targetPort}/test-headers`, {
        headers: {
          'Host': `${targetUrlHostname}:${targetPort}`, // Simulating changeOrigin=true
          'X-Custom-Header': 'custom-value',
          'Accept-Language': 'en-US',
          'User-Agent': 'Test-Client/1.0',
        },
      })

      // Verify all headers were preserved
      expect(receivedHeaders.host).toBe(`${targetUrlHostname}:${targetPort}`)
      expect(receivedHeaders['x-custom-header']).toBe('custom-value')
      expect(receivedHeaders['accept-language']).toBe('en-US')
      expect(receivedHeaders['user-agent']).toBe('Test-Client/1.0')
    })
  })

  // Real end-to-end test: proxy through rpx's shared request handler on an
  // ephemeral port (no privileged ports, DNS, or sudo side effects) and assert
  // that changeOrigin actually rewrites the upstream-facing Origin header. This
  // exercises the same handler the single-proxy, multi-proxy, single-port and
  // daemon paths all use.
  describe('Real proxy through the shared handler with changeOrigin', () => {
    let upstream: ReturnType<typeof Bun.serve>

    beforeAll(() => {
      // Upstream echoes back the host/origin it received so we can verify rewrites.
      upstream = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req: Request) {
          return new Response(JSON.stringify({
            receivedHost: req.headers.get('host'),
            receivedOrigin: req.headers.get('origin'),
          }), { headers: { 'content-type': 'application/json' } })
        },
      })
    })

    afterAll(() => {
      upstream.stop(true)
    })

    it('rewrites the Origin to the upstream when changeOrigin is true', async () => {
      const sourceHost = `127.0.0.1:${upstream.port}`
      const proxy = createSharedProxyServer({
        routeEntries: [{ host: 'test.rpx.localhost', route: { sourceHost, changeOrigin: true } }],
        listenPort: 0,
        sslConfig: null,
        originGuard: null,
        verbose: false,
      })
      expect(proxy).not.toBeNull()
      try {
        const res = await fetch(`http://127.0.0.1:${proxy!.port}/path`, {
          headers: { host: 'test.rpx.localhost', origin: 'https://original.example.com' },
        })
        const data = await res.json() as { receivedHost: string, receivedOrigin: string }
        // rpx always forwards the upstream host; changeOrigin additionally
        // rewrites Origin to the upstream target.
        expect(data.receivedHost).toBe(sourceHost)
        expect(data.receivedOrigin).toBe(`http://${sourceHost}`)
      }
      finally {
        proxy!.stop(true)
      }
    })

    it('preserves the client Origin when changeOrigin is false', async () => {
      const sourceHost = `127.0.0.1:${upstream.port}`
      const proxy = createSharedProxyServer({
        routeEntries: [{ host: 'test.rpx.localhost', route: { sourceHost, changeOrigin: false } }],
        listenPort: 0,
        sslConfig: null,
        originGuard: null,
        verbose: false,
      })
      try {
        const res = await fetch(`http://127.0.0.1:${proxy!.port}/path`, {
          headers: { host: 'test.rpx.localhost', origin: 'https://original.example.com' },
        })
        const data = await res.json() as { receivedOrigin: string }
        expect(data.receivedOrigin).toBe('https://original.example.com')
      }
      finally {
        proxy!.stop(true)
      }
    })
  })
})
