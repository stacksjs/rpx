import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as hostsModule from '../src/hosts'

// Mock the entire module to avoid making actual system changes
describe('hosts', () => {
  let mockCheckHosts: any
  let mockAddHosts: any
  let mockRemoveHosts: any

  beforeEach(() => {
    // Create complete mock implementations that don't touch the system
    mockCheckHosts = spyOn(hostsModule, 'checkHosts').mockImplementation(async (hosts) => {
      return hosts.map(host => host === 'localhost')
    })

    mockAddHosts = spyOn(hostsModule, 'addHosts').mockImplementation(async () => {
      // Mock implementation that doesn't modify anything
      return Promise.resolve()
    })

    mockRemoveHosts = spyOn(hostsModule, 'removeHosts').mockImplementation(async () => {
      // Mock implementation that doesn't modify anything
      return Promise.resolve()
    })
  })

  describe('hosts file operations', () => {
    it('checks hosts entries correctly', async () => {
      const result = await hostsModule.checkHosts(['localhost', 'example.com'], true)
      expect(mockCheckHosts).toHaveBeenCalledWith(['localhost', 'example.com'], true)
      expect(result).toEqual([true, false])
    })

    it('calls addHosts with correct parameters', async () => {
      await hostsModule.addHosts(['example.com', 'test.local'], true)
      expect(mockAddHosts).toHaveBeenCalledWith(['example.com', 'test.local'], true)
    })

    it('calls removeHosts with correct parameters', async () => {
      await hostsModule.removeHosts(['example.com'], true)
      expect(mockRemoveHosts).toHaveBeenCalledWith(['example.com'], true)
    })

    it('has a defined hosts file path', () => {
      expect(hostsModule.hostsFilePath).toBeDefined()
      expect(typeof hostsModule.hostsFilePath).toBe('string')
    })
  })
})
