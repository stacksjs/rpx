// @ts-expect-error dtsx issues
import type { TlsConfig, TlsOption } from '@stacksjs/tlsx'

export interface StartOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
}

export interface BaseProxyConfig {
  from: string // localhost:5173
  to: string // stacks.localhost
  start?: StartOptions
}

export type BaseProxyOptions = Partial<BaseProxyConfig>

export interface CleanupConfig {
  domains: string[] // default: [], if only specific domain/s should be cleaned up
  hosts: boolean // default: true, if hosts file should be cleaned up
  certs: boolean // default: false, if certificates should be cleaned up
  verbose: boolean // default: false
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
}

export type SharedProxyOptions = Partial<SharedProxyConfig>

export interface SingleProxyConfig extends BaseProxyConfig, SharedProxyConfig {}

export interface MultiProxyConfig extends SharedProxyConfig {
  proxies: Array<BaseProxyConfig & { cleanUrls: boolean }>
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
