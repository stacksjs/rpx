import type { Plugin } from 'vite'
import type { VitePluginRpxOptions } from './types'

export interface SimplifiedPluginOptions extends VitePluginRpxOptions {}

export function SimplifiedVitePlugin(options: SimplifiedPluginOptions = {}): Plugin {
  return {
    name: 'vite-plugin-rpx',
    enforce: 'pre',
    apply: 'serve',

    configResolved(config) {
      if (config.command === 'build')
        return

      // Prevent HMR port conflicts
      if (!options.enableHmr && config.server) {
        if (config.server.hmr === true) {
          config.server.hmr = {
            port: 20000 + Math.floor(Math.random() * 10000),
          }
        }
      }
    },
  }
}
