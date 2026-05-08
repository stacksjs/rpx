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

export interface BaseProxyConfig {
  from: string // localhost:5173
  to: string // stacks.localhost
  start?: StartOptions
  pathRewrites?: PathRewrite[]
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
