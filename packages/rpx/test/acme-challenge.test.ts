import { describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { readAcmeChallenge } from '../src/acme-challenge'
import { handleHttpRedirect } from '../src/daemon'

async function withWebroot(fn: (webroot: string) => Promise<void> | void): Promise<void> {
  const webroot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-acme-'))
  try {
    await fn(webroot)
  }
  finally {
    await fsp.rm(webroot, { recursive: true, force: true }).catch(() => {})
  }
}

describe('readAcmeChallenge', () => {
  it('returns the token contents (flat <webroot>/<token>) for a valid challenge request', async () => {
    await withWebroot(async (webroot) => {
      await fsp.writeFile(path.join(webroot, 'tok3n_AB-cd'), 'tok3n_AB-cd.keyauth')
      expect(readAcmeChallenge(webroot, '/.well-known/acme-challenge/tok3n_AB-cd')).toBe('tok3n_AB-cd.keyauth')
    })
  })

  it('returns null for non-challenge paths', () => {
    expect(readAcmeChallenge('/srv/acme', '/')).toBeNull()
    expect(readAcmeChallenge('/srv/acme', '/index.html')).toBeNull()
  })

  it('returns null when no webroot is configured', () => {
    expect(readAcmeChallenge('', '/.well-known/acme-challenge/tok')).toBeNull()
  })

  it('refuses path traversal and unsafe tokens', async () => {
    await withWebroot(async (webroot) => {
      await fsp.writeFile(path.join(webroot, 'secret'), 'top-secret')
      // A traversal attempt is rejected by the token charset guard, never read.
      expect(readAcmeChallenge(webroot, '/.well-known/acme-challenge/..%2fsecret')).toBeNull()
      expect(readAcmeChallenge(webroot, '/.well-known/acme-challenge/../../secret')).toBeNull()
      expect(readAcmeChallenge(webroot, '/.well-known/acme-challenge/')).toBeNull()
    })
  })

  it('returns null when the token file is absent', async () => {
    await withWebroot((webroot) => {
      expect(readAcmeChallenge(webroot, '/.well-known/acme-challenge/missing')).toBeNull()
    })
  })
})

describe('handleHttpRedirect webroot ACME serving', () => {
  const req = (url: string) => new Request(url, { headers: { host: new URL(url).host } })

  it('serves a webroot challenge token on :80 with NO on-demand manager (200, not 301)', async () => {
    await withWebroot(async (webroot) => {
      await fsp.writeFile(path.join(webroot, 'boxtok-1'), 'boxtok-1.keyauth')
      const res = handleHttpRedirect(req('http://dashboard.example.com/.well-known/acme-challenge/boxtok-1'), null, webroot)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('boxtok-1.keyauth')
    })
  })

  it('redirects a normal request to HTTPS (301)', () => {
    const res = handleHttpRedirect(req('http://dashboard.example.com/login'), null)
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://dashboard.example.com/login')
  })

  it('redirects a challenge request to HTTPS when neither store nor webroot has the token', () => {
    // No on-demand manager and no webroot configured: a challenge miss must not
    // 404 (that would break other ACME clients) — it falls through to the 301.
    const res = handleHttpRedirect(req('http://dashboard.example.com/.well-known/acme-challenge/absent'), null)
    expect(res.status).toBe(301)
  })
})
