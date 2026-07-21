import { describe, expect, it } from 'bun:test'
import { withLowMemoryTls } from '../src/sni'

describe('TLS memory configuration', () => {
  it('enables released OpenSSL buffers for a single certificate', () => {
    const tls = withLowMemoryTls({ key: 'key', cert: 'cert' })

    expect(tls).toEqual({ key: 'key', cert: 'cert', lowMemoryMode: true })
  })

  it('enables released OpenSSL buffers for every SNI certificate', () => {
    const tls = withLowMemoryTls([
      { serverName: 'one.test', key: 'one-key', cert: 'one-cert' },
      { serverName: 'two.test', key: 'two-key', cert: 'two-cert' },
    ])

    expect(tls.every(entry => entry.lowMemoryMode === true)).toBe(true)
    expect(tls.map(entry => entry.serverName)).toEqual(['one.test', 'two.test'])
  })
})
