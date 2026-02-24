/* eslint-disable no-console */
import type { IncomingHttpHeaders, SecureServerOptions } from 'node:http2'
import type { ServerOptions } from 'node:https'
import type { BaseProxyConfig, CleanupOptions, ProxyConfig, ProxyOption, ProxyOptions, ProxySetupOptions, SingleProxyConfig, SSLConfig, StartOptions } from './types'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as https from 'node:https'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import * as tls from 'node:tls'
import { log } from './logger'
import colors from 'picocolors'
import { version } from '../package.json'
import { config } from './config'
import { addHosts, checkHosts, removeHosts } from './hosts'
import { checkExistingCertificates, cleanupCertificates, generateCertificate, httpsConfig, loadSSLConfig } from './https'
import { DefaultPortManager, findAvailablePort, isPortInUse } from './port-manager'
import { ProcessManager } from './process-manager'
import { debugLog } from './utils'

const processManager = new ProcessManager()
// Create a global port manager for coordinating port usage
const globalPortManager = new DefaultPortManager('0.0.0.0')

// Keep track of all running servers for cleanup
const activeServers: Set<http.Server | https.Server> = new Set()

type AnyServerType = http.Server | https.Server | http2.Http2SecureServer
type AnyIncomingMessage = http.IncomingMessage | http2.Http2ServerRequest
type AnyServerResponse = http.ServerResponse | http2.Http2ServerResponse

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

    // Add server closing promises
    const serverClosePromises = Array.from(activeServers).map(server =>
      new Promise<void>((resolve) => {
        server.close(() => {
          debugLog('cleanup', 'Server closed successfully', options?.verbose)
          resolve()
        })
      }),
    )
    cleanupPromises.push(...serverClosePromises)

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
process.on('uncaughtException', (err) => {
  debugLog('process', `Uncaught exception: ${err}`, true)
  log.error('Uncaught exception:', err)
  signalHandler('uncaughtException')
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
  catch (err: any) {
    // Check if we've exceeded the maximum test duration
    if (Date.now() - startTime > maxTestDuration) {
      debugLog('connection', `Connection test timed out after ${maxTestDuration}ms, but continuing anyway`, verbose)
      log.warn(`Connection test to ${hostname}:${port} timed out, but RPX will try to proceed anyway.`)
      return // Continue with setup despite timeout
    }

    // If we're dealing with a server that takes time to start up
    if (err.code === 'ECONNREFUSED' && retries > 0) {
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
    const errorMessage = `Failed to connect to ${hostname}:${port} after ${5 - retries} attempts: ${err.message}`
    debugLog('connection', `${errorMessage}. To bypass this check set RPX_BYPASS_CONNECTION_TEST=true`, verbose)
    log.warn(errorMessage)
    log.warn(`RPX will try to continue anyway. If you're sure this is correct, you can set RPX_BYPASS_CONNECTION_TEST=true to skip this check.`)
  }
}

export async function startServer(options: SingleProxyConfig): Promise<void> {
  debugLog('server', `Starting server with options: ${JSON.stringify(options)}`, options.verbose)

  // Parse URLs early to get the hostnames
  const fromUrl = new URL((options.from?.startsWith('http') ? options.from : `http://${options.from}`) || 'localhost:5173')
  const toUrl = new URL((options.to?.startsWith('http') ? options.to : `http://${options.to}`) || 'rpx.localhost')
  const fromPort = Number.parseInt(fromUrl.port) || (fromUrl.protocol.includes('https:') ? 443 : 80)

  // Check and update hosts file for custom domains
  const hostsToCheck = [toUrl.hostname]
  if (!toUrl.hostname.includes('localhost') && !toUrl.hostname.includes('127.0.0.1')) {
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
    from: options.from || 'localhost:5173',
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
  fromPort: number,
  listenPort: number,
  hostname: string,
  sourceUrl: Pick<URL, 'hostname' | 'host'>,
  ssl: SSLConfig | null,
  vitePluginUsage?: boolean,
  verbose?: boolean,
  cleanUrls?: boolean,
  changeOrigin?: boolean,
): Promise<void> {
  debugLog('proxy', `Creating proxy server ${from} -> ${to} with cleanUrls: ${cleanUrls}`, verbose)

  // Convert HTTP/2 headers to HTTP/1 compatible format
  function normalizeHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const normalized: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(headers)) {
      // Skip HTTP/2 pseudo-headers
      if (!key.startsWith(':')) {
        normalized[key] = value
      }
    }
    return normalized
  }

  const requestHandler = (req: AnyIncomingMessage, res: AnyServerResponse) => {
    debugLog('request', `Incoming request: ${req.method} ${req.url}`, verbose)

    let path = req.url || '/'
    let method = req.method || 'GET'

    // For HTTP/2 requests, extract method and path from pseudo-headers
    if (req instanceof http2.Http2ServerRequest) {
      const headers = req.headers
      method = (headers[':method'] as string) || method
      path = (headers[':path'] as string) || path
    }

    // Handle clean URLs
    if (cleanUrls) {
      // Don't modify URLs that already have an extension
      if (!path.match(/\.[a-z0-9]+$/i)) {
        // If path ends with trailing slash, look for index.html
        if (path.endsWith('/')) {
          path = `${path}index.html`
        }
        // Otherwise append .html
        else {
          path = `${path}.html`
        }
      }
    }

    // Normalize request headers
    const normalizedHeaders = normalizeHeaders(req.headers)

    // Handle changeOrigin option - modify the host header to match the target
    if (changeOrigin) {
      normalizedHeaders.host = `${sourceUrl.hostname}:${fromPort}`
      debugLog('request', `Changed origin: setting host header to ${normalizedHeaders.host}`, verbose)
    }

    const proxyOptions = {
      hostname: sourceUrl.hostname,
      port: fromPort,
      path,
      method,
      headers: normalizedHeaders,
    }

    debugLog('request', `Proxy request options: ${JSON.stringify(proxyOptions)}`, verbose)

    const proxyReq = http.request(proxyOptions, (proxyRes) => {
      debugLog('response', `Proxy response received with status ${proxyRes.statusCode}`, verbose)

      // Handle 404s for clean URLs
      if (cleanUrls && proxyRes.statusCode === 404) {
        // Try alternative paths for clean URLs
        const alternativePaths = []

        // If the path ends with .html, try without it
        if (path.endsWith('.html')) {
          alternativePaths.push(path.slice(0, -5))
        }
        // If path doesn't end with .html, try with it
        else if (!path.match(/\.[a-z0-9]+$/i)) {
          alternativePaths.push(`${path}.html`)
        }
        // If path doesn't end with /, try with /index.html
        if (!path.endsWith('/')) {
          alternativePaths.push(`${path}/index.html`)
        }

        // Try alternative paths
        if (alternativePaths.length > 0) {
          debugLog('cleanUrls', `Trying alternative paths: ${alternativePaths.join(', ')}`, verbose)

          // Try each alternative path
          const tryNextPath = (paths: string[]) => {
            if (paths.length === 0) {
              // If no alternatives work, send original 404
              ;(res as http.ServerResponse).writeHead(proxyRes.statusCode || 404, proxyRes.headers)
              proxyRes.pipe(res as http.ServerResponse)
              return
            }

            const altPath = paths[0]
            const altOptions = { ...proxyOptions, path: altPath }

            const altReq = http.request(altOptions, (altRes) => {
              if (altRes.statusCode === 200) {
                // If we found a matching path, use it
                debugLog('cleanUrls', `Found matching path: ${altPath}`, verbose)
                ;(res as http.ServerResponse).writeHead(altRes.statusCode, altRes.headers)
                altRes.pipe(res as http.ServerResponse)
              }
              else {
                // Try next alternative
                tryNextPath(paths.slice(1))
              }
            })

            altReq.on('error', () => tryNextPath(paths.slice(1)))
            altReq.end()
          }

          tryNextPath(alternativePaths)
          return
        }
      }

      // Add security headers
      const headers = {
        ...proxyRes.headers,
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
      }

      ;(res as http.ServerResponse).writeHead(proxyRes.statusCode || 500, headers)
      proxyRes.pipe(res as http.ServerResponse)
    })

    proxyReq.on('error', (err) => {
      debugLog('request', `Proxy request failed: ${err}`, verbose)
      log.error('Proxy request failed:', err)
      ;(res as http.ServerResponse).writeHead(502)
      ;(res as http.ServerResponse).end(`Proxy Error: ${err.message}`)
    })

    req.pipe(proxyReq)
  }

  debugLog('server', `Creating server with SSL config: ${!!ssl}`, verbose)

  // Use Bun.serve for HTTPS as it handles TLS better than Node's https module in Bun
  if (ssl) {
    return new Promise<void>((resolve, reject) => {
      try {
        const bunServer = Bun.serve({
          port: listenPort,
          hostname,
          tls: {
            key: ssl.key,
            cert: ssl.cert,
            ca: ssl.ca,
            // Bun's TLS options - don't request client certificates
            requestCert: false,
            rejectUnauthorized: false,
          },
          async fetch(req: Request) {
            const url = new URL(req.url)
            debugLog('request', `Bun.serve received: ${req.method} ${url.pathname}`, verbose)

            // Build target URL from sourceUrl object
            const baseUrl = `http://${sourceUrl.host}`
            const targetUrl = new URL(url.pathname + url.search, baseUrl)

            // Forward the request
            try {
              const headers = new Headers(req.headers)
              headers.set('host', sourceUrl.host)
              if (changeOrigin) {
                headers.set('origin', baseUrl)
              }
              headers.set('x-forwarded-for', '127.0.0.1')
              headers.set('x-forwarded-proto', 'https')
              headers.set('x-forwarded-host', to)

              const response = await fetch(targetUrl.toString(), {
                method: req.method,
                headers,
                body: req.body,
                redirect: 'manual',
              })

              // Clone response with modified headers if needed
              const responseHeaders = new Headers(response.headers)

              // Handle clean URLs redirect
              if (cleanUrls && url.pathname.endsWith('.html')) {
                const cleanPath = url.pathname.replace(/\.html$/, '')
                return new Response(null, {
                  status: 301,
                  headers: { Location: cleanPath },
                })
              }

              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
              })
            }
            catch (err) {
              debugLog('request', `Proxy error: ${err}`, verbose)
              return new Response(`Proxy Error: ${err}`, { status: 502 })
            }
          },
          error(err: Error) {
            debugLog('server', `Bun.serve error: ${err}`, verbose)
            return new Response(`Server Error: ${err.message}`, { status: 500 })
          },
        })

        // Store reference for cleanup
        activeServers.add(bunServer as unknown as http.Server)

        logToConsole({
          from,
          to,
          vitePluginUsage,
          listenPort,
          ssl: true,
          cleanUrls,
          verbose,
        })

        resolve()
      }
      catch (err) {
        reject(err)
      }
    })
  }

  // For non-SSL, use Node's http.createServer
  const server = http.createServer(requestHandler)

  function setupServer(serverInstance: AnyServerType) {
    // Use the module-level activeServers set
    activeServers.add(serverInstance as http.Server | https.Server)

    return new Promise<void>((resolve, reject) => {
      serverInstance.listen(listenPort, hostname, () => {
        debugLog('server', `Server listening on port ${listenPort}`, verbose)

        logToConsole({
          from,
          to,
          vitePluginUsage,
          listenPort,
          ssl: !!ssl,
          cleanUrls,
          verbose,
        })

        resolve()
      })

      serverInstance.on('error', (err) => {
        debugLog('server', `Server error: ${err}`, verbose)
        reject(err)
      })
    })
  }

  return setupServer(server)
}

