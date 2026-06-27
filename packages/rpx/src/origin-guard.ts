/**
 * Origin verification guard for "CDN in front of rpx" topologies.
 *
 * When rpx is the origin behind a CDN (e.g. CloudFront → rpx), the origin host
 * is publicly resolvable, so a client could resolve it and hit rpx directly,
 * bypassing the CDN's caching/WAF. The standard mitigation is a shared secret:
 * the CDN injects a secret request header on the origin fetch, and the origin
 * rejects any request to the protected hosts that lacks it.
 *
 * `createOriginGuard` returns a tiny pre-router gate you place in front of your
 * fetch handler. It only guards the listed hosts (exact or `*.wildcard`) — every
 * other host (e.g. apps served directly, not via the CDN) passes through
 * untouched. ACME HTTP-01 challenge paths are exempt by default so cert renewal
 * keeps working on the open `:80` listener.
 *
 * @example
 * const guard = createOriginGuard({
 *   header: 'x-origin-verify',
 *   value: process.env.ORIGIN_SECRET!,
 *   hosts: ['stacksjs.com', 'www.stacksjs.com', 'origin.stacksjs.com'],
 * })
 * Bun.serve({ fetch: req => guard(req) ?? handler(req, server) })
 */
import { timingSafeEqual } from 'node:crypto'
import { matchesWildcard } from './host-match'

/**
 * Compare a request-supplied secret against the expected value in constant time,
 * so the shared secret can't be recovered byte-by-byte via response timing. The
 * length check leaks only the secret's length (standard and acceptable); the
 * byte comparison itself is timing-safe.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided == null)
    return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length)
    return false
  return timingSafeEqual(a, b)
}

/** Lowercase and strip a single trailing dot so `Host: example.com.` ≡ `example.com`. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '')
}

export interface OriginGuardOptions {
  /** Header the CDN injects on the origin hop (case-insensitive), e.g. `x-origin-verify`. */
  header: string
  /** Expected secret value. Requests to protected hosts must carry `header: value`. */
  value: string
  /** Hosts to protect — exact (`stacksjs.com`) or wildcard (`*.stacksjs.com`). Others pass through. */
  hosts: string[]
  /**
   * Request paths exempt from the check (prefix match). Defaults to the ACME
   * HTTP-01 challenge prefix so cert issuance/renewal is never blocked.
   */
  exemptPaths?: string[]
  /** Body returned on rejection. Defaults to a short plain-text message. */
  forbiddenMessage?: string
}

export interface OriginGuard {
  /** Returns a 403 Response to short-circuit, or `undefined` to let the request proceed. */
  (req: Request): Response | undefined
  /** Whether a given hostname is in the protected set. */
  protects: (hostname: string) => boolean
}

const DEFAULT_EXEMPT = ['/.well-known/acme-challenge/']

function hostnameOf(req: Request): string {
  const hostHeader = req.headers.get('host')
  if (hostHeader)
    return normalizeHost(hostHeader.split(':')[0])
  try {
    return normalizeHost(new URL(req.url).hostname)
  }
  catch {
    return ''
  }
}

export function createOriginGuard(options: OriginGuardOptions): OriginGuard {
  const header = options.header.toLowerCase()
  const exact = new Set<string>()
  const wildcards: string[] = []
  for (const h of options.hosts) {
    const host = normalizeHost(h)
    if (host.startsWith('*.'))
      wildcards.push(host)
    else
      exact.add(host)
  }
  const exemptPaths = options.exemptPaths ?? DEFAULT_EXEMPT
  const forbidden = options.forbiddenMessage
    ?? 'Forbidden: direct origin access is not allowed; requests must arrive via the CDN.\n'

  const protects = (hostname: string): boolean => {
    const h = normalizeHost(hostname)
    return exact.has(h) || wildcards.some(w => matchesWildcard(h, w))
  }

  const guard: OriginGuard = ((req: Request): Response | undefined => {
    const host = hostnameOf(req)
    if (!protects(host))
      return undefined

    let pathname = '/'
    try {
      pathname = new URL(req.url).pathname
    }
    catch {
      // fall through with '/'
    }
    if (exemptPaths.some(p => pathname.startsWith(p)))
      return undefined

    if (secretMatches(req.headers.get(header), options.value))
      return undefined

    return new Response(forbidden, { status: 403, headers: { 'content-type': 'text/plain' } })
  }) as OriginGuard
  guard.protects = protects
  return guard
}
