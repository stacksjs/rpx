/**
 * HTTP Basic authentication for proxy/static routes.
 *
 * A route may declare `auth` (see {@link import('./types').BasicAuthConfig}); the
 * shared request handler then gates every transport (proxy, static, WebSocket)
 * for that route behind a `401`/`WWW-Authenticate` challenge until valid
 * credentials are supplied. This is how rpx serves password-protected sites — the
 * ts-cloud management dashboard, staging environments, internal tools — without
 * an extra auth proxy in front of it.
 *
 * Credentials come from inline `username`/`password`, an inline `users[]` list,
 * and/or an Apache-style `htpasswd` file (bcrypt, apr1, SHA1, or plaintext lines).
 * All comparisons are constant-time to avoid leaking credentials via timing.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { BasicAuthConfig } from './types'

/** A resolved, ready-to-enforce auth policy for one route. */
export interface ResolvedAuth {
  /** Realm string shown in the browser's auth prompt. */
  realm: string
  /** Constant-time credential check. */
  verify: (username: string, password: string) => boolean
}

/** ACME http-01 challenge prefix — never gated, or on-demand TLS issuance breaks. */
const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/'

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Compare against self so the work (and timing) is independent of the inputs.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/**
 * Apache apr1 (`$apr1$`) MD5-based crypt — the format `openssl passwd -apr1` and
 * `htpasswd` (without `-B`) emit. Faithful port of the reference algorithm.
 */
function apr1Crypt(password: string, salt: string): string {
  const md5 = (buf: Buffer): Buffer => createHash('md5').update(buf).digest()
  const pw = Buffer.from(password, 'utf8')
  const saltBuf = Buffer.from(salt, 'utf8')

  const result = md5(Buffer.concat([pw, saltBuf, pw]))

  const ctx: Buffer[] = [pw, Buffer.from('$apr1$', 'utf8'), saltBuf]
  for (let i = pw.length; i > 0; i -= 16)
    ctx.push(result.subarray(0, Math.min(i, 16)))
  for (let i = pw.length; i > 0; i >>= 1)
    ctx.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1))
  let final = md5(Buffer.concat(ctx))

  for (let i = 0; i < 1000; i++) {
    const round: Buffer[] = []
    round.push(i & 1 ? pw : final.subarray(0, 16))
    if (i % 3)
      round.push(saltBuf)
    if (i % 7)
      round.push(pw)
    round.push(i & 1 ? final.subarray(0, 16) : pw)
    final = md5(Buffer.concat(round))
  }

  // Custom base64 ("./0-9A-Za-z") with the apr1 byte interleaving.
  const itoa64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const to64 = (value: number, count: number): string => {
    let out = ''
    let v = value
    for (let i = 0; i < count; i++) {
      out += itoa64[v & 0x3F]
      v >>= 6
    }
    return out
  }
  const p = final
  let encoded = ''
  encoded += to64((p[0] << 16) | (p[6] << 8) | p[12], 4)
  encoded += to64((p[1] << 16) | (p[7] << 8) | p[13], 4)
  encoded += to64((p[2] << 16) | (p[8] << 8) | p[14], 4)
  encoded += to64((p[3] << 16) | (p[9] << 8) | p[15], 4)
  encoded += to64((p[4] << 16) | (p[10] << 8) | p[5], 4)
  encoded += to64(p[11], 2)
  return `$apr1$${salt}$${encoded}`
}

/** Verify a plaintext password against a single htpasswd hash field. */
function verifyHtpasswdHash(password: string, hash: string): boolean {
  // bcrypt ($2a/$2b/$2y) — htpasswd -B / modern default.
  if (/^\$2[aby]?\$/.test(hash)) {
    try {
      return Bun.password.verifySync(password, hash)
    }
    catch {
      return false
    }
  }
  // Apache apr1 MD5.
  if (hash.startsWith('$apr1$')) {
    const parts = hash.split('$') // ['', 'apr1', salt, digest]
    const salt = parts[2] ?? ''
    return safeEqual(apr1Crypt(password, salt), hash)
  }
  // SHA1: {SHA}base64(sha1(password)).
  if (hash.startsWith('{SHA}')) {
    const digest = createHash('sha1').update(password, 'utf8').digest('base64')
    return safeEqual(`{SHA}${digest}`, hash)
  }
  // Plaintext htpasswd entry (no recognizable prefix).
  return safeEqual(password, hash)
}

/** Parse an htpasswd file body into a `user → hash` map (last entry wins). */
export function parseHtpasswd(body: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#'))
      continue
    const idx = line.indexOf(':')
    if (idx <= 0)
      continue
    entries.set(line.slice(0, idx), line.slice(idx + 1))
  }
  return entries
}

/**
 * Resolve a {@link BasicAuthConfig} into an enforceable policy, or `undefined`
 * when no usable credentials are configured (treated as "no auth"). The htpasswd
 * file, when given, is read once here so request handling stays allocation-free.
 */
export function resolveAuth(cfg?: BasicAuthConfig): ResolvedAuth | undefined {
  if (!cfg)
    return undefined

  const realm = (cfg.realm ?? '').trim() || 'Restricted'
  const inline: Array<{ username: string, password: string }> = []
  if (cfg.username)
    inline.push({ username: cfg.username, password: cfg.password ?? '' })
  for (const user of cfg.users ?? []) {
    if (user?.username)
      inline.push({ username: user.username, password: user.password ?? '' })
  }

  let htpasswd: Map<string, string> | undefined
  if (cfg.htpasswdFile) {
    try {
      htpasswd = parseHtpasswd(readFileSync(cfg.htpasswdFile, 'utf8'))
    }
    catch {
      // Unreadable htpasswd file: fall back to inline creds only. A route that
      // ends up with no credentials at all is reported as unprotected below.
      htpasswd = undefined
    }
  }

  if (inline.length === 0 && (!htpasswd || htpasswd.size === 0))
    return undefined

  const verify = (username: string, password: string): boolean => {
    let ok = false
    // Check every inline credential without short-circuiting (constant work).
    for (const cred of inline) {
      if (safeEqual(username, cred.username) && safeEqual(password, cred.password))
        ok = true
    }
    if (htpasswd) {
      const hash = htpasswd.get(username)
      if (hash && verifyHtpasswdHash(password, hash))
        ok = true
    }
    return ok
  }

  return { realm, verify }
}

/**
 * Enforce a route's Basic auth policy against a request. Returns `undefined`
 * when the request is authorized (handling continues) or a `401` challenge
 * `Response` when it is not. ACME http-01 challenge requests are always allowed
 * so on-demand certificate issuance for a protected host still works.
 */
export function enforceBasicAuth(req: Request, pathname: string, auth: ResolvedAuth): Response | undefined {
  if (pathname.startsWith(ACME_CHALLENGE_PREFIX))
    return undefined

  const header = req.headers.get('authorization') ?? ''
  const sep = header.indexOf(' ')
  const scheme = sep === -1 ? header : header.slice(0, sep)
  const encoded = sep === -1 ? '' : header.slice(sep + 1).trim()

  if (scheme.toLowerCase() === 'basic' && encoded) {
    let decoded = ''
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8')
    }
    catch {
      decoded = ''
    }
    const idx = decoded.indexOf(':')
    if (idx >= 0 && auth.verify(decoded.slice(0, idx), decoded.slice(idx + 1)))
      return undefined
  }

  // Quote-escape the realm so a stray `"` can't break out of the header value.
  const realm = auth.realm.replace(/["\\]/g, '')
  return new Response('401 Unauthorized', {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`,
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}
