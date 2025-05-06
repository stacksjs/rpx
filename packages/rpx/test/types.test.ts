import type {
  BaseProxyConfig,
  CleanupOptions,
  MultiProxyConfig,
  ProxyOption,
  ProxyOptions,
  SharedProxyConfig,
  SingleProxyConfig,
  SSLConfig,
  StartOptions,
  TlsOption,
} from '../src/types'
import { describe, expect, it } from 'bun:test'

describe('types', () => {
  // Test the types by creating instances and checking their structure

  describe('StartOptions', () => {
    it('should have the expected shape', () => {
      const startOptions: StartOptions = {
        command: 'npm run dev',
        cwd: '/tmp',
        env: { NODE_ENV: 'development' },
      }

      expect(startOptions.command).toBe('npm run dev')
      expect(startOptions.cwd).toBe('/tmp')
      expect(startOptions.env?.NODE_ENV).toBe('development')
    })
  })

  describe('BaseProxyConfig', () => {
    it('should have the expected shape', () => {
      const baseConfig: BaseProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        start: {
          command: 'npm run dev',
        },
      }

      expect(baseConfig.from).toBe('localhost:3000')
      expect(baseConfig.to).toBe('example.com')
      expect(baseConfig.start?.command).toBe('npm run dev')
    })
  })

  describe('CleanupOptions', () => {
    it('should have the expected shape', () => {
      const cleanupOptions: CleanupOptions = {
        domains: ['example.com', 'test.local'],
        hosts: true,
        certs: false,
        verbose: true,
      }

      expect(cleanupOptions.domains).toEqual(['example.com', 'test.local'])
      expect(cleanupOptions.hosts).toBe(true)
      expect(cleanupOptions.certs).toBe(false)
      expect(cleanupOptions.verbose).toBe(true)
    })
  })

  describe('SharedProxyConfig', () => {
    it('should have the expected shape', () => {
      const sharedConfig: SharedProxyConfig = {
        https: true,
        cleanup: {
          hosts: true,
        },
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      expect(sharedConfig.https).toBe(true)
      expect(sharedConfig.cleanup).toBeDefined()
      expect(typeof sharedConfig.cleanup).toBe('object')
      expect(sharedConfig.vitePluginUsage).toBe(false)
      expect(sharedConfig.verbose).toBe(true)
      expect(sharedConfig.cleanUrls).toBe(false)
    })

    it('supports TLS options', () => {
      const tlsOption: TlsOption = {
        certPath: '/tmp/cert.pem',
        keyPath: '/tmp/key.pem',
        caCertPath: '/tmp/ca.pem',
      }

      const sharedConfig: SharedProxyConfig = {
        https: tlsOption,
        vitePluginUsage: false,
        verbose: true,
        cleanup: false,
        cleanUrls: false,
      }

      expect(sharedConfig.https).toEqual(tlsOption)
    })
  })

  describe('SingleProxyConfig', () => {
    it('should combine base and shared configs', () => {
      const singleConfig: SingleProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        https: true,
        cleanup: true,
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      expect(singleConfig.from).toBe('localhost:3000')
      expect(singleConfig.to).toBe('example.com')
      expect(singleConfig.https).toBe(true)
      expect(singleConfig.cleanup).toBe(true)
      expect(singleConfig.vitePluginUsage).toBe(false)
      expect(singleConfig.verbose).toBe(true)
      expect(singleConfig.cleanUrls).toBe(false)
    })
  })

  describe('MultiProxyConfig', () => {
    it('should have proxies array with base configs', () => {
      const multiConfig: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
          { from: 'localhost:3001', to: 'app2.example.com', cleanUrls: true },
        ],
        https: true,
        cleanup: true,
        vitePluginUsage: false,
        verbose: true,
        cleanUrls: false,
      }

      expect(multiConfig.proxies.length).toBe(2)
      expect(multiConfig.proxies[0].from).toBe('localhost:3000')
      expect(multiConfig.proxies[0].to).toBe('app1.example.com')
      expect(multiConfig.proxies[1].from).toBe('localhost:3001')
      expect(multiConfig.proxies[1].to).toBe('app2.example.com')
      expect(multiConfig.https).toBe(true)
      expect(multiConfig.cleanup).toBe(true)
    })
  })

  describe('SSLConfig', () => {
    it('should have key and cert properties', () => {
      const sslConfig: SSLConfig = {
        key: '-----BEGIN PRIVATE KEY-----...',
        cert: '-----BEGIN CERTIFICATE-----...',
        ca: '-----BEGIN CERTIFICATE-----...',
      }

      expect(sslConfig.key).toBeDefined()
      expect(sslConfig.cert).toBeDefined()
      expect(sslConfig.ca).toBeDefined()
    })
  })

  describe('ProxyOption', () => {
    it('should support partial config', () => {
      const option: ProxyOption = {
        to: 'example.com',
        https: true,
      }

      expect(option.to).toBe('example.com')
      expect(option.https).toBe(true)
      expect(option.from).toBeUndefined()
    })
  })

  describe('ProxyOptions', () => {
    it('should support both single and multi configurations', () => {
      const singleOptions: ProxyOptions = {
        from: 'localhost:3000',
        to: 'example.com',
      }

      const multiOptions: ProxyOptions = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
          { from: 'localhost:3001', to: 'app2.example.com', cleanUrls: false },
        ],
      }

      expect(singleOptions.from).toBe('localhost:3000')
      expect(singleOptions.to).toBe('example.com')

      expect(Array.isArray(multiOptions.proxies)).toBe(true)
      expect(multiOptions.proxies?.length).toBe(2)
    })
  })
})
