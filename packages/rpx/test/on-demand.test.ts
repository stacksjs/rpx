import type { CertIssuer } from '../src/on-demand'
import type { SniTlsEntry } from '../src/sni'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { isLikelyHostname, matchesAllowedSuffix, OnDemandCertManager } from '../src/on-demand'

/** A fake issuer that returns deterministic PEMs and records calls. */
function fakeIssuer(): { issuer: CertIssuer, calls: string[][] } {
  const calls: string[][] = []
  const issuer: CertIssuer = async (opts) => {
    calls.push(opts.domains)
    return {
      certPem: `cert:${opts.domains[0]}`,
      keyPem: `key:${opts.domains[0]}`,
      chainPem: '',
      fullChainPem: `fullchain:${opts.domains[0]}`,
      accountKeyPem: 'acct',
      notAfter: new Date(Date.now() + 90 * 86_400_000),
    }
  }
  return { issuer, calls }
}

describe('matchesAllowedSuffix', () => {
  it('matches an exact host', () => {
    expect(matchesAllowedSuffix('example.com', ['example.com'])).toBe(true)
  })
  it('matches a subdomain of a suffix', () => {
    expect(matchesAllowedSuffix('a.example.com', ['example.com'])).toBe(true)
    expect(matchesAllowedSuffix('a.b.example.com', ['example.com'])).toBe(true)
  })
  it('does not match an unrelated host', () => {
    expect(matchesAllowedSuffix('evil.com', ['example.com'])).toBe(false)
  })
  it('does not partial-match a non-boundary suffix', () => {
    // notexample.com must NOT match suffix example.com
    expect(matchesAllowedSuffix('notexample.com', ['example.com'])).toBe(false)
  })
  it('tolerates a leading dot in the suffix', () => {
    expect(matchesAllowedSuffix('a.example.com', ['.example.com'])).toBe(true)
  })
  it('refuses when there are no suffixes', () => {
    expect(matchesAllowedSuffix('example.com', [])).toBe(false)
    expect(matchesAllowedSuffix('example.com', undefined)).toBe(false)
  })
})

describe('isLikelyHostname', () => {
  it('accepts a real FQDN', () => {
    expect(isLikelyHostname('app.example.com')).toBe(true)
  })
  it('rejects bare labels, wildcards, ports, paths', () => {
    expect(isLikelyHostname('localhost')).toBe(false)
    expect(isLikelyHostname('*.example.com')).toBe(false)
    expect(isLikelyHostname('example.com:443')).toBe(false)
    expect(isLikelyHostname('example.com/x')).toBe(false)
    expect(isLikelyHostname('')).toBe(false)
  })
})

