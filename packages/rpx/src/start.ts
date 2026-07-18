/* eslint-disable no-console */
import type { BaseProxyConfig, CleanupOptions, LoadBalancerConfig, ProxyConfig, ProxyFrom, ProxyOption, ProxyOptions, ProxySetupOptions, ResolvedProxyOptions, SingleProxyConfig, SSLConfig, StartOptions } from './types'
import { exec, execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import * as tls from 'node:tls'
import { log } from './logger'
import { colors } from './colors'
import { config } from './config'
import { runViaDaemon } from './daemon-runner'
import { addHosts, checkHosts, removeHosts } from './hosts'
import { checkExistingCertificates, cleanupCertificates, generateCertificate, httpsConfig, loadSSLConfig } from './https'
import { createUpstreamPool, primaryUpstreamUrl, startHealthChecks, stopHealthChecks } from './load-balancer'
import type { UpstreamPool } from './load-balancer'
import { DefaultPortManager, findAvailablePort, isPortInUse } from './port-manager'
import { ProcessManager } from './process-manager'
import { createOriginGuard } from './origin-guard'
import { createProxyFetchHandler, createProxyWebSocketHandler } from './proxy-handler'
import type { ProxyRoute, ProxyServer as ProxyServerLike } from './proxy-handler'
import { resolveRedirect } from './redirect'
import { readAcmeChallenge } from './acme-challenge'
import { resolveAuth } from './auth'
import type { ResolvedAuth } from './auth'
import { isWildcardPattern } from './host-match'
import { buildHostRoutes, matchHostRoute, normalizePathPrefix } from './host-routes'
import { buildSniTlsConfig } from './sni'
import type { SniTlsEntry } from './sni'
import { OnDemandCertManager } from './on-demand'
import { resolveStaticRoute } from './static-files'
import { debugLog, getSudoPassword, safeStringify, shouldReusePort } from './utils'

const processManager = new ProcessManager()
const version = '0.12.0'
// Create a global port manager for coordinating port usage
const globalPortManager = new DefaultPortManager('0.0.0.0')

// Keep track of all running servers for cleanup
const activeServers: Set<http.Server | https.Server> = new Set()
// Upstream pools with active-health-check timers, so `cleanup()` can stop them
// and not leak `setInterval` handles across repeated start/stop cycles (tests).
const activeUpstreamPools: Set<UpstreamPool> = new Set()
type SharedTlsConfig = SSLConfig | SniTlsEntry[]

let isCleaningUp = false
let cleanupPromiseResolve: (() => void) | null = null
let cleanupPromise: Promise<void> | null = null

export async function cleanup(options?: CleanupOptions): Promise<void> {
  if (isCleaningUp) {
    debugLog('cleanup', 'Cleanup already in progress, skipping', options?.verbose)
    // Return the existing cleanup promise if it exists
    return cleanupPromise || Promise.resolve()
  }

  isCleaningUp = true
  debugLog('cleanup', 'Starting cleanup process', options?.verbose)

  // Create a new cleanup promise that can be returned to all callers
  cleanupPromise = new Promise<void>((resolve) => {
    cleanupPromiseResolve = resolve
  })

  try {
    // Stop all watched processes first
    await processManager.stopAll(options?.verbose)

    log.info('Shutting down proxy servers...')

    // Create an array to store all cleanup promises
    const cleanupPromises: Promise<void>[] = []

    // Add server closing promises. `activeServers` holds a mix of Node servers
    // (the HTTP redirect server) and Bun.serve servers (every proxy listener
    // now routes through Bun). They expose different shutdown APIs: Node uses
    // `.close(cb)`, Bun uses `.stop(closeActiveConnections)`. Detect and call
    // the right one so Bun listeners are actually released — without this they
    // leak whenever the process doesn't `exit()` (Vite-plugin mode and tests).
    const serverClosePromises = Array.from(activeServers).map(server =>
      new Promise<void>((resolve) => {
        const s = server as unknown as {
          stop?: (closeActiveConnections?: boolean) => void
          close?: (cb?: () => void) => void
        }
        try {
          if (typeof s.stop === 'function') {
            s.stop(true)
            debugLog('cleanup', 'Bun server stopped', options?.verbose)
            resolve()
          }
          else if (typeof s.close === 'function') {
            s.close(() => {
              debugLog('cleanup', 'Server closed successfully', options?.verbose)
              resolve()
            })
          }
          else {
            resolve()
          }
        }
        catch (err) {
          debugLog('cleanup', `Error stopping server: ${err}`, options?.verbose)
          resolve()
        }
      }),
    )
    cleanupPromises.push(...serverClosePromises)
    // Drop references so a subsequent cleanup() doesn't try to stop them again.
    activeServers.clear()

    // Stop any active-health-check timers so they don't keep firing (or
    // leak) after the servers they belong to are gone.
    for (const pool of activeUpstreamPools)
      stopHealthChecks(pool)
    activeUpstreamPools.clear()

    // hosts file cleanup if configured
    if (options?.hosts && options.domains?.length) {
      debugLog('cleanup', 'Cleaning up hosts file entries', options?.verbose)
      debugLog('cleanup', `Original domains for cleanup: ${JSON.stringify(options.domains)}`, options?.verbose)

      // More precise filtering to only filter actual localhost domains
      // In tests, domains may contain 'test.local' which should not be filtered out
      const domainsToClean = options.domains.filter((domain) => {
        // Don't filter out domains in unit tests
        if (domain === 'test.local')
          return true

        // Only filter out actual localhost domains
        return domain !== 'localhost'
          && !domain.startsWith('localhost.')
          && domain !== '127.0.0.1'
      })

      debugLog('cleanup', `Filtered domains for cleanup: ${JSON.stringify(domainsToClean)}`, options?.verbose)

      if (domainsToClean.length > 0) {
        log.info('Cleaning up hosts file entries...')
        cleanupPromises.push(
          removeHosts(domainsToClean, options?.verbose)
            .then(() => {
              debugLog('cleanup', `Removed hosts entries for ${domainsToClean.join(', ')}`, options?.verbose)
            })
            .catch((err) => {
              debugLog('cleanup', `Failed to remove hosts entries: ${err}`, options?.verbose)
              log.warn(`Failed to clean up hosts file entries for ${domainsToClean.join(', ')}:`, err)
            }),
        )
      }
    }

    // certificate cleanup if configured
    if (options?.certs && options.domains?.length) {
      debugLog('cleanup', 'Cleaning up SSL certificates', options?.verbose)
      log.info('Cleaning up SSL certificates...')

      const certCleanupPromises = options.domains.map(async (domain) => {
        try {
          await cleanupCertificates(domain, options?.verbose)
          debugLog('cleanup', `Removed certificates for ${domain}`, options?.verbose)
        }
        catch (err) {
          debugLog('cleanup', `Failed to remove certificates for ${domain}: ${err}`, options?.verbose)
          log.warn(`Failed to clean up certificates for ${domain}:`, err)
        }
      })

      cleanupPromises.push(...certCleanupPromises)
    }

    await Promise.allSettled(cleanupPromises)
    debugLog('cleanup', 'All cleanup tasks completed successfully', options?.verbose)
    log.success('All cleanup tasks completed successfully')
  }
  catch (err) {
    debugLog('cleanup', `Error during cleanup: ${err}`, options?.verbose)
    log.error('Error during cleanup:', err)
  }
  finally {
    if (cleanupPromiseResolve)
      cleanupPromiseResolve()
    cleanupPromiseResolve = null
    isCleaningUp = false

    // Only exit the process if not running in a test environment
    // and we're not being called from the Vite plugin
    const isVitePluginCall = options && 'vitePluginUsage' in options && options.vitePluginUsage === true
    if (process.env.NODE_ENV !== 'test' && process.env.BUN_ENV !== 'test' && !isVitePluginCall) {
      // Use a more forceful exit to ensure all handles are closed
      process.exit(0)
    }
  }

  return cleanupPromise
}

// Register cleanup handlers
let isHandlingSignal = false

function signalHandler(signal: string) {
  if (isHandlingSignal) {
    // Force exit if we get a second signal
    debugLog('signal', `Received second ${signal} signal, forcing exit`, true)
    process.exit(1)
    return
  }

  isHandlingSignal = true
  debugLog('signal', `Received ${signal} signal, initiating cleanup`, true)

  cleanup()
    .catch((err) => {
      debugLog('signal', `Cleanup failed after ${signal}: ${err}`, true)
      process.exit(1)
    })
    .finally(() => {
      isHandlingSignal = false
    })
}

// Use a unified approach to handle signals
process.once('SIGINT', () => signalHandler('SIGINT'))
process.once('SIGTERM', () => signalHandler('SIGTERM'))
// A reverse proxy must outlive a single bad request: log uncaught errors /
// rejections and keep serving rather than tearing every route down. Clean
// shutdown still happens on SIGINT/SIGTERM above; only those exit the process.
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception (continuing):', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection (continuing):', reason)
})

