import type { TlsConfig, TlsOption } from '@stacksjs/tlsx'
import type { OriginGuardOptions } from './origin-guard'

export interface StartOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
}

export interface PathRewrite {
  /** Path prefix to match, e.g. '/api' */
  from: string
  /** Target backend to route to, e.g. 'localhost:3008' */
  to: string
  /**
   * Strip the matched prefix before forwarding. Default: `false` (preserve path).
   *
   * Matches the behavior of Vite's `server.proxy`, nginx `proxy_pass http://host:port`
   * (no trailing slash), and http-proxy-middleware's default. Most upstreams that own
   * a `/api` namespace expect the prefix to remain on the request URL.
   *
   * Set to `true` only when the upstream registers routes WITHOUT the prefix
   * (e.g., upstream serves `/cart/add` and you want `/api/cart/add` to reach it).
   */
  stripPrefix?: boolean
}

/**
 * How a static-file route maps request paths to files on disk.
 *
 * - `directory` (default): `/about` → `<root>/about/index.html` (SSG dir style).
 * - `flat`: `/about` → `<root>/about.html` (flat-file style).
 */
export type PathRewriteStyle = 'directory' | 'flat'

export interface StaticRouteConfig {
  /** Absolute path to the directory served for this route. */
  dir: string
  /**
   * Single-page-app fallback: serve `index.html` for any path that doesn't
   * resolve to a real file (so client-side routing works). Default: `false`.
   */
  spa?: boolean
  /**
   * Extensionless-URL resolution style for `.html` files. Default: `directory`.
   */
  pathRewriteStyle?: PathRewriteStyle
  /**
   * `Cache-Control` max-age (seconds) for served files. Default: `0`.
   */
  maxAge?: number
}

export interface BaseProxyConfig {
  /**
   * Upstream `host:port` to forward to (e.g. `localhost:5173`). Optional when
   * `static` is set (the route serves files from disk instead of proxying).
   */
  from?: string // localhost:5173
  to: string // stacks.localhost
  /**
   * Optional path prefix this route owns under the host `to` (e.g. `'/api'`).
   * Lets multiple routes share one host, each serving a different path —
   * `/api` proxied to an app, `/docs` from a static dir, `/` from another.
   * The longest matching prefix wins; omit (or `'/'`) for the host default.
   */
  path?: string
  start?: StartOptions
  pathRewrites?: PathRewrite[]
  /**
   * Serve a local directory for this route instead of proxying to `from`.
   * Provide an absolute directory path (shorthand) or a {@link StaticRouteConfig}.
   * When set, `from` is optional; exactly one of `from`/`static` must be present.
   */
  static?: string | StaticRouteConfig
  /**
   * Stable id used when registering this proxy with the rpx daemon. Derived
   * from `to` if omitted. Must match `/^[a-zA-Z0-9._-]+$/` and be ≤128 chars.
   */
  id?: string
}

export type BaseProxyOptions = Partial<BaseProxyConfig>

export interface CleanupConfig {
  domains: string[] // default: [], if only specific domain/s should be cleaned up
  hosts: boolean // default: true, if hosts file should be cleaned up
  certs: boolean // default: false, if certificates should be cleaned up
  verbose: boolean // default: false
  vitePluginUsage?: boolean // default: false, if cleanup was initiated by the Vite plugin
}

export type CleanupOptions = Partial<CleanupConfig>

/**
 * A real PEM cert+key pair on disk for one SNI server name.
 */
export interface DomainCert {
  /** Absolute path to the PEM certificate (fullchain). */
  certPath: string
  /** Absolute path to the PEM private key. */
  keyPath: string
}

/**
 * Production TLS using real certs (e.g. Let's Encrypt) served per-domain via
 * SNI on a single listener. Provide either an explicit `domains` map or a
 * `certsDir` convention.
 */
