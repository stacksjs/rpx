/**
 * On-demand TLS for rpx: issue a real (Let's Encrypt, http-01) certificate for
 * an unknown host the first time it's needed, gated by an `ask` callback and/or
 * an `allowedSuffixes` allowlist.
 *
 * ## The Bun limitation this works around (verified on Bun 1.3.14 + 1.4.0)
 *
 * Bun.serve has **no working `SNICallback`**, and `server.reload({ tls })` does
 * **NOT** update certificates at runtime. So rpx cannot mint a cert *during* the
 * TLS handshake (the way Caddy's on-demand TLS does). Instead this manager
 * implements on-demand as **ask-gated issuance + listener recreate**:
 *
 *   - rpx serves the ACME `http-01` challenge from its own `:80` listener (same
 *     process, so the challenge token is reachable the instant we register it).
 *   - issuance is triggered before the HTTPS request — either reactively from
 *     the `:80` handler (first plaintext hit for the host), or programmatically
 *     via {@link OnDemandCertManager.ensureCert} (e.g. a tunnel server
 *     pre-warming a subdomain's cert at registration time).
 *   - once a cert is issued it's written to `certsDir` and added to the live SNI
 *     set; the manager then asks its host to rebuild the `:443` listener so the
 *     new cert is actually served (a sub-second `server.stop()` + re-`Bun.serve`).
 *
 * Concurrency: per-host in-flight de-dupe means N concurrent `ensureCert(host)`
 * calls drive exactly one ACME order. Failures are logged and negatively cached
 * for a short window so we don't hammer Let's Encrypt (which is rate-limited).
 */
import type { Http01Store, ObtainCertificateOptions, ObtainCertificateResult } from '@stacksjs/tlsx'
import type { OnDemandTlsConfig } from './types'
import type { SniTlsEntry } from './sni'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { defaultHttp01Store, obtainCertificate } from '@stacksjs/tlsx'
import { debugLog } from './utils'

/**
 * The issuance function the manager calls. Defaults to tlsx's
 * {@link obtainCertificate}; tests inject a stub so the suite never touches
 * Let's Encrypt.
 */
export type CertIssuer = (options: ObtainCertificateOptions) => Promise<ObtainCertificateResult>

export interface OnDemandCertManagerOptions {
  /** Resolved on-demand config (already merged with defaults). */
  config: OnDemandTlsConfig
  /** Where issued PEMs are written / read. Required (resolved by the caller). */
  certsDir: string
  /** Initial SNI set to seed from (e.g. productionCerts already on disk). */
  initial?: SniTlsEntry[]
  /**
   * Called after a new cert is added to the SNI set so the host can rebuild its
   * `:443` listener (Bun can't hot-update tls — see file header).
   */
  onCertAdded?: (entries: SniTlsEntry[]) => void | Promise<void>
  /** http-01 challenge store rpx's `:80` listener serves from. */
  http01Store?: Http01Store
  /** Inject the issuer (tests stub this). Defaults to tlsx `obtainCertificate`. */
  issuer?: CertIssuer
  verbose?: boolean
  /** How long to negatively-cache a failed host before retrying. Default 60s. */
  negativeCacheMs?: number
}

const DEFAULT_NEGATIVE_CACHE_MS = 60_000
/**
 * Hard ceiling on the negative-cache map. An attacker can hit `:80` with endless
 * distinct Host values; without a bound the failure cache would grow forever
 * (memory DoS). At the cap we sweep expired entries, then evict oldest-first.
 */
const MAX_NEGATIVE_CACHE = 4096

/**
 * True if `host` is covered by the `allowedSuffixes` allowlist: it equals a
 * suffix, or is a subdomain of one (`a.example.com` for suffix `example.com`).
 */
