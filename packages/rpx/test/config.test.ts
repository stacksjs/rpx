import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config, defaultConfig } from '../src/config'

describe('config', () => {
  it('has expected default properties', () => {
    expect(defaultConfig).toHaveProperty('from')
    expect(defaultConfig).toHaveProperty('to')
    expect(defaultConfig).toHaveProperty('cleanUrls')
    expect(defaultConfig).toHaveProperty('https')
    expect(defaultConfig).toHaveProperty('cleanup')
    expect(defaultConfig).toHaveProperty('vitePluginUsage')
    expect(defaultConfig).toHaveProperty('verbose')
  })

  it('has correct default values', () => {
    expect(defaultConfig.from).toBe('localhost:5173')
    expect(defaultConfig.to).toBe('stacks.localhost')
    expect(defaultConfig.cleanUrls).toBe(false)
    expect(defaultConfig.vitePluginUsage).toBe(false)
    expect(defaultConfig.verbose).toBe(true)
  })

  it('has correct SSL paths', () => {
    const sslBase = join(homedir(), '.stacks', 'ssl')

    expect(defaultConfig.https.caCertPath).toBe(join(sslBase, 'stacks.localhost.ca.crt'))
    expect(defaultConfig.https.certPath).toBe(join(sslBase, 'stacks.localhost.crt'))
    expect(defaultConfig.https.keyPath).toBe(join(sslBase, 'stacks.localhost.crt.key'))
  })

  it('exports the loaded config', () => {
    expect(config).toBeDefined()
    expect(config.from).toBeDefined()
    expect(config.to).toBeDefined()
  })
})
