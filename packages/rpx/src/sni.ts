/**
 * Build a Bun.serve TLS array for per-domain SNI from real PEM files on disk.
 *
 * Production deployments (Let's Encrypt) have one cert+key per domain. Bun's
 * `Bun.serve({ tls: [{ serverName, cert, key }, ...] })` selects the right cert
 * by SNI server name at handshake time, so a single listener can front many
 * domains with their own real certs.
 */
import type { DomainCert, ProductionTlsConfig } from './types'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as tlsx from '@stacksjs/tlsx'
import { log } from './logger'
import { debugLog } from './utils'

/** One entry of the Bun.serve `tls` array. */
export interface SniTlsEntry {
  serverName: string
  cert: string
  key: string
}

/**
 * The cert a listener presents when the client sends no SNI at all (an
 * IP-literal URL such as `https://192.168.1.20/`) or an SNI name no entry
 * matches. Bun has no separate "default context" knob: the FIRST element of
 * the `tls` array is the default, and it is the only element allowed to omit
 * `serverName` (verified on Bun 1.3.14: an unnamed entry anywhere but first
 * throws "SNI tls object must have a serverName"). See {@link buildListenerTls}.
 *
 * Without one, the first SNI entry is the default, so a name nothing matches
 * was answered with whichever tenant's certificate happened to be read first
 * (on a shared gateway, `a.b.hq.training` got `trifit.stacksjs.com`). Real-cert
 * listeners therefore always get one: the LAN local-CA leaf when configured,
 * otherwise {@link fallbackTlsContext}.
 */
export interface DefaultTlsContext {
  cert: string
  key: string
}

/**
 * Default for {@link import('./types').SharedProxyConfig.maxTlsContexts}. A
 * parsed cert + key per SNI entry lives for the life of the listener; 256 is
 * far beyond any one box's routed hosts while staying small on a 4 GB Pi.
 */
export const DEFAULT_MAX_TLS_CONTEXTS = 256

/**
 * Memory guard: cap the live SNI set at `max` entries. Keeps the FIRST `max`
 * (callers order the set so the hosts that matter most, e.g. a LAN local-CA
 * leaf, come first) and logs ONE warning naming every dropped host, so a
 * silently missing cert is never a mystery. Returns the input untouched when
 * it fits.
 */
function contextLimit(max: number | undefined): number {
  return max !== undefined && Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_TLS_CONTEXTS
}

export function capTlsContexts(entries: SniTlsEntry[], max: number = DEFAULT_MAX_TLS_CONTEXTS, verbose?: boolean): SniTlsEntry[] {
  const limit = contextLimit(max)
  if (entries.length <= limit)
    return entries
  const kept = entries.slice(0, limit)
  const dropped = entries.slice(limit).map(entry => entry.serverName)
  log.warn(`rpx: ${entries.length} TLS contexts exceed maxTlsContexts=${limit}; keeping the first ${limit} and dropping ${dropped.length} host(s): ${dropped.join(', ')}`)
  debugLog('sni', `capped SNI set to ${limit} of ${entries.length}`, verbose)
  return kept
}

/**
 * How many labels below its own level a wildcard certificate is also offered.
 * See {@link deepWildcardAliases}.
 */
export const DEEP_WILDCARD_LEVELS = 2

/**
 * Extra SNI names that hand a wildcard certificate to names deeper than it
 * covers: `*.*.example.com` and `*.*.*.example.com` for `*.example.com`.
 *
 * A wildcard covers exactly one label, but a wildcard ROUTE matches any depth,
 * so `a.b.example.com` reaches the same app. Without an entry for it the
 * handshake fell through to the listener's default certificate, which named
 * some other tenant. The browser still reports a name mismatch, as it must,
 * but now with the certificate of the site the name belongs to.
 *
 * Bun's SNI match (uSockets' sni_tree) matches label by label, `*` standing
 * for one label, and prefers the more specific name at every level whatever
 * the order of the array (verified on Bun 1.4.2): an exact name, or a closer
 * wildcard such as `*.foo.example.com` for `x.foo.example.com`, still wins over
 * these aliases. Names that are already taken are never shadowed.
 */
