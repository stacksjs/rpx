/**
 * LAN production mode: a Raspberry Pi serving `pi-stacks.local` and a private
 * IP over HTTPS from a Root CA rpx owns, next to public domains on ACME.
 *
 * Pins: the CA is created once and reused; ONE leaf carries every host as a
 * dNSName SAN and every IP as an iPAddress (type 7) SAN; the leaf is the
 * listener's DEFAULT TLS context so an IP-literal connection with no SNI still
 * gets it; the leaf is re-minted near expiry or when the SAN set grows; and no
 * ACME order is ever attempted for a `.local` host.
 */
import type { OnDemandCertManager } from '../src/on-demand'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import {
  ensureLocalCa,
  leafRenewalReason,
  LOCAL_CA_LEAF_CERT_FILENAME,
  LOCAL_CA_LEAF_KEY_FILENAME,
  localCaPaths,
  parseSanNames,
  resolveLocalCaConfig,
} from '../src/local-ca'
import * as Start from '../src/start'
import { collectRouteEntries, createSharedProxyServer } from '../src/start'

const HOSTS = ['pi-stacks.local', 'pi.home.arpa']
const IP = '192.168.1.20'
const DAY = 24 * 60 * 60 * 1000

let dir: string | undefined

afterEach(async () => {
  if (dir)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  dir = undefined
})

async function freshDir(): Promise<string> {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-local-ca-'))
  return dir
}

/** Peer certificate presented for a TLS connection with the given SNI (or none). */
function peerCert(port: number, servername?: string): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      resolve(cert)
    })
    socket.on('error', reject)
  })
}

describe('resolveLocalCaConfig', () => {
  it('normalizes hosts and IPs', () => {
    const resolved = resolveLocalCaConfig({ dir: '/tmp/x', hosts: [' Pi-Stacks.local ', 'pi-stacks.local'], ips: [IP, IP] })
    expect(resolved.hosts).toEqual(['pi-stacks.local'])
    expect(resolved.ips).toEqual([IP])
    expect(resolved.validityDays).toBe(825)
    expect(resolved.renewBeforeDays).toBe(30)
    expect(resolved.installTrust).toBe(false)
  })

  it('rejects an empty host list, an IP in hosts, and a bad IP', () => {
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: [] })).toThrow(/at least one host/)
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: [IP] })).toThrow(/not a hostname/)
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['*.local'] })).toThrow(/not a hostname/)
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['a.local'], ips: ['999.1.1.1'] })).toThrow(/not an IP address/)
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['a.local'], validityDays: 10, renewBeforeDays: 10 })).toThrow(/renewBeforeDays/)
  })

  it('is a config error for a host to be both LAN-only and in a public on-demand set', () => {
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['app.example.com'] }, { enabled: true, allowedSuffixes: ['example.com'] }))
      .toThrow(/overlap on app.example.com/)
    // A disabled on-demand block claims nothing.
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['app.example.com'] }, { enabled: false, allowedSuffixes: ['example.com'] }))
      .not
      .toThrow()
    expect(() => resolveLocalCaConfig({ dir: '/tmp/x', hosts: ['pi-stacks.local'] }, { enabled: true, allowedSuffixes: ['example.com'] }))
      .not
      .toThrow()
  })
})

