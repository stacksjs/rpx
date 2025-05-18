import type { TlsConfig } from '@stacksjs/rpx'

export interface VitePluginRpxOptions {
  /**
   * Whether the plugin is enabled
   * @default true
   */
  enabled?: boolean

  /**
   * Domain for HTTPS certificates and hosts file
   * @default 'localhost'
   */
  domain?: string

  /**
   * Enable HTTPS with self-signed certificates
   * @default false
   */
  https?: boolean | TlsConfig

  /**
   * Enable clean URLs (automatically append .html or /index.html)
   * @default false
   */
  cleanUrls?: boolean

  /**
   * Whether to clean up on exit
   * @default true
   */
  cleanup?: boolean | {
    /**
     * Whether to clean up hosts file entries
     * @default true
     */
    hosts?: boolean
    /**
     * Whether to clean up SSL certificates
     * @default false
     */
    certs?: boolean
  }

  /**
   * Change the origin of the host header to match the target URL
   * @default false
   */
  changeOrigin?: boolean

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean

  /**
   * If true, will regenerate and re-trust certs that exist but are not trusted by the system.
   * @default false
   */
  regenerateUntrustedCerts?: boolean

  /**
   * Enable HMR WebSocket server (disabled by default to prevent port allocation issues)
   * @default false
   */
  enableHmr?: boolean
}

export type { TlsConfig }
