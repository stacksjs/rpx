import type { TlsConfig, TlsOption } from '@stacksjs/tlsx'

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
