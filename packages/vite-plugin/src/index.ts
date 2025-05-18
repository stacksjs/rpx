/* eslint-disable no-console */
import type { Plugin, ViteDevServer } from 'vite'
import type { VitePluginRpxOptions } from './types'
import { exec, spawn } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import { checkExistingCertificates, checkHosts, cleanup, portManager, startProxies } from '@stacksjs/rpx'
import colors from 'picocolors'
import { SimplifiedVitePlugin } from './simplified-plugin'
import { buildConfig } from './utils'

const execAsync = promisify(exec)

async function checkInitialSudo(): Promise<boolean> {
  try {
    await execAsync('sudo -n true')
    return true
  }
  catch {
    return false
  }
}

async function needsSudoAccess(options: VitePluginRpxOptions, domain: string): Promise<boolean> {
  try {
    // Check if we need to generate certificates
    if (options.https) {
      const config = buildConfig(options, 'localhost:5173') // temporary URL for config
      const existingCerts = await checkExistingCertificates(config)
      if (!existingCerts) {
        return true
      }
    }

    // Check if we need to modify hosts file
    if (!domain.includes('localhost') && !domain.includes('127.0.0.1')) {
      const hostsExist = await checkHosts([domain], options.verbose)
      // Only need sudo if hosts don't exist and we don't have write permission
      if (!hostsExist[0]) {
        try {
          // Try to write a test file to check permissions
          await execAsync('sudo -n touch /etc/hosts')
          return false
        }
        catch {
          return true
        }
      }
    }

    return false
  }
  catch (error) {
    console.error('Error checking sudo requirements:', error)
    return false // If we can't check, don't assume we need sudo
  }
}

// Export the simplified plugin types and implementation
export { SimplifiedVitePlugin } from './simplified-plugin'
export type { SimplifiedPluginOptions } from './simplified-plugin'

// Set the default export to be the simplified plugin
export default SimplifiedVitePlugin

/**
 * Legacy VitePluginRpx implementation - kept for backward compatibility
 * @deprecated Use SimplifiedVitePlugin instead to avoid WebSocket port allocation issues
 */
