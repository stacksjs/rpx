import type { CleanupOptions } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import realProcess from 'node:process'
import * as Hosts from '../src/hosts'
import * as Https from '../src/https'
import { cleanup } from '../src/start'

// Mock dependencies
const mockProcessExit = mock(() => {})
const mockConsoleLog = mock(() => {})
const mockConsoleSuccess = mock(() => {})
// Spies, not `mock.module`: see the beforeEach below.
let mockRemoveHosts: any
let mockCleanupCertificates: any

// `mock.module` is global and persists for the rest of the test run. A partial
// process replacement ({ exit, on, once, env }) therefore poisons every file
// ordered after this one — anything reaching for `process.off`, `process.platform`,
// `process.cwd`, … (e.g. the daemon worker's SIGHUP cleanup) hits `undefined`.
// Delegate to the real process via a Proxy so only `exit`/`env`/`on`/`once` are
// overridden and every other member stays real.
const processOverrides: Record<string | symbol, unknown> = {
  exit: mockProcessExit,
  on: () => {},
  once: () => {},
  env: { ...realProcess.env, NODE_ENV: 'test' },
}
const processMock = new Proxy(realProcess, {
  get(target, prop) {
    if (prop in processOverrides)
      return processOverrides[prop]
    const value = Reflect.get(target, prop)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
processOverrides.default = processMock
mock.module('node:process', () => processMock)

describe('Cleanup Process', () => {
  beforeEach(() => {
    mockProcessExit.mockClear()
    mockConsoleLog.mockClear()
    mockConsoleSuccess.mockClear()
    // These two were `mock.module('../src/hosts')` / `('../src/https')`, which
    // replace the whole namespace permanently — `mock.restore()` does not undo a
    // module mock, so no later file could recover, and each namespace was left
    // holding a single export (#2270). Spies on the namespace members are
    // restorable and still observe `cleanup`'s internal calls, the same way
    // start.test.ts does it.
    mockRemoveHosts = spyOn(Hosts, 'removeHosts').mockImplementation(async () => {})
    mockCleanupCertificates = spyOn(Https, 'cleanupCertificates').mockImplementation(async () => {})
  })

  afterEach(() => {
    mock.restore()
  })

  it('should handle multiple cleanup calls gracefully', async () => {
    const options: CleanupOptions = {
      domains: ['test.local'],
      hosts: true,
      verbose: false,
    }

    // Start first cleanup
    const cleanup1 = cleanup(options)

    // Start second cleanup while first is in progress
    const cleanup2 = cleanup(options)

    // Both should resolve
    await Promise.all([cleanup1, cleanup2])

    // removeHosts should only be called once
    expect(mockRemoveHosts).toHaveBeenCalledTimes(1)
  })

  it('should not exit process if called from Vite plugin', async () => {
    const options: CleanupOptions = {
      domains: ['test.local'],
      hosts: true,
      verbose: false,
      vitePluginUsage: true,
    }

    await cleanup(options)

    expect(mockProcessExit).not.toHaveBeenCalled()
  })

  it('should clean up hosts if specified', async () => {
    const options: CleanupOptions = {
      domains: ['test.local'],
      hosts: true,
      verbose: false,
    }

    await cleanup(options)

    expect(mockRemoveHosts).toHaveBeenCalledTimes(1)
    expect(mockRemoveHosts).toHaveBeenCalledWith(['test.local'], false)
  })

  it('should clean up certificates if specified', async () => {
    const options: CleanupOptions = {
      domains: ['test.local'],
      certs: true,
      verbose: false,
    }

    await cleanup(options)

    expect(mockCleanupCertificates).toHaveBeenCalledTimes(1)
    expect(mockCleanupCertificates).toHaveBeenCalledWith('test.local', false)
  })

  it('should filter out localhost domains during cleanup', async () => {
    const options: CleanupOptions = {
      domains: ['localhost', 'test.local', '127.0.0.1', 'localhost.test'],
      hosts: true,
      verbose: false,
    }

    await cleanup(options)

    // Should only contain test.local, filtering out the others
    expect(mockRemoveHosts).toHaveBeenCalledWith(['test.local'], false)
  })
})