describe('ensureLocalCa', () => {
  it('creates the CA once (key 0600) and reuses CA and leaf on the next start', async () => {
    const d = await freshDir()
    const first = await ensureLocalCa({ dir: d, hosts: HOSTS, ips: [IP] })
    expect(first.caCreated).toBe(true)
    expect(first.leafMinted).toBe(true)
    expect(first.renewalReason).toBe('no leaf on disk')
    const paths = localCaPaths(d)
    expect(first.paths).toEqual(paths)
    expect(path.basename(paths.certPath)).toBe(LOCAL_CA_LEAF_CERT_FILENAME)
    expect(path.basename(paths.keyPath)).toBe(LOCAL_CA_LEAF_KEY_FILENAME)
    if (process.platform !== 'win32') {
      expect((await fsp.stat(paths.caKeyPath)).mode & 0o777).toBe(0o600)
      expect((await fsp.stat(paths.keyPath)).mode & 0o777).toBe(0o600)
    }

    const second = await ensureLocalCa({ dir: d, hosts: HOSTS, ips: [IP] })
    expect(second.caCreated).toBe(false)
    expect(second.leafMinted).toBe(false)
    expect(second.renewalReason).toBeNull()
    expect(second.caCert).toBe(first.caCert)
    expect(second.cert).toBe(first.cert)
    expect(second.key).toBe(first.key)
    expect(await fsp.readFile(paths.caCertPath, 'utf8')).toBe(first.caCert)
  })

  it('mints ONE leaf with a dNSName SAN per host and the IP as an iPAddress (type 7) SAN, signed by the CA', async () => {
    const d = await freshDir()
    const material = await ensureLocalCa({ dir: d, hosts: HOSTS, ips: [IP] })
    const leaf = new X509Certificate(material.cert)
    const ca = new X509Certificate(material.caCert)

    // Signature, not a name match (Bun's checkIssued returns the cert object).
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(ca.ca).toBe(true)
    const san = parseSanNames(leaf.subjectAltName)
    for (const host of HOSTS)
      expect(san.dns.has(host)).toBe(true)
    expect(san.ips.has(IP)).toBe(true)
    expect(leaf.subjectAltName).toContain(`IP Address:${IP}`)
    // GeneralName iPAddress is context tag [7]: 0x87, length 4, the octets.
    expect(leaf.raw.includes(Buffer.from([0x87, 0x04, 192, 168, 1, 20]))).toBe(true)

    // Every host maps to the same leaf, and the default context is that leaf.
    expect(material.entries.map(e => e.serverName)).toEqual(HOSTS)
    expect(material.entries.every(e => e.cert === material.cert && e.key === material.key)).toBe(true)
    expect(material.defaultTls).toEqual({ cert: material.cert, key: material.key })
    const daysValid = (new Date(leaf.validTo).getTime() - Date.now()) / DAY
    expect(daysValid).toBeGreaterThan(820)
  })

  it('re-mints the leaf when fewer than renewBeforeDays remain', async () => {
    const d = await freshDir()
    // tlsx backdates notBefore by a couple of days, so the windows below keep
    // a few days of slack on either side of the 30-day renewal threshold.
    const cfg = { dir: d, hosts: HOSTS, ips: [IP], validityDays: 60, renewBeforeDays: 30 }
    const first = await ensureLocalCa(cfg)
    // Ten days in: roughly 48 left, not under the window yet.
    const later = await ensureLocalCa(cfg, { now: () => new Date(Date.now() + 10 * DAY) })
    expect(later.leafMinted).toBe(false)
    // Thirty-five days in: roughly 23 left, under the window.
    const renewed = await ensureLocalCa(cfg, { now: () => new Date(Date.now() + 35 * DAY) })
    expect(renewed.leafMinted).toBe(true)
    expect(renewed.renewalReason).toMatch(/day\(s\) left, under renewBeforeDays=30/)
    expect(renewed.cert).not.toBe(first.cert)
    expect(renewed.caCert).toBe(first.caCert)
    expect(await fsp.readFile(localCaPaths(d).certPath, 'utf8')).toBe(renewed.cert)
  })

  it('re-mints the leaf when a host or IP is added to the config', async () => {
    const d = await freshDir()
    const first = await ensureLocalCa({ dir: d, hosts: [HOSTS[0]] })
    const withIp = await ensureLocalCa({ dir: d, hosts: [HOSTS[0]], ips: [IP] })
    expect(withIp.leafMinted).toBe(true)
    expect(withIp.renewalReason).toContain(`missing IP SAN(s): ${IP}`)
    expect(withIp.cert).not.toBe(first.cert)
    const withHost = await ensureLocalCa({ dir: d, hosts: HOSTS, ips: [IP] })
    expect(withHost.leafMinted).toBe(true)
    expect(withHost.renewalReason).toContain('missing DNS SAN(s): pi.home.arpa')
  })

  it('leafRenewalReason rejects a leaf from another CA', async () => {
    const d = await freshDir()
    const a = await ensureLocalCa({ dir: path.join(d, 'a'), hosts: HOSTS })
    const b = await ensureLocalCa({ dir: path.join(d, 'b'), hosts: HOSTS })
    expect(leafRenewalReason({ cert: a.cert, key: a.key, caCert: b.caCert }, { hosts: HOSTS, ips: [], renewBeforeDays: 30 })).toBe('not issued by the current Root CA')
    expect(leafRenewalReason({ cert: a.cert, key: b.key, caCert: a.caCert }, { hosts: HOSTS, ips: [], renewBeforeDays: 30 })).toBe('private key does not match the certificate')
    expect(leafRenewalReason({ cert: a.cert, key: a.key, caCert: a.caCert }, { hosts: HOSTS, ips: [], renewBeforeDays: 30 })).toBeNull()
  })
})

