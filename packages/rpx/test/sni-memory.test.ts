import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { log } from '../src/logger'
import { buildListenerTls, capTlsContexts, DEFAULT_MAX_TLS_CONTEXTS, withLowMemoryTls } from '../src/sni'

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

function entries(n: number, prefix = 'host'): Array<{ serverName: string, cert: string, key: string }> {
  return Array.from({ length: n }, (_, i) => ({ serverName: `${prefix}${i}.test`, cert: `cert${i}`, key: `key${i}` }))
}

describe('maxTlsContexts memory guard', () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    warnSpy?.mockRestore()
    warnSpy = undefined
  })

  it('defaults to 256 contexts', () => {
    expect(DEFAULT_MAX_TLS_CONTEXTS).toBe(256)
    warnSpy = spyOn(log, 'warn').mockImplementation(() => {})
    expect(capTlsContexts(entries(256))).toHaveLength(256)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(capTlsContexts(entries(257))).toHaveLength(256)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('returns the input untouched when it fits', () => {
    warnSpy = spyOn(log, 'warn').mockImplementation(() => {})
    const input = entries(3)
    expect(capTlsContexts(input, 3)).toBe(input)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('keeps the first N entries and logs ONE warning naming every dropped host', () => {
    warnSpy = spyOn(log, 'warn').mockImplementation(() => {})
    const kept = capTlsContexts(entries(5), 2)
    expect(kept.map(e => e.serverName)).toEqual(['host0.test', 'host1.test'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('maxTlsContexts=2')
    for (const dropped of ['host2.test', 'host3.test', 'host4.test'])
      expect(message).toContain(dropped)
    expect(message).not.toContain('host1.test,')
  })

  it('falls back to the default for a nonsensical limit', () => {
    warnSpy = spyOn(log, 'warn').mockImplementation(() => {})
    expect(capTlsContexts(entries(300), 0)).toHaveLength(256)
    expect(capTlsContexts(entries(300), Number.NaN)).toHaveLength(256)
  })
})

describe('buildListenerTls', () => {
  it('puts the default context first, without a serverName, and caps the named entries', () => {
    const warnSpy = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const tls = buildListenerTls({
        sni: entries(4),
        defaultTls: { cert: 'default-cert', key: 'default-key' },
        maxTlsContexts: 3,
      })
      expect(tls).toHaveLength(4)
      expect(tls[0]).toEqual({ cert: 'default-cert', key: 'default-key', lowMemoryMode: true })
      expect('serverName' in tls[0]).toBe(false)
      expect(tls.slice(1).map(e => e.serverName)).toEqual(['host0.test', 'host1.test', 'host2.test'])
      expect(tls.every(e => e.lowMemoryMode === true)).toBe(true)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    }
    finally {
      warnSpy.mockRestore()
    }
  })

  it('emits only named entries when there is no default context', () => {
    const tls = buildListenerTls({ sni: entries(2) })
    expect(tls.map(e => e.serverName)).toEqual(['host0.test', 'host1.test'])
  })
})
