import { describe, expect, it } from 'bun:test'
import {
  buildHostRoutes,
  matchHostList,
  matchHostRoute,
  normalizePathPrefix,
  pathPrefixMatches,
} from '../src/host-routes'

describe('normalizePathPrefix', () => {
  it('treats empty/undefined/root as the host default "/"', () => {
    expect(normalizePathPrefix(undefined)).toBe('/')
    expect(normalizePathPrefix('')).toBe('/')
    expect(normalizePathPrefix('/')).toBe('/')
  })

  it('adds a leading slash and strips trailing slashes', () => {
    expect(normalizePathPrefix('api')).toBe('/api')
    expect(normalizePathPrefix('/api/')).toBe('/api')
    expect(normalizePathPrefix('/docs///')).toBe('/docs')
    expect(normalizePathPrefix('  /api  ')).toBe('/api')
  })
})

describe('pathPrefixMatches', () => {
  it('root prefix matches everything', () => {
    expect(pathPrefixMatches('/', '/')).toBe(true)
    expect(pathPrefixMatches('/anything/deep', '/')).toBe(true)
  })

  it('matches at a segment boundary only', () => {
    expect(pathPrefixMatches('/api', '/api')).toBe(true)
    expect(pathPrefixMatches('/api/users', '/api')).toBe(true)
    expect(pathPrefixMatches('/apifoo', '/api')).toBe(false)
    expect(pathPrefixMatches('/ap', '/api')).toBe(false)
  })
})

describe('buildHostRoutes', () => {
  it('groups by host and sorts longest-prefix first ("/" last)', () => {
    const table = buildHostRoutes([
      { host: 'stacksjs.com', path: '/', route: 'public' },
      { host: 'stacksjs.com', path: '/api/v2', route: 'v2' },
      { host: 'stacksjs.com', path: '/api', route: 'app' },
    ])
    const list = table.get('stacksjs.com')!
    // Longest prefix first; the root default sorts last.
    expect(list.map(e => e.path)).toEqual(['/api/v2', '/api', '/'])
  })

  it('later entry wins on a (host, path) collision', () => {
    const table = buildHostRoutes([
      { host: 'a.com', path: '/x', route: 'first' },
      { host: 'a.com', path: '/x', route: 'second' },
    ])
    expect(matchHostRoute(table, 'a.com', '/x')).toBe('second')
  })
})

describe('matchHostList', () => {
  it('exact host beats wildcard, deepest wildcard beats shallow', () => {
    const table = buildHostRoutes([
      { host: '*.example.com', path: '/', route: 'shallow' },
      { host: '*.api.example.com', path: '/', route: 'deep' },
      { host: 'api.example.com', path: '/', route: 'exact' },
    ])
    expect(matchHostList(table, 'api.example.com')?.[0].route).toBe('exact')
    expect(matchHostList(table, 'v1.api.example.com')?.[0].route).toBe('deep')
    expect(matchHostList(table, 'foo.example.com')?.[0].route).toBe('shallow')
    expect(matchHostList(table, 'nope.org')).toBeUndefined()
  })
})

describe('matchHostRoute — path precedence within a host', () => {
  // The stacksjs.com-style multi-site layout: an app under /api, a docs static
  // dir under /docs, and a public static dir at the root.
  const table = buildHostRoutes([
    { host: 'stacksjs.com', path: '/', route: { kind: 'static', dir: '/var/www/public' } },
    { host: 'stacksjs.com', path: '/api', route: { kind: 'proxy', from: 'localhost:3000' } },
    { host: 'stacksjs.com', path: '/docs', route: { kind: 'static', dir: '/var/www/docs' } },
  ])

  it('routes /api/* to the app', () => {
    expect(matchHostRoute(table, 'stacksjs.com', '/api')).toEqual({ kind: 'proxy', from: 'localhost:3000' })
    expect(matchHostRoute(table, 'stacksjs.com', '/api/users/1')).toEqual({ kind: 'proxy', from: 'localhost:3000' })
  })

  it('routes /docs* to the docs static dir', () => {
    expect(matchHostRoute(table, 'stacksjs.com', '/docs')).toEqual({ kind: 'static', dir: '/var/www/docs' })
    expect(matchHostRoute(table, 'stacksjs.com', '/docs/guide')).toEqual({ kind: 'static', dir: '/var/www/docs' })
  })

  it('falls back to the public root for everything else', () => {
    expect(matchHostRoute(table, 'stacksjs.com', '/')).toEqual({ kind: 'static', dir: '/var/www/public' })
    expect(matchHostRoute(table, 'stacksjs.com', '/about')).toEqual({ kind: 'static', dir: '/var/www/public' })
    // /apidocs is not under /api (segment boundary) so it hits the default.
    expect(matchHostRoute(table, 'stacksjs.com', '/apidocs')).toEqual({ kind: 'static', dir: '/var/www/public' })
  })

  it('returns undefined when the host is unknown', () => {
    expect(matchHostRoute(table, 'other.com', '/api')).toBeUndefined()
  })

  it('a host with no "/" default returns undefined for unclaimed paths', () => {
    const t = buildHostRoutes([
      { host: 'h.com', path: '/api', route: 'app' },
    ])
    expect(matchHostRoute(t, 'h.com', '/api/x')).toBe('app')
    expect(matchHostRoute(t, 'h.com', '/other')).toBeUndefined()
  })

  it('host-only routing (single "/" default) is unchanged', () => {
    const t = buildHostRoutes([
      { host: 'a.com', route: 'a' },
      { host: 'b.com', path: '/', route: 'b' },
    ])
    expect(matchHostRoute(t, 'a.com', '/anything')).toBe('a')
    expect(matchHostRoute(t, 'b.com', '/x/y')).toBe('b')
  })
})