export function deepWildcardAliases(entries: SniTlsEntry[], levels: number = DEEP_WILDCARD_LEVELS): SniTlsEntry[] {
  const taken = new Set(entries.map(entry => entry.serverName))
  const aliases: SniTlsEntry[] = []
  for (const entry of entries) {
    if (!entry.serverName.startsWith('*.'))
      continue
    let name = entry.serverName
    for (let level = 0; level < levels; level++) {
      name = `*.${name}`
      if (taken.has(name))
        continue
      taken.add(name)
      aliases.push({ serverName: name, cert: entry.cert, key: entry.key })
    }
  }
  return aliases
}

/** Common name of the certificate {@link fallbackTlsContext} mints. */
export const FALLBACK_TLS_COMMON_NAME = 'no-matching-certificate.invalid'

let fallbackTls: Promise<DefaultTlsContext | null> | null = null

/**
 * A neutral default certificate for a real-cert listener: self-signed, minted
 * in memory once per process, naming only `no-matching-certificate.invalid`.
 * A client whose name matches no loaded certificate (or that sends no SNI)
 * gets this instead of another tenant's certificate, so the error it shows is
 * an untrusted certificate that reveals nothing about the box's other sites.
 *
 * Resolves `null` when minting fails; the listener then keeps Bun's old
 * fallback (its first SNI entry) rather than refusing to start.
 */
export function fallbackTlsContext(verbose?: boolean): Promise<DefaultTlsContext | null> {
  if (fallbackTls)
    return fallbackTls
  fallbackTls = (async () => {
    try {
      const ca = await tlsx.createRootCA({ commonName: 'rpx fallback', organization: 'rpx', validityYears: 10, verbose: false })
      const leaf = await tlsx.generateCertificate({
        domain: FALLBACK_TLS_COMMON_NAME,
        domains: [FALLBACK_TLS_COMMON_NAME],
        commonName: FALLBACK_TLS_COMMON_NAME,
        organizationName: 'rpx',
        validityDays: 3650,
        rootCA: { certificate: ca.certificate, privateKey: ca.privateKey },
        verbose: false,
      })
      debugLog('sni', `minted fallback certificate ${FALLBACK_TLS_COMMON_NAME}`, verbose)
      return { cert: leaf.certificate, key: leaf.privateKey }
    }
    catch (err) {
      log.warn(`rpx: could not mint the fallback TLS certificate (${(err as Error).message}); unmatched names get the first SNI certificate`)
      return null
    }
  })()
  return fallbackTls
}

/**
 * Assemble the `Bun.serve({ tls })` array for a shared listener: the optional
 * default context first (no `serverName`), then the SNI entries capped at
 * `maxTlsContexts`, then {@link deepWildcardAliases} while the cap allows,
 * every entry in low-memory mode.
 */
export function buildListenerTls(opts: {
  sni: SniTlsEntry[]
  defaultTls?: DefaultTlsContext | null
  maxTlsContexts?: number
  verbose?: boolean
}): Bun.TLSOptions[] {
  const capped = capTlsContexts(opts.sni, opts.maxTlsContexts, opts.verbose)
  const room = contextLimit(opts.maxTlsContexts) - capped.length
  const aliases = room > 0 ? deepWildcardAliases(capped).slice(0, room) : []
  const named: Bun.TLSOptions[] = [...capped, ...aliases].map(entry => ({ serverName: entry.serverName, cert: entry.cert, key: entry.key }))
  const list: Bun.TLSOptions[] = opts.defaultTls
    ? [{ cert: opts.defaultTls.cert, key: opts.defaultTls.key }, ...named]
    : named
  return withLowMemoryTls(list)
}