describe('OnDemandCertManager.ensureCert', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-ondemand-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('is a no-op resolving false when disabled', async () => {
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      config: { enabled: false, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
    })
    expect(await m.ensureCert('a.example.com')).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('issues for an allowedSuffixes-approved host and adds it to the SNI set', async () => {
    const { issuer, calls } = fakeIssuer()
    const added: SniTlsEntry[][] = []
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
      onCertAdded: e => void added.push(e),
    })
    expect(await m.ensureCert('app.example.com')).toBe(true)
    expect(calls).toEqual([['app.example.com']])
    expect(m.hasCert('app.example.com')).toBe(true)
    expect(m.sniEntries().map(e => e.serverName)).toContain('app.example.com')
    // PEMs are persisted to certsDir as <host>.{crt,key}
    expect(await fsp.readFile(path.join(dir, 'app.example.com.crt'), 'utf8')).toBe('fullchain:app.example.com')
    expect(await fsp.readFile(path.join(dir, 'app.example.com.key'), 'utf8')).toBe('key:app.example.com')
    // rebuild callback fired once with the augmented set
    expect(added.length).toBe(1)
    expect(added[0].some(e => e.serverName === 'app.example.com')).toBe(true)
  })

  it('refuses a host rejected by ask (and never issues)', async () => {
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      config: { enabled: true, ask: host => host === 'good.example.com' },
      certsDir: dir,
      issuer,
    })
    expect(await m.ensureCert('bad.example.com')).toBe(false)
    expect(calls.length).toBe(0)
    expect(m.hasCert('bad.example.com')).toBe(false)
  })

  it('issues a host approved by ask', async () => {
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      config: { enabled: true, ask: host => host === 'good.example.com' },
      certsDir: dir,
      issuer,
    })
    expect(await m.ensureCert('good.example.com')).toBe(true)
    expect(calls).toEqual([['good.example.com']])
  })

  it('de-dupes concurrent ensureCert for the same host (one ACME order)', async () => {
    let resolveIssue!: () => void
    const gate = new Promise<void>((r) => { resolveIssue = r })
    const calls: string[][] = []
    const issuer: CertIssuer = async (opts) => {
      calls.push(opts.domains)
      await gate // hold all callers until released
      return {
        certPem: 'c',
        keyPem: 'k',
        chainPem: '',
        fullChainPem: 'fc',
        accountKeyPem: 'a',
        notAfter: new Date(),
      }
    }
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
    })
    const all = Promise.all([
      m.ensureCert('x.example.com'),
      m.ensureCert('x.example.com'),
      m.ensureCert('x.example.com'),
    ])
    resolveIssue()
    const results = await all
    expect(results).toEqual([true, true, true])
    // Only one underlying issuance ran despite three concurrent callers.
    expect(calls.length).toBe(1)
  })

  it('no-ops when a cert is already present in the seeded SNI set', async () => {
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
      initial: [{ serverName: 'seeded.example.com', cert: 'c', key: 'k' }],
    })
    expect(await m.ensureCert('seeded.example.com')).toBe(true)
    expect(calls.length).toBe(0)
  })

  it('adopts an existing on-disk cert without calling ACME', async () => {
    await fsp.writeFile(path.join(dir, 'ondisk.example.com.crt'), 'disk-cert')
    await fsp.writeFile(path.join(dir, 'ondisk.example.com.key'), 'disk-key')
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
    })
    expect(await m.ensureCert('ondisk.example.com')).toBe(true)
    expect(calls.length).toBe(0)
    expect(m.sniEntries().find(e => e.serverName === 'ondisk.example.com')?.cert).toBe('disk-cert')
  })

  it('negatively caches a failed issuance so it does not hammer the CA', async () => {
    let attempts = 0
    const issuer: CertIssuer = async () => {
      attempts++
      throw new Error('boom')
    }
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
      negativeCacheMs: 10_000,
    })
    expect(await m.ensureCert('fail.example.com')).toBe(false)
    expect(await m.ensureCert('fail.example.com')).toBe(false)
    // Second call short-circuits on the negative cache — only one real attempt.
    expect(attempts).toBe(1)
  })

  it('adopts an externally placed on-disk cert even while negatively cached', async () => {
    let attempts = 0
    const issuer: CertIssuer = async () => {
      attempts++
      throw new Error('boom')
    }
    const m = new OnDemandCertManager({
      config: { enabled: true, allowedSuffixes: ['example.com'] },
      certsDir: dir,
      issuer,
      negativeCacheMs: 10_000,
    })
    expect(await m.ensureCert('fixed.example.com')).toBe(false)
    expect(attempts).toBe(1)
    // Operator recovers out-of-band (e.g. `tlsx acme:issue`) while the failure
    // is still negatively cached.
    await fsp.writeFile(path.join(dir, 'fixed.example.com.crt'), 'disk-cert')
    await fsp.writeFile(path.join(dir, 'fixed.example.com.key'), 'disk-key')
    expect(await m.ensureCert('fixed.example.com')).toBe(true)
    expect(m.sniEntries().find(e => e.serverName === 'fixed.example.com')?.cert).toBe('disk-cert')
    // The negative cache still gated ACME: no further issuance attempt ran.
    expect(attempts).toBe(1)
  })

  it('refuses obviously-invalid hostnames before approval/issuance', async () => {
    const { issuer, calls } = fakeIssuer()
    const m = new OnDemandCertManager({
      // ask would approve anything, but the hostname guard rejects first.
      config: { enabled: true, ask: () => true },
      certsDir: dir,
      issuer,
    })
    expect(await m.ensureCert('localhost')).toBe(false)
    expect(await m.ensureCert('*.example.com')).toBe(false)
    expect(calls.length).toBe(0)
  })
})
