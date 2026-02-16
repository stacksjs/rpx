import type { BunPlugin } from 'bun'
import type { PluginBuilder, RpxPluginOptions } from './types'
import path from 'node:path'
import * as process from 'node:process'
import {
  cleanup,
  httpsConfig,
  startProxies,
} from '@stacksjs/rpx'
import colors from 'picocolors'
import { execAsync, needsSudoAccess } from './utils'

/**
 * A Bun plugin to provide custom domain names for local development
 * instead of using localhost:port
 */
function RpxBunPlugin(options: RpxPluginOptions = {}): BunPlugin {
  const {
    enabled = true,
    domain: userDomain,
    https = false,
    verbose = false,
    cleanUrls = false,
    cleanup: cleanupOpts = {
      hosts: true,
      certs: false,
    },
  } = options

  // Store server instance and port to clean up later
  let serverPort: number | null = null
  let domain: string = ''
  let isProxyStarted = false
  let isCleaningUp = false
  let hasSudoAccess = false
  let cleanupPromise: Promise<void> | null = null

  const debug = (...args: any[]) => {
    if (verbose)
      console.error('[bun-plugin-rpx]', ...args)
  }

  return {
    name: 'bun-plugin-rpx',
    async setup(build) {
      if (!enabled) {
        debug('Plugin is disabled, skipping setup')
        return
      }

      // Get the project name from package.json as a fallback domain
      let projectName = ''
      try {
        const pkgPath = path.join(process.cwd(), 'package.json')
        const pkg = await import(pkgPath, {
          with: { type: 'json' },
        })
        projectName = pkg.default.name || 'app'
      }
      catch {
        projectName = 'app'
      }

      // Use provided domain or fallback to projectName.localhost
      domain = userDomain || `${projectName}.localhost`

      // Check if we need sudo access early
      if (https || (!domain.includes('localhost') && !domain.includes('127.0.0.1'))) {
        try {
          const needsSudo = await needsSudoAccess({
            domain,
            https,
            verbose,
          })

          if (needsSudo) {
            debug('Sudo access required for setup')
            hasSudoAccess = await checkInitialSudo()

            if (!hasSudoAccess) {
              process.stdout.write('\nSudo access required for proxy setup.\n')

              const sudo = Bun.spawn(['sudo', 'true'], {
                stdio: ['inherit', 'inherit', 'inherit'],
              })

              const exitCode = await sudo.exited
              hasSudoAccess = exitCode === 0

              if (!hasSudoAccess) {
                console.error('Failed to get sudo access. Please try again.')
                process.exit(1)
              }
            }
          }
        }
        catch (error) {
          console.error('Error checking sudo requirements:', error)
        }
      }

      // Hook into serve to intercept port and start rpx
      const buildWithServe = build as unknown as PluginBuilder
      const originalServe = buildWithServe.serve

      buildWithServe.serve = (options?) => {
        // Store the original serve function result
        const server = originalServe(options)
        const originalStart = server.start

        server.start = async (...args) => {
          // Start the original server
          const result = await originalStart.apply(server, args)

          // Get the port from the server
          serverPort = result.port

          if (serverPort && !isProxyStarted) {
            await startRpx(serverPort)
            isProxyStarted = true
          }

          return result
        }

        return server
      }

      // Setup exit handler
      const exitHandler = async () => {
        if (!domain || isCleaningUp) {
          debug('Skipping cleanup - no domain or already cleaning')
          return
        }

        isCleaningUp = true
        debug('Starting cleanup process')

        try {
          cleanupPromise = cleanup({
            domains: [domain],
            hosts: typeof cleanupOpts === 'boolean' ? cleanupOpts : cleanupOpts?.hosts,
            certs: typeof cleanupOpts === 'boolean' ? cleanupOpts : cleanupOpts?.certs,
            verbose,
          })

          await cleanupPromise
          debug('Cleanup completed successfully')
        }
        catch (error) {
          console.error('Error during cleanup:', error)
        }
        finally {
          isCleaningUp = false
          cleanupPromise = null
        }
      }

      // Handle process exit - cleanup is handled by the rpx library
      process.once('SIGINT', exitHandler)
      process.once('SIGTERM', exitHandler)
      process.once('beforeExit', exitHandler)
      process.once('exit', async () => {
        if (cleanupPromise) {
          try {
            await cleanupPromise
          }
          catch (error) {
            console.error('Cleanup failed during exit:', error)
            process.exit(1)
          }
        }
      })
    },
  }

  /**
   * Start rpx proxy
   */
  async function startRpx(port: number) {
    if (!port) {
      debug('No port provided, cannot start proxy')
      return
    }

    try {
      debug(`Starting RPX: ${domain} -> localhost:${port}`)

      // Configure and start the proxy
      const serverUrl = `localhost:${port}`

      const config = {
        from: serverUrl,
        to: domain,
        https: https ? httpsConfig({ to: domain }) : false,
        cleanup: cleanupOpts ?? true,
        cleanUrls,
        verbose,
      }

      const colorUrl = (url: string) => colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`))

      await startProxies(config)

      // Display the proxy URL information
      const protocol = https ? 'https' : 'http'
      const proxiedUrl = `${protocol}://${domain}/`

      console.error(`\n  ${colors.green('➜')}  ${colors.bold('Local')}:   http://localhost:${port}`)
      console.error(`  ${colors.green('➜')}  ${colors.bold('Proxied URL')}: ${colorUrl(proxiedUrl)}`)

      if (https) {
        console.error(`  ${colors.green('➜')}  ${colors.bold('SSL')}: ${colors.dim('TLS 1.2/1.3, HTTP/2')}`)
      }
    }
    catch (error) {
      console.error('Failed to start rpx:', error)
      process.exit(1)
    }
  }
}

async function checkInitialSudo(): Promise<boolean> {
  try {
    await execAsync('sudo -n true')
    return true
  }
  catch {
    return false
  }
}

export { RpxBunPlugin }
export default RpxBunPlugin
