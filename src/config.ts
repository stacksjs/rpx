import type { ReverseProxyConfig } from './types'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from 'bunfig'

export const defaultConfig: ReverseProxyConfig = {
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
}

// eslint-disable-next-line antfu/no-top-level-await
export const config: ReverseProxyConfig = await loadConfig({
  name: 'reverse-proxy',
  defaultConfig,
})
