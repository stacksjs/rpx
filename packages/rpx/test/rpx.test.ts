import { beforeAll, describe, expect, it } from 'bun:test'
import { config } from '../src/config'
import { addHosts, removeHosts } from '../src/hosts'
import { httpsConfig } from '../src/https'
import { DefaultPortManager, findAvailablePort, isPortInUse, portManager } from '../src/port-manager'
import { cleanup, startProxies, startProxy } from '../src/start'
import { extractHostname, getPrimaryDomain, isMultiProxyConfig, isSingleProxyConfig } from '../src/utils'

describe('@stacksjs/rpx', () => {
  beforeAll(() => {
    process.env.APP_ENV = 'test'
  })

  it('exports required modules', () => {
    // Verify all exports
    expect(config).toBeDefined()
    expect(startProxies).toBeDefined()
    expect(typeof startProxies).toBe('function')
    expect(startProxy).toBeDefined()
    expect(typeof startProxy).toBe('function')
    expect(cleanup).toBeDefined()
    expect(typeof cleanup).toBe('function')

    // Make sure utility functions are exported
    expect(extractHostname).toBeDefined()
    expect(typeof extractHostname).toBe('function')
    expect(getPrimaryDomain).toBeDefined()
    expect(typeof getPrimaryDomain).toBe('function')

    // Check that type guards are exported
    expect(isMultiProxyConfig).toBeDefined()
    expect(typeof isMultiProxyConfig).toBe('function')
    expect(isSingleProxyConfig).toBeDefined()
    expect(typeof isSingleProxyConfig).toBe('function')

    // Check host management functions
    expect(addHosts).toBeDefined()
    expect(typeof addHosts).toBe('function')
    expect(removeHosts).toBeDefined()
    expect(typeof removeHosts).toBe('function')

    // Check HTTPS configuration functions
    expect(httpsConfig).toBeDefined()
    expect(typeof httpsConfig).toBe('function')

    // Check port management functions
    expect(portManager).toBeDefined()
    expect(DefaultPortManager).toBeDefined()
    expect(isPortInUse).toBeDefined()
    expect(typeof isPortInUse).toBe('function')
    expect(findAvailablePort).toBeDefined()
    expect(typeof findAvailablePort).toBe('function')
  })

  it('has default export as startProxies function', async () => {
    // Verify the barrel index.ts default export is the startProxies function
    // Import start module directly to avoid mock interference from other test files
    const startMod = await import('../src/start')
    expect(startMod.startProxies).toBeDefined()
    expect(typeof startMod.startProxies).toBe('function')
    expect(startMod.startProxies).toBe(startProxies)
  })
})