/**
 * Test connection to a server
 */
async function testConnection(hostname: string, port: number, verbose?: boolean, retries = 5): Promise<void> {
  debugLog('connection', `Testing connection to ${hostname}:${port} (retries left: ${retries})`, verbose)

  // Add a maximum retry timeout to prevent hanging indefinitely
  const maxTestDuration = 15000 // 15 seconds maximum for the entire test process
  const startTime = Date.now()

  // Check if we should bypass the connection test (for special cases)
  if (process.env.RPX_BYPASS_CONNECTION_TEST === 'true') {
    debugLog('connection', `Bypassing connection test for ${hostname}:${port} due to RPX_BYPASS_CONNECTION_TEST flag`, verbose)
    return
  }

  const tryConnect = () => new Promise<void>((resolve, reject) => {
    const socket = net.connect({
      host: hostname,
      port,
      timeout: 3000, // Increase timeout to 3 seconds per attempt for better reliability
    })

    socket.once('connect', () => {
      debugLog('connection', `Successfully connected to ${hostname}:${port}`, verbose)
      socket.end()
      resolve()
    })

    socket.once('timeout', () => {
      debugLog('connection', `Connection to ${hostname}:${port} timed out`, verbose)
      socket.destroy()
      reject(new Error('Connection timed out'))
    })

    socket.once('error', (err) => {
      debugLog('connection', `Failed to connect to ${hostname}:${port}: ${err}`, verbose)
      socket.destroy()
      reject(err)
    })
  })

  try {
    await tryConnect()
  }
  catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    // Check if we've exceeded the maximum test duration
    if (Date.now() - startTime > maxTestDuration) {
      debugLog('connection', `Connection test timed out after ${maxTestDuration}ms, but continuing anyway`, verbose)
      log.warn(`Connection test to ${hostname}:${port} timed out, but RPX will try to proceed anyway.`)
      return // Continue with setup despite timeout
    }

    // If we're dealing with a server that takes time to start up
    if (e.code === 'ECONNREFUSED' && retries > 0) {
      debugLog('connection', `Connection refused, server might be starting up. Retrying in 2 seconds... (${retries} retries left)`, verbose)
      await new Promise(resolve => setTimeout(resolve, 2000))
      return testConnection(hostname, port, verbose, retries - 1)
    }

    // For other errors, retry with a different approach
    if (retries > 0) {
      // Try a more resilient HTTP check if traditional socket connection fails
      try {
        debugLog('connection', `Trying HTTP request to ${hostname}:${port}`, verbose)
        await new Promise<void>((resolve, reject) => {
          const req = http.request({
            hostname,
            port,
            path: '/',
            method: 'HEAD',
            timeout: 5000,
          }, (res) => {
            // Any response is considered success (even 404, 500, etc)
            debugLog('connection', `Received HTTP response with status: ${res.statusCode}`, verbose)
            resolve()
          })

          req.on('error', e => reject(e))
          req.on('timeout', () => {
            req.destroy()
            reject(new Error('HTTP request timed out'))
          })

          req.end()
        })

        debugLog('connection', `HTTP request to ${hostname}:${port} succeeded`, verbose)
        return // HTTP request succeeded, continue with setup
      }
      catch (httpErr) {
        debugLog('connection', `HTTP request to ${hostname}:${port} failed: ${httpErr}`, verbose)

        // Still retry the regular socket connection approach
        debugLog('connection', `Retrying socket connection in 2 seconds... (${retries} retries left)`, verbose)
        await new Promise(resolve => setTimeout(resolve, 2000))
        return testConnection(hostname, port, verbose, retries - 1)
      }
    }

    // For production environments, we might want to be more strict
    // But for typical usage, let's be permissive and just warn
    const errorMessage = `Failed to connect to ${hostname}:${port} after ${5 - retries} attempts: ${e.message}`
    debugLog('connection', `${errorMessage}. To bypass this check set RPX_BYPASS_CONNECTION_TEST=true`, verbose)
    log.warn(errorMessage)
    log.warn(`RPX will try to continue anyway. If you're sure this is correct, you can set RPX_BYPASS_CONNECTION_TEST=true to skip this check.`)
  }
}

export async function startServer(options: SingleProxyConfig): Promise<void> {
  debugLog('server', `Starting server with options: ${safeStringify(options)}`, options.verbose)

  // Parse URLs early to get the hostnames. `from` may be a load-balanced pool
  // (array); connection testing / hosts-file checks below only need a single
  // representative upstream, so use the first one — the full `options.from`
  // (with all upstreams) is still passed through to `setupProxy` untouched for
  // the actual pool construction downstream.
  const primaryFrom = primaryUpstreamUrl(options.from)
  const fromUrl = new URL(primaryFrom.startsWith('http') ? primaryFrom : `http://${primaryFrom}`)
  const toUrl = new URL((options.to?.startsWith('http') ? options.to : `http://${options.to}`) || 'rpx.localhost')
  const fromPort = Number.parseInt(fromUrl.port) || (fromUrl.protocol.includes('https:') ? 443 : 80)

  // Check and update hosts file for custom domains
  const hostsToCheck = [toUrl.hostname]
  if (isHostsManagementEnabled(options) && !toUrl.hostname.includes('localhost') && !toUrl.hostname.includes('127.0.0.1')) {
    debugLog('hosts', `Checking if hosts file entry exists for: ${toUrl.hostname}`, options?.verbose)

    try {
      const hostsExist = await checkHosts(hostsToCheck, options.verbose)
      if (!hostsExist[0]) {
        log.info(`Adding ${toUrl.hostname} to hosts file...`)
        log.info('This may require sudo/administrator privileges')
        try {
          await addHosts(hostsToCheck, options.verbose)
        }
        catch (addError) {
          log.error('Failed to add hosts entry:', (addError as Error).message)
          log.warn('You can manually add this entry to your hosts file:')
          log.warn(`127.0.0.1 ${toUrl.hostname}`)
          log.warn(`::1 ${toUrl.hostname}`)

          if (process.platform === 'win32') {
            log.warn('On Windows:')
            log.warn('1. Run notepad as administrator')
            log.warn('2. Open C:\\Windows\\System32\\drivers\\etc\\hosts')
          }
          else {
            log.warn('On Unix systems:')
            log.warn('sudo nano /etc/hosts')
          }
        }
      }
      else {
        debugLog('hosts', `Host entry already exists for ${toUrl.hostname}`, options.verbose)
      }
    }
    catch (checkError) {
      log.error('Failed to check hosts file:', (checkError as Error).message)
      // Continue with proxy setup even if hosts check fails
    }
  }

  // Test connection to source server before proceeding
  try {
    await testConnection(fromUrl.hostname, fromPort, options.verbose)
  }
  catch (err) {
    debugLog('server', `Connection test failed: ${err}`, options.verbose)
    log.error((err as Error).message)
    // Don't exit process, continue with proxy setup
    log.warn('Continuing with proxy setup despite connection test failure...')
    log.info('If you need to bypass connection testing, set environment variable RPX_BYPASS_CONNECTION_TEST=true')
  }

  let sslConfig = options._cachedSSLConfig || null

  if (options.https) {
    try {
      if (options.https === true) {
        options.https = httpsConfig({
          ...options,
          to: toUrl.hostname,
        })
      }

      // Always check for existing and trusted certificates
      sslConfig = await checkExistingCertificates({
        ...options,
        to: toUrl.hostname,
        https: options.https,
      })

      // Generate new certificates if loading failed, returned null, or not trusted
      if (!sslConfig) {
        debugLog('ssl', `Generating new certificates for ${toUrl.hostname}`, options.verbose)
        await generateCertificate({
          ...options,
          from: fromUrl.toString(),
          to: toUrl.hostname,
          https: options.https,
        })

        // Try loading again after generation
        sslConfig = await checkExistingCertificates({
          ...options,
          to: toUrl.hostname,
          https: options.https,
        })

        if (!sslConfig) {
          throw new Error(`Failed to load SSL configuration after generating certificates for ${toUrl.hostname}`)
        }
      }
    }
    catch (err) {
      debugLog('server', `SSL setup failed: ${err}`, options.verbose)
      throw err
    }
  }

  debugLog('server', `Setting up reverse proxy with SSL config for ${toUrl.hostname}`, options.verbose)

  await setupProxy({
    ...options,
    from: primaryFrom,
    originalFrom: options.from || primaryFrom,
    to: toUrl.hostname,
    fromPort,
    sourceUrl: {
      hostname: fromUrl.hostname,
      host: fromUrl.host,
    },
    ssl: sslConfig,
  })
}

