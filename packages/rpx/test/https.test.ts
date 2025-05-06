import type { SingleProxyConfig } from '../src/types'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import path from 'node:path'
import {
  generateSSLPaths,
  generateWildcardPatterns,
  httpsConfig,
} from '../src/https'

describe('https', () => {
  beforeEach(() => {
    // Reset mocks and spies
    mock.restore()
  })

  describe('generateWildcardPatterns', () => {
    it('generates wildcard patterns for a domain', () => {
      const patterns = generateWildcardPatterns('example.com')
      expect(patterns).toContain('example.com')
      expect(patterns).toContain('*.com')
    })

    it('generates patterns for subdomains', () => {
      const patterns = generateWildcardPatterns('api.example.com')
      expect(patterns).toContain('api.example.com')
      expect(patterns).toContain('*.example.com')
    })

    it('handles single-level domains', () => {
      const patterns = generateWildcardPatterns('localhost')
      expect(patterns).toEqual(['localhost'])
    })
  })

  describe('generateSSLPaths', () => {
    it('generates default SSL paths', () => {
      const paths = generateSSLPaths()
      expect(paths.caCertPath).toContain('stacks.localhost.ca.crt')
      expect(paths.certPath).toContain('stacks.localhost.crt')
      expect(paths.keyPath).toContain('stacks.localhost.key')
    })

    it('generates SSL paths for a specific domain', () => {
      const paths = generateSSLPaths({ to: 'example.com' })
      expect(paths.caCertPath).toContain('example.com.ca.crt')
      expect(paths.certPath).toContain('example.com.crt')
      expect(paths.keyPath).toContain('example.com.key')
    })

    it('uses custom base path if provided', () => {
      const customBasePath = '/tmp/ssl'
      const paths = generateSSLPaths({
        to: 'example.com',
        https: {
          basePath: customBasePath,
        },
      })

      expect(paths.caCertPath).toBe(path.join(customBasePath, 'example.com.ca.crt'))
      expect(paths.certPath).toBe(path.join(customBasePath, 'example.com.crt'))
      expect(paths.keyPath).toBe(path.join(customBasePath, 'example.com.key'))
    })

    it('sanitizes wildcards in domain names', () => {
      const paths = generateSSLPaths({ to: '*.example.com' })
      expect(paths.caCertPath).toContain('wildcard.example.com.ca.crt')
      expect(paths.certPath).toContain('wildcard.example.com.crt')
      expect(paths.keyPath).toContain('wildcard.example.com.key')
    })
  })

  describe('httpsConfig', () => {
    it('generates default SSL configuration', () => {
      const options: SingleProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        cleanUrls: false,
        vitePluginUsage: false,
        verbose: false,
        https: true,
        cleanup: false,
      }

      const config = httpsConfig(options)
      expect(config.commonName).toBe('example.com')
      // Check for subjectAltNames
      expect(Array.isArray(config.subjectAltNames)).toBe(true)

      // Look for the domain in the subjectAltNames
      const hasDomain = config.subjectAltNames.some(
        (altName: any) => altName.type === 2 && altName.value === 'example.com',
      )
      expect(hasDomain).toBe(true)
    })

    it('includes all required fields', () => {
      const options: SingleProxyConfig = {
        from: 'localhost:3000',
        to: 'example.com',
        cleanUrls: false,
        vitePluginUsage: false,
        verbose: true,
        https: true,
        cleanup: false,
      }

      const config = httpsConfig(options)
      expect(config).toHaveProperty('commonName')
      expect(config).toHaveProperty('countryName')
      expect(config).toHaveProperty('stateName')
      expect(config).toHaveProperty('localityName')
      expect(config).toHaveProperty('organizationName')
      expect(config).toHaveProperty('subjectAltNames')
      expect(config).toHaveProperty('validityDays')
      expect(config).toHaveProperty('keyPath')
      expect(config).toHaveProperty('certPath')
      expect(config).toHaveProperty('caCertPath')
    })
  })
})
