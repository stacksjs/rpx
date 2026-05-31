import { describe, expect, it } from 'bun:test'
import {
  contentTypeFor,
  resolveStaticFile,
  resolveStaticRoute,
  safeRelativePath,
} from '../src/static-files'

const ROOT = '/srv/site'

describe('resolveStaticRoute', () => {
  it('expands a string shorthand to defaults', () => {
    expect(resolveStaticRoute('/srv/site', false)).toEqual({
      dir: '/srv/site',
      spa: false,
      pathRewriteStyle: 'directory',
      maxAge: 0,
      cleanUrls: false,
    })
  })

  it('preserves explicit config and threads cleanUrls', () => {
    expect(resolveStaticRoute({ dir: '/srv/site', spa: true, pathRewriteStyle: 'flat', maxAge: 3600 }, true)).toEqual({
      dir: '/srv/site',
      spa: true,
      pathRewriteStyle: 'flat',
      maxAge: 3600,
      cleanUrls: true,
    })
  })
})

describe('contentTypeFor', () => {
  it('maps common extensions', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/x/app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/x/styles.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/x/logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('/x/pic.PNG')).toBe('image/png')
  })

  it('falls back to octet-stream for unknown', () => {
    expect(contentTypeFor('/x/file.unknownext')).toBe('application/octet-stream')
    expect(contentTypeFor('/x/noext')).toBe('application/octet-stream')
  })
})

describe('safeRelativePath', () => {
  it('strips the leading slash', () => {
    expect(safeRelativePath('/about')).toBe('about')
    expect(safeRelativePath('/assets/app.js')).toBe('assets/app.js')
  })

  it('decodes percent-encoding', () => {
    expect(safeRelativePath('/a%20b')).toBe('a b')
  })

  it('clamps .. against the root so it cannot escape', () => {
    // A rooted path collapses `..` segments, keeping the result inside root.
    expect(safeRelativePath('/../etc/passwd')).toBe('etc/passwd')
    expect(safeRelativePath('/a/../../etc/passwd')).toBe('etc/passwd')
    expect(safeRelativePath('/%2e%2e/secret')).toBe('secret')
  })

  it('rejects backslash and NUL escapes', () => {
    expect(safeRelativePath('/a\\b')).toBeNull()
    expect(safeRelativePath('/a\0b')).toBeNull()
  })

  it('rejects malformed percent-encoding', () => {
    expect(safeRelativePath('/%')).toBeNull()
  })
})

describe('resolveStaticFile', () => {
  const dir = (over: Partial<ReturnType<typeof resolveStaticRoute>> = {}) =>
    ({ dir: ROOT, spa: false, pathRewriteStyle: 'directory' as const, maxAge: 0, cleanUrls: false, ...over })

  it('root maps to index.html', () => {
    expect(resolveStaticFile('/', dir())).toEqual({ filePath: '/srv/site/index.html' })
  })

  it('trailing slash maps to that dir index.html', () => {
    expect(resolveStaticFile('/blog/', dir())).toEqual({ filePath: '/srv/site/blog/index.html' })
  })

  it('asset with a real extension maps straight through', () => {
    expect(resolveStaticFile('/assets/app.css', dir())).toEqual({ filePath: '/srv/site/assets/app.css' })
  })

  it('extensionless directory style → <path>/index.html', () => {
    expect(resolveStaticFile('/about', dir())).toEqual({ filePath: '/srv/site/about/index.html' })
  })

  it('extensionless flat style → <path>.html', () => {
    expect(resolveStaticFile('/about', dir({ pathRewriteStyle: 'flat' }))).toEqual({ filePath: '/srv/site/about.html' })
  })

  it('cleanUrls redirects explicit .html to the clean path', () => {
    expect(resolveStaticFile('/about.html', dir({ cleanUrls: true }))).toEqual({
      filePath: '/srv/site/about.html',
      redirectTo: '/about',
    })
  })

  it('cleanUrls redirects /dir/index.html to /dir/', () => {
    expect(resolveStaticFile('/blog/index.html', dir({ cleanUrls: true }))).toEqual({
      filePath: '/srv/site/blog/index.html',
      redirectTo: '/blog/',
    })
  })

  it('clamps traversal so it stays inside the root dir', () => {
    expect(resolveStaticFile('/a/../../assets/x.css', dir())).toEqual({ filePath: '/srv/site/assets/x.css' })
  })

  it('returns null on a backslash escape', () => {
    expect(resolveStaticFile('/a\\b', dir())).toBeNull()
  })
})
