import { afterEach, describe, expect, it, mock } from 'bun:test'
import { config } from '../src/config'
import * as Hosts from '../src/hosts'
import * as Https from '../src/https'
import * as Start from '../src/start'

// Simplified test that just verifies exports and basic functionality
describe('Integration', () => {
  // Guard: nothing here should outlive the file (see #2270).
  afterEach(() => {
    mock.restore()
  })

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
    // These were spied "to avoid system calls", but the spies were only ever
    // asserted on — never invoked — so they bought nothing and leaked no-op
    // stubs onto `../src/hosts` for the rest of the run (#2270). Assert on the
    // real exports instead.
    expect(Hosts.addHosts).toBeDefined()
    expect(Hosts.checkHosts).toBeDefined()
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
    expect(patterns).not.toContain('*.com')
  })
})
