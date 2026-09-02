/**
 * LAN production mode: HTTPS for hosts public ACME can never certify.
 *
 * A Raspberry Pi on a home or office network answers `pi-stacks.local` and a
 * private IP. Let's Encrypt will not issue for either, so rpx runs its own
 * Root CA under `localCa.dir`, mints ONE leaf naming every configured host
 * (dNSName SAN) and IP (iPAddress SAN), serves it under each host's SNI name
 * AND as the listener's default TLS context (an IP-literal URL sends no SNI),
 * and re-mints it before it expires. Public domains on the same box keep
 * their on-demand ACME certs; the two sets never overlap.
 */
import type { CertificateOptions } from '@stacksjs/tlsx'
import type { DefaultTlsContext, SniTlsEntry } from './sni'
import type { LocalCaConfig, OnDemandTlsConfig } from './types'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { isIP } from 'node:net'
import * as path from 'node:path'
import * as tlsx from '@stacksjs/tlsx'
import { ensureRootCA, getRootCAPaths, isCertTrusted } from './https'
import { log } from './logger'
import { matchesAllowedSuffix } from './on-demand'
import { debugLog } from './utils'

export const LOCAL_CA_LEAF_CERT_FILENAME = 'rpx-local-host.crt'
export const LOCAL_CA_LEAF_KEY_FILENAME = 'rpx-local-host.key'
/** Common name of the Root CA rpx mints for a LAN gateway. */
export const LOCAL_CA_COMMON_NAME = 'rpx Local CA'
export const DEFAULT_LOCAL_CA_VALIDITY_DAYS = 825
export const DEFAULT_LOCAL_CA_RENEW_BEFORE_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface LocalCaPaths {
  caCertPath: string
  caKeyPath: string
  certPath: string
  keyPath: string
}

/** Where the CA and the leaf live inside `dir`. */
export function localCaPaths(dir: string): LocalCaPaths {
  const ca = getRootCAPaths(dir)
  return {
    caCertPath: ca.caCertPath,
    caKeyPath: ca.caKeyPath,
    certPath: path.join(dir, LOCAL_CA_LEAF_CERT_FILENAME),
    keyPath: path.join(dir, LOCAL_CA_LEAF_KEY_FILENAME),
  }
}

export interface ResolvedLocalCaConfig {
  dir: string
  hosts: string[]
  ips: string[]
  installTrust: boolean
  validityDays: number
  renewBeforeDays: number
}

/**
 * Normalize and validate a {@link LocalCaConfig}. Throws on an empty host
 * list, a malformed host or IP, and on any host that a public on-demand set
 * also claims (the two flows would fight over one SNI name, and ACME would be
 * asked for a name it can never issue).
 */
export function resolveLocalCaConfig(cfg: LocalCaConfig, onDemandTls?: OnDemandTlsConfig): ResolvedLocalCaConfig {
  if (!cfg || typeof cfg.dir !== 'string' || cfg.dir.trim() === '')
    throw new Error('localCa.dir is required')

  const hosts = [...new Set((cfg.hosts ?? []).map(h => String(h).trim().toLowerCase()).filter(Boolean))]
  if (hosts.length === 0)
    throw new Error('localCa.hosts must name at least one host')
  for (const host of hosts) {
    if (host.startsWith('*') || host.includes('/') || host.includes(':') || host.includes(' ') || isIP(host) !== 0)
      throw new Error(`localCa.hosts entry ${JSON.stringify(host)} is not a hostname (wildcards are not supported; put IP addresses in localCa.ips)`)
  }

  const ips = [...new Set((cfg.ips ?? []).map(ip => String(ip).trim()).filter(Boolean))]
  for (const ip of ips) {
    if (isIP(ip) === 0)
      throw new Error(`localCa.ips entry ${JSON.stringify(ip)} is not an IP address`)
  }

  if (onDemandTls?.enabled) {
    const clash = hosts.filter(host => matchesAllowedSuffix(host, onDemandTls.allowedSuffixes))
    if (clash.length > 0)
      throw new Error(`localCa.hosts and onDemandTls.allowedSuffixes overlap on ${clash.join(', ')}; a host is either LAN-only (local CA) or public (ACME), never both`)
  }

  const validityDays = cfg.validityDays ?? DEFAULT_LOCAL_CA_VALIDITY_DAYS
  const renewBeforeDays = cfg.renewBeforeDays ?? DEFAULT_LOCAL_CA_RENEW_BEFORE_DAYS
  if (!(validityDays > 0))
    throw new Error('localCa.validityDays must be a positive number of days')
  if (!(renewBeforeDays >= 0) || renewBeforeDays >= validityDays)
    throw new Error('localCa.renewBeforeDays must be between 0 and localCa.validityDays')

  return { dir: cfg.dir, hosts, ips, installTrust: cfg.installTrust === true, validityDays, renewBeforeDays }
}