describe('default TLS context on the shared listener', () => {
  it('presents the local leaf to a connection with no SNI and to an unknown SNI, alongside a public SNI cert', async () => {
    const d = await freshDir()
    const local = await ensureLocalCa({ dir: d, hosts: HOSTS, ips: [IP] })
    // A second, unrelated SNI cert (what a public on-demand domain looks like).
    const pubKey = path.join(d, 'app.example.com.key')
    const pubCrt = path.join(d, 'app.example.com.crt')
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', pubKey, '-out', pubCrt, '-days', '1', '-nodes', '-subj', '/CN=app.example.com'])
    const pub = { serverName: 'app.example.com', cert: await fsp.readFile(pubCrt, 'utf8'), key: await fsp.readFile(pubKey, 'utf8') }

    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('lan-upstream') })
    const routeEntries = await collectRouteEntries([
      { from: `127.0.0.1:${upstream.port}`, to: HOSTS[0], cleanUrls: false },
      { from: `127.0.0.1:${upstream.port}`, to: 'app.example.com', cleanUrls: false },
    ], false, false)
    // Public cert deliberately FIRST in the SNI array: without an explicit
    // default, Bun would present it to every no-SNI connection.
    const server = createSharedProxyServer({
      routeEntries,
      listenPort: 0,
      sslConfig: [pub, ...local.entries],
      defaultTls: local.defaultTls,
      originGuard: null,
      verbose: false,
    })
    expect(server).not.toBeNull()
    const port = server!.port as number

    try {
      const noSni = await peerCert(port)
      expect(noSni.subject.CN).toBe(HOSTS[0])
      expect(String(noSni.subjectaltname)).toContain(`IP Address:${IP}`)

      const unknownSni = await peerCert(port, 'stranger.example.org')
      expect(unknownSni.subject.CN).toBe(HOSTS[0])

      const byHost = await peerCert(port, HOSTS[1])
      expect(byHost.subject.CN).toBe(HOSTS[0])

      const publicHost = await peerCert(port, 'app.example.com')
      expect(publicHost.subject.CN).toBe('app.example.com')

      // The IP-literal request (no SNI) is proxied like any other.
      const res = await fetch(`https://127.0.0.1:${port}/`, { headers: { host: HOSTS[0] }, tls: { rejectUnauthorized: false } })
      expect(await res.text()).toBe('lan-upstream')
    }
    finally {
      server!.stop(true)
      upstream.stop(true)
    }
  })
})

