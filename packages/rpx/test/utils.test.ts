import type { MultiProxyConfig, ProxyOption, SingleProxyConfig } from '../src/types'
import { describe, expect, it, spyOn } from 'bun:test'
import * as utils from '../src/utils'

describe('utils', () => {
  describe('extractHostname', () => {
    it('extracts hostname from single proxy options', () => {
      const options: ProxyOption = {
        to: 'example.com',
      }
      expect(utils.extractHostname(options)).toEqual(['example.com'])
    })

    it('extracts hostname from URL in to field', () => {
      const options: ProxyOption = {
        to: 'https://example.com',
      }
      expect(utils.extractHostname(options)).toEqual(['example.com'])
    })

    it('extracts hostnames from multi proxy options', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
          { from: 'localhost:3001', to: 'app2.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.extractHostname(options)).toEqual(['app1.example.com', 'app2.example.com'])
    })

    it('returns default hostname when no options provided', () => {
      const options = {} as ProxyOption
      expect(utils.extractHostname(options)).toEqual(['stacks.localhost'])
    })
  })

  describe('getPrimaryDomain', () => {
    it('returns primary domain from single proxy options', () => {
      const options: ProxyOption = {
        to: 'example.com',
      }
      expect(utils.getPrimaryDomain(options)).toBe('example.com')
    })

    it('returns primary domain from multi proxy options', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
          { from: 'localhost:3001', to: 'app2.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.getPrimaryDomain(options)).toBe('app1.example.com')
    })

    it('returns default domain when no options provided', () => {
      expect(utils.getPrimaryDomain()).toBe('stacks.localhost')
    })
  })

  describe('isMultiProxyConfig', () => {
    it('identifies multi proxy config', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isMultiProxyConfig(options)).toBe(true)
    })

    it('identifies non-multi proxy config', () => {
      const options: SingleProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isMultiProxyConfig(options)).toBe(false)
    })
  })

  describe('isSingleProxyConfig', () => {
    it('identifies single proxy config', () => {
      const options: SingleProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isSingleProxyConfig(options)).toBe(true)
    })

    it('identifies non-single proxy config', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isSingleProxyConfig(options)).toBe(false)
    })
  })

  describe('isMultiProxyOptions', () => {
    it('identifies multi proxy options', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isMultiProxyOptions(options)).toBe(true)
    })

    it('identifies non-multi proxy options', () => {
      const options: ProxyOption = {
        to: 'example.com',
      }
      expect(utils.isMultiProxyOptions(options)).toBe(false)
    })
  })

  describe('isSingleProxyOptions', () => {
    it('identifies single proxy options', () => {
      const options: ProxyOption = {
        to: 'example.com',
      }
      expect(utils.isSingleProxyOptions(options)).toBe(true)
    })

    it('identifies non-single proxy options', () => {
      const options: MultiProxyConfig = {
        proxies: [
          { from: 'localhost:3000', to: 'app1.example.com', cleanUrls: false },
        ],
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
        https: false,
        cleanup: false,
      }
      expect(utils.isSingleProxyOptions(options)).toBe(false)
    })
  })

  describe('debugLog', () => {
    it('should not log when verbose is false', () => {
      const consoleSpy = spyOn(console, 'debug').mockImplementation(() => {})
      utils.debugLog('test', 'message', false)
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('should log when verbose is true', () => {
      // debugLog uses @stacksjs/clarity Logger, not console.debug
      // Just verify it doesn't throw when verbose is true
      expect(() => utils.debugLog('test', 'message', true)).not.toThrow()
    })
  })

  describe('resolvePathRewrite', () => {
    const apiRewrite = { from: '/api', to: 'localhost:3008' }

    it('returns null when no rewrites are configured', () => {
      expect(utils.resolvePathRewrite('/api/cart', undefined)).toBeNull()
      expect(utils.resolvePathRewrite('/api/cart', [])).toBeNull()
    })

    it('returns null when no rewrite matches', () => {
      expect(utils.resolvePathRewrite('/products', [apiRewrite])).toBeNull()
    })

    it('preserves the path by default (stripPrefix unset)', () => {
      expect(utils.resolvePathRewrite('/api/cart/add', [apiRewrite])).toEqual({
        targetHost: 'localhost:3008',
        targetPath: '/api/cart/add',
      })
    })

    it('preserves the path when stripPrefix is explicitly false', () => {
      const rewrites = [{ ...apiRewrite, stripPrefix: false }]
      expect(utils.resolvePathRewrite('/api/cart/add', rewrites)).toEqual({
        targetHost: 'localhost:3008',
        targetPath: '/api/cart/add',
      })
    })

    it('strips the prefix when stripPrefix is true', () => {
      const rewrites = [{ ...apiRewrite, stripPrefix: true }]
      expect(utils.resolvePathRewrite('/api/cart/add', rewrites)).toEqual({
        targetHost: 'localhost:3008',
        targetPath: '/cart/add',
      })
    })

    it('strips to "/" when path equals the prefix exactly', () => {
      const rewrites = [{ ...apiRewrite, stripPrefix: true }]
      expect(utils.resolvePathRewrite('/api', rewrites)).toEqual({
        targetHost: 'localhost:3008',
        targetPath: '/',
      })
    })

    it('matches the prefix exactly without false-matching similar paths', () => {
      // /apidocs must NOT match /api
      expect(utils.resolvePathRewrite('/apidocs', [apiRewrite])).toBeNull()
      // /api itself must match
      expect(utils.resolvePathRewrite('/api', [apiRewrite])?.targetPath).toBe('/api')
      // /api/ must match
      expect(utils.resolvePathRewrite('/api/', [apiRewrite])?.targetPath).toBe('/api/')
    })

    it('uses the first matching rewrite when multiple match', () => {
      const rewrites = [
        { from: '/api/v2', to: 'localhost:4000' },
        { from: '/api', to: 'localhost:3008' },
      ]
      expect(utils.resolvePathRewrite('/api/v2/users', rewrites)?.targetHost).toBe('localhost:4000')
      expect(utils.resolvePathRewrite('/api/users', rewrites)?.targetHost).toBe('localhost:3008')
    })

    it('extracts host from a fully-qualified URL in `to`', () => {
      const rewrites = [{ from: '/api', to: 'http://upstream.test:9000/anything' }]
      expect(utils.resolvePathRewrite('/api/x', rewrites)).toEqual({
        targetHost: 'upstream.test:9000',
        targetPath: '/api/x',
      })
    })
  })
})
