/**
 * Host-based route matching with wildcard support.
 *
 * The routing table is keyed by host pattern. A pattern is either an exact
 * hostname (`api.example.com`) or a wildcard (`*.example.com`). Lookup prefers
 * an exact match, then the most-specific (deepest-suffix) wildcard.
 *
 * Kept dependency-free and pure so it's reusable from both the daemon and the
 * in-process multi-proxy path, and trivially unit-testable.
 */

export function isWildcardPattern(pattern: string): boolean {
  return pattern.startsWith('*.')
}

/**
 * True if `hostname` matches the wildcard `pattern` (`*.suffix`). A wildcard
 * matches exactly one or more leading labels — `*.example.com` matches
 * `a.example.com` and `a.b.example.com`, but NOT the bare apex `example.com`.
 */
export function matchesWildcard(hostname: string, pattern: string): boolean {
  if (!isWildcardPattern(pattern))
    return false
  const suffix = pattern.slice(1) // '*.example.com' → '.example.com'
  return hostname.length > suffix.length && hostname.endsWith(suffix)
}

/**
 * Find the route value for `hostname` in a host-keyed map. Exact match wins;
 * otherwise the matching wildcard with the longest (most-specific) suffix wins.
 * Returns `undefined` when nothing matches.
 */
export function matchHost<T>(table: Map<string, T>, hostname: string): T | undefined {
  const exact = table.get(hostname)
  if (exact !== undefined)
    return exact

  let best: T | undefined
  let bestLen = -1
  for (const [pattern, value] of table) {
    if (!isWildcardPattern(pattern))
      continue
    if (matchesWildcard(hostname, pattern)) {
      const len = pattern.length - 1 // length of the matched suffix
      if (len > bestLen) {
        bestLen = len
        best = value
      }
    }
  }
  return best
}
