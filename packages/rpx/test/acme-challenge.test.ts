import { describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { readAcmeChallenge } from '../src/acme-challenge'

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
