import type { ProxyOptions } from './packages/rpx/src/types'

const config: ProxyOptions = {
  https: true,

  // If true, will regenerate and re-trust certs that exist but are not trusted by the system.
  // If false, will use the existing cert even if not trusted (may result in browser warnings).
  regenerateUntrustedCerts: true,

  cleanup: {
    hosts: true,
    certs: false,
  },

  proxies: [
    {
      from: 'localhost:5173',
      to: 'stacks.localhost',
      cleanUrls: true,
      start: {
        command: 'bun run dev:docs',
        // lazy: true,
      },
    },
  ],

  vitePluginUsage: false,
  verbose: false,
}

export default config
