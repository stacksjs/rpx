/**
 * Redirect routes: a gateway host whose requests are answered with an HTTP
 * redirect (a `Location` response) instead of being proxied to an upstream or
 * served from disk. The canonical use is pointing an alternate/parked domain at
 * its primary host — e.g. `very-good-adblock.org` → `https://verygoodadblock.org`
 * — while preserving deep links: the request path + query are appended to the
 * target by default.
 *
 * Kept transport-agnostic and dependency-free so both the shared `:443` handler
 * and tests can use it directly.
 */

/**
 * Public redirect config for a route. A bare string is shorthand for a
 * permanent (301) redirect to that URL, path-preserving.
 */
export interface RedirectRouteConfig {
  /** Target base URL, e.g. `https://example.com` (a path prefix is allowed). */
  to: string
  /** HTTP status. Default `301` (permanent). */
  status?: 301 | 302 | 307 | 308
  /** Append the request path + query to `to`. Default `true`. */
  preservePath?: boolean
}

/** A normalized redirect, ready to serve. */
export interface ResolvedRedirect {
  to: string
  status: 301 | 302 | 307 | 308
  preservePath: boolean
}

const DEFAULT_REDIRECT_STATUS = 301 as const

/**
 * Normalize a `redirect` config (string shorthand or object) into a
 * {@link ResolvedRedirect}. A `to` without a scheme is treated as `https://<to>`
 * (a public redirect should land on TLS), and any trailing slash is trimmed so
 * appending the request path joins cleanly.
 */
export function resolveRedirect(input: string | RedirectRouteConfig): ResolvedRedirect {
  const cfg = typeof input === 'string' ? { to: input } : input
  let to = (cfg.to ?? '').trim()
  if (to && !/^[a-z][\w+.-]*:\/\//i.test(to))
    to = `https://${to}`
  to = to.replace(/\/+$/, '')
  return {
    to,
    status: cfg.status ?? DEFAULT_REDIRECT_STATUS,
    preservePath: cfg.preservePath ?? true,
  }
}

/**
 * Build the `Location` value for a redirect route. With `preservePath` the
 * request `pathname` + `search` (e.g. `/a/b?x=1`) is appended to the target
 * base; otherwise the bare target is used. `pathname` always starts with `/`
 * and `search` carries its own leading `?` (or is empty).
 */
export function buildRedirectLocation(redirect: ResolvedRedirect, pathname: string, search: string): string {
  if (!redirect.preservePath)
    return redirect.to || '/'
  const tail = `${pathname}${search}`
  return tail === '/' ? `${redirect.to}/` : `${redirect.to}${tail}`
}
