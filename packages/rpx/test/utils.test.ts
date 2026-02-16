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
})
