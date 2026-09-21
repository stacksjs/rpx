import type { PortManager } from './types'
import { randomUUID } from 'node:crypto'
import * as net from 'node:net'
import { debugLog } from './utils'

/** Highest port the OS can bind. */
const MAX_PORT = 65535

/**
 * Check if a port is in use
 */
export function isPortInUse(port: number, hostname: string, verbose?: boolean): Promise<boolean> {
  debugLog('port', `Checking if port ${port} is in use on ${hostname}`, verbose)
  return new Promise((resolve) => {
    const server = net.createServer()

    // Add a timeout to ensure we don't hang indefinitely
    const timeout = setTimeout(() => {
      debugLog('port', `Checking port ${port} timed out, assuming it's in use`, verbose)
      server.close()
      resolve(true)
    }, 3000) // 3 second timeout

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (err.code === 'EADDRINUSE') {
        debugLog('port', `Port ${port} is in use`, verbose)
        resolve(true)
      }
      else {
        // Other errors should also be treated as port unavailable
        debugLog('port', `Error checking port ${port}: ${err.message}`, verbose)
        resolve(true)
      }
    })

    server.once('listening', () => {
      clearTimeout(timeout)
      debugLog('port', `Port ${port} is available`, verbose)
      server.close()
      resolve(false)
    })

    try {
      server.listen(port, hostname)
    }
    catch (err) {
      clearTimeout(timeout)
      debugLog('port', `Exception checking port ${port}: ${err}`, verbose)
      resolve(true)
    }
  })
}

/**
 * Find next available port
 */
export async function findAvailablePort(
  startPort: number,
  hostname: string,
  verbose?: boolean,
  maxAttempts = 50,
): Promise<number> {
  debugLog('port', `Finding available port starting from ${startPort} (max attempts: ${maxAttempts})`, verbose)
  let port = startPort
  let attempts = 0

  while (attempts < maxAttempts) {
    attempts++
    const isInUse = await isPortInUse(port, hostname, verbose)

    if (!isInUse) {
      debugLog('port', `Found available port: ${port} after ${attempts} attempts`, verbose)
      return port
    }

    debugLog('port', `Port ${port} is in use, trying ${port + 1} (attempt ${attempts}/${maxAttempts})`, verbose)
    port++
  }

  throw new Error(`Unable to find available port after ${maxAttempts} attempts starting from ${startPort}`)
}

/**
 * Host to dial when probing a port we just bound.
 *
 * A wildcard bind address is not a destination: connecting to `0.0.0.0` is
 * undefined-ish across platforms, so dial the matching loopback address
 * instead - the probe listener bound to the wildcard answers there too.
 */
function probeDialHost(hostname: string): string {
  if (hostname === '' || hostname === '0.0.0.0')
    return '127.0.0.1'
  if (hostname === '::' || hostname === '[::]')
    return '::1'
  return hostname
}

/**
 * Test if a port is actually connectable, i.e. whether *something* is already
 * listening there and accepting connections.
 *
 * This answers "is this port occupied and healthy", which is the opposite of
 * what a caller looking for a port to BIND wants - see {@link isPortClaimable}.
 */