/**
 * Production gateways keep many TLS contexts alive and may serve large,
 * concurrent responses. Ask OpenSSL to release per-connection read and write
 * buffers as soon as they are idle instead of retaining their peak size for the
 * lifetime of every keep-alive socket.
 */
export function withLowMemoryTls(tls: Bun.TLSOptions): Bun.TLSOptions
export function withLowMemoryTls(tls: Bun.TLSOptions[]): Bun.TLSOptions[]
export function withLowMemoryTls(tls: Bun.TLSOptions | Bun.TLSOptions[]): Bun.TLSOptions | Bun.TLSOptions[]
export function withLowMemoryTls(tls: Bun.TLSOptions | Bun.TLSOptions[]): Bun.TLSOptions | Bun.TLSOptions[] {
  if (Array.isArray(tls))
    return tls.map(entry => ({ ...entry, lowMemoryMode: true }))
  return { ...tls, lowMemoryMode: true }
}

/**
 * Map a PEM filename under a `certsDir` to its SNI server name. Returns `null`
 * for files that aren't `<name>.crt`. The wildcard convention
 * `_wildcard.<apex>.crt` maps to server name `*.<apex>`.
 */
export function serverNameFromCertFilename(filename: string): string | null {
  if (!filename.endsWith('.crt'))
    return null
  const base = filename.slice(0, -'.crt'.length)
  if (base.length === 0)
    return null
  if (base.startsWith('_wildcard.'))
    return `*.${base.slice('_wildcard.'.length)}`
  return base
}

async function readPair(serverName: string, certPath: string, keyPath: string, verbose?: boolean): Promise<SniTlsEntry | null> {
  try {
    const [cert, key] = await Promise.all([
      fsp.readFile(certPath, 'utf8'),
      fsp.readFile(keyPath, 'utf8'),
    ])
    return { serverName, cert, key }
  }
  catch (err) {
    debugLog('sni', `skipping ${serverName}: ${(err as Error).message}`, verbose)
    return null
  }
}

/**
 * Build the SNI TLS array from a {@link ProductionTlsConfig}. Reads PEM files
 * from an explicit `domains` map and/or a `certsDir` convention. Files that
 * can't be read are skipped (logged in verbose mode). Returns `[]` when nothing
 * usable is found so the caller can fall back to the dev cert flow.
 */
export async function buildSniTlsConfig(cfg: ProductionTlsConfig, verbose?: boolean): Promise<SniTlsEntry[]> {
  const bySrvName = new Map<string, DomainCert>()
  const discoveredServerNames = cfg.certsDirServerNames
    ? new Set(cfg.certsDirServerNames)
    : undefined

  if (cfg.certsDir) {
    let names: string[] = []
    try {
      names = await fsp.readdir(cfg.certsDir)
    }
    catch (err) {
      debugLog('sni', `certsDir read failed (${cfg.certsDir}): ${(err as Error).message}`, verbose)
    }
    for (const name of names) {
      const serverName = serverNameFromCertFilename(name)
      if (!serverName)
        continue
      if (discoveredServerNames && !discoveredServerNames.has(serverName))
        continue
      const base = name.slice(0, -'.crt'.length)
      bySrvName.set(serverName, {
        certPath: path.join(cfg.certsDir, name),
        keyPath: path.join(cfg.certsDir, `${base}.key`),
      })
    }
  }

  // Explicit `domains` entries take precedence over `certsDir` discoveries.
  if (cfg.domains) {
    for (const [serverName, pair] of Object.entries(cfg.domains))
      bySrvName.set(serverName, pair)
  }

  const entries: SniTlsEntry[] = []
  for (const [serverName, pair] of bySrvName) {
    const entry = await readPair(serverName, pair.certPath, pair.keyPath, verbose)
    if (entry)
      entries.push(entry)
  }
  return entries
}
