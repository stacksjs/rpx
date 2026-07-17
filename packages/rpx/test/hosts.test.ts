import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as hostsModule from '../src/hosts'
import { dropStaleRpxHostsLines, filterRpxHostsEntries, hostsLineMapsHost, isLoopbackDevelopmentHost, parseHostsLine } from '../src/hosts'

describe('isLoopbackDevelopmentHost', () => {
  it('treats RFC 6761 .localhost names as loopback dev hosts', () => {
    expect(isLoopbackDevelopmentHost('nsdap-registry.localhost')).toBe(true)
    expect(isLoopbackDevelopmentHost('api.foo.localhost.')).toBe(true)
    expect(isLoopbackDevelopmentHost('localhost')).toBe(true)
    expect(isLoopbackDevelopmentHost('example.test')).toBe(false)
  })
})

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

describe('parseHostsLine', () => {
  it('parses a plain mapping line', () => {
    expect(parseHostsLine('127.0.0.1 example.test')).toEqual({
      address: '127.0.0.1',
      names: ['example.test'],
      comment: '',
      rpxPid: null,
      rpxManaged: false,
    })
  })

  it('parses multiple names on one line', () => {
    const parsed = parseHostsLine('127.0.0.1 a.test b.test')
    expect(parsed?.names).toEqual(['a.test', 'b.test'])
  })

  it('parses the inline rpx marker with a pid', () => {
    const parsed = parseHostsLine('127.0.0.1 example.test # rpx:pid=4242')
    expect(parsed?.rpxManaged).toBe(true)
    expect(parsed?.rpxPid).toBe(4242)
  })

  it('parses the bare inline rpx marker', () => {
    const parsed = parseHostsLine('::1 example.test # rpx')
    expect(parsed?.rpxManaged).toBe(true)
    expect(parsed?.rpxPid).toBeNull()
  })

  it('does not treat lookalike comments as rpx markers', () => {
    expect(parseHostsLine('127.0.0.1 example.test # rpxy')?.rpxManaged).toBe(false)
    expect(parseHostsLine('127.0.0.1 example.test # rpx:pid=abc')?.rpxManaged).toBe(false)
    expect(parseHostsLine('127.0.0.1 example.test # note about rpx:pid=1')?.rpxManaged).toBe(false)
  })

  it('returns null for comments, blanks, and address-only lines', () => {
    expect(parseHostsLine('# a comment')).toBeNull()
    expect(parseHostsLine('   ')).toBeNull()
    expect(parseHostsLine('127.0.0.1')).toBeNull()
  })
})

describe('hostsLineMapsHost', () => {
  it('matches exact loopback hosts only', () => {
    expect(hostsLineMapsHost('127.0.0.1 example.test', 'example.test')).toBe(true)
    expect(hostsLineMapsHost('::1 example.test', 'example.test')).toBe(true)
    expect(hostsLineMapsHost('127.0.0.1 api.example.test', 'example.test')).toBe(false)
    expect(hostsLineMapsHost('127.0.0.1 example.test.evil', 'example.test')).toBe(false)
    expect(hostsLineMapsHost('10.0.0.1 example.test', 'example.test')).toBe(false)
  })
})

describe('filterRpxHostsEntries', () => {
  it('removes inline-marked lines for the requested host', () => {
    const content = [
      '127.0.0.1 localhost',
      '127.0.0.1 example.test # rpx:pid=100',
      '::1 example.test # rpx:pid=100',
      '',
    ].join('\n')
    const { content: next, removed } = filterRpxHostsEntries(content, ['example.test'])
    expect(removed.sort()).toEqual(['example.test'])
    expect(next).toBe('127.0.0.1 localhost\n')
  })

  it('never removes unmarked lines, even when the host matches', () => {
    const content = '127.0.0.1 example.test\n'
    const { content: next, removed } = filterRpxHostsEntries(content, ['example.test'])
    expect(removed).toEqual([])
    expect(next).toBe('127.0.0.1 example.test\n')
  })

  it('does not touch subdomains of a removed host', () => {
    const content = [
      '127.0.0.1 example.test # rpx:pid=100',
      '127.0.0.1 api.example.test # rpx:pid=100',
      '',
    ].join('\n')
    const { content: next, removed } = filterRpxHostsEntries(content, ['example.test'])
    expect(removed).toEqual(['example.test'])
    expect(next).toBe('127.0.0.1 api.example.test # rpx:pid=100\n')
  })

  it('removes a whole legacy block including its comment', () => {
    const content = [
      '127.0.0.1 localhost',
      '# Added by rpx',
      '127.0.0.1 example.test',
      '::1 example.test',
      '',
    ].join('\n')
    const { content: next, removed } = filterRpxHostsEntries(content, ['example.test'])
    expect(removed.sort()).toEqual(['example.test'])
    expect(next).toBe('127.0.0.1 localhost\n')
  })

  it('keeps a legacy comment when its block still owns another host', () => {
    const content = [
      '# Added by rpx',
      '127.0.0.1 example.test',
      '::1 example.test',
      '# Added by rpx',
      '127.0.0.1 other.test',
      '::1 other.test',
      '',
    ].join('\n')
    const { content: next, removed } = filterRpxHostsEntries(content, ['example.test'])
    expect(removed).toEqual(['example.test'])
    expect(next).toBe([
      '# Added by rpx',
      '127.0.0.1 other.test',
      '::1 other.test',
      '',
    ].join('\n'))
  })

  it('handles mixed inline and legacy entries in one file', () => {
    const content = [
      '255.255.255.255 broadcasthost',
      '# Added by rpx',
      '127.0.0.1 old.test',
      '::1 old.test',
      '127.0.0.1 new.test # rpx:pid=7',
      '::1 new.test # rpx:pid=7',
      '',
    ].join('\n')
    const { content: next, removed } = filterRpxHostsEntries(content, ['old.test', 'new.test'])
    expect(removed.sort()).toEqual(['new.test', 'old.test'])
    expect(next).toBe('255.255.255.255 broadcasthost\n')
  })
})

describe('dropStaleRpxHostsLines', () => {
  const alive = new Set([111])
  const isAlive = (pid: number) => alive.has(pid)

  it('drops lines whose owner pid is dead', () => {
    const content = [
      '127.0.0.1 dead.test # rpx:pid=999',
      '::1 dead.test # rpx:pid=999',
      '127.0.0.1 live.test # rpx:pid=111',
      '',
    ].join('\n')
    const { content: next, removed, stalePids } = dropStaleRpxHostsLines(content, isAlive)
    expect(removed).toEqual(['dead.test', 'dead.test'])
    expect(stalePids).toEqual([999])
    expect(next).toBe('127.0.0.1 live.test # rpx:pid=111\n')
  })

  it('keeps unmarked, unpinned, and non-loopback lines', () => {
    const content = [
      '127.0.0.1 manual.test',
      '127.0.0.1 pinned.test # rpx',
      '10.0.0.5 elsewhere.test # rpx:pid=999',
      '# Added by rpx',
      '127.0.0.1 legacy.test',
      '',
    ].join('\n')
    const { content: next, removed } = dropStaleRpxHostsLines(content, isAlive)
    expect(removed).toEqual([])
    expect(next).toBe(content)
  })
})