export function testPortConnectivity(
  port: number,
  hostname: string,
  timeout = 5000,
  verbose?: boolean,
): Promise<boolean> {
  debugLog('port', `Testing connection to ${hostname}:${port}`, verbose)
  return new Promise((resolve) => {
    const socket = net.connect({
      host: hostname,
      port,
      timeout,
    })

    socket.once('connect', () => {
      debugLog('port', `Successfully connected to ${hostname}:${port}`, verbose)
      socket.end()
      resolve(true)
    })

    socket.once('timeout', () => {
      debugLog('port', `Connection to ${hostname}:${port} timed out`, verbose)
      socket.destroy()
      resolve(false)
    })

    socket.once('error', (err) => {
      debugLog('port', `Failed to connect to ${hostname}:${port}: ${err.message}`, verbose)
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Test whether *we* can claim `port`: bind a probe listener on it, dial that
 * listener, and confirm the bytes that come back are the probe's own nonce.
 *
 * Binding alone is not proof of ownership. On macOS a wildcard bind succeeds
 * while a loopback-only listener already holds the same port (Postgres on
 * 127.0.0.1:5432 is the everyday example), and the more specific binding keeps
 * winning every connection - so a server "successfully" bound there would never
 * receive a request. The nonce handshake is what distinguishes the two: traffic
 * has to reach our listener, not somebody else's.
 */
export function isPortClaimable(
  port: number,
  hostname: string,
  timeout = 3000,
  verbose?: boolean,
): Promise<boolean> {
  debugLog('port', `Probing whether ${hostname}:${port} can be claimed`, verbose)
  return new Promise((resolve) => {
    const nonce = `rpx-port-probe-${randomUUID()}`
    const server = net.createServer((socket) => { socket.end(nonce) })
    let settled = false
    const timer = setTimeout(() => finish(false, 'probe timed out'), timeout)

    function finish(claimable: boolean, reason: string): void {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      // Closing a server that never bound emits ERR_SERVER_NOT_RUNNING, and the
      // persistent error handler below is what keeps that (or a late bind error)
      // from reaching the process as an unhandled 'error' event.
      if (server.listening)
        server.close()
      debugLog('port', `Port ${port} ${claimable ? 'can be claimed' : 'cannot be claimed'}: ${reason}`, verbose)
      resolve(claimable)
    }

    server.on('error', (err: NodeJS.ErrnoException) => finish(false, `bind failed (${err.code ?? err.message})`))

    server.listen(port, hostname, () => {
      const socket = net.connect({ host: probeDialHost(hostname), port, timeout })
      let received = ''

      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => { received += chunk })
      socket.once('timeout', () => {
        socket.destroy()
        finish(false, 'probe connection timed out')
      })
      socket.once('error', (err) => {
        socket.destroy()
        finish(false, `probe connection failed (${err.message})`)
      })
      socket.once('close', () => {
        finish(received === nonce, received === nonce ? 'probe answered itself' : 'another listener answered')
      })
    })

    // Never hold the event loop open on account of a probe.
    server.unref()
  })
}

export class DefaultPortManager implements PortManager {
  usedPorts: Set<number> = new Set()
  private hostname: string
  private verbose?: boolean
  private maxRetries: number

  constructor(hostname: string = '0.0.0.0', verbose?: boolean, maxRetries = 50) {
    this.hostname = hostname
    this.verbose = verbose
    this.maxRetries = maxRetries
  }

  /**
   * Reserve the first port at or after `startPort` that this process can bind.
   *
   * `verifyClaim` adds the {@link isPortClaimable} handshake on top of the
   * plain bind check, for callers that cannot tolerate a port whose traffic
   * would be swallowed by a more specific listener.
   *
   * The search is a bounded scan. It used to recurse, re-deriving the retry
   * budget from the port it had just rejected - `port < startPort + maxRetries`
   * with `startPort` advancing in lockstep, so the guard could never fire and
   * the scan walked the entire port space one port at a time. Worse, the old
   * verification step required the candidate to be CONNECTABLE, which a free
   * port never is: every genuinely free port was rejected, and the scan only
   * stopped once it blundered onto a port owned by an unrelated service. What
   * that cost in practice was minutes of spinning followed by a port belonging
   * to somebody else.
   */
  async getNextAvailablePort(startPort: number, verifyClaim = false): Promise<number> {
    const first = Math.min(Math.max(Math.trunc(startPort), 1), MAX_PORT)
    const last = Math.min(first + this.maxRetries - 1, MAX_PORT)

    for (let port = first; port <= last; port++) {
      if (this.usedPorts.has(port)) {
        debugLog('port', `Port ${port} is already reserved by this process`, this.verbose)
        continue
      }

      if (await isPortInUse(port, this.hostname, this.verbose))
        continue

      if (verifyClaim && !(await isPortClaimable(port, this.hostname, 3000, this.verbose)))
        continue

      debugLog('port', `Reserved port ${port} (scan started at ${first})`, this.verbose)
      this.usedPorts.add(port)
      return port
    }

    throw new Error(`Unable to find an available port in ${first}-${last} after ${last - first + 1} attempts`)
  }

  releasePort(port: number): void {
    debugLog('port', `Releasing port ${port}`, this.verbose)
    this.usedPorts.delete(port)
  }
}

// Global port manager instance
export const portManager: DefaultPortManager = new DefaultPortManager()
