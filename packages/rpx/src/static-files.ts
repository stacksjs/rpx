/**
 * Static-file serving for proxy routes.
 *
 * A route configured with `static` serves files from a local directory instead
 * of forwarding to an upstream. Path resolution is split into a pure function
 * (`resolveStaticFile`) so it's trivially unit-testable, and a thin `Bun.file`
 * wrapper (`serveStaticFile`) that does the actual I/O.
 */
import type { PathRewriteStyle, StaticRouteConfig } from './types'
import * as path from 'node:path'

/** Normalized static-route config (shorthand string already expanded). */
export interface ResolvedStaticRoute {
  dir: string
  spa: boolean
  pathRewriteStyle: PathRewriteStyle
  maxAge: number
  cleanUrls: boolean
}

export function resolveStaticRoute(
  cfg: string | StaticRouteConfig,
  cleanUrls: boolean,
): ResolvedStaticRoute {
  if (typeof cfg === 'string')
    return { dir: cfg, spa: false, pathRewriteStyle: 'directory', maxAge: 0, cleanUrls }
  return {
    dir: cfg.dir,
    spa: cfg.spa ?? false,
    pathRewriteStyle: cfg.pathRewriteStyle ?? 'directory',
    maxAge: cfg.maxAge ?? 0,
    cleanUrls,
  }
}

/** A minimal extension → MIME map covering the common web asset types. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Decode + normalize a URL pathname into a safe relative path.
 *
 * Traversal safety: normalizing against a leading `/` collapses every `..`
 * segment and clamps at the root, so the returned relative path never contains
 * `..` and `path.join(root, rel)` can't escape `root`. Backslash, NUL and
 * malformed percent-encoding are rejected outright (return `null`); the
 * residual `..` guard is belt-and-suspenders.
 */
export function safeRelativePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    return null
  }
  // Reject NUL and backslash (Windows-style) escapes outright.
  if (decoded.includes('\0') || decoded.includes('\\'))
    return null

  // `path.posix.normalize` collapses `..`/`.`; a leading `/` keeps it rooted so
  // a normalized result that still contains `..` means traversal above root.
  const normalized = path.posix.normalize(`/${decoded}`)
  if (normalized.includes('..'))
    return null
  // Strip the leading slash to get a path relative to the static root.
  return normalized.replace(/^\/+/, '')
}

export interface StaticResolution {
  /** Absolute file path to attempt to serve. */
  filePath: string
  /** When set, the request should 301-redirect to this clean URL. */
  redirectTo?: string
}

/**
 * Pure resolution of an incoming request pathname to a candidate file path on
 * disk. Does no I/O; the caller checks existence and may fall back (SPA).
 *
 * Rules:
 *  - A trailing `/` (or root) resolves to `index.html` in that directory.
 *  - `cleanUrls` + a `.html` request → 301 to the extensionless URL.
 *  - Extensionless paths resolve per `pathRewriteStyle`:
 *      - `directory`: `/about` → `about/index.html`
 *      - `flat`:      `/about` → `about.html`
 *  - Paths with a real extension (`.css`, `.png`, …) map straight through.
 *
 * Returns `null` when the path is unsafe (traversal attempt).
 */
export function resolveStaticFile(
  pathname: string,
  route: ResolvedStaticRoute,
): StaticResolution | null {
  const rel = safeRelativePath(pathname)
  if (rel === null)
    return null

  const ext = path.posix.extname(rel)

  // `cleanUrls`: redirect explicit `.html` requests to the clean URL.
  if (route.cleanUrls && ext === '.html') {
    const clean = pathname.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '')
    return { filePath: path.join(route.dir, rel), redirectTo: clean || '/' }
  }

  // Directory or root request → index.html.
  if (rel === '' || pathname.endsWith('/'))
    return { filePath: path.join(route.dir, rel, 'index.html') }

  // Asset with a concrete extension → serve directly.
  if (ext !== '')
    return { filePath: path.join(route.dir, rel) }

  // Extensionless route → resolve by SSG style.
  if (route.pathRewriteStyle === 'flat')
    return { filePath: path.join(route.dir, `${rel}.html`) }
  return { filePath: path.join(route.dir, rel, 'index.html') }
}

/**
 * Serve a static file for the matched route. Returns a 301 for clean-URL
 * redirects, the file with the right `Content-Type`/`Cache-Control` when it
 * exists, the SPA `index.html` fallback when configured, or 404.
 */
export async function serveStaticFile(
  pathname: string,
  route: ResolvedStaticRoute,
): Promise<Response> {
  const resolution = resolveStaticFile(pathname, route)
  if (!resolution)
    return new Response('Forbidden', { status: 403 })

  if (resolution.redirectTo)
    return new Response(null, { status: 301, headers: { Location: resolution.redirectTo } })

  const cacheControl = route.maxAge > 0
    ? `public, max-age=${route.maxAge}`
    : 'no-cache'

  const file = Bun.file(resolution.filePath)
  if (await file.exists()) {
    return new Response(file, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(resolution.filePath),
        'Cache-Control': cacheControl,
      },
    })
  }

  // SPA fallback: serve the root index.html so client-side routing works.
  if (route.spa) {
    const indexPath = path.join(route.dir, 'index.html')
    const index = Bun.file(indexPath)
    if (await index.exists()) {
      return new Response(index, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      })
    }
  }

  return new Response('Not Found', { status: 404 })
}
