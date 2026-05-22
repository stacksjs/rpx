import { describe, expect, it } from 'bun:test'
import {
  normalizeSha256Fingerprint,
  parseSha256HashesFromSecurityListing,
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