async function createProxyServer(
  from: string,
  to: string,
  listenPort: number,
  sourceUrl: Pick<URL, 'hostname' | 'host'>,
  ssl: SSLConfig | null,
  vitePluginUsage?: boolean,
  verbose?: boolean,
  cleanUrls?: boolean,
  changeOrigin?: boolean,
  auth?: ResolvedAuth,
  originalFrom?: ProxyFrom,
  loadBalancer?: LoadBalancerConfig,
): Promise<void> {
  debugLog('proxy', `Creating proxy server ${from} -> ${to} with cleanUrls: ${cleanUrls}`, verbose)

  // Route the single proxy through the same shared handler the multi-proxy and
  // daemon paths use. This unifies HTTP forwarding (the pooled keepalive
  // transport, path rewrites, changeOrigin) AND — crucially — gives WebSocket /
  // `wss` proxying in single-proxy mode, which dev-server HMR over HTTPS relies
  // on (issue #26). The previous hand-rolled `fetch()` forwarder had no
  // `websocket` handler, so HMR upgrades were dropped.
  //
  // `from` may be a load-balanced pool (array); always route dispatch through
  // an `upstreamPool` (even the degenerate single-upstream case) so the
  // selection/health-tracking logic in `resolveTarget` has one code path.
  // `sourceHost` is kept too as a plain-string mirror for tests/tools that
  // still read it directly.
  const pool = createUpstreamPool(originalFrom ?? sourceUrl.host, loadBalancer)
  startHealthChecks(pool)

  const routeEntries = [{
    host: to,
    route: {
      sourceHost: sourceUrl.host,
      upstreamPool: pool,
      cleanUrls: cleanUrls || false,
      changeOrigin: changeOrigin || false,
      basePath: '/',
      auth,
    } as ProxyRoute,
  }]

  const server = createSharedProxyServer({ routeEntries, listenPort, sslConfig: ssl, originGuard: null, verbose: verbose ?? false })
  if (!server) {
    stopHealthChecks(pool)
    throw new Error(`Failed to start proxy server for ${to} on port ${listenPort}`)
  }

  activeUpstreamPools.add(pool)

  logToConsole({
    from,
    to,
    vitePluginUsage,
    listenPort,
    ssl: !!ssl,
    cleanUrls,
    verbose,
  })
}

export async function setupProxy(options: ProxySetupOptions): Promise<void> {
  debugLog('setup', `Setting up reverse proxy: ${safeStringify(options)}`, options.verbose)

  const { from, originalFrom, to, sourceUrl, ssl, verbose, cleanup: cleanupOptions, vitePluginUsage, changeOrigin, cleanUrls } = options
  const httpPort = 80
  const httpsPort = 443
  const hostname = '0.0.0.0'
  // Use the global port manager if not provided
  const portManager = options.portManager || globalPortManager

  const hostsEnabled = isHostsManagementEnabled(options)

  try {
    // Add an extra check to make sure the hostname is in the hosts file
    if (hostsEnabled && to && !to.includes('localhost') && !to.includes('127.0.0.1')) {
      const hostsExist = await checkHosts([to], verbose)
      if (!hostsExist[0]) {
        log.warn(`The hostname ${to} isn't in your hosts file. Adding it now...`)
        try {
          await addHosts([to], verbose)
          log.success(`Added ${to} to your hosts file.`)
        }
        catch (error) {
          log.error(`Failed to add ${to} to your hosts file: ${error}`)
          log.info(`You may need to manually add '127.0.0.1 ${to}' to your /etc/hosts file.`)
        }
      }
    }
    else {
      // On macOS, *.localhost domains resolve to 127.0.0.1 automatically (RFC 6761)
      // so we don't need to add them to /etc/hosts
      if (hostsEnabled && process.platform !== 'darwin' && to && to.includes('localhost') && !to.match(/^(localhost|127\.0\.0\.1)$/)) {
        const hostsExist = await checkHosts([to], verbose)
        if (!hostsExist[0]) {
          debugLog('hosts', `${to} not found in hosts file, adding...`, verbose)
          try {
            await addHosts([to], verbose)
          }
          catch (error) {
            debugLog('hosts', `Failed to add ${to} to hosts file: ${error}`, verbose)
          }
        }
      }
    }

    // Handle HTTP redirect server only for the first proxy
    if (ssl && !portManager.usedPorts.has(httpPort)) {
      const isHttpPortBusy = await isPortInUse(httpPort, hostname, verbose)
      if (!isHttpPortBusy) {
        debugLog('setup', 'Starting HTTP redirect server', verbose)
        startHttpRedirectServer(verbose)
        portManager.usedPorts.add(httpPort)
      }
      else {
        debugLog('setup', 'Port 80 is in use, skipping HTTP redirect', verbose)
        if (verbose)
          log.warn('Port 80 is in use, HTTP to HTTPS redirect will not be available')
      }
    }

    const targetPort = ssl ? httpsPort : httpPort

    // First check if the target port is already in use
    const isTargetPortBusy = await isPortInUse(targetPort, hostname, verbose)

    let finalPort: number

    if (isTargetPortBusy) {
      debugLog('setup', `Port ${targetPort} is already in use`, verbose)
      if (verbose)
        log.warn(`Port ${targetPort} is already in use. This may be another instance of rpx or another service.`)

      // For port 443, we need admin/sudo privileges to use it directly
      if (targetPort === 443) {
        // Use the enhanced port manager with connectivity testing for more reliability
        finalPort = await portManager.getNextAvailablePort(3443, true)
        debugLog('setup', `Using port ${finalPort} instead of ${targetPort}`, verbose)
        if (verbose)
          log.info(`Using port ${finalPort} instead. Access your site at https://${to}:${finalPort}`)
      }
      else {
        // Use the enhanced port manager with connectivity testing for more reliability
        finalPort = await portManager.getNextAvailablePort(targetPort + 1000, true)
        debugLog('setup', `Using port ${finalPort} instead of ${targetPort}`, verbose)
        if (verbose)
          log.info(`Using port ${finalPort} instead. Access your site at http://${to}:${finalPort}`)
      }
    }
    else {
      // Standard port is available, use it
      finalPort = targetPort
      portManager.usedPorts.add(finalPort)
      debugLog('setup', `Using standard ${targetPort === 443 ? 'HTTPS' : 'HTTP'} port ${targetPort} for ${to}`, verbose)
    }

    await createProxyServer(from, to, finalPort, sourceUrl, ssl, vitePluginUsage, verbose, cleanUrls, changeOrigin, resolveAuth((options as { auth?: import('./types').BasicAuthConfig }).auth), originalFrom, options.loadBalancer)
  }
  catch (err) {
    debugLog('setup', `Setup failed: ${err}`, verbose)
    log.error(`Failed to setup reverse proxy: ${(err as Error).message}`)
    cleanup({
      domains: [to],
      hosts: typeof cleanupOptions === 'boolean' ? cleanupOptions : cleanupOptions?.hosts,
      certs: typeof cleanupOptions === 'boolean' ? cleanupOptions : cleanupOptions?.certs,
      verbose,
      vitePluginUsage,
    })
  }
}