describe('startProxies with localCa', () => {
  it('registers the leaf per host and as the default context, keeps public ACME, and never asks ACME for a .local host', async () => {
    const d = await freshDir()
    const certsDir = path.join(d, 'certs')
    await fsp.mkdir(certsDir)
    Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(certsDir, 'app.example.com.key'), '-out', path.join(certsDir, 'app.example.com.crt'), '-days', '1', '-nodes', '-subj', '/CN=app.example.com'])

    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    const redirectSpy = spyOn(Start, 'startHttpRedirectServer').mockImplementation(() => {})
    createSharedSpy.mockClear()
    redirectSpy.mockClear()
    try {
      await Start.startProxies({
        proxies: [
          { from: 'localhost:3000', to: HOSTS[0] },
          { from: 'localhost:3000', to: 'app.example.com' },
        ],
        https: true,
        httpsPort: 47543,
        httpPort: 47180,
        productionCerts: { certsDir },
        onDemandTls: { enabled: true, allowedSuffixes: ['example.com'], certsDir },
        localCa: { dir: path.join(d, 'local-ca'), hosts: HOSTS, ips: [IP] },
        cleanup: false,
        vitePluginUsage: false,
        verbose: false,
        cleanUrls: false,
      } as any)

      expect(createSharedSpy).toHaveBeenCalled()
      const [opts] = createSharedSpy.mock.calls[createSharedSpy.mock.calls.length - 1] as [{ sslConfig: Array<{ serverName: string, cert: string }>, defaultTls?: { cert: string } | null }]
      const names = opts.sslConfig.map(e => e.serverName)
      // Local hosts lead the set (never dropped by the memory cap); the public
      // cert is still there.
      expect(names.slice(0, HOSTS.length)).toEqual(HOSTS)
      expect(names).toContain('app.example.com')
      expect(opts.defaultTls).toBeTruthy()
      expect(opts.defaultTls!.cert).toBe(opts.sslConfig[0].cert)
      expect(new X509Certificate(opts.defaultTls!.cert).subjectAltName).toContain(`IP Address:${IP}`)

      // The on-demand manager was seeded with the local leaf: the .local host
      // is "already covered", so the :80 path never kicks issuance for it, and
      // it is not in the allowlist either, so it could never be approved.
      expect(redirectSpy).toHaveBeenCalled()
      const onDemand = redirectSpy.mock.calls[0][4] as OnDemandCertManager
      expect(onDemand.hasCert(HOSTS[0])).toBe(true)
      expect(onDemand.hasCert(HOSTS[1])).toBe(true)
      expect(onDemand.hasCert('app.example.com')).toBe(true)
      expect(await onDemand.isApproved(HOSTS[0])).toBe(false)
      expect(await onDemand.ensureCert(HOSTS[0])).toBe(true)
      expect(onDemand.sniEntries().find(e => e.serverName === HOSTS[0])!.cert).toBe(opts.defaultTls!.cert)
    }
    finally {
      createSharedSpy.mockRestore()
      redirectSpy.mockRestore()
    }
  })

  it('rejects a host claimed by both localCa and the on-demand allowlist before binding anything', async () => {
    const d = await freshDir()
    const createSharedSpy = spyOn(Start, 'createSharedProxyServer').mockImplementation(() => null)
    createSharedSpy.mockClear()
    try {
      await expect(Start.startProxies({
        proxies: [{ from: 'localhost:3000', to: 'app.example.com' }],
        https: true,
        httpsPort: 47544,
        httpPort: 47181,
        onDemandTls: { enabled: true, allowedSuffixes: ['example.com'] },
        localCa: { dir: d, hosts: ['app.example.com'] },
        cleanup: false,
        verbose: false,
      } as any)).rejects.toThrow(/overlap on app.example.com/)
      expect(createSharedSpy).not.toHaveBeenCalled()
      // Nothing was minted for a config that never validated.
      expect(await fsp.readdir(d)).toEqual([])
    }
    finally {
      createSharedSpy.mockRestore()
    }
  })
})
