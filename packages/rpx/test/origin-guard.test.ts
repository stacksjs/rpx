import { describe, expect, it } from 'bun:test'
import { createOriginGuard } from '../src/origin-guard'

const SECRET = 's3cr3t-value'
const opts = {
  header: 'x-origin-verify',
  value: SECRET,
  hosts: ['stacksjs.com', 'www.stacksjs.com', 'origin.stacksjs.com', '*.apps.example.com'],
}

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe('createOriginGuard', () => {
  it('lets protected hosts through when the secret matches (Host header)', () => {
    const guard = createOriginGuard(opts)
    const r = guard(req('https://origin.stacksjs.com/docs', { host: 'stacksjs.com', 'x-origin-verify': SECRET }))
    expect(r).toBeUndefined()
  })

  it('rejects protected hosts when the secret is missing', () => {
    const guard = createOriginGuard(opts)
    const r = guard(req('https://origin.stacksjs.com/docs', { host: 'origin.stacksjs.com' }))
    expect(r?.status).toBe(403)
  })

  it('rejects protected hosts when the secret is wrong', () => {
    const guard = createOriginGuard(opts)
    const r = guard(req('https://stacksjs.com/', { host: 'stacksjs.com', 'x-origin-verify': 'nope' }))
    expect(r?.status).toBe(403)
  })

  it('lets unprotected hosts through untouched (no secret required)', () => {
    const guard = createOriginGuard(opts)
    expect(guard(req('https://registry.pantry.dev/', { host: 'registry.pantry.dev' }))).toBeUndefined()
    expect(guard(req('https://localtunnel.dev/', { host: 'localtunnel.dev' }))).toBeUndefined()
  })

  it('matches wildcard protected hosts', () => {
    const guard = createOriginGuard(opts)
    expect(guard(req('https://a.apps.example.com/', { host: 'a.apps.example.com' }))?.status).toBe(403)
    expect(guard(req('https://a.apps.example.com/', { host: 'a.apps.example.com', 'x-origin-verify': SECRET }))).toBeUndefined()
    // bare apex of the wildcard is not protected
    expect(guard(req('https://apps.example.com/', { host: 'apps.example.com' }))).toBeUndefined()
  })

  it('exempts ACME challenge paths so cert renewal is never blocked', () => {
    const guard = createOriginGuard(opts)
    const r = guard(req('http://origin.stacksjs.com/.well-known/acme-challenge/tok', { host: 'origin.stacksjs.com' }))
    expect(r).toBeUndefined()
  })

  it('is case-insensitive on host and header name', () => {
    const guard = createOriginGuard(opts)
    expect(guard(req('https://STACKSJS.com/', { host: 'StacksJS.com', 'X-Origin-Verify': SECRET }))).toBeUndefined()
  })

  it('falls back to the URL hostname when there is no Host header', () => {
    const guard = createOriginGuard(opts)
    expect(guard(req('https://origin.stacksjs.com/'))?.status).toBe(403)
  })

  it('exposes protects() for callers that want to branch on coverage', () => {
    const guard = createOriginGuard(opts)
    expect(guard.protects('stacksjs.com')).toBe(true)
    expect(guard.protects('a.apps.example.com')).toBe(true)
    expect(guard.protects('registry.pantry.dev')).toBe(false)
  })

  it('treats a trailing-dot (FQDN) host as the protected host — no bypass', () => {
    const guard = createOriginGuard(opts)
    // `Host: stacksjs.com.` is the FQDN form of `stacksjs.com`; it must NOT slip
    // the guard. Without the secret it is rejected just like the dotless form.
    expect(guard(req('https://stacksjs.com/', { host: 'stacksjs.com.' }))?.status).toBe(403)
    expect(guard(req('https://stacksjs.com/', { host: 'stacksjs.com.', 'x-origin-verify': SECRET }))).toBeUndefined()
    expect(guard.protects('stacksjs.com.')).toBe(true)
    // wildcard form too
    expect(guard(req('https://a.apps.example.com/', { host: 'a.apps.example.com.' }))?.status).toBe(403)
  })

  it('rejects a wrong secret of the same length (constant-time compare path)', () => {
    const guard = createOriginGuard(opts)
    const sameLen = 'x'.repeat(SECRET.length)
    expect(sameLen.length).toBe(SECRET.length)
    expect(guard(req('https://stacksjs.com/', { host: 'stacksjs.com', 'x-origin-verify': sameLen }))?.status).toBe(403)
  })
})
