import type { CleanupOptions } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup } from '../src/start'

// Mock dependencies
const mockProcessExit = mock(() => {})
const mockConsoleLog = mock(() => {})
const mockConsoleSuccess = mock(() => {})
const mockRemoveHosts = mock(async () => {})
const mockCleanupCertificates = mock(async () => {})

// Set up mocks
mock.module('node:process', () => ({
  exit: mockProcessExit,
  on: () => {},
  once: () => {},
  env: { NODE_ENV: 'test' },
}))

mock.module('consola', () => ({
  consola: {
    info: mockConsoleLog,
    success: mockConsoleSuccess,
    warn: () => {},
    error: () => {},
  },
}))

mock.module('../src/hosts', () => ({
  removeHosts: mockRemoveHosts,
}))

mock.module('../src/https', () => ({
  cleanupCertificates: mockCleanupCertificates,
}))

describe('Cleanup Process', () => {
  beforeEach(() => {
    mockProcessExit.mockClear()
    mockConsoleLog.mockClear()
    mockConsoleSuccess.mockClear()
    mockRemoveHosts.mockClear()
    mockCleanupCertificates.mockClear()
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
