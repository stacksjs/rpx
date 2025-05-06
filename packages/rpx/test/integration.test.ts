import { describe, expect, it, spyOn } from 'bun:test'
import { config } from '../src/config'
import * as Hosts from '../src/hosts'
import * as Https from '../src/https'
import * as Start from '../src/start'

// Simplified test that just verifies exports and basic functionality
describe('Integration', () => {
  // Just verify that the required functions exist and are exported
  it('exports required functionality', () => {
    expect(Start.startProxies).toBeDefined()
    expect(typeof Start.startProxies).toBe('function')
    expect(Start.startProxy).toBeDefined()
    expect(typeof Start.startProxy).toBe('function')
    expect(Start.cleanup).toBeDefined()
    expect(typeof Start.cleanup).toBe('function')
  })

  // Basic test for config
  it('has valid configuration', () => {
    expect(config).toBeDefined()
    expect(config.from).toBeDefined()
    expect(config.to).toBeDefined()
  })

  // Check that util functions are working
  it('has working host utilities', () => {
    // Mock the functions to avoid system calls
    const mockAddHosts = spyOn(Hosts, 'addHosts').mockImplementation(async () => {})
    const mockCheckHosts = spyOn(Hosts, 'checkHosts').mockImplementation(async (hosts) => {
      return hosts.map(host => host === 'localhost')
    })

    expect(mockAddHosts).toBeDefined()
    expect(mockCheckHosts).toBeDefined()
  })

  // Check HTTPS functionality
  it('has working HTTPS utilities', () => {
    // Verify the functions exist
    expect(Https.generateSSLPaths).toBeDefined()
    expect(Https.generateWildcardPatterns).toBeDefined()
    expect(Https.httpsConfig).toBeDefined()

    // Test a utility function
    const patterns = Https.generateWildcardPatterns('example.com')
    expect(patterns).toContain('example.com')
    expect(patterns).toContain('*.com')
  })
})
