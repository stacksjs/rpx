import { describe, expect, it } from 'bun:test'
import { isWildcardPattern, matchesWildcard, matchHost } from '../src/host-match'

describe('isWildcardPattern', () => {
  it('detects wildcard patterns', () => {
    expect(isWildcardPattern('*.example.com')).toBe(true)
    expect(isWildcardPattern('api.example.com')).toBe(false)
    expect(isWildcardPattern('example.com')).toBe(false)
    expect(isWildcardPattern('*')).toBe(false)
  })
})

describe('matchesWildcard', () => {
  it('matches one or more leading labels', () => {
    expect(matchesWildcard('a.example.com', '*.example.com')).toBe(true)
    expect(matchesWildcard('a.b.example.com', '*.example.com')).toBe(true)
  })

  it('does not match the bare apex', () => {
    expect(matchesWildcard('example.com', '*.example.com')).toBe(false)
  })

  it('does not match unrelated suffixes', () => {
    expect(matchesWildcard('a.notexample.com', '*.example.com')).toBe(false)
    expect(matchesWildcard('evil.com', '*.example.com')).toBe(false)
  })

  it('returns false for non-wildcard patterns', () => {
    expect(matchesWildcard('a.example.com', 'a.example.com')).toBe(false)
  })
})

describe('matchHost', () => {
  it('exact match wins over wildcard', () => {
    const table = new Map<string, string>([
      ['*.example.com', 'wild'],
      ['api.example.com', 'exact'],
    ])
    expect(matchHost(table, 'api.example.com')).toBe('exact')
  })

  it('falls back to wildcard when no exact match', () => {
    const table = new Map<string, string>([['*.example.com', 'wild']])
    expect(matchHost(table, 'foo.example.com')).toBe('wild')
    expect(matchHost(table, 'a.b.example.com')).toBe('wild')
  })

  it('deepest (most-specific) wildcard suffix wins', () => {
    const table = new Map<string, string>([
      ['*.example.com', 'shallow'],
      ['*.api.example.com', 'deep'],
    ])
    expect(matchHost(table, 'v1.api.example.com')).toBe('deep')
    expect(matchHost(table, 'foo.example.com')).toBe('shallow')
  })

  it('no false positives for unrelated hosts', () => {
    const table = new Map<string, string>([['*.example.com', 'wild']])
    expect(matchHost(table, 'example.com')).toBeUndefined()
    expect(matchHost(table, 'evil.com')).toBeUndefined()
    expect(matchHost(table, 'notexample.com')).toBeUndefined()
  })

  it('returns undefined on an empty table', () => {
    expect(matchHost(new Map<string, string>(), 'anything.com')).toBeUndefined()
  })
})
