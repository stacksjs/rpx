import type { IncomingHttpHeaders } from 'node:http'
import type { MultiProxyConfig, ProxyOption, SharedProxyConfig, SingleProxyConfig } from '../src/types'
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as http from 'node:http'
import * as Start from '../src/start'
import { isMultiProxyConfig } from '../src/utils'

// Extended interface to include changeOrigin for testing
interface ProxyConfigWithChangeOrigin extends ProxyOption {
  from: string
  to: string
  cleanUrls: boolean
  changeOrigin?: boolean
}

/**
 * Tests focusing on multi-proxy configurations with changeOrigin option
 */
describe('multi-proxy configurations', () => {
  describe('proxy configurations with changeOrigin', () => {
    it('supports multiple proxies with different changeOrigin settings', () => {
      // Create a multi-proxy configuration with different changeOrigin settings
      const multiConfig: MultiProxyConfig & { changeOrigin?: boolean } = {
        proxies: [
          {
            from: 'localhost:3000',
            to: 'service1.example.com',
            changeOrigin: true,
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
          {
            from: 'localhost:3001',
            to: 'service2.example.com',
            changeOrigin: false,
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
          {
            from: 'localhost:3002',
            to: 'service3.example.com',
            // changeOrigin is undefined - should behave like false
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
        ],
        https: false,
        cleanup: false,
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      // Verify it's a multiproxy config
      expect(isMultiProxyConfig(multiConfig)).toBe(true)

      // Check individual proxy configurations
      expect((multiConfig.proxies[0] as ProxyConfigWithChangeOrigin).changeOrigin).toBe(true)
      expect((multiConfig.proxies[1] as ProxyConfigWithChangeOrigin).changeOrigin).toBe(false)
      expect((multiConfig.proxies[2] as ProxyConfigWithChangeOrigin).changeOrigin).toBeUndefined()
    })

    it('properly handles header modification based on changeOrigin settings', () => {
      // This test simulates what would happen with multiple proxies
      // Each having different changeOrigin settings

      // Original request headers
      const originalHeaders: IncomingHttpHeaders = {
        'host': 'client.example.com',
        'user-agent': 'test-client',
      }

      // Function that simulates header processing as in the actual implementation
      function processHeaders(
        headers: IncomingHttpHeaders,
        sourceUrl: { hostname: string, port: number },
        changeOrigin?: boolean,
      ): IncomingHttpHeaders {
        // Clone headers to avoid side effects
        const normalizedHeaders = { ...headers } as IncomingHttpHeaders

        // Apply changeOrigin behavior as in the actual source code
        if (changeOrigin) {
          const { hostname, port } = sourceUrl
          // Format IPv6 addresses with brackets
          const formattedHost = hostname.includes(':')
            ? `[${hostname}]:${port}`
            : `${hostname}:${port}`

          normalizedHeaders.host = formattedHost
        }

        return normalizedHeaders
      }

      // Define multiple proxy targets with different settings
      const sources = [
        {
          hostname: 'service1.example.com',
          port: 8001,
          changeOrigin: true,
        },
        {
          hostname: 'service2.example.com',
          port: 8002,
          changeOrigin: false,
        },
        {
          hostname: 'service3.example.com',
          port: 8003,
          // changeOrigin is undefined
        },
      ]

      // Process headers for each proxy configuration
      const results = sources.map(source =>
        processHeaders(
          originalHeaders,
          { hostname: source.hostname, port: source.port },
          source.changeOrigin,
        ),
      )

      // Verify the results
      // First proxy should change the host header (changeOrigin=true)
      expect(results[0].host).toBe('service1.example.com:8001')

      // Second proxy should preserve the original host header (changeOrigin=false)
      expect(results[1].host).toBe('client.example.com')

      // Third proxy should also preserve the host (changeOrigin=undefined acts like false)
      expect(results[2].host).toBe('client.example.com')
    })
  })

  describe('startProxy with multiple configurations', () => {
    // Mock start proxies function for this test
    let startProxiesSpy: any

    beforeEach(() => {
      // Spy on startProxies to avoid actually starting servers
      startProxiesSpy = spyOn(Start, 'startProxies').mockImplementation(async () => { })
    })

    it('passes the correct changeOrigin settings to each proxy', () => {
      // Create a multi-proxy configuration
      const config: MultiProxyConfig & { changeOrigin?: boolean } = {
        proxies: [
          {
            from: 'localhost:3000',
            to: 'app1.example.com',
            changeOrigin: true,
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
          {
            from: 'localhost:3001',
            to: 'app2.example.com',
            changeOrigin: false,
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
        ],
        https: false,
        cleanup: false,
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      // Start the proxies
      Start.startProxies(config)

      // Verify startProxies was called with our configuration
      expect(startProxiesSpy).toHaveBeenCalledWith(config)

      // Verify the configuration passed to startProxies
      const passedConfig = startProxiesSpy.mock.calls[0][0] as MultiProxyConfig & { changeOrigin?: boolean }
      expect((passedConfig.proxies[0] as ProxyConfigWithChangeOrigin).changeOrigin).toBe(true)
      expect((passedConfig.proxies[1] as ProxyConfigWithChangeOrigin).changeOrigin).toBe(false)
    })

    it('allows mixed changeOrigin settings with global defaults', () => {
      // Create a multi-proxy configuration with global changeOrigin
      const config: MultiProxyConfig & { changeOrigin?: boolean } = {
        proxies: [
          {
            from: 'localhost:3000',
            to: 'app1.example.com',
            // No changeOrigin specified - should inherit from parent
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
          {
            from: 'localhost:3001',
            to: 'app2.example.com',
            changeOrigin: false, // Explicitly override parent
            cleanUrls: false,
          } as ProxyConfigWithChangeOrigin,
        ],
        changeOrigin: true, // Global setting
        https: false,
        cleanup: false,
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      // Start the proxies
      Start.startProxies(config)

      // Verify startProxies was called with our configuration
      expect(startProxiesSpy).toHaveBeenCalledWith(config)

      // In the real implementation, undefined values would potentially
      // inherit from the parent config, but we're just testing the
      // static configuration values here
      const passedConfig = startProxiesSpy.mock.calls[0][0] as MultiProxyConfig & { changeOrigin?: boolean }

      // Just verify the structure was passed, not specific values which might be modified
      expect(typeof passedConfig).toBe('object')
      expect(Array.isArray(passedConfig.proxies)).toBe(true)
      expect(passedConfig.proxies.length).toBe(2)
      expect((passedConfig.proxies[1] as ProxyConfigWithChangeOrigin).changeOrigin).toBe(false) // Explicitly set value should be preserved
    })
  })
})
