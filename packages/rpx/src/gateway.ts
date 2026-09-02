/**
 * The rpx gateway entry: what ts-cloud's rendered assembler did on every box,
 * now inside rpx itself so a box (or a Raspberry Pi) runs the prebuilt `rpx`
 * binary instead of compiling a generated launcher with `bun build`.
 *
 * Each deploy writes ONE fragment, `<sitesDir>/<slug>.json` (the shape of
 * ts-cloud's `RpxGatewayConfig`), and the gateway merges every fragment at
 * start. The merge semantics are those of ts-cloud's `renderRpxAssembler` and
 * `mergeRpxFragments` (packages/ts-cloud/src/drivers/shared/rpx-gateway.ts):
 *
 *  - fragments are read in filename order;
 *  - a malformed fragment is reported loudly and skipped, never dropped in
 *    silence (its hosts would 404 until someone noticed);
 *  - routes are concatenated, deduped by `id` (else `to + path`), first writer
 *    wins and the duplicate is logged with its first owner;
 *  - `onDemandTls.allowedSuffixes` are unioned; the first non-empty `email`
 *    wins; the ACME directory is production if ANY fragment wants production
 *    (a fragment without the `staging` flag counts as production);
 *  - the LAST fragment naming `productionCerts.certsDir` wins (the assembler
 *    overwrites on every fragment); `certsDirServerNames` is derived from the
 *    merged routes' hosts;
 *  - the first `acmeChallengeWebroot` wins;
 *  - the first origin-guard header + secret wins; hosts are unioned only from
 *    fragments that agree on both (a disagreeing tenant's hosts stay
 *    unguarded rather than rejecting all of its traffic).
 */
import type { LocalCaConfig, OnDemandTlsConfig, ProductionTlsConfig, ProxyOptions, ResolvedProxyOptions } from './types'
import type { OriginGuardOptions } from './origin-guard'
import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as process from 'node:process'
import { startProxies } from './start'
import { debugLog } from './utils'

/** Default directory on the box that holds real per-domain TLS certs. */
export const DEFAULT_GATEWAY_CERTS_DIR = '/etc/rpx/certs'
/** Default per-app fragment registry. */
export const DEFAULT_GATEWAY_SITES_DIR = '/etc/rpx/sites.d'

/**
 * One route inside a fragment. Structurally the rpx `BaseProxyConfig` (ts-cloud
 * emits exactly these keys), typed loosely enough that a fragment written by
 * an older or newer ts-cloud still loads.
 */
export type GatewayRoute = NonNullable<ResolvedProxyOptions['proxies']>[number]

/** A per-app fragment: ts-cloud's `RpxGatewayConfig` plus its `slug`. */
export interface GatewayFragment {
  slug?: string
  proxies?: GatewayRoute[]
  productionCerts?: Partial<ProductionTlsConfig>
  onDemandTls?: Partial<OnDemandTlsConfig> & { staging?: boolean }
  acmeChallengeWebroot?: string
  originGuard?: Partial<OriginGuardOptions>
  [key: string]: unknown
}

export interface GatewayFragmentFile {
  /** Basename inside `sitesDir`, e.g. `stacks.json`. */
  file: string
  fragment: GatewayFragment
}

export interface GatewayOptions {
  /** Directory of `*.json` fragments. Default `/etc/rpx/sites.d`. */
  sitesDir?: string
  /**
   * Fallback certs directory when no fragment names one. Default
   * `/etc/rpx/certs`.
   */
  certsDir?: string
  /** LAN production mode; see {@link LocalCaConfig}. */
  localCa?: LocalCaConfig
  /**
   * `false` serves plain HTTP only on `httpPort` and binds nothing on the
   * HTTPS port. Default `true`.
   */
  https?: boolean
  /** Shared HTTP port (redirect, ACME http-01, or plain HTTP). Default `80`. */
  httpPort?: number
  /** Shared HTTPS port. Default `443`. */
  httpsPort?: number
  /** Memory guard on the SNI set; see `SharedProxyConfig.maxTlsContexts`. */
  maxTlsContexts?: number
  /**
   * Verbose logging. Defaults to `RPX_VERBOSE !== 'false'`, the hard default
   * ts-cloud installs with, because without it a production TLS failure looks
   * like "nothing happens".
   */
  verbose?: boolean
  /**
   * Called for every fragment that could not be read or parsed. The default
   * writes to `console.error` and continues; the fragment is skipped either
   * way, never silently.
   */
  onFragmentError?: (file: string, err: Error) => void
}

function defaultFragmentError(file: string, err: Error): void {
  console.error(`[rpx gateway] SKIPPING malformed fragment ${file}; its host(s) will 404 until fixed: ${err.message}`)
}

/**
 * Read every `*.json` fragment in `sitesDir`, in filename order. A missing
 * directory yields no fragments (a box with nothing deployed yet). A fragment
 * that fails to read or parse is passed to `onFragmentError` and skipped.
 */
export async function readGatewayFragments(
  sitesDir: string,
  onFragmentError: (file: string, err: Error) => void = defaultFragmentError,
): Promise<GatewayFragmentFile[]> {
  let names: string[] = []
  try {
    names = (await readdir(sitesDir)).filter(name => name.endsWith('.json')).sort()
  }
  catch {
    return []
  }

  const fragments: GatewayFragmentFile[] = []
  for (const file of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(sitesDir, file), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new TypeError('fragment is not a JSON object')
      fragments.push({ file, fragment: parsed as GatewayFragment })
    }
    catch (err) {
      onFragmentError(file, err instanceof Error ? err : new Error(String(err)))
    }
  }
  return fragments
}