export async function setupProxy(options: ProxySetupOptions): Promise<void> {
  debugLog('setup', `Setting up reverse proxy: ${JSON.stringify(options)}`, options.verbose)

  const { from, to, fromPort, sourceUrl, ssl, verbose, cleanup: cleanupOptions, vitePluginUsage, changeOrigin, cleanUrls } = options
  const httpPort = 80
  const httpsPort = 443
  const hostname = '0.0.0.0'
  // Use the global port manager if not provided
  const portManager = options.portManager || globalPortManager

  try {
    // Add an extra check to make sure the hostname is in the hosts file
    if (to && !to.includes('localhost') && !to.includes('127.0.0.1')) {
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
      if (process.platform !== 'darwin' && to && to.includes('localhost') && !to.match(/^(localhost|127\.0\.0\.1)$/)) {
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

    await createProxyServer(from, to, fromPort, finalPort, hostname, sourceUrl, ssl, vitePluginUsage, verbose, cleanUrls, changeOrigin)
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

export function startHttpRedirectServer(verbose?: boolean): void {
  debugLog('redirect', 'Starting HTTP redirect server', verbose)

  const server = http
    .createServer((req, res) => {
      const host = req.headers.host || ''
      debugLog('redirect', `Redirecting request from ${host}${req.url} to HTTPS`, verbose)
      res.writeHead(301, {
        Location: `https://${host}${req.url}`,
      })
      res.end()
    })
    .listen(80)
  activeServers.add(server)
  debugLog('redirect', 'HTTP redirect server started', verbose)
}

export function startProxy(options: ProxyOption): void {
  const mergedOptions = {
    ...config,
    ...options,
  }

  debugLog('proxy', `Starting proxy with options: ${JSON.stringify(mergedOptions)}`, mergedOptions?.verbose)

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
    import('./dns').then(({ startDnsServer, setupResolver }) => {
      startDnsServer([targetDomain], mergedOptions.verbose).then((started) => {
        if (started) {
          setupResolver(mergedOptions.verbose, [targetDomain]).then(() => {
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

  debugLog('proxy', `Server options: ${JSON.stringify(serverOptions)}`, mergedOptions.verbose)

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
function getVerbose(options: any): boolean {
  return options?.verbose || false
}

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
    regenerateUntrustedCerts: false,
  } as any

  if (options) {
    mergedOptions = {
      ...mergedOptions,
      ...options,
    }
  }

  const verbose = getVerbose(mergedOptions)
  debugLog('config', `Starting with config: ${JSON.stringify(mergedOptions, null, 2)}`, verbose)
  debugLog('config', `Is multi-proxy? ${'proxies' in mergedOptions}`, verbose)

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

          // Parse the URL to get hostname and port
          const fromUrl = new URL(proxy.from.startsWith('http') ? proxy.from : `http://${proxy.from}`)
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

      // Parse the URL to get hostname and port
      const fromUrl = new URL(mergedOptions.from?.startsWith('http') ? mergedOptions.from : `http://${mergedOptions.from}`)
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

  // Resolve SSL configuration if HTTPS is enabled
  if (mergedOptions.https) {
    let existingSSLConfig = await checkExistingCertificates(mergedOptions)

    if (!existingSSLConfig) {
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
    ? mergedOptions.proxies.map((proxy: any) => ({
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
        verbose,
        _cachedSSLConfig: mergedOptions._cachedSSLConfig,
      } as ProxyOption]

  // Extract domains for cleanup
  const domains = proxyOptions.map((opt: ProxyOption) => opt.to || 'rpx.localhost')
  const sslConfig = mergedOptions._cachedSSLConfig

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

  if (process.platform === 'darwin' && customDomains.length > 0) {
    const { startDnsServer, setupResolver } = await import('./dns')
    const dnsStarted = await startDnsServer(customDomains, verbose)
    if (dnsStarted) {
      await setupResolver(verbose, customDomains)
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
      const { stopDnsServer, removeResolver } = await import('./dns')
      stopDnsServer(mergedOptions.verbose)
      await removeResolver(mergedOptions.verbose)
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

  // Register cleanup handlers
  process.on('SIGINT', cleanupHandler)
  process.on('SIGTERM', cleanupHandler)
  process.on('uncaughtException', (err) => {
    debugLog('process', `Uncaught exception: ${err}`, true)
    console.error('Uncaught exception:', err)
    cleanupHandler()
  })

  // Start all proxies
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
        _cachedSSLConfig: sslConfig,
        changeOrigin: option.changeOrigin || false,
      })
    }
    catch (err) {
      debugLog('proxies', `Failed to start proxy for ${option.to}: ${err}`, option.verbose)
      console.error(`Failed to start proxy for ${option.to}:`, err)
      cleanupHandler()
    }
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