/** Canonical form of an IP for SAN comparison (IPv6 zero-groups expanded, lowercase). */
function canonicalIp(ip: string): string {
  const family = isIP(ip)
  if (family === 4)
    return ip
  if (family !== 6)
    return ip.toLowerCase()
  let head: string[] = []
  let tail: string[] = []
  const [left, right] = ip.split('::')
  head = left ? left.split(':') : []
  tail = right ? right.split(':') : []
  // An embedded IPv4 tail (::ffff:192.168.0.1) becomes two hex groups.
  const expandV4 = (groups: string[]): string[] => groups.flatMap((g) => {
    if (!g.includes('.'))
      return [g]
    const octets = g.split('.').map(o => Number.parseInt(o, 10))
    return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)]
  })
  head = expandV4(head)
  tail = expandV4(tail)
  const missing = ip.includes('::') ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tail]
  return groups.map(g => Number.parseInt(g || '0', 16).toString(16)).join(':')
}

/** Parse Node's `subjectAltName` string into the dNSName and iPAddress sets. */
export function parseSanNames(subjectAltName: string | undefined): { dns: Set<string>, ips: Set<string> } {
  const dns = new Set<string>()
  const ips = new Set<string>()
  for (const raw of (subjectAltName ?? '').split(',')) {
    const part = raw.trim()
    if (part.startsWith('DNS:'))
      dns.add(part.slice('DNS:'.length).toLowerCase())
    else if (part.startsWith('IP Address:'))
      ips.add(canonicalIp(part.slice('IP Address:'.length)))
  }
  return { dns, ips }
}

/**
 * Why an on-disk leaf must be re-minted, or `null` when it can be reused.
 * Checked on every start: SAN coverage (a host or IP added to the config),
 * the signing CA (a rotated CA orphans its leaves), the key pair, and the
 * expiry window (`renewBeforeDays`).
 */
export function leafRenewalReason(
  material: { cert: string, key: string, caCert: string },
  cfg: Pick<ResolvedLocalCaConfig, 'hosts' | 'ips' | 'renewBeforeDays'>,
  now: Date = new Date(),
): string | null {
  let leaf: X509Certificate
  let ca: X509Certificate
  try {
    leaf = new X509Certificate(material.cert)
    ca = new X509Certificate(material.caCert)
  }
  catch (err) {
    return `unreadable certificate (${(err as Error).message})`
  }

  try {
    if (!leaf.checkPrivateKey(createPrivateKey(material.key)))
      return 'private key does not match the certificate'
  }
  catch (err) {
    return `unreadable private key (${(err as Error).message})`
  }

  // Signature check, not a name check: two rpx CAs share one subject, so a
  // leaf from a rotated CA must be detected by the key that signed it.
  let signedByCa = false
  try {
    signedByCa = leaf.verify(ca.publicKey)
  }
  catch {
    signedByCa = false
  }
  if (!signedByCa)
    return 'not issued by the current Root CA'

  const san = parseSanNames(leaf.subjectAltName)
  const missingHosts = cfg.hosts.filter(host => !san.dns.has(host))
  if (missingHosts.length > 0)
    return `missing DNS SAN(s): ${missingHosts.join(', ')}`
  const missingIps = cfg.ips.filter(ip => !san.ips.has(canonicalIp(ip)))
  if (missingIps.length > 0)
    return `missing IP SAN(s): ${missingIps.join(', ')}`

  const notAfter = new Date(leaf.validTo).getTime()
  const notBefore = new Date(leaf.validFrom).getTime()
  if (Number.isNaN(notAfter) || Number.isNaN(notBefore))
    return 'unreadable validity period'
  if (notBefore > now.getTime())
    return 'not valid yet'
  const daysLeft = (notAfter - now.getTime()) / MS_PER_DAY
  if (daysLeft < cfg.renewBeforeDays)
    return daysLeft <= 0 ? 'expired' : `${Math.floor(daysLeft)} day(s) left, under renewBeforeDays=${cfg.renewBeforeDays}`

  return null
}

export interface LocalCaMaterial {
  paths: LocalCaPaths
  /** PEM of the Root CA that signed the leaf (what a client has to trust). */
  caCert: string
  cert: string
  key: string
  /** True when this start created the Root CA (first run under `dir`). */
  caCreated: boolean
  /** True when this start minted the leaf; `renewalReason` says why. */
  leafMinted: boolean
  renewalReason: string | null
  notAfter: Date
  /** One SNI entry per configured host, all backed by the single leaf. */
  entries: SniTlsEntry[]
  /** The same leaf as the listener's default (no-SNI / IP-literal) context. */
  defaultTls: DefaultTlsContext
  /** Result of the trust-store step (`installTrust`), when it ran. */
  trust?: { alreadyTrusted: boolean, installed: boolean }
}

export interface EnsureLocalCaOptions {
  verbose?: boolean
  /** The on-demand set to validate against (a host may not be in both). */
  onDemandTls?: OnDemandTlsConfig
  /** Clock override for tests. */
  now?: () => Date
}

/**
 * Newer tlsx releases ship their own `isCertTrusted` (with a Linux trust-store
 * check). Prefer it when the installed tlsx has one; fall back to rpx's own
 * fingerprint check otherwise. Resolved at call time so rpx keeps working
 * against both older and newer tlsx builds.
 */