export interface MergeGatewayOptions {
  /** Fallback certs directory when no fragment names one. */
  certsDir?: string
  /** Called on a duplicate route (first writer wins) or a disagreeing origin-guard secret. */
  onWarning?: (message: string) => void
}

/**
 * Merge fragments into the options `startProxies` takes, with ts-cloud's
 * assembler semantics (see the module header). Pure: no I/O, no env reads.
 */
export function mergeGatewayFragments(
  fragments: GatewayFragmentFile[],
  options: MergeGatewayOptions = {},
): ProxyOptions {
  const warn = options.onWarning ?? ((message: string) => console.warn(`[rpx gateway] ${message}`))

  const proxies: GatewayRoute[] = []
  const seen = new Set<string>()
  const owners = new Map<string, string>()
  const suffixes = new Set<string>()
  const guardHosts = new Set<string>()
  let email: string | undefined
  let certsDir = options.certsDir ?? DEFAULT_GATEWAY_CERTS_DIR
  let acmeChallengeWebroot: string | undefined
  let guard: { header: string, value: string } | undefined
  let anyProduction = false

  for (const { file, fragment } of fragments) {
    for (const route of Array.isArray(fragment.proxies) ? fragment.proxies : []) {
      const key = route.id || `${route.to}${route.path ?? ''}`
      if (seen.has(key)) {
        warn(`duplicate route ${key} in ${file} ignored; first declared by ${owners.get(key)}`)
        continue
      }
      seen.add(key)
      owners.set(key, file)
      proxies.push(route)
    }
    for (const suffix of fragment.onDemandTls?.allowedSuffixes ?? [])
      suffixes.add(suffix)
    email ??= fragment.onDemandTls?.email
    // One gateway, one ACME directory: production wins any disagreement, and
    // a fragment predating the flag counts as production.
    if (fragment.onDemandTls && fragment.onDemandTls.staging !== true)
      anyProduction = true
    if (fragment.productionCerts?.certsDir)
      certsDir = fragment.productionCerts.certsDir
    acmeChallengeWebroot ??= fragment.acmeChallengeWebroot
    if (fragment.originGuard && fragment.originGuard.header && fragment.originGuard.value) {
      guard ??= { header: fragment.originGuard.header, value: fragment.originGuard.value }
      if (fragment.originGuard.header === guard.header && fragment.originGuard.value === guard.value) {
        for (const host of fragment.originGuard.hosts ?? [])
          guardHosts.add(host)
      }
      else {
        warn(`origin-guard secret in ${file} differs from the one already in force; its hosts stay unguarded rather than rejecting all traffic`)
      }
    }
  }

  const merged: ProxyOptions = {
    proxies: proxies as NonNullable<Extract<ProxyOptions, { proxies?: unknown }>['proxies']>,
    productionCerts: {
      certsDir,
      // A shared host's cert directory also holds mail and retired-site PEMs.
      // Only routed hosts become live OpenSSL SNI contexts.
      certsDirServerNames: [...new Set(proxies.map(route => route.to).filter(Boolean))],
    },
    https: true,
    hostsManagement: false,
    cleanup: { hosts: false, certs: false },
  }
  if (suffixes.size > 0)
    merged.onDemandTls = { enabled: true, allowedSuffixes: [...suffixes], email, certsDir, staging: !anyProduction }
  if (acmeChallengeWebroot)
    merged.acmeChallengeWebroot = acmeChallengeWebroot
  if (guard)
    merged.originGuard = { header: guard.header, value: guard.value, hosts: [...guardHosts] }
  return merged
}

/**
 * Resolve the full `startProxies` options for a gateway: read + merge the
 * fragments, then apply the gateway-level switches (`https`, ports, local CA,
 * memory guard, verbosity). Exported so the CLI and tests see exactly what
 * {@link startGateway} starts.
 */
export async function resolveGatewayOptions(options: GatewayOptions = {}): Promise<ProxyOptions> {
  const sitesDir = options.sitesDir ?? DEFAULT_GATEWAY_SITES_DIR
  const verbose = options.verbose ?? process.env.RPX_VERBOSE !== 'false'
  const fragments = await readGatewayFragments(sitesDir, options.onFragmentError)
  debugLog('gateway', `merged ${fragments.length} fragment(s) from ${sitesDir}: ${fragments.map(f => f.file).join(', ') || '<none>'}`, verbose)

  const merged = mergeGatewayFragments(fragments, { certsDir: options.certsDir })
  // A gateway is one listener per port by definition: with `https: false` (or
  // a single route) `startProxies` would otherwise fall back to a per-proxy
  // listener with its upstream probe and port hunting.
  const resolved: ProxyOptions = { ...merged, verbose, singlePortMode: true }
  if (options.https === false)
    resolved.https = false
  if (options.httpPort !== undefined)
    resolved.httpPort = options.httpPort
  if (options.httpsPort !== undefined)
    resolved.httpsPort = options.httpsPort
  if (options.localCa)
    resolved.localCa = options.localCa
  if (options.maxTlsContexts !== undefined)
    resolved.maxTlsContexts = options.maxTlsContexts
  return resolved
}

/**
 * Start the gateway: merge every fragment under `sitesDir` and hand the result
 * to {@link startProxies}. Resolves once the listeners are bound (or a bind was
 * refused and logged); the process then serves until SIGINT / SIGTERM.
 */
export async function startGateway(options: GatewayOptions = {}): Promise<void> {
  const resolved = await resolveGatewayOptions(options)
  const proxies = 'proxies' in resolved && Array.isArray(resolved.proxies) ? resolved.proxies : []
  if (proxies.length === 0 && !options.localCa)
    console.warn(`[rpx gateway] no routes found under ${options.sitesDir ?? DEFAULT_GATEWAY_SITES_DIR}; every request will answer 404 until a fragment is deployed`)
  await startProxies(resolved)
}
