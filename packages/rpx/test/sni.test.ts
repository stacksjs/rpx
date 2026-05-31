import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSniTlsConfig, serverNameFromCertFilename } from '../src/sni'

describe('serverNameFromCertFilename', () => {
  it('maps <domain>.crt to the domain', () => {
    expect(serverNameFromCertFilename('api.example.com.crt')).toBe('api.example.com')
  })

  it('maps _wildcard.<apex>.crt to *.<apex>', () => {
    expect(serverNameFromCertFilename('_wildcard.example.com.crt')).toBe('*.example.com')
  })

  it('ignores non-crt files', () => {
    expect(serverNameFromCertFilename('api.example.com.key')).toBeNull()
    expect(serverNameFromCertFilename('readme.txt')).toBeNull()
    expect(serverNameFromCertFilename('.crt')).toBeNull()
  })
})

describe('buildSniTlsConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-sni-test-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const writePair = async (base: string) => {
    await fsp.writeFile(path.join(dir, `${base}.crt`), `CERT:${base}`)
    await fsp.writeFile(path.join(dir, `${base}.key`), `KEY:${base}`)
  }

  it('builds entries from a certsDir convention', async () => {
    await writePair('api.example.com')
    await writePair('_wildcard.example.com')

    const entries = await buildSniTlsConfig({ certsDir: dir })
    const byName = new Map(entries.map(e => [e.serverName, e]))

    expect(byName.get('api.example.com')).toEqual({
      serverName: 'api.example.com',
      cert: 'CERT:api.example.com',
      key: 'KEY:api.example.com',
    })
    expect(byName.get('*.example.com')).toEqual({
      serverName: '*.example.com',
      cert: 'CERT:_wildcard.example.com',
      key: 'KEY:_wildcard.example.com',
    })
  })

  it('skips a cert whose key file is missing', async () => {
    await fsp.writeFile(path.join(dir, 'broken.example.com.crt'), 'CERT')
    const entries = await buildSniTlsConfig({ certsDir: dir })
    expect(entries.find(e => e.serverName === 'broken.example.com')).toBeUndefined()
  })

  it('explicit domains map takes precedence over certsDir', async () => {
    await writePair('api.example.com')
    const certPath = path.join(dir, 'explicit.crt')
    const keyPath = path.join(dir, 'explicit.key')
    await fsp.writeFile(certPath, 'EXPLICIT-CERT')
    await fsp.writeFile(keyPath, 'EXPLICIT-KEY')

    const entries = await buildSniTlsConfig({
      certsDir: dir,
      domains: { 'api.example.com': { certPath, keyPath } },
    })
    const api = entries.find(e => e.serverName === 'api.example.com')
    expect(api?.cert).toBe('EXPLICIT-CERT')
    expect(api?.key).toBe('EXPLICIT-KEY')
  })

  it('returns an empty array when nothing is usable', async () => {
    const entries = await buildSniTlsConfig({ certsDir: path.join(dir, 'does-not-exist') })
    expect(entries).toEqual([])
  })
})