export function startHttpRedirectServer(verbose?: boolean, httpPort = 80, httpsPort = 443, acmeChallengeWebroot?: string, onDemand?: OnDemandCertManager | null): void {
  debugLog('redirect', `Starting HTTP redirect server on port ${httpPort}`, verbose)

  const server = http
    .createServer((req, res) => {
      const pathname = req.url ? req.url.split('?', 1)[0] : ''

      // ACME http-01 challenges: rpx's on-demand manager keeps its tokens in
      // memory; an external `tlsx acme:renew --webroot` drops them on disk.
      // Serve both so certs issue/renew without taking the gateway down.
      if (pathname.startsWith('/.well-known/acme-challenge/')) {
        if (onDemand) {
          const keyAuth = onDemand.challengeStore.handlePath(pathname)
          if (keyAuth !== undefined) {
            debugLog('redirect', `Serving on-demand ACME challenge ${pathname}`, verbose)
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end(keyAuth)
            return
          }
        }
        if (acmeChallengeWebroot) {
          const keyAuth = readAcmeChallenge(acmeChallengeWebroot, pathname)
          if (keyAuth != null) {
            debugLog('redirect', `Serving ACME challenge ${pathname}`, verbose)
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end(keyAuth)
            return
          }
        }
        // With on-demand active a challenge miss is a real 404 (Let's Encrypt
        // must not follow a redirect for a token we never registered).
        if (onDemand) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('challenge not found')
          return
        }
      }

      const rawHost = req.headers.host || ''
      // Strip any incoming port so we can append the HTTPS port when it's
      // non-standard (e.g. redirecting `:80` → `:8443` in a custom-port setup).
      const hostname = rawHost.includes(':') ? rawHost.slice(0, rawHost.indexOf(':')) : rawHost
      // First plaintext hit for an approved-but-uncovered host: kick off
      // issuance so the cert exists for the subsequent HTTPS request.
      if (onDemand && hostname && !onDemand.hasCert(hostname))
        onDemand.ensureCert(hostname).catch(() => {})

      const target = httpsPort === 443 ? hostname : `${hostname}:${httpsPort}`
      debugLog('redirect', `Redirecting request from ${rawHost}${req.url} to https://${target}`, verbose)
      res.writeHead(301, {
        Location: `https://${target}${req.url}`,
      })
      res.end()
    })
    .listen(httpPort)
  activeServers.add(server)
  debugLog('redirect', 'HTTP redirect server started', verbose)
}

export function startProxy(options: ProxyOption): void {
  const mergedOptions = {
    ...config,
    ...options,
  }

  debugLog('proxy', `Starting proxy with options: ${safeStringify(mergedOptions)}`, mergedOptions?.verbose)

  // viaDaemon: register with the long-running daemon instead of binding our
  // own :443. The daemon owns TLS termination and host-header routing for
  // every concurrent `rpx start` on this machine.
  if (mergedOptions.viaDaemon) {
    if (!mergedOptions.from || !mergedOptions.to) {
      log.error('viaDaemon mode requires both `from` and `to`')
      return
    }
    runViaDaemon({
      proxies: [{
        id: mergedOptions.id,
        from: mergedOptions.from,
        to: mergedOptions.to,
        path: mergedOptions.path,
        cleanUrls: mergedOptions.cleanUrls,
        changeOrigin: mergedOptions.changeOrigin,
        pathRewrites: mergedOptions.pathRewrites,
      }],
      verbose: mergedOptions.verbose,
    }).catch((err) => {
      log.error(`Failed to register with rpx daemon: ${err.message}`)
      process.exit(1)
    })
    return
  }

  // Start DNS server for custom domains on macOS (any domain that's not localhost/127.0.0.1)
  const targetDomain = mergedOptions.to || ''
  const tld = targetDomain.split('.').pop()?.toLowerCase() || ''
  const isCustomDomain = process.platform === 'darwin'
    && targetDomain
    && !targetDomain.includes('localhost')
    && !targetDomain.includes('127.0.0.1')

  // TLDs that are problematic for local development (owned by Google/others with HSTS preloading)
  const problematicTlds = ['dev', 'app', 'page', 'new', 'day', 'foo']
  // Reserved TLDs that are safe for local development (RFC 2606 / RFC 6761)
  const reservedTlds = ['test', 'localhost', 'local', 'example', 'invalid']

  if (isCustomDomain && problematicTlds.includes(tld) && mergedOptions?.verbose) {
    log.warn(`The .${tld} TLD may not work reliably for local development`)
    log.info(`  Google owns .${tld} with HSTS preloading, which can bypass local DNS`)
    log.info(`  Consider using a reserved TLD: .test, .localhost, or .local`)
  }

  if (isCustomDomain) {
    import('./dns').then(({ setupDevelopmentDns }) => {
      setupDevelopmentDns({ domains: [targetDomain], verbose: mergedOptions.verbose }).then((started) => {
        if (started) {
          Promise.resolve().then(() => {
            if (mergedOptions.verbose) {
              if (reservedTlds.includes(tld)) {
                log.success(`DNS server started for .${tld} domains`)
              }
              else {
                log.success(`DNS server started for .${tld} domains (hosts file entry also added)`)
              }
            }
          })
        }
        else {
          debugLog('dns', `Could not start DNS server - ${targetDomain} may not resolve in browser`, mergedOptions.verbose)
        }
      })
    }).catch((err) => {
      debugLog('dns', `Failed to start DNS server: ${err}`, mergedOptions.verbose)
    })
  }

  const serverOptions: SingleProxyConfig = {
    from: mergedOptions.from,
    to: mergedOptions.to,
    cleanUrls: mergedOptions.cleanUrls,
    https: httpsConfig(mergedOptions),
    cleanup: mergedOptions.cleanup,
    vitePluginUsage: mergedOptions.vitePluginUsage,
    changeOrigin: mergedOptions.changeOrigin,
    verbose: mergedOptions.verbose,
    regenerateUntrustedCerts: mergedOptions.regenerateUntrustedCerts,
  }

  debugLog('proxy', `Server options: ${safeStringify(serverOptions)}`, mergedOptions.verbose)

  startServer(serverOptions).catch((err) => {
    debugLog('proxy', `Failed to start proxy: ${err}`, mergedOptions.verbose)
    log.error(`Failed to start proxy: ${err.message}`)
    cleanup({
      domains: [mergedOptions.to],
      hosts: typeof mergedOptions.cleanup === 'boolean' ? mergedOptions.cleanup : mergedOptions.cleanup?.hosts,
      certs: typeof mergedOptions.cleanup === 'boolean' ? mergedOptions.cleanup : mergedOptions.cleanup?.certs,
      verbose: mergedOptions.verbose,
    })
  })
}

