import { createRootCA } from '@stacksjs/tlsx'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  normalizeSha256Fingerprint,
  parseSha256HashesFromSecurityListing,
  readCertCommonName,
  readCertSha256Fingerprint,
} from '../src/cert-inspect'

describe('cert-inspect', () => {
  describe('normalizeSha256Fingerprint', () => {
    it('strips openssl prefix and colons', () => {
      expect(normalizeSha256Fingerprint('sha256 Fingerprint=AB:CD:EF')).toBe('ABCDEF')
    })

    it('normalizes security listing lines', () => {
      expect(normalizeSha256Fingerprint('SHA-256 hash: ab12cd34')).toBe('AB12CD34')
    })
  })

  describe('reads a real cert via tlsx (no openssl)', () => {
    let certPath: string
    let dir: string
    let pem: string

    beforeAll(async () => {
      const ca = await createRootCA()
      pem = ca.certificate
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-certinspect-'))
      certPath = path.join(dir, 'ca.crt')
      fs.writeFileSync(certPath, pem)
    })
    afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

    it('reads the SHA-256 fingerprint matching crypto.X509Certificate', () => {
      const expected = normalizeSha256Fingerprint(new X509Certificate(pem).fingerprint256)
      expect(readCertSha256Fingerprint(certPath)).toBe(expected)
      expect(readCertSha256Fingerprint(certPath)).toMatch(/^[A-F0-9]{64}$/)
    })

    it('reads the common name', () => {
      expect(readCertCommonName(certPath)).toBe('Local Development Root CA')
    })

    it('returns null for a missing/garbage cert instead of throwing', () => {
      expect(readCertSha256Fingerprint(path.join(dir, 'nope.crt'))).toBeNull()
      expect(readCertCommonName(path.join(dir, 'nope.crt'))).toBeNull()
    })
  })

  describe('parseSha256HashesFromSecurityListing', () => {
    it('collects hashes from security -Z output', () => {
      const listing = `
SHA-256 hash: AABBCCDD00112233
label: rpx.localhost
SHA-256 hash: 44556677
`
      expect(parseSha256HashesFromSecurityListing(listing)).toEqual([
        'AABBCCDD00112233',
        '44556677',
      ])
    })
  })
})