type TrustCheck = (certPath: string, options?: { verbose?: boolean }) => Promise<boolean> | boolean

async function isCaTrusted(caCertPath: string, verbose?: boolean): Promise<boolean> {
  // `Reflect.get`, not a property access: the bundler would otherwise flag
  // the missing export at build time against a tlsx that predates it.
  const viaTlsx = Reflect.get(tlsx, 'isCertTrusted') as TrustCheck | undefined
  if (typeof viaTlsx === 'function') {
    try {
      return await viaTlsx(caCertPath, { verbose })
    }
    catch (err) {
      debugLog('local-ca', `tlsx isCertTrusted failed (${(err as Error).message}); using rpx's own check`, verbose)
    }
  }
  return isCertTrusted(caCertPath, { verbose, regenerateUntrustedCerts: true })
}

/**
 * Install the local Root CA into the system trust store (tlsx `installCA`),
 * skipped when it is already trusted. Never throws: on a box where the trust
 * store cannot be written rpx must still serve; the operator sees a warning
 * and can trust the CA by hand.
 */
export async function installLocalCaTrust(paths: LocalCaPaths, verbose?: boolean): Promise<{ alreadyTrusted: boolean, installed: boolean }> {
  if (await isCaTrusted(paths.caCertPath, verbose)) {
    debugLog('local-ca', `Root CA ${paths.caCertPath} already trusted; skipping installCA`, verbose)
    return { alreadyTrusted: true, installed: false }
  }
  try {
    const result = await tlsx.installCA({ basePath: path.dirname(paths.caCertPath), caCertPath: paths.caCertPath, verbose })
    if (verbose)
      log.success(`Root CA ${result.alreadyTrusted ? 'already trusted' : 'installed'} in the system trust store (${paths.caCertPath})`)
    return { alreadyTrusted: result.alreadyTrusted, installed: result.trustInstalled }
  }
  catch (err) {
    log.warn(`rpx: could not install the local Root CA into the system trust store: ${(err as Error).message}`)
    log.warn(`rpx: trust it manually: ${paths.caCertPath}`)
    return { alreadyTrusted: false, installed: false }
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  }
  catch {
    return null
  }
}

/**
 * Load-or-create the Root CA under `cfg.dir`, then reuse or (re)mint the one
 * LAN leaf. Idempotent: a second start with the same config touches nothing.
 */
export async function ensureLocalCa(cfg: LocalCaConfig, options: EnsureLocalCaOptions = {}): Promise<LocalCaMaterial> {
  const verbose = options.verbose
  const resolved = resolveLocalCaConfig(cfg, options.onDemandTls)
  const now = options.now ?? (() => new Date())
  const paths = localCaPaths(resolved.dir)

  const rootCA = await ensureRootCA(resolved.dir, {
    verbose,
    caOptions: { commonName: LOCAL_CA_COMMON_NAME, organization: 'rpx', verbose },
  })
  if (rootCA.created && verbose)
    log.info(`Created local Root CA at ${paths.caCertPath}`)

  const [existingCert, existingKey] = await Promise.all([readIfExists(paths.certPath), readIfExists(paths.keyPath)])
  let renewalReason: string | null
  if (existingCert && existingKey)
    renewalReason = leafRenewalReason({ cert: existingCert, key: existingKey, caCert: rootCA.certificate }, resolved, now())
  else
    renewalReason = 'no leaf on disk'

  let cert: string
  let key: string
  if (renewalReason === null && existingCert && existingKey) {
    cert = existingCert
    key = existingKey
    debugLog('local-ca', `reusing leaf ${paths.certPath}`, verbose)
  }
  else {
    debugLog('local-ca', `minting leaf for ${[...resolved.hosts, ...resolved.ips].join(', ')} (${renewalReason})`, verbose)
    const leafOptions: CertificateOptions = {
      domain: resolved.hosts[0],
      domains: resolved.hosts,
      altNameIPs: resolved.ips,
      commonName: resolved.hosts[0],
      organizationName: 'rpx',
      validityDays: resolved.validityDays,
      rootCA: { certificate: rootCA.certificate, privateKey: rootCA.privateKey },
      verbose,
    }
    const leaf = await tlsx.generateCertificate(leafOptions)
    cert = leaf.certificate
    key = leaf.privateKey
    await fs.writeFile(paths.keyPath, key, { mode: 0o600 })
    await fs.writeFile(paths.certPath, cert)
    if (verbose)
      log.success(`Minted local certificate for ${[...resolved.hosts, ...resolved.ips].join(', ')} (${renewalReason})`)
  }

  const notAfter = new Date(new X509Certificate(cert).validTo)
  const material: LocalCaMaterial = {
    paths,
    caCert: rootCA.certificate,
    cert,
    key,
    caCreated: rootCA.created,
    leafMinted: renewalReason !== null,
    renewalReason,
    notAfter,
    entries: resolved.hosts.map(serverName => ({ serverName, cert, key })),
    defaultTls: { cert, key },
  }

  if (resolved.installTrust)
    material.trust = await installLocalCaTrust(paths, verbose)

  return material
}
