import type { PortManager } from './types'
import * as net from 'node:net'
import { debugLog } from './utils'

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
 * Test if a port is actually connectable
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

  async getNextAvailablePort(startPort: number, testConnectivity = false): Promise<number> {
    if (this.usedPorts.has(startPort)) {
      // If we already have this port registered as used, find another one
      return this.findNextAvailablePort(startPort + 1, testConnectivity)
    }

    const isInUse = await isPortInUse(startPort, this.hostname, this.verbose)

    if (isInUse) {
      return this.findNextAvailablePort(startPort + 1, testConnectivity)
    }

    // If requested, test that we can actually connect to this port
    if (testConnectivity) {
      const isConnectable = await testPortConnectivity(startPort, this.hostname, 3000, this.verbose)
      if (!isConnectable) {
        debugLog('port', `Port ${startPort} is available but not connectable, trying next port`, this.verbose)
        return this.findNextAvailablePort(startPort + 1, testConnectivity)
      }
    }

    // Port is available, register it
    this.usedPorts.add(startPort)
    return startPort
  }

  private async findNextAvailablePort(startPort: number, testConnectivity = false): Promise<number> {
    const port = await findAvailablePort(startPort, this.hostname, this.verbose, this.maxRetries)

    // If requested, test that we can actually connect to this port
    if (testConnectivity) {
      const isConnectable = await testPortConnectivity(port, this.hostname, 3000, this.verbose)
      if (!isConnectable) {
        // If the port isn't connectable, try the next one
        if (port < startPort + this.maxRetries) {
          return this.findNextAvailablePort(port + 1, testConnectivity)
        }
        else {
          throw new Error(`Unable to find a connectable port after ${this.maxRetries} attempts`)
        }
      }
    }

    this.usedPorts.add(port)
    return port
  }

  releasePort(port: number): void {
    debugLog('port', `Releasing port ${port}`, this.verbose)
    this.usedPorts.delete(port)
  }
}

// Global port manager instance
export const portManager: DefaultPortManager = new DefaultPortManager()