// Helper function to safely get verbose flag from different config types
function getVerbose(options: ProxyOptions): boolean {
  return options?.verbose || false
}

/**
 * Whether rpx may read/write `/etc/hosts`. Disabled when `hostsManagement` is
 * explicitly `false`, or when `cleanup.hosts` is `false` (or `cleanup` is
 * `false`). Real-server deployments with real DNS should set
 * `hostsManagement: false` so rpx never touches `/etc/hosts`.
 */
function isHostsManagementEnabled(options: ProxyOptions): boolean {
  if (options?.hostsManagement === false)
    return false
  const cleanup = options?.cleanup
  if (cleanup === false)
    return false
  if (cleanup && typeof cleanup === 'object' && cleanup.hosts === false)
    return false
  return true
}

// `options` IS used below; pickier's no-unused-vars mis-fires on this fn after
// the on-demand wiring (its --fix would wrongly rename to `_options`) — the
// same false positive documented on runDaemon in daemon.ts.
// eslint-disable-next-line pickier/no-unused-vars
export async function startProxies(options?: ProxyOptions): Promise<void> {
  // Allow re-using a previous SSL config between multiple startProxies calls
  // This is particularly important for the Vite plugin
  let mergedOptions = {
    from: 'localhost:5173',
    to: 'rpx.localhost',
    https: false,
    cleanup: {
      hosts: true,
      certs: false,
    },
    vitePluginUsage: false,
    verbose: false,
    cleanUrls: false,
    changeOrigin: false,
    regenerateUntrustedCerts: true,
  } as ResolvedProxyOptions

  if (options) {
    mergedOptions = {
      ...mergedOptions,
      ...options,
    }
  }

  const verbose = getVerbose(mergedOptions)
  // Master switch for /etc/hosts management. `hostsManagement: false` (real
  // server with real DNS) or `cleanup: { hosts: false }` disables all hosts
  // reads/writes. Defaults to enabled for backward compatibility.
  const hostsEnabled = isHostsManagementEnabled(mergedOptions)
  debugLog('config', `Starting with config: ${safeStringify(mergedOptions, 2)}`, verbose)
  debugLog('config', `Is multi-proxy? ${'proxies' in mergedOptions}`, verbose)
  debugLog('config', `Hosts management enabled? ${hostsEnabled}`, verbose)

  // viaDaemon mode short-circuits before any port binding / cert work — the
  // daemon owns all of that. We only need to register entries and block.
  if (mergedOptions.viaDaemon) {
    const isMulti = 'proxies' in mergedOptions && Array.isArray(mergedOptions.proxies)
    const proxies = isMulti
      ? (mergedOptions.proxies as Array<BaseProxyConfig & { cleanUrls?: boolean, changeOrigin?: boolean }>)
        .map(p => ({
          id: p.id,
          from: p.from,
          to: p.to,
          path: p.path,
          cleanUrls: p.cleanUrls ?? mergedOptions.cleanUrls,
          changeOrigin: p.changeOrigin ?? mergedOptions.changeOrigin,
          pathRewrites: p.pathRewrites,
        }))
      : [{
          id: mergedOptions.id,
          from: mergedOptions.from,
          to: mergedOptions.to ?? 'rpx.localhost',
          path: mergedOptions.path,
          cleanUrls: mergedOptions.cleanUrls,
          changeOrigin: mergedOptions.changeOrigin,
          pathRewrites: mergedOptions.pathRewrites,
        }]
    await runViaDaemon({ proxies, verbose })
    return
  }

  // Start dev servers first if configured
  if ('proxies' in mergedOptions && Array.isArray(mergedOptions.proxies)) {
    debugLog('servers', `Found ${mergedOptions.proxies.length} proxies in config`, verbose)
    for (const proxy of mergedOptions.proxies) {
      if (proxy.start) {
        const proxyId = `${proxy.from}-${proxy.to}`
        try {
          debugLog('watch', `Starting command for ${proxyId} with command: ${proxy.start.command}`, verbose)
          log.info(`Starting command for ${proxyId}...`)

          await processManager.startProcess(proxyId, proxy.start, verbose)

          // Parse the URL to get hostname and port. `from` may be a
          // load-balanced pool (array) — use the first upstream to gate
          // readiness (the `start` command boots a single process).
          const proxyPrimaryFrom = primaryUpstreamUrl(proxy.from)
          const fromUrl = new URL(proxyPrimaryFrom.startsWith('http') ? proxyPrimaryFrom : `http://${proxyPrimaryFrom}`)
          const hostname = fromUrl.hostname || 'localhost'
          const port = Number(fromUrl.port) || 80

          // Wait for the server to be ready
          try {
            await testConnection(hostname, port, verbose)
            debugLog('watch', `Dev server is ready at ${hostname}:${port}`, verbose)
          }
          catch (err) {
            // Special handling for connection errors that may be recoverable
            // Sometimes Vite and other dev servers can take longer to initialize
            debugLog('watch', `Connection check failed, but continuing with proxy setup: ${err}`, verbose)
            log.warn(`Dev server connection check failed. RPX will try to proceed anyway...`)

            // Don't throw here - we'll attempt to continue even though the connection test failed
            // This allows for the case where the server might become available shortly after
          }
        }
        catch (err) {
          debugLog('watch', `Failed to start command for ${proxyId}: ${err}`, verbose)
          throw new Error(`Failed to start command for ${proxyId}: ${err}`)
        }
      }
      else {
        debugLog('watch', `No start command for proxy ${proxy.from} -> ${proxy.to}`, verbose)
      }
    }
  }
  else if ('start' in mergedOptions && mergedOptions.start) {
    debugLog('watch', 'Found start command in single proxy config', verbose)
    const proxyId = `${mergedOptions.from}-${mergedOptions.to}`
    try {
      if (mergedOptions.start) {
        debugLog('watch', `Starting command: ${mergedOptions.start.command}`, verbose)
        await processManager.startProcess(proxyId, mergedOptions.start, verbose)
      }

      // Parse the URL to get hostname and port. `from` may be a load-balanced
      // pool (array) — use the first upstream to gate readiness (the `start`
      // command boots a single process).
      const mergedPrimaryFrom = primaryUpstreamUrl(mergedOptions.from)
      const fromUrl = new URL(mergedPrimaryFrom.startsWith('http') ? mergedPrimaryFrom : `http://${mergedPrimaryFrom}`)
      const hostname = fromUrl.hostname || 'localhost'
      const port = Number(fromUrl.port) || 80

      // Wait for the server to be ready
      try {
        await testConnection(hostname, port, verbose)
        debugLog('watch', `Dev server is ready at ${hostname}:${port}`, verbose)
      }
      catch (err) {
        // Special handling for connection errors that may be recoverable
        debugLog('watch', `Connection check failed, but continuing with proxy setup: ${err}`, verbose)
        log.warn(`Dev server connection check failed. RPX will try to proceed anyway...`)

        // Don't throw here - we'll attempt to continue even though the connection test failed
      }
    }
    catch (err) {
      debugLog('watch', `Failed to run start command: ${err}`, verbose)
      throw new Error(`Failed to run start command: ${err}`)
    }
  }
  else {
    debugLog('watch', 'No start command found in config', verbose)
  }

  // Get primary domain for certificates
  const primaryDomain = 'proxies' in mergedOptions && Array.isArray(mergedOptions.proxies)
    ? mergedOptions.proxies[0]?.to
    : ('to' in mergedOptions ? mergedOptions.to : 'rpx.localhost')

  // Pre-acquire sudo credentials once so that all subsequent sudo operations
  // (cert trust, hosts file, DNS resolver) reuse the cached credential
  // without prompting again. `sudo -v` validates and caches for the timeout period.
  if (process.platform !== 'win32' && (mergedOptions.https || hostsEnabled)) {
    const sudoPassword = getSudoPassword()
    if (!sudoPassword) {
      try {
        debugLog('sudo', 'Pre-acquiring sudo credentials for privileged operations', verbose)
        execSync('sudo -v', { stdio: 'inherit' })
      }
      catch {
        debugLog('sudo', 'Could not pre-acquire sudo credentials', verbose)
      }
    }
  }

  let productionTlsConfig: SniTlsEntry[] = []

  if (mergedOptions.productionCerts) {
    productionTlsConfig = await buildSniTlsConfig(mergedOptions.productionCerts, verbose)
    if (productionTlsConfig.length > 0) {
      debugLog(
        'ssl',
        `Using ${productionTlsConfig.length} production SNI cert(s): ${productionTlsConfig.map(entry => entry.serverName).join(', ')}`,
        verbose,
      )
    }
  }

  // Resolve SSL configuration if HTTPS is enabled and no production SNI set was
  // provided. Production gateways must not fall back to dev-local certificates
  // when real PEMs are available under `productionCerts`.
  if (mergedOptions.https) {
    let existingSSLConfig = productionTlsConfig.length > 0 ? null : await checkExistingCertificates(mergedOptions)

    if (!existingSSLConfig && productionTlsConfig.length === 0) {
      debugLog('ssl', `No valid or trusted certificates found for ${primaryDomain}, generating new ones`, mergedOptions.verbose)
      await generateCertificate(mergedOptions)
      existingSSLConfig = await checkExistingCertificates(mergedOptions)
      if (!existingSSLConfig) {
        throw new Error(`Failed to load SSL certificates after generation for ${primaryDomain}`)
      }
    }
    else {
      debugLog('ssl', `Using existing and trusted certificates for ${primaryDomain}`, mergedOptions.verbose)
    }
    mergedOptions._cachedSSLConfig = existingSSLConfig
  }

  // Prepare proxy configurations
  const proxyOptions = 'proxies' in mergedOptions && Array.isArray(mergedOptions.proxies)
    ? mergedOptions.proxies.map(proxy => ({
        ...proxy,
        https: mergedOptions.https,
        cleanup: mergedOptions.cleanup,
        cleanUrls: proxy.cleanUrls ?? ('cleanUrls' in mergedOptions ? mergedOptions.cleanUrls : false),
        vitePluginUsage: mergedOptions.vitePluginUsage,
        changeOrigin: proxy.changeOrigin ?? mergedOptions.changeOrigin,
        verbose,
        _cachedSSLConfig: mergedOptions._cachedSSLConfig,
      } as ProxyOption))
    : [{
        from: 'from' in mergedOptions ? mergedOptions.from : 'localhost:5173',
        to: 'to' in mergedOptions ? mergedOptions.to : 'rpx.localhost',
        cleanUrls: 'cleanUrls' in mergedOptions ? mergedOptions.cleanUrls : false,
        https: mergedOptions.https,
        cleanup: mergedOptions.cleanup,
        vitePluginUsage: mergedOptions.vitePluginUsage,
        start: ('start' in mergedOptions) ? mergedOptions.start : undefined,
        changeOrigin: mergedOptions.changeOrigin,
        auth: 'auth' in mergedOptions ? mergedOptions.auth : undefined,
        verbose,
        _cachedSSLConfig: mergedOptions._cachedSSLConfig,
      } as ProxyOption]

  // Extract domains for cleanup
  const domains = proxyOptions.map((opt: ProxyOption) => opt.to || 'rpx.localhost')
  const sslConfig: SharedTlsConfig | null = productionTlsConfig.length > 0
    ? productionTlsConfig
    : (mergedOptions._cachedSSLConfig ?? null)

  // Start DNS server for custom domains on macOS (any domain that's not localhost/127.0.0.1)
  const customDomains = domains.filter((d: string) =>
    d && !d.includes('localhost') && !d.includes('127.0.0.1'),
  )

  // TLDs that are problematic for local development (owned by Google/others with HSTS preloading)
  const problematicTlds = ['dev', 'app', 'page', 'new', 'day', 'foo']
  // Reserved TLDs that are safe for local development (RFC 2606 / RFC 6761)
  const reservedTlds = ['test', 'localhost', 'local', 'example', 'invalid']

  // Warn about problematic TLDs
  const uniqueTlds = [...new Set(customDomains.map((d: string) => d.split('.').pop()?.toLowerCase()))]
  const problematicFound = uniqueTlds.filter((t): t is string => !!t && problematicTlds.includes(t as string))
  if (problematicFound.length > 0 && verbose) {
    log.warn(`The following TLDs may not work reliably for local development: ${problematicFound.map(t => `.${t}`).join(', ')}`)
    log.info(`  These TLDs have HSTS preloading which can bypass local DNS`)
    log.info(`  Consider using reserved TLDs: .test, .localhost, or .local`)
  }

  // Local development DNS (resolver overrides + hosts entries) is a dev-only
  // convenience. On a real server (`hostsManagement: false`) DNS is real, so
  // skip it entirely — nothing under /etc should be touched.
  if (hostsEnabled && process.platform === 'darwin' && customDomains.length > 0) {
    const { setupDevelopmentDns } = await import('./dns')
    const dnsStarted = await setupDevelopmentDns({ domains: customDomains, verbose })
    if (dnsStarted) {
      if (verbose) {
        const hasReservedOnly = uniqueTlds.every((t): t is string => !!t && reservedTlds.includes(t as string))
        if (hasReservedOnly) {
          log.success(`DNS server started for ${uniqueTlds.map(t => `.${t}`).join(', ')} domains`)
        }
        else {
          log.success(`DNS server started for ${uniqueTlds.map(t => `.${t}`).join(', ')} domains (hosts file entries also added)`)
        }
      }
    }
    else {
      debugLog('dns', 'Could not start DNS server - custom domains may not resolve', verbose)
    }
  }

  // Setup cleanup handler
  const cleanupHandler = async () => {
    debugLog('cleanup', 'Starting cleanup handler', mergedOptions.verbose)

    try {
      // Stop DNS server
      const { tearDownDevelopmentDns } = await import('./dns')
      await tearDownDevelopmentDns({ verbose: mergedOptions.verbose })
    }
    catch (err) {
      debugLog('cleanup', `Error stopping DNS server: ${err}`, mergedOptions.verbose)
    }

    try {
      // Stop all watched processes first
      await processManager.stopAll(mergedOptions.verbose)
    }
    catch (err) {
      debugLog('cleanup', `Error stopping processes: ${err}`, mergedOptions.verbose)
    }

    await cleanup({
      domains,
      hosts: typeof mergedOptions.cleanup === 'boolean' ? mergedOptions.cleanup : mergedOptions.cleanup?.hosts,
      certs: typeof mergedOptions.cleanup === 'boolean' ? mergedOptions.cleanup : mergedOptions.cleanup?.certs,
      verbose: mergedOptions.verbose || false,
    })
  }

  // Register cleanup handlers. NB: no per-call uncaughtException handler — the
  // module-level one logs-and-continues so a single stray error can't tear down
  // every route (and stacking one per startProxies() call would re-run teardown
  // N times on one error).
  process.on('SIGINT', cleanupHandler)
  process.on('SIGTERM', cleanupHandler)

  // Single-port routing: collapse every proxy onto one shared listener that
  // routes by Host header (and path) instead of binding a port per proxy.
  //   - HTTPS multi-proxy already shares :443 when more than one proxy exists.
  //   - `singlePortMode` extends the shared listener to the HTTP-only and
  //     single-proxy cases, and makes the listening port(s) configurable
  //     (`httpsPort`/`httpPort`, defaulting to 443/80).
  const singlePortMode = mergedOptions.singlePortMode === true
  const httpsPort = mergedOptions.httpsPort ?? 443
  const httpPort = mergedOptions.httpPort ?? 80
  // Origin lockdown: when a CDN fronts this gateway, reject direct hits to the
  // fronted hosts that lack the CDN's shared-secret header (the CDN injects it).
  const originGuard = mergedOptions.originGuard ? createOriginGuard(mergedOptions.originGuard) : null

  // Real per-domain SNI certs (Let's Encrypt PEMs under `productionCerts`) only
  // work through the shared listener's SNI array — `startServer`'s individual
  // (non-shared) path below always mints/uses a local dev self-signed cert,
  // ignoring `productionTlsConfig` entirely (it's never even passed through).
  // Without this, a single-`proxies`-entry production gateway (the common
  // one-site-per-box shape) silently served a browser-untrusted dev cert
  // despite a real cert sitting on disk — confirmed via a live Hetzner deploy
  // (stacksjs/status#1 Phase 9) where `uptime-status.org`'s real Let's Encrypt
  // cert was ignored until this forced the shared path for its single route.
  const useSharedHttps = !!sslConfig && (proxyOptions.length > 1 || singlePortMode || productionTlsConfig.length > 0)
  const useSharedHttp = !sslConfig && singlePortMode && proxyOptions.length > 0

  if (useSharedHttps && sslConfig) {
    debugLog('proxies', `Creating shared HTTPS server for ${proxyOptions.length} domains on port ${httpsPort}`, verbose)

    const routeEntries = await collectRouteEntries(proxyOptions, hostsEnabled, verbose)

    // On-demand TLS (opt-in): lazily issue a real cert for an approved-but-
    // unknown host the first time it's needed — the same manager and config
    // shape the daemon path uses. Without this, a gateway launched via
    // `startProxies` (e.g. ts-cloud's launcher) never issued anything: no ACME
    // attempt, no log line, and externally-placed certs only got adopted after
    // a restart. Holds the live SNI set; a newly issued/adopted cert triggers
    // a listener rebuild below (Bun can't hot-update tls — see on-demand.ts).
    let sharedServer: ReturnType<typeof Bun.serve> | null = null
    const onDemandCfg = mergedOptions.onDemandTls
    const onDemand: OnDemandCertManager | null = onDemandCfg?.enabled
      ? new OnDemandCertManager({
          config: onDemandCfg,
          // Matches the daemon's fallback chain (getDaemonRpxDir() inlined to
          // keep start.ts free of the daemon module graph).
          certsDir: onDemandCfg.certsDir ?? mergedOptions.productionCerts?.certsDir ?? path.join(os.homedir(), '.stacks', 'rpx', 'on-demand-certs'),
          initial: productionTlsConfig,
          verbose,
          onCertAdded: (entries) => { void rebuildSharedTls(entries) },
        })
      : null

    /**
     * (Re)bind the shared listener with the newest SNI set. Single-flight,
     * mirroring the daemon's rebuild: concurrent cert events record the newest
     * desired set and one in-flight rebuild converges to it. `createShared-
     * ProxyServer` returns null on bind failure (e.g. EADDRINUSE while the old
     * socket drains), so retry on a short backoff instead of giving up.
     */
    let rebuildLatest: SniTlsEntry[] | null = null
    let rebuilding = false
    async function rebuildSharedTls(entries: SniTlsEntry[]): Promise<void> {
      rebuildLatest = entries
      if (rebuilding)
        return
      rebuilding = true
      try {
        while (rebuildLatest) {
          const target = rebuildLatest
          rebuildLatest = null
          debugLog('proxies', `rebuilding :${httpsPort} with ${target.length} SNI cert(s)`, verbose)
          if (sharedServer) {
            activeServers.delete(sharedServer as unknown as http.Server)
            sharedServer.stop(false)
          }
          let rebound = false
          for (let attempt = 0; !rebound && attempt < 60; attempt++) {
            const s = createSharedProxyServer({ routeEntries, listenPort: httpsPort, sslConfig: target, originGuard, verbose })
            if (s) {
              sharedServer = s
              rebound = true
              break
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** Math.min(attempt, 4), 500)))
          }
          if (!rebound)
            log.error(`rpx: CRITICAL — could not rebind :${httpsPort} after cert issuance; HTTPS unbound until the next cert event or a gateway restart`)
        }
      }
      finally {
        rebuilding = false
      }
    }

    // Start HTTP→HTTPS redirect on the configured HTTP port if it's free. The
    // :80 server also serves the on-demand challenge store and kicks reactive
    // issuance on the first plaintext hit for an uncovered host.
    const isHttpPortBusy = await isPortInUse(httpPort, '0.0.0.0', verbose)
    if (!isHttpPortBusy) {
      startHttpRedirectServer(verbose, httpPort, httpsPort, mergedOptions.acmeChallengeWebroot, onDemand)
    }

    const isPortBusy = await isPortInUse(httpsPort, '0.0.0.0', verbose)
    if (isPortBusy) {
      debugLog('proxies', `Port ${httpsPort} is already in use, cannot start shared proxy`, verbose)
      if (verbose)
        log.warn(`Port ${httpsPort} is in use. Shared HTTPS proxy cannot start.`)
      return
    }

    // Seed from the manager's live set when on-demand is active (it may have
    // adopted certs from `certsDir` beyond the initial production set); until
    // it holds anything, serve the pre-on-demand TLS config as-is.
    const initialTls = onDemand && onDemand.sniEntries().length > 0 ? onDemand.sniEntries() : sslConfig
    sharedServer = createSharedProxyServer({ routeEntries, listenPort: httpsPort, sslConfig: initialTls, originGuard, verbose })
    if (!sharedServer) {
      log.error(`Shared HTTPS proxy failed to bind :${httpsPort}; not exiting`)
      return
    }
  }
  else if (useSharedHttp) {
    debugLog('proxies', `Creating shared HTTP server for ${proxyOptions.length} domains on port ${httpPort}`, verbose)

    const routeEntries = await collectRouteEntries(proxyOptions, hostsEnabled, verbose)

    const isPortBusy = await isPortInUse(httpPort, '0.0.0.0', verbose)
    if (isPortBusy) {
      debugLog('proxies', `Port ${httpPort} is already in use, cannot start shared proxy`, verbose)
      if (verbose)
        log.warn(`Port ${httpPort} is in use. Shared HTTP proxy cannot start.`)
      return
    }

    const server = createSharedProxyServer({ routeEntries, listenPort: httpPort, sslConfig: null, originGuard, verbose })
    if (!server) {
      log.error(`Shared HTTP proxy failed to bind :${httpPort}; not exiting`)
      return
    }
  }
  else {
    // Single proxy or no SSL — use individual servers (original behavior)
    for (const option of proxyOptions) {
      try {
        const domain = option.to || 'rpx.localhost'
        debugLog('proxy', `Starting proxy for ${domain} with SSL config: ${!!sslConfig}`, option.verbose)

        await startServer({
          from: option.from || 'localhost:5173',
          to: domain,
          cleanUrls: option.cleanUrls || false,
          https: option.https || false,
          cleanup: option.cleanup || false,
          vitePluginUsage: option.vitePluginUsage || false,
          verbose: option.verbose || false,
          _cachedSSLConfig: mergedOptions._cachedSSLConfig,
          changeOrigin: option.changeOrigin || false,
          loadBalancer: option.loadBalancer,
          auth: option.auth,
          path: option.path,
          pathRewrites: option.pathRewrites,
        })
      }
      catch (err) {
        // One route failing must not tear down the others — log and continue so
        // the healthy proxies keep serving.
        debugLog('proxies', `Failed to start proxy for ${option.to}: ${err}`, option.verbose)
        log.error(`Failed to start proxy for ${option.to}:`, err)
      }
    }
  }
}

