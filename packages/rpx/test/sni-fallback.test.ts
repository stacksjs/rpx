/**
 * A name the gateway holds no certificate for must not be answered with some
 * other tenant's certificate. Production saw `a.b.hq.training` (deeper than
 * the `*.hq.training` wildcard covers) get `trifit.stacksjs.com`, simply
 * because Bun falls back to the first SNI entry. These tests run real
 * handshakes against Bun.serve to pin what Bun's SNI match actually does.
 */
import type { SniTlsEntry } from '../src/sni'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { buildListenerTls, deepWildcardAliases, fallbackTlsContext, FALLBACK_TLS_COMMON_NAME } from '../src/sni'

const entry = (serverName: string): SniTlsEntry => ({ serverName, cert: `CERT:${serverName}`, key: `KEY:${serverName}` })

describe('deepWildcardAliases', () => {
  it('offers a wildcard certificate two labels deeper than it covers', () => {
    expect(deepWildcardAliases([entry('*.example.com')])).toEqual([
      { serverName: '*.*.example.com', cert: 'CERT:*.example.com', key: 'KEY:*.example.com' },
      { serverName: '*.*.*.example.com', cert: 'CERT:*.example.com', key: 'KEY:*.example.com' },
    ])
  })

  it('adds nothing for exact names', () => {
    expect(deepWildcardAliases([entry('example.com'), entry('api.example.com')])).toEqual([])
  })

  it('never shadows a name that is already loaded, nor repeats one', () => {
    const aliases = deepWildcardAliases([entry('*.example.com'), entry('*.*.example.com')])
    expect(aliases.map(a => a.serverName)).toEqual(['*.*.*.example.com', '*.*.*.*.example.com'])
    expect(aliases[0].cert).toBe('CERT:*.example.com')
  })
})

describe('buildListenerTls deep wildcard aliases', () => {
  it('appends the aliases after the real entries', () => {
    const tlsList = buildListenerTls({ sni: [entry('example.com'), entry('*.example.com')] })
    expect(tlsList.map(t => t.serverName)).toEqual(['example.com', '*.example.com', '*.*.example.com', '*.*.*.example.com'])
  })

  it('keeps the aliases inside maxTlsContexts', () => {
    const tlsList = buildListenerTls({ sni: [entry('example.com'), entry('*.example.com')], maxTlsContexts: 3 })
    expect(tlsList.map(t => t.serverName)).toEqual(['example.com', '*.example.com', '*.*.example.com'])
  })
})

describe('fallbackTlsContext', () => {
  it('mints one neutral self-signed certificate per process', async () => {
    const first = await fallbackTlsContext()
    expect(first).not.toBeNull()
    expect(await fallbackTlsContext()).toBe(first)
    const cert = new X509Certificate(first!.cert)
    expect(cert.subject).toContain(`CN=${FALLBACK_TLS_COMMON_NAME}`)
    expect(cert.subjectAltName).toBe(`DNS:${FALLBACK_TLS_COMMON_NAME}`)
  })
})

describe('listener certificate for unmatched names (real handshakes)', () => {
  let dir: string
  let server: ReturnType<typeof Bun.serve>
  let unnamedServer: ReturnType<typeof Bun.serve>

  const pair = async (serverName: string): Promise<SniTlsEntry> => {
    const base = serverName.replace('*', '_wildcard')
    const keyPath = path.join(dir, `${base}.key`)
    const certPath = path.join(dir, `${base}.crt`)
    const res = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', `/CN=${serverName}`])
    if (res.exitCode !== 0)
      throw new Error(`openssl failed: ${res.stderr.toString()}`)
    return { serverName, cert: await fsp.readFile(certPath, 'utf8'), key: await fsp.readFile(keyPath, 'utf8') }
  }

  /** CN of the certificate the listener presents for `servername`. */
  const presented = (port: number, servername?: string): Promise<string> => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
      resolve(String(socket.getPeerCertificate().subject?.CN ?? ''))
      socket.end()
    })
    socket.on('error', reject)
  })

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-sni-fallback-'))
    // The unrelated tenant goes FIRST, as readdir happened to order it on the
    // production gateway.
    const sni = [
      await pair('trifit.example.net'),
      await pair('*.hq.example'),
      await pair('hq.example'),
      await pair('*.team.hq.example'),
    ]
    const fetch = (): Response => new Response('ok')
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: buildListenerTls({ sni, defaultTls: await fallbackTlsContext() }), fetch })
    unnamedServer = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: buildListenerTls({ sni }), fetch })
  })

  afterAll(async () => {
    server?.stop(true)
    unnamedServer?.stop(true)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('reproduces the bug without a default: Bun answers with the first entry', async () => {
    expect(await presented(unnamedServer.port as number, 'unknown.example.org')).toBe('trifit.example.net')
  })

  it('still serves exact and one-label wildcard matches', async () => {
    const port = server.port as number
    expect(await presented(port, 'hq.example')).toBe('hq.example')
    expect(await presented(port, 'app.hq.example')).toBe('*.hq.example')
    expect(await presented(port, 'trifit.example.net')).toBe('trifit.example.net')
  })

  it('answers a name deeper than a wildcard with that wildcard, not another tenant', async () => {
    const port = server.port as number
    expect(await presented(port, 'a.b.hq.example')).toBe('*.hq.example')
    expect(await presented(port, 'a.b.c.hq.example')).toBe('*.hq.example')
  })

  it('prefers a closer wildcard over a deep alias', async () => {
    const port = server.port as number
    expect(await presented(port, 'x.team.hq.example')).toBe('*.team.hq.example')
    expect(await presented(port, 'a.x.team.hq.example')).toBe('*.team.hq.example')
  })

  it('answers unknown names and no-SNI clients with the neutral certificate', async () => {
    const port = server.port as number
    expect(await presented(port, 'unknown.example.org')).toBe(FALLBACK_TLS_COMMON_NAME)
    expect(await presented(port, 'sub.trifit.example.net')).toBe(FALLBACK_TLS_COMMON_NAME)
    expect(await presented(port, 'a.b.c.d.hq.example')).toBe(FALLBACK_TLS_COMMON_NAME)
    expect(await presented(port)).toBe(FALLBACK_TLS_COMMON_NAME)
  })
})
