/**
 * Path-aware routing within a single host.
 *
 * `host-match.ts` answers "which host pattern owns this hostname?" (exact wins,
 * then most-specific wildcard). That is sufficient when every host maps to a
 * single backend. But a single domain often needs to serve several things at
 * once — e.g. `stacksjs.com/api/*` proxied to an app on `:3000`,
 * `stacksjs.com/docs*` served from `/var/www/docs`, and `stacksjs.com/` served
 * from `/var/www/public`. That requires a second routing dimension: the
 * request **path**.
 *
 * This module layers path routing on top of host routing without disturbing
 * host-only routing:
 *   - Each host pattern maps to a list of `(path, route)` entries.
 *   - Lookup first resolves the host (reusing `matchHost` semantics), then picks
 *     the entry whose `path` is the longest prefix of the request pathname.
 *   - A host with a single entry whose `path` is `'/'` (or empty) behaves
 *     exactly like the old host-only table — full backward compatibility.
 *
 * Kept dependency-free and pure so it's reusable from both the daemon and the
 * in-process multi-proxy path, and trivially unit-testable.
 */
import { isWildcardPattern, matchesWildcard } from './host-match'

/** One path-scoped route under a host. */
export interface PathRoute<T> {
  /**
   * Path prefix this route owns, e.g. `'/api'`. `'/'` (or `''`) is the host
   * default that catches everything not claimed by a more specific prefix.
   */
  path: string
  /** The route value (e.g. a {@link import('./proxy-handler').ProxyRoute}). */
  route: T
}

/**
 * A host-keyed routing table where each host owns an ordered set of
 * path-scoped routes. Build it with {@link buildHostRoutes}.
 */
export type HostRoutes<T> = Map<string, Array<PathRoute<T>>>

/**
 * Normalize a path prefix to a leading-slash, no-trailing-slash form so prefix
 * comparisons are predictable. `''`/`undefined`/`'/'` all normalize to `'/'`
 * (the host default). `'/api/'` → `'/api'`, `'docs'` → `'/docs'`.
 */
export function normalizePathPrefix(path: string | undefined): string {
  if (!path || path === '/')
    return '/'
  let p = path.trim()
  if (!p.startsWith('/'))
    p = `/${p}`
  // Strip trailing slashes (but keep the root '/').
  p = p.replace(/\/+$/, '')
  return p === '' ? '/' : p
}

/**
 * True if `pathname` is matched by the prefix `prefix`. The root prefix `'/'`
 * matches everything. A non-root prefix matches when the pathname equals it
 * (`/api`), or continues with a `/` (`/api/x`) — so `/api` does NOT match
 * `/apifoo`, only a real path-segment boundary.
 */
export function pathPrefixMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/')
    return true
  if (pathname === prefix)
    return true
  return pathname.startsWith(`${prefix}/`)
}

/**
 * Build a {@link HostRoutes} table from a flat list of entries. Entries are
 * grouped by host; within each host the path-routes are sorted longest-prefix
 * first so {@link matchHostRoute} can take the first match. If two entries
 * collide on the same (host, path) the later one wins (matching `Map.set`).
 */
export function buildHostRoutes<T>(
  entries: Array<{ host: string, path?: string, route: T }>,
): HostRoutes<T> {
  const byHost = new Map<string, Map<string, T>>()
  for (const e of entries) {
    const prefix = normalizePathPrefix(e.path)
    let paths = byHost.get(e.host)
    if (!paths) {
      paths = new Map<string, T>()
      byHost.set(e.host, paths)
    }
    paths.set(prefix, e.route)
  }

  const table: HostRoutes<T> = new Map()
  for (const [host, paths] of byHost) {
    const list: Array<PathRoute<T>> = []
    for (const [path, route] of paths)
      list.push({ path, route })
    // Longest prefix first; '/' (length 1) naturally sorts last as the default.
    list.sort((a, b) => b.path.length - a.path.length)
    table.set(host, list)
  }
  return table
}

/**
 * Find the path-route list for `hostname` in a {@link HostRoutes} table. Exact
 * host match wins; otherwise the most-specific (deepest-suffix) wildcard wins —
 * mirroring {@link import('./host-match').matchHost}.
 */
export function matchHostList<T>(table: HostRoutes<T>, hostname: string): Array<PathRoute<T>> | undefined {
  const exact = table.get(hostname)
  if (exact !== undefined)
    return exact

  let best: Array<PathRoute<T>> | undefined
  let bestLen = -1
  for (const [pattern, value] of table) {
    if (!isWildcardPattern(pattern))
      continue
    if (matchesWildcard(hostname, pattern)) {
      const len = pattern.length - 1
      if (len > bestLen) {
        bestLen = len
        best = value
      }
    }
  }
  return best
}

/**
 * Resolve a (hostname, pathname) pair to a single route value. First the host
 * is resolved ({@link matchHostList}); then the longest matching path prefix
 * within that host wins. Returns `undefined` when no host matches, or a host
 * matches but no path prefix (including the `'/'` default) covers the request.
 */
export function matchHostRoute<T>(table: HostRoutes<T>, hostname: string, pathname: string): T | undefined {
  const list = matchHostList(table, hostname)
  if (!list)
    return undefined
  // `list` is pre-sorted longest-prefix-first, so the first match is the most
  // specific one ('/' is last and matches everything as the host default).
  for (const entry of list) {
    if (pathPrefixMatches(pathname, entry.path))
      return entry.route
  }
  return undefined
}
