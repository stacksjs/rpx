import type { ProxyOptions } from '@stacksjs/rpx'
import os from 'node:os'
import path from 'node:path'

const config: ProxyOptions = {
  https: {
    // Custom SSL settings for better browser compatibility
    domain: 'rpx.localhost',
    hostCertCN: 'rpx.localhost',
    altNameIPs: ['127.0.0.1', '::1'],
    altNameURIs: ['localhost'],
    organizationName: 'RPX Development',
    countryName: 'US',
    stateName: 'California',
    localityName: 'Local Development',
    commonName: 'rpx.localhost',
    validityDays: 825, // Longer validity for development
    subjectAltNames: [
      { type: 2, value: 'rpx.localhost' },
      { type: 2, value: '*.rpx.localhost' },
      { type: 2, value: 'localhost' },
    ],
    // Use standard paths that are easier to manage
    basePath: path.join(os.homedir(), '.stacks', 'ssl'),
  },

  cleanup: {
    hosts: true,
    certs: false,
  },

  proxies: [
    {
      from: 'localhost:5173',
      to: 'rpx.localhost',
      cleanUrls: true,
      start: {
        command: 'bun run dev:docs',
        // lazy: true,
      },
    },
  ],

  vitePluginUsage: false,
  verbose: true, // Enable verbose mode for better debugging
}

export default config
