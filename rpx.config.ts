import type { ProxyOptions } from './src/types'

const config: ProxyOptions = {
  https: true,

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
