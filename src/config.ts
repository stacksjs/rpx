import type { ReverseProxyConfig } from './types'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from 'bun-config'

// eslint-disable-next-line antfu/no-top-level-await
export const config: ReverseProxyConfig = await loadConfig({
  name: 'reverse-proxy',
  defaultConfig: {
    from: 'localhost:5173',
    to: 'stacks.localhost',
    https: {
      domain: 'stacks.localhost',
      hostCertCN: 'stacks.localhost',
      caCertPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.ca.crt`),
      certPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt`),
      keyPath: path.join(os.homedir(), '.stacks', 'ssl', `stacks.localhost.crt.key`),
      altNameIPs: ['127.0.0.1'],
      altNameURIs: ['localhost'],
      organizationName: 'stacksjs.org',
      countryName: 'US',
      stateName: 'California',
      localityName: 'Playa Vista',
      commonName: 'stacks.localhost',
      validityDays: 180,
      verbose: false,
    },
    verbose: true,
  },
})
