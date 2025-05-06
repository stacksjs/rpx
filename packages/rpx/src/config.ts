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
}

// @ts-expect-error dtsx issue
// eslint-disable-next-line antfu/no-top-level-await
export const config: ProxyConfig = await loadConfig({
  name: 'rpx',
  cwd: resolve(__dirname, '..'),
  defaultConfig,
})
