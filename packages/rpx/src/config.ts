import type { ProxyConfig } from './types'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from 'bunfig'

export const defaultConfig: ProxyConfig = {
  from: 'localhost:5173',
  to: 'stacks.localhost',
  cleanUrls: false,
  https: {
    basePath: '',
    caCertPath: join(homedir(), '.stacks', 'ssl', `stacks.localhost.ca.crt`),
    certPath: join(homedir(), '.stacks', 'ssl', `stacks.localhost.crt`),
    keyPath: join(homedir(), '.stacks', 'ssl', `stacks.localhost.crt.key`),
  },
  cleanup: {
    certs: false,
    hosts: false,
  },
  vitePluginUsage: false,
  verbose: true,
  changeOrigin: false,
  /**
   * If true, will regenerate and re-trust certs that exist but are not trusted by the system.
   * If false, will use the existing cert even if not trusted (may result in browser warnings).
   */
  regenerateUntrustedCerts: true,
}

// Lazy-loaded config to avoid top-level await (enables bun --compile)
let _config: ProxyConfig | null = null

export async function getConfig(): Promise<ProxyConfig> {
  if (!_config) {
    _config = await loadConfig({
  name: 'rpx',
  cwd: resolve(__dirname, '..'),
  defaultConfig,
})
  }
  return _config
}

// For backwards compatibility - synchronous access with default fallback
export const config: ProxyConfig = defaultConfig
