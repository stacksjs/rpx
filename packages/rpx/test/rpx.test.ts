import { beforeAll, describe, expect, it } from 'bun:test'

describe('@stacksjs/rpx', () => {
  beforeAll(() => {
    process.env.APP_ENV = 'test'
  })

  it('exports required modules', async () => {
    const rpx = await import('../src')

    // Verify all exports
    expect(rpx.config).toBeDefined()
    expect(rpx.startProxies).toBeDefined()
    expect(typeof rpx.startProxies).toBe('function')
    expect(rpx.startProxy).toBeDefined()
    expect(typeof rpx.startProxy).toBe('function')
    expect(rpx.cleanup).toBeDefined()
    expect(typeof rpx.cleanup).toBe('function')

    // Make sure utility functions are exported
    expect(rpx.extractHostname).toBeDefined()
    expect(typeof rpx.extractHostname).toBe('function')
    expect(rpx.getPrimaryDomain).toBeDefined()
    expect(typeof rpx.getPrimaryDomain).toBe('function')

    // Check that type guards are exported
    expect(rpx.isMultiProxyConfig).toBeDefined()
    expect(typeof rpx.isMultiProxyConfig).toBe('function')
    expect(rpx.isSingleProxyConfig).toBeDefined()
    expect(typeof rpx.isSingleProxyConfig).toBe('function')

    // Check host management functions
    expect(rpx.addHosts).toBeDefined()
    expect(typeof rpx.addHosts).toBe('function')
    expect(rpx.removeHosts).toBeDefined()
    expect(typeof rpx.removeHosts).toBe('function')

    // Check HTTPS configuration functions
    expect(rpx.generateSSLPaths).toBeDefined()
    expect(typeof rpx.generateSSLPaths).toBe('function')
    expect(rpx.httpsConfig).toBeDefined()
    expect(typeof rpx.httpsConfig).toBe('function')
  })

  it('has default export as startProxies function', async () => {
    const defaultExport = await import('../src').then(mod => mod.default)
    const { startProxies } = await import('../src/start')

    expect(defaultExport).toBe(startProxies)
  })
})
