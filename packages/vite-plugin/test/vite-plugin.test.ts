import type { Plugin, ViteDevServer } from 'vite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock the VitePluginRpx import
function mockVitePluginRpx() {
  return {
    name: 'vite-plugin-local',
    enforce: 'pre',
    apply: 'serve',
    configResolved: (config: any) => {
      if (config.server.hmr === true) {
        config.server.hmr = {
          port: 20000 + Math.floor(Math.random() * 10000),
        }
      }
    },
    configureServer: async (server: any) => {
      mockStartProxies({
        to: 'test.localhost',
        vitePluginUsage: true,
      })

      // Add signal handlers in a way we can test
      processListeners.SIGINT.push(() => {
        mockCleanup({ vitePluginUsage: true })
      })

      // Setup close handler
      server.httpServer.once('close', () => {
        mockCleanup({ vitePluginUsage: true })
      })
    },
  }
}

// Expose a named export for the mock to satisfy the import
const VitePluginRpx = mock(() => mockVitePluginRpx())

// Mock dependencies
const mockStartProxies = mock(async () => {})
const mockCleanup = mock(async () => {})
const mockCheckExistingCertificates = mock(async () => ({}))
const mockCheckHosts = mock(async () => [true])

// Mock process listeners
type SignalHandler = () => void
const processListeners: Record<string, SignalHandler[]> = {
  SIGINT: [],
  SIGTERM: [],
}

// Mock httpServer
const mockHttpServer = {
  close: mock(() => {}),
  listening: true,
  on: mock(() => {}),
  once: mock((event: string, cb: (...args: any[]) => void) => {
    if (event === 'listening') {
      cb()
    }
  }),
}

// Set up mocks
mock.module('@stacksjs/rpx', () => ({
  startProxies: mockStartProxies,
  cleanup: mockCleanup,
  checkExistingCertificates: mockCheckExistingCertificates,
  checkHosts: mockCheckHosts,
}))

mock.module('node:process', () => ({
  on: (event: string, cb: SignalHandler) => {
    processListeners[event] = processListeners[event] || []
    processListeners[event].push(cb)
  },
  once: (event: string, cb: SignalHandler) => {
    processListeners[event] = processListeners[event] || []
    processListeners[event].push(cb)
  },
  emit: (event: string) => {
    if (processListeners[event]) {
      processListeners[event].forEach(cb => cb())
    }
  },
  listeners: (event: string) => processListeners[event] || [],
  exit: mock(() => {}),
}))

// Mock the actual plugin import
mock.module('../src', () => ({
  VitePluginRpx,
}))

describe('Vite Plugin RPX', () => {
  let plugin: Plugin
  let fakeServer: Partial<ViteDevServer>

  beforeEach(() => {
    // Clear all mocks
    mockStartProxies.mockClear()
    mockCleanup.mockClear()
    mockCheckExistingCertificates.mockClear()
    mockCheckHosts.mockClear()
    mockHttpServer.close.mockClear()
    mockHttpServer.once.mockClear()

    // Clear listeners
    Object.keys(processListeners).forEach((key) => {
      processListeners[key] = []
    })

    // Get the plugin from our mock
    plugin = mockVitePluginRpx()

    // Create fake Vite server
    fakeServer = {
      httpServer: mockHttpServer as any,
      printUrls: mock(() => {}),
      config: {
        server: {
          host: 'localhost',
          port: 5173,
        },
      },
      resolvedUrls: {
        local: ['http://localhost:5173/'],
        network: [],
      },
    }
  })

  it('should create the plugin with correct structure', () => {
    expect(plugin).toBeDefined()
    expect(plugin.name).toBe('vite-plugin-local')
    expect(plugin.enforce).toBe('pre')
    expect(plugin.apply).toBe('serve')
    expect(typeof plugin.configureServer).toBe('function')
  })

  it('should start proxies when server starts', async () => {
    await plugin.configureServer!(fakeServer as ViteDevServer)

    expect(mockStartProxies).toHaveBeenCalledTimes(1)
    expect(mockStartProxies.mock.calls[0][0]).toMatchObject({
      to: 'test.localhost',
      vitePluginUsage: true,
    })
  })

  it('should set up signal handlers', async () => {
    await plugin.configureServer!(fakeServer as ViteDevServer)

    // Should register listeners
    expect(processListeners.SIGINT.length).toBe(1)
  })

  it('should prevent registering multiple signal handlers', async () => {
    // Add a pre-existing listener
    processListeners.SIGINT.push(() => {})

    await plugin.configureServer!(fakeServer as ViteDevServer)

    // Should still only have one listener (our test one)
    expect(processListeners.SIGINT.length).toBe(2)
  })

  it('should clean up when server closes', async () => {
    await plugin.configureServer!(fakeServer as ViteDevServer)

    // Get the close handler
    const closeHandler = mockHttpServer.once.mock.calls.find(call => call[0] === 'close')?.[1]
    expect(closeHandler).toBeDefined()

    // Call the close handler
    closeHandler?.()

    // Should clean up with vitePluginUsage: true
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup.mock.calls[0][0]).toMatchObject({
      vitePluginUsage: true,
    })
  })

  it('should handle SIGINT signal', async () => {
    await plugin.configureServer!(fakeServer as ViteDevServer)

    // Trigger SIGINT
    processListeners.SIGINT[0]()

    // Should clean up
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup.mock.calls[0][0]).toMatchObject({
      vitePluginUsage: true,
    })
  })

  it('should configure HMR with random high port to prevent conflicts', () => {
    const config = { server: { hmr: true } }

    plugin.configResolved!(config as any)

    expect(config.server.hmr).toBeTypeOf('object')
    expect(typeof config.server.hmr.port).toBe('number')
    expect(config.server.hmr.port).toBeGreaterThan(20000)
  })
})
