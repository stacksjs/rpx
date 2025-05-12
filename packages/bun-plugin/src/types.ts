import type { TlsConfig } from '@stacksjs/rpx'
import type { ServeOptions } from 'bun'

export interface RpxPluginOptions {
  /**
   * Enable/disable the plugin
   * @default true
   */
  enabled?: boolean

  /**
   * The domain to use instead of localhost:port
   * @example 'my-app.test', 'awesome.localhost'
   * @default '$projectName.localhost'
   */
  domain?: string

  /**
   * SSL/TLS configuration
   * - true: uses default SSL config
   * - false: disables SSL
   * - object: custom SSL configuration
   * @default false
   */
  https?: boolean | TlsConfig

  /**
   * Cleanup options
   * - true: cleanup everything
   * - false: cleanup nothing
   * - object: cleanup specific items
   * @default { hosts: true, certs: false }
   * @example { hosts: true, certs: true }
   */
  cleanup?: boolean | {
    hosts?: boolean
    certs?: boolean
  }

  /**
   * By default, URLs ending with .html are served as-is.
   * However, some users may prefer "Clean URLs" without the .html extension
   * for example, example.com/path instead of example.com/path.html.
   * @default false
   */
  cleanUrls?: boolean

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean
}

export interface ServeFunction {
  (options?: ServeOptions): {
    start: (...args: unknown[]) => Promise<{ port: number }>
    stop: () => Promise<void>
  }
}

export interface PluginBuilder {
  serve: ServeFunction
}

export interface SudoCheckOptions {
  domain: string
  https: boolean
  verbose?: boolean
}

export type { TlsConfig }
