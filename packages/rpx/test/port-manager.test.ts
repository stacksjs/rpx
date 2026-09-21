import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'bun:test'
import { DefaultPortManager, isPortClaimable, portManager } from '../src/port-manager'

describe('Port Manager', () => {
  describe('DefaultPortManager', () => {
    it('should initialize with an empty set of used ports', () => {
      const manager = new DefaultPortManager()
      expect(manager.usedPorts.size).toBe(0)
    })

    it('should track ports when they are added', () => {
      const manager = new DefaultPortManager()
      manager.usedPorts.add(8080)
      expect(manager.usedPorts.has(8080)).toBe(true)
      expect(manager.usedPorts.size).toBe(1)
    })

    it('should release a port when requested', () => {
      const manager = new DefaultPortManager()
      manager.usedPorts.add(8080)
      expect(manager.usedPorts.has(8080)).toBe(true)

      manager.releasePort(8080)
      expect(manager.usedPorts.has(8080)).toBe(false)
    })
  })

  describe('Global port manager instance', () => {
    it('should be an instance of DefaultPortManager', () => {
      expect(portManager).toBeInstanceOf(DefaultPortManager)
    })
  })
})

describe('Port selection', () => {
  const servers: net.Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve())
    })))
  })

  function listen(port: number, hostname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      servers.push(server)
      server.once('error', reject)
      server.listen(port, hostname, () => resolve())
    })
  }

  async function freePort(): Promise<number> {
    const probe = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as net.AddressInfo).port))
    })
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  // The verified search used to demand that the candidate port be CONNECTABLE,
  // which a free port never is, so it rejected every usable port and scanned on
  // until it hit one owned by an unrelated service. It has to return promptly,
  // and it has to return a port that is actually free.
  it('reserves the first free port even when connectivity is verified', async () => {
    const manager = new DefaultPortManager('127.0.0.1')
    const start = await freePort()

    const startedAt = Date.now()
    const port = await manager.getNextAvailablePort(start, true)

    expect(port).toBe(start)
    expect(manager.usedPorts.has(start)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })

  it('steps over a port that is already listening', async () => {
    const manager = new DefaultPortManager('127.0.0.1')
    const taken = await freePort()
    await listen(taken, '127.0.0.1')

    const port = await manager.getNextAvailablePort(taken, true)
    expect(port).toBeGreaterThan(taken)
  })

  it('steps over a port it has already reserved', async () => {
    const manager = new DefaultPortManager('127.0.0.1')
    const start = await freePort()
    manager.usedPorts.add(start)

    const port = await manager.getNextAvailablePort(start, true)
    expect(port).toBeGreaterThan(start)
  })

  // The recursion guard re-derived its budget from the port it had just
  // rejected, so it could never fire. A bounded scan gives up instead of
  // walking the whole port space.
  it('gives up after maxRetries instead of scanning forever', async () => {
    const manager = new DefaultPortManager('127.0.0.1', false, 2)
    const first = await freePort()
    await listen(first, '127.0.0.1')
    await listen(first + 1, '127.0.0.1')

    await expect(manager.getNextAvailablePort(first, true)).rejects.toThrow(/Unable to find an available port/)
  })
})

describe('isPortClaimable', () => {
  const servers: net.Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve())
    })))
  })

  function listen(port: number, hostname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(socket => socket.end('not-the-probe'))
      servers.push(server)
      server.once('error', reject)
      server.listen(port, hostname, () => resolve())
    })
  }

  async function freePort(): Promise<number> {
    const probe = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as net.AddressInfo).port))
    })
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  it('claims a free port', async () => {
    const port = await freePort()
    expect(await isPortClaimable(port, '127.0.0.1')).toBe(true)
  })

  it('refuses a port that is already bound', async () => {
    const port = await freePort()
    await listen(port, '127.0.0.1')
    expect(await isPortClaimable(port, '127.0.0.1')).toBe(false)
  })

  // A wildcard bind can succeed while a loopback-only listener keeps winning
  // the traffic (Postgres on 127.0.0.1:5432). Binding says yes; the handshake
  // is what catches it.
  it('refuses a wildcard port whose traffic a loopback listener steals', async () => {
    const port = await freePort()
    await listen(port, '127.0.0.1')
    expect(await isPortClaimable(port, '0.0.0.0')).toBe(false)
  })
})