export interface ProductionTlsConfig {
  /**
   * Explicit per-domain cert/key files keyed by SNI server name. Use
   * `*.example.com` for a wildcard server name.
   */
  domains?: Record<string, DomainCert>
  /**
   * Directory of PEM files following the convention `<domain>.crt` /
   * `<domain>.key`. A wildcard pair `_wildcard.<apex>.crt` /
   * `_wildcard.<apex>.key` is registered under server name `*.<apex>`.
   */
  certsDir?: string
}

/**
 * On-demand TLS: issue a real (Let's Encrypt, http-01) certificate for an
 * unknown host the first time it's needed, gated by an `ask` callback and/or an
 * `allowedSuffixes` allowlist to prevent abuse.
 *
 * ## Why this is "ask-gated issuance + listener recreate", not at-handshake
 *
 * Bun (verified on 1.3.14 + 1.4.0) has **no working SNICallback** and
 * `server.reload({ tls })` does **not** update certs at runtime. So rpx cannot
 * mint a cert during the TLS handshake the way Caddy's on-demand TLS does.
 * Instead rpx:
 *   1. Sees the first plaintext request for the host on its `:80` listener.
 *   2. Asks `ask(host)` / checks `allowedSuffixes`; if approved, drives the
 *      ACME http-01 flow (serving the challenge from its own `:80`).
 *   3. Writes the PEMs into `certsDir` and rebuilds the `:443` listener with the
 *      augmented SNI cert set (a sub-second `server.stop()` + re-`Bun.serve`).
 * The subsequent HTTPS request then finds the freshly-issued cert.
 *
 * Issuance can also be triggered programmatically via the manager's
 * `ensureCert(host)` (e.g. a tunnel server pre-warming a subdomain's cert on
 * registration) so the cert exists before the first browser hit.
 */
export interface OnDemandTlsConfig {
  /** Master switch. On-demand TLS is opt-in; default `false`. */
  enabled?: boolean
  /**
   * Gate issuance for a given hostname. Return `true` to allow rpx to obtain a
   * cert, `false` to refuse. Combined with {@link allowedSuffixes} (a host is
   * approved if either the suffix allowlist matches OR `ask` returns true). If
   * neither is provided, on-demand issuance refuses every host.
   */
  ask?: (host: string) => boolean | Promise<boolean>
  /**
   * Allowlist of domain suffixes that may be auto-issued without consulting
   * `ask`. A host matches a suffix when it equals it or ends with `.<suffix>`
   * (so `example.com` allows `example.com` and `a.example.com`).
   */
  allowedSuffixes?: string[]
  /** Contact email for the ACME account (recommended by Let's Encrypt). */
  email?: string
  /**
   * Use Let's Encrypt **staging** (untrusted but un-rate-limited) instead of
   * production. Default `false` (real, trusted, rate-limited certs).
   */
  staging?: boolean
  /**
   * Directory where issued PEMs are written (`<host>.crt` / `<host>.key`) and
   * from which existing certs are loaded. Should match the SNI `certsDir` so
   * issued certs survive restarts. Defaults to the daemon's productionCerts
   * `certsDir` when wired through the daemon.
   */
  certsDir?: string
}

