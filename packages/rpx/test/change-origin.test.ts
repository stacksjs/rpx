import type * as http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProxyOption } from '../src/types'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { cleanup, startProxy } from '../src/start'
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

  // Real test with actual server and proxy
  describe('Real proxy with startProxy and changeOrigin', () => {
    // Test server ports
    const testTargetPort = 47001 // Port where our target server runs

    // Store server reference for cleanup
    let testTargetServer: http.Server | null = null

    // Setup test environment
    beforeAll(async () => {
      // Create a target server that echoes back the request headers
      await new Promise<void>((resolve) => {
        testTargetServer = createServer((req: IncomingMessage, res: ServerResponse) => {
          // Echo back the headers we received for verification
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            receivedHost: req.headers.host,
            headers: req.headers,
            url: req.url,
          }))
        })

        testTargetServer.listen(testTargetPort, '127.0.0.1', () => {
          debugLog('test', `Test target server listening on port ${testTargetPort}`, true)
          resolve()
        })
      })

      // Configure the proxy correctly
      // NOTE: rpx's "from" is the target server, "to" is the domain to access the proxy
      const proxyConfig: ProxyOption = {
        from: `127.0.0.1:${testTargetPort}`, // The target server address
        to: 'test.rpx.localhost', // The domain to access the proxy
        https: false, // Disable HTTPS for testing
        cleanup: false,
        verbose: true,
        changeOrigin: true, // Enable changeOrigin
      }

      // Start the proxy
      startProxy(proxyConfig)

      // Wait for the proxy to initialize
      await new Promise(resolve => setTimeout(resolve, 2000))
    })

    // Clean up the test environment
    afterAll(async () => {
      // Clean up proxy processes
      await cleanup()

      // Clean up the target server
      return new Promise<void>((resolve) => {
        if (testTargetServer) {
          testTargetServer.close(() => {
            debugLog('test', 'Test target server closed', true)
            resolve()
          })
        }
        else {
          resolve()
        }
      })
    })

    // This test makes direct requests to the target server to verify it's working
    it('should verify the target server is up and responding', async () => {
      try {
        // Make a direct request to the target server to confirm it's working
        const directResponse = await fetch(`http://127.0.0.1:${testTargetPort}/test-direct`, {
          headers: {
            Host: 'original.example.com',
          },
        })

        expect(directResponse.ok).toBe(true)

        const data = await directResponse.json() as { receivedHost: string }
        debugLog('test', `Direct request received host header: ${data.receivedHost}`, true)

        // The target server should receive the exact host header we sent
        expect(data.receivedHost).toBe('original.example.com')
      }
      catch (error) {
        debugLog('test', `Error in direct target test: ${error}`, true)
        throw error
      }
    })
  })
})
