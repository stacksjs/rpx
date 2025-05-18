import { describe, expect, it } from 'bun:test'
import { DefaultPortManager, portManager } from '../src/port-manager'

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