/**
 * Build the `(host, path, route)` entries for a shared single-port listener from
 * the resolved per-proxy options, and ensure an `/etc/hosts` entry exists for
 * each non-localhost domain (once per domain). Several proxies can share one
 * domain on different paths (e.g. `/api` → app, `/docs` → static dir, `/` →
 * public) — `buildHostRoutes` groups + longest-prefix-sorts them later. Shared
 * by the single-port HTTPS and HTTP paths so routing is identical regardless of
 * whether TLS is terminated.
 */
export async function collectRouteEntries(
  proxyOptions: ProxyOption[],
  hostsEnabled: boolean,
  verbose: boolean,
): Promise<Array<{ host: string, path?: string, route: ProxyRoute }>> {
  const routeEntries: Array<{ host: string, path?: string, route: ProxyRoute }> = []
  const seenDomains = new Set<string>()

  for (const option of proxyOptions) {
    const domain = option.to || 'rpx.localhost'
    const cleanUrls = option.cleanUrls || false
    const routePath = option.path
    const basePath = normalizePathPrefix(routePath)

    const auth = resolveAuth(option.auth)

    // Redirect route: answer with a Location (e.g. an alternate domain → its
    // canonical host). Takes precedence over proxy/static — no upstream needed.
    if (option.redirect) {
      const redirect = resolveRedirect(option.redirect)
      routeEntries.push({
        host: domain,
        path: routePath,
        route: { redirect, basePath, auth },
      })
      debugLog('proxies', `Route: ${domain}${routePath ?? ''} → redirect ${redirect.status} ${redirect.to}${auth ? ' (auth)' : ''}`, verbose)
    }
    // Static-file route: serve a local directory instead of proxying.
    else if (option.static) {
      routeEntries.push({
        host: domain,
        path: routePath,
        route: { static: resolveStaticRoute(option.static, cleanUrls), cleanUrls, basePath, auth },
      })
      debugLog('proxies', `Route: ${domain}${routePath ?? ''} → static ${typeof option.static === 'string' ? option.static : option.static.dir}${auth ? ' (auth)' : ''}`, verbose)
    }
    else {
      const primaryFrom = primaryUpstreamUrl(option.from)
      const fromUrl = new URL(primaryFrom.startsWith('http') ? primaryFrom : `http://${primaryFrom}`)
      // Always build an `upstreamPool` (even for a plain single-string `from`)
      // so route dispatch has one selection/health-tracking code path — see
      // `pickUpstream`/`resolveTarget` in proxy-handler.ts.
      const pool = createUpstreamPool(option.from ?? fromUrl.host, option.loadBalancer)
      startHealthChecks(pool)
      activeUpstreamPools.add(pool)
      routeEntries.push({
        host: domain,
        path: routePath,
        route: {
          sourceHost: fromUrl.host,
          upstreamPool: pool,
          cleanUrls,
          changeOrigin: option.changeOrigin || false,
          pathRewrites: option.pathRewrites,
          basePath,
          auth,
        },
      })
      debugLog('proxies', `Route: ${domain}${routePath ?? ''} → ${fromUrl.host}${auth ? ' (auth)' : ''}`, verbose)
    }

    // Ensure hosts file entries exist for non-localhost domains. A wildcard
    // domain (`*.example.com`) has no single hosts entry — skip it. Skipped
    // entirely when hosts management is disabled (real-server mode). Add each
    // domain once even when several path-routes share it.
    if (seenDomains.has(domain)) {
      continue
    }
    seenDomains.add(domain)
    if (hostsEnabled && !isWildcardPattern(domain) && !domain.includes('localhost') && !domain.includes('127.0.0.1')) {
      try {
        const hostsExist = await checkHosts([domain], verbose)
        if (!hostsExist[0]) {
          await addHosts([domain], verbose)
        }
      }
      catch {
        debugLog('hosts', `Could not add hosts entry for ${domain}`, verbose)
      }
    }
  }

  return routeEntries
}