export function VitePluginRpx(options: VitePluginRpxOptions): Plugin {
  const {
    enabled = true,
    verbose = false,
    cleanup: cleanupOpts = {
      hosts: true,
      certs: false,
    },
  } = options

  let domains: string[] | undefined
  let proxyUrl: string | undefined
  let originalConsole: typeof console
  let cleanupPromise: Promise<void> | null = null
  let serverInstance: ViteDevServer | undefined
  let isShuttingDown = false

  const debug = (...args: any[]) => {
    if (verbose && originalConsole)
      originalConsole.log('[vite-plugin-local]', ...args)
  }

  const exitHandler = async () => {
    if (!domains?.length || isShuttingDown) {
      debug('Skipping cleanup - no domains or already shutting down')
      return cleanupPromise
    }

    isShuttingDown = true
    debug('Starting cleanup process')

    try {
      cleanupPromise = cleanup({
        domains,
        hosts: typeof cleanupOpts === 'boolean' ? cleanupOpts : cleanupOpts?.hosts,
        certs: typeof cleanupOpts === 'boolean' ? cleanupOpts : cleanupOpts?.certs,
        verbose,
        vitePluginUsage: true, // Mark this cleanup as coming from the Vite plugin
      })

      await cleanupPromise
      domains = undefined
      debug('Cleanup completed successfully')
      return cleanupPromise
    }
    catch (error) {
      console.error('Error during cleanup:', error)
      throw error
    }
    finally {
      isShuttingDown = false
      cleanupPromise = null
    }
  }

  const handleSignal = async (signal: string) => {
    debug(`Received ${signal}, initiating cleanup...`)

    try {
      await exitHandler()
      debug(`Cleanup after ${signal} completed successfully`)
    }
    catch (error) {
      console.error(`Cleanup failed after ${signal}:`, error)
    }

    // Don't exit on CLOSE to allow normal server shutdown
    if (signal !== 'CLOSE' && serverInstance?.httpServer) {
      serverInstance.httpServer.close()
    }
  }

  return {
    name: 'vite-plugin-local',
    enforce: 'pre',
    apply: 'serve',

    configResolved(resolvedConfig) {
      // Early exit if we're in build mode
      if (resolvedConfig.command === 'build')
        return

      // Disable HMR WebSocket server completely by default
      // This is critical to stop the infinite port allocation loop
      if (resolvedConfig.server) {
        debug('Disabling HMR WebSocket server in Vite to prevent port allocation loops')
        resolvedConfig.server.hmr = false
      }
    },

    async configureServer(viteServer: ViteDevServer) {
      if (!enabled)
        return

      serverInstance = viteServer
      originalConsole = { ...console }

      // Move sudo check here
      const config = buildConfig(options)
      const domain = config.to

      const needsSudo = await needsSudoAccess(options, domain)
      if (needsSudo) {
        const hasSudoAccess = await checkInitialSudo()

        if (!hasSudoAccess) {
          const origLog = console.log
          console.log = () => { }

          process.stdout.write('\nSudo access required for proxy setup.\n')

          const gotSudoAccess = await new Promise<boolean>((resolve) => {
            const sudo = spawn('sudo', ['true'], {
              stdio: 'inherit',
            })

            sudo.on('exit', (code) => {
              resolve(code === 0)
            })
          })

          console.log = origLog

          if (!gotSudoAccess) {
            console.error('Failed to get sudo access. Please try again.')
            process.exit(1)
          }
        }
      }

      if (serverInstance.httpServer) {
        serverInstance.httpServer.once('close', () => {
          debug('Server closing, cleaning up...')
          handleSignal('CLOSE').catch(console.error)
        })
      }

      // Only register process signal handlers if they haven't been registered by rpx
      const registeredEvents = process.listeners('SIGINT').length > 0
        && process.listeners('SIGTERM').length > 0

      if (!registeredEvents) {
        // Register signal handlers only if rpx hasn't registered them already
        process.once('SIGINT', () => handleSignal('SIGINT').catch(console.error))
        process.once('SIGTERM', () => handleSignal('SIGTERM').catch(console.error))
      }

      const colorUrl = (url: string) => colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`))

      // Store the original printUrls function
      const originalPrintUrls = serverInstance.printUrls

      // Wrap the printUrls function to add our custom output while preserving other plugins' modifications
      serverInstance.printUrls = () => {
        if (!serverInstance?.resolvedUrls)
          return

        // Call the original printUrls function first
        if (typeof originalPrintUrls === 'function') {
          originalPrintUrls.call(serverInstance)
        }
        else {
          // If no other plugin has modified printUrls, print the default local URL
          console.log(`  ${colors.green('➜')}  ${colors.bold('Local')}:   ${colorUrl(serverInstance.resolvedUrls.local[0])}`)
          console.log(`  ${colors.green('➜')}  ${colors.bold('Network')}: ${colors.dim('use --host to expose')}`)
        }

        // Add our custom proxy URL information
        if (proxyUrl) {
          const protocol = options.https ? 'https' : 'http'
          const proxiedUrl = `${protocol}://${proxyUrl}/`
          console.log(`  ${colors.green('➜')}  ${colors.bold('Proxied URL')}: ${colorUrl(proxiedUrl)}`)

          if (options.https) {
            console.log(`  ${colors.green('➜')}  ${colors.bold('SSL')}: ${colors.dim('TLS 1.2/1.3, HTTP/2')}`)
          }
        }
      }

      const startProxy = async () => {
        try {
          const host = typeof serverInstance?.config.server.host === 'boolean'
            ? 'localhost'
            : serverInstance?.config.server.host || 'localhost'

          const port = serverInstance?.config.server.port || 5173
          const serverUrl = `${host}:${port}`

          const config = buildConfig(options, serverUrl)
          domains = [config.to]
          proxyUrl = config.to

          debug('Starting proxies...')
          await startProxies({
            ...config,
            vitePluginUsage: true, // Mark this as coming from the Vite plugin
          })
          debug('Proxy setup complete')
        }
        catch (error) {
          console.error('Failed to start reverse proxy:', error)
          process.exit(1)
        }
      }

      // Wait for the server to be ready before starting the proxy
      if (serverInstance.httpServer) {
        serverInstance.httpServer.once('listening', () => {
          startProxy().catch(console.error)
        })

        if (serverInstance.httpServer.listening) {
          await startProxy()
        }
      }
    },

    // Add a closeBundle hook to ensure cleanup happens
    async closeBundle() {
      debug('Bundle closing, initiating cleanup...')
      await handleSignal('CLOSE')
    },
  }
}