export interface SharedProxyConfig {
  https: boolean | TlsOption
  cleanup: boolean | CleanupOptions
  vitePluginUsage: boolean
  verbose: boolean
  _cachedSSLConfig?: SSLConfig | null
  start?: StartOptions
  cleanUrls: boolean
  changeOrigin?: boolean // default: false - changes the origin of the host header to the target URL
  regenerateUntrustedCerts?: boolean // If true, will regenerate and re-trust certs that exist but are not trusted by the system.
  /**
   * Route every proxy through a single shared listener instead of binding a
   * separate port per proxy. All traffic arrives on one port (the configured
   * {@link httpsPort} when HTTPS is enabled, otherwise {@link httpPort}) and is
   * routed to the correct upstream by the request `Host` header (and path).
   *
   * Without this, rpx binds one `:443` (or `:80`) listener per proxy, falling
   * back to `:8443`, `:8444`, … when the port is taken — so each domain ends up
   * on a different port. Single-port mode collapses them onto one.
   *
   * Note: when HTTPS is enabled and more than one proxy is configured, rpx
   * already shares a single `:443` listener; `singlePortMode` additionally
   * enables the shared listener for the HTTP-only and single-proxy cases, and
   * makes the listening port configurable. Default: `false`.
   */
  singlePortMode?: boolean
  /**
   * Port for the shared HTTP listener (single-port HTTP mode) and the
   * HTTP→HTTPS redirect server. Default: `80`.
   */
  httpPort?: number
  /**
   * Port for the shared HTTPS listener. Default: `443`.
   */
  httpsPort?: number
  /**
   * Route this proxy through the long-running rpx daemon instead of binding
   * its own :443. Lets multiple `rpx start` invocations coexist on shared
   * `:443` (Valet-style). Default: `false` for backward compatibility.
   */
  viaDaemon?: boolean
  /**
   * Master switch for all `/etc/hosts` reads/writes. Set to `false` on a real
   * server with real DNS so rpx never touches `/etc/hosts`. When omitted, the
   * legacy behavior applies (driven by `cleanup.hosts`). `cleanup: { hosts:
   * false }` also disables hosts management.
   */
  hostsManagement?: boolean
  /**
   * Production per-domain SNI certs (Let's Encrypt PEMs already on disk). When
   * provided, the listener serves a different real cert per SNI server name
   * instead of the dev self-signed shared cert.
   */
  productionCerts?: ProductionTlsConfig
  /**
   * On-demand TLS: lazily issue a real cert for an unknown (but approved) host
   * the first time it's needed. Opt-in — see {@link OnDemandTlsConfig}.
   */
  onDemandTls?: OnDemandTlsConfig
  /**
   * Origin lockdown for "CDN in front of rpx" setups. When set, the shared
   * HTTPS handler rejects requests to the listed hosts that lack the CDN's
   * shared-secret header — so the publicly-resolvable origin can't be used to
   * bypass the CDN. See {@link createOriginGuard}.
   */
  originGuard?: OriginGuardOptions
}

export type SharedProxyOptions = Partial<SharedProxyConfig>

export interface SingleProxyConfig extends BaseProxyConfig, SharedProxyConfig {}

export interface MultiProxyConfig extends SharedProxyConfig {
  proxies: Array<BaseProxyConfig & { cleanUrls: boolean, pathRewrites?: PathRewrite[] }>
}

export type ProxyConfig = SingleProxyConfig
export type ProxyConfigs = SingleProxyConfig | MultiProxyConfig

export type BaseProxyOption = Partial<BaseProxyConfig>
export type ProxyOption = Partial<SingleProxyConfig>
export type ProxyOptions = Partial<SingleProxyConfig> | Partial<MultiProxyConfig>

/**
 * Internal shape used by `startProxies` after merging the built-in defaults with
 * the caller's single- or multi-proxy options. Every field is optional, and the
 * `proxies` array elements tolerate the per-proxy `cleanUrls`/`changeOrigin`
 * overrides the runtime reads — so the merged object can be accessed across both
 * single and multi shapes without falling back to `any`.
 */
export type ResolvedProxyOptions = Partial<SingleProxyConfig> & {
  proxies?: Array<BaseProxyConfig & { cleanUrls?: boolean, changeOrigin?: boolean, pathRewrites?: PathRewrite[] }>
}

export interface SSLConfig {
  key: string
  cert: string
  ca?: string | string[]
}

export interface ProxySetupOptions extends Omit<ProxyOption, 'from'> {
  fromPort: number
  sourceUrl: Pick<URL, 'hostname' | 'host'>
  ssl: SSLConfig | null
  from: string
  to: string
  portManager?: PortManager
}

export interface PortManager {
  usedPorts: Set<number>
  getNextAvailablePort: (startPort: number) => Promise<number>
}

export type { TlsConfig, TlsOption }
