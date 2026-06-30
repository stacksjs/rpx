/**
 * ACME http-01 challenge serving for the gateway's `:80` listener.
 *
 * A production gateway holds `:80` (it redirects to HTTPS), so an ACME client
 * can't bind `:80` itself to answer a Let's Encrypt http-01 challenge without
 * taking the gateway down. Instead the client (e.g. `tlsx acme:renew --webroot`)
 * drops the challenge token under `<webroot>/.well-known/acme-challenge/<token>`
 * and the gateway serves it from there — so certs for origin/CDN domains that
 * can't use dns-01 can be issued and renewed with zero downtime.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The fixed request prefix Let's Encrypt fetches an http-01 token from. */
export const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/'

/**
 * If `pathname` is an ACME http-01 challenge request, return the token's
 * key-authorization contents from `webroot`; otherwise (or on any unsafe/missing
 * token) return `null` so the caller falls through to its normal handling.
 *
 * The token must be a single path segment of ACME's `base64url` alphabet — this
 * never rejects a real Let's Encrypt token, but refuses slashes, `..`, and other
 * traversal so a crafted request can't read outside the challenge directory.
 */
export function readAcmeChallenge(webroot: string, pathname: string): string | null {
  if (!webroot || !pathname.startsWith(ACME_CHALLENGE_PREFIX))
    return null
  const token = pathname.slice(ACME_CHALLENGE_PREFIX.length)
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token))
    return null
  try {
    return fs.readFileSync(path.join(webroot, '.well-known', 'acme-challenge', token), 'utf8')
  }
  catch {
    return null
  }
}