export function matchesAllowedSuffix(host: string, suffixes: string[] | undefined): boolean {
  if (!suffixes || suffixes.length === 0)
    return false
  return suffixes.some((s) => {
    const suffix = s.startsWith('.') ? s.slice(1) : s
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

/** Strict-ish hostname guard so we never feed junk Host headers into ACME. */
export function isLikelyHostname(host: string): boolean {
  if (!host || host.length > 253)
    return false
  if (host.includes('/') || host.includes(':') || host.includes(' '))
    return false
  // No wildcards (http-01 can't do them) and must contain a dot (a real FQDN).
  if (host.startsWith('*'))
    return false
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)
}

/**
 * Holds the live SNI cert set and lazily issues certs for approved hosts.
 *
 * The set is keyed by SNI server name; `ensureCert(host)` is the entry point for
 * both the reactive `:80` path and programmatic pre-warming.
 */
export class OnDemandCertManager {
  private readonly config: OnDemandTlsConfig
  private readonly certsDir: string
  private readonly onCertAdded?: (entries: SniTlsEntry[]) => void | Promise<void>
  private readonly http01Store: Http01Store
  private readonly issuer: CertIssuer
  private readonly verbose: boolean
  private readonly negativeCacheMs: number

  /** Live SNI set, keyed by server name. */
  private readonly certs = new Map<string, SniTlsEntry>()
  /** In-flight issuances, keyed by host — de-dupes concurrent ensureCert calls. */
  private readonly inFlight = new Map<string, Promise<boolean>>()
  /** host → epoch-ms until which we refuse to retry after a failure. */
  private readonly negativeCache = new Map<string, number>()

  constructor(opts: OnDemandCertManagerOptions) {
    this.config = opts.config
    this.certsDir = opts.certsDir
    this.onCertAdded = opts.onCertAdded
    this.http01Store = opts.http01Store ?? defaultHttp01Store
    this.issuer = opts.issuer ?? obtainCertificate
    this.verbose = opts.verbose ?? false
    this.negativeCacheMs = opts.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS
    for (const e of opts.initial ?? [])
      this.certs.set(e.serverName, e)
  }

  /** The http-01 store rpx's `:80` listener must serve challenge tokens from. */
  get challengeStore(): Http01Store {
    return this.http01Store
  }

  /** A snapshot of the current SNI set for `Bun.serve({ tls })`. */
  sniEntries(): SniTlsEntry[] {
    return Array.from(this.certs.values())
  }

  /** True if a usable cert for `host` is already loaded in the live set. */
  hasCert(host: string): boolean {
    return this.certs.has(host)
  }

  /**
   * Decide whether rpx may issue a cert for `host`. A host is approved when the
   * `allowedSuffixes` allowlist matches OR `ask(host)` resolves truthy. With
   * neither configured, every host is refused (fail-closed, anti-abuse).
   */
  async isApproved(host: string): Promise<boolean> {
    if (!isLikelyHostname(host))
      return false
    if (matchesAllowedSuffix(host, this.config.allowedSuffixes))
      return true
    if (this.config.ask) {
      try {
        return await this.config.ask(host)
      }
      catch (err) {
        debugLog('on-demand', `ask(${host}) threw: ${(err as Error).message}`, this.verbose)
        return false
      }
    }
    return false
  }

  /**
   * Ensure a cert exists for `host`, issuing one via ACME http-01 if needed.
   *
   * No-ops (resolves `true`) when a cert is already loaded. Otherwise checks
   * approval, then drives issuance — de-duping concurrent calls for the same
   * host so only one ACME order runs. Resolves `false` when refused or on a
   * negatively-cached failure. Never throws; errors are logged + cached.
   */
  async ensureCert(host: string): Promise<boolean> {
    if (!this.config.enabled)
      return false
    if (this.certs.has(host))
      return true
    // Cheap pre-filter: reject anything that isn't a plausible hostname before
    // touching the disk or the `ask` callback, so a flood of junk Host headers on
    // the public `:80` path can't drive per-request fs reads / ask amplification.
    if (!isLikelyHostname(host))
      return false

    const inFlight = this.inFlight.get(host)
    if (inFlight)
      return inFlight

    const until = this.negativeCache.get(host)
    if (until !== undefined && Date.now() < until) {
      debugLog('on-demand', `${host} negatively cached for ${until - Date.now()}ms`, this.verbose)
      return false
    }

    const promise = this.issue(host).finally(() => {
      this.inFlight.delete(host)
    })
    this.inFlight.set(host, promise)
    return promise
  }

  private async issue(host: string): Promise<boolean> {
    // A concurrent caller may have already loaded it while we were queued.
    if (this.certs.has(host))
      return true

    // Maybe it's already on disk (issued by a prior run) — adopt without ACME.
    if (await this.loadFromDisk(host))
      return true

    if (!(await this.isApproved(host))) {
      debugLog('on-demand', `refused issuance for ${host} (not approved)`, this.verbose)
      // Cache the refusal too, so repeated junk for the same host is O(1) and
      // doesn't re-pay the disk/ask cost every time.
      this.cacheNegative(host)
      return false
    }

    try {
      debugLog('on-demand', `issuing cert for ${host} (staging=${this.config.staging ?? false})`, this.verbose)
      const result = await this.issuer({
        domains: [host],
        method: 'http-01',
        http01Store: this.http01Store,
        email: this.config.email,
        staging: this.config.staging,
      })
      await this.persist(host, result.fullChainPem, result.keyPem)
      const entry: SniTlsEntry = { serverName: host, cert: result.fullChainPem, key: result.keyPem }
      this.certs.set(host, entry)
      this.negativeCache.delete(host)
      debugLog('on-demand', `issued + installed cert for ${host}`, this.verbose)
      await this.onCertAdded?.(this.sniEntries())
      return true
    }
    catch (err) {
      this.cacheNegative(host)
      debugLog('on-demand', `issuance for ${host} failed: ${(err as Error).message}`, this.verbose)
      return false
    }
  }

  /** Record a negative-cache entry for `host`, sweeping expired entries and
   *  bounding the map so it can never grow without limit. */
  private cacheNegative(host: string): void {
    if (this.negativeCache.size >= MAX_NEGATIVE_CACHE) {
      const now = Date.now()
      for (const [h, until] of this.negativeCache) {
        if (until <= now)
          this.negativeCache.delete(h)
      }
      // Still full (all entries live)? Drop the oldest-inserted one.
      if (this.negativeCache.size >= MAX_NEGATIVE_CACHE) {
        const oldest = this.negativeCache.keys().next().value
        if (oldest !== undefined)
          this.negativeCache.delete(oldest)
      }
    }
    this.negativeCache.set(host, Date.now() + this.negativeCacheMs)
  }

  /** Try to load an already-present `<host>.{crt,key}` pair from `certsDir`. */
  private async loadFromDisk(host: string): Promise<boolean> {
    const { certPath, keyPath } = this.pathsFor(host)
    try {
      const [cert, key] = await Promise.all([
        fsp.readFile(certPath, 'utf8'),
        fsp.readFile(keyPath, 'utf8'),
      ])
      const entry: SniTlsEntry = { serverName: host, cert, key }
      this.certs.set(host, entry)
      debugLog('on-demand', `adopted existing on-disk cert for ${host}`, this.verbose)
      await this.onCertAdded?.(this.sniEntries())
      return true
    }
    catch {
      return false
    }
  }

  private pathsFor(host: string): { certPath: string, keyPath: string } {
    return {
      certPath: path.join(this.certsDir, `${host}.crt`),
      keyPath: path.join(this.certsDir, `${host}.key`),
    }
  }

  private async persist(host: string, certPem: string, keyPem: string): Promise<void> {
    await fsp.mkdir(this.certsDir, { recursive: true }).catch(() => {})
    const { certPath, keyPath } = this.pathsFor(host)
    await Promise.all([
      fsp.writeFile(certPath, certPem, 'utf8'),
      fsp.writeFile(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 }),
    ])
  }
}