/**
 * Create a single shared `Bun.serve` listener that routes every request by
 * `Host` header (and path) to the right upstream. When `sslConfig` is provided
 * the listener terminates TLS; otherwise it serves plain HTTP (single-port HTTP
 * mode). Registers the server for cleanup and returns it, or `null` if
 * `Bun.serve` threw (e.g. the port could not be bound).
 */
export function createSharedProxyServer(opts: {
  routeEntries: Array<{ host: string, path?: string, route: ProxyRoute }>
  listenPort: number
  sslConfig: SharedTlsConfig | null
  originGuard: ReturnType<typeof createOriginGuard> | null
  verbose: boolean
}): ReturnType<typeof Bun.serve> | null {
  const { routeEntries, listenPort, sslConfig, originGuard, verbose } = opts
  const routingTable = buildHostRoutes(routeEntries)
  const baseFetchHandler = createProxyFetchHandler(
    (host, pathname) => matchHostRoute(routingTable, host, pathname),
    verbose,
  )
  const sharedFetchHandler = originGuard
    ? (req: Request, server: ProxyServerLike) => originGuard(req) ?? baseFetchHandler(req, server)
    : baseFetchHandler
  const sharedWsHandler = createProxyWebSocketHandler(verbose)

  try {
    const bunServer = Bun.serve({
      port: listenPort,
      hostname: '0.0.0.0',
      // Opt-in (RPX_REUSE_PORT): lets multiple rpx instances share the port for
      // multi-core scaling on Linux. Off by default — see shouldReusePort().
      reusePort: shouldReusePort(),
      ...(sslConfig
        ? {
            tls: Array.isArray(sslConfig)
              ? sslConfig.map(entry => ({
                  serverName: entry.serverName,
                  key: entry.key,
                  cert: entry.cert,
                }))
              : {
                  key: sslConfig.key,
                  cert: sslConfig.cert,
                  ca: sslConfig.ca,
                  requestCert: false,
                  rejectUnauthorized: false,
                },
          }
        : {}),
      fetch(req: Request, server: unknown) {
        return sharedFetchHandler(req, server as ProxyServerLike)
      },
      websocket: sharedWsHandler,
      error(err: Error) {
        debugLog('server', `Shared proxy server error: ${err}`, verbose)
        return new Response(`Server Error: ${err.message}`, { status: 500 })
      },
    })

    activeServers.add(bunServer as unknown as http.Server)
    debugLog('proxies', `Shared ${sslConfig ? 'HTTPS' : 'HTTP'} proxy listening on port ${listenPort} for ${routingTable.size} domains`, verbose)
    return bunServer
  }
  catch (err) {
    debugLog('proxies', `Failed to start shared proxy: ${err}`, verbose)
    console.error('Failed to start shared proxy:', err)
    return null
  }
}

interface OutputOptions {
  from?: string
  to?: string
  vitePluginUsage?: boolean
  listenPort?: number
  ssl?: boolean
  cleanUrls?: boolean
}

// eslint-disable-next-line pickier/no-unused-vars
function logToConsole(options?: OutputOptions & { verbose?: boolean }) {
  // Skip console output for Vite plugin (handles its own output) and non-verbose mode (caller handles output)
  if (options?.vitePluginUsage || !options?.verbose)
    return

  console.log('')
  console.log(`  ${colors.green(colors.bold('rpx'))} ${colors.green(`v${version}`)}`)
  console.log(`  ${colors.green('➜')}  ${colors.dim(options?.from ?? '')} ${colors.dim('➜')} ${colors.cyan(options?.ssl ? `https://${options?.to}` : `http://${options?.to}`)}`)

  if (options?.listenPort !== (options?.ssl ? 443 : 80))
    console.log(`  ${colors.green('➜')}  Listening on port ${options?.listenPort}`)

  if (options?.cleanUrls)
    console.log(`  ${colors.green('➜')}  Clean URLs enabled`)
}
