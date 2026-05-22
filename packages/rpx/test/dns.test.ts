import { describe, expect, it } from 'bun:test'
import {
  devDomainsFromHosts,
  normalizeDevDomain,
  resolverBasenameForDomain,
  resolverBasenamesForDomains,
} from '../src/dns-state'
import { contentLooksLikeRpxResolver, DNS_PORT } from '../src/dns'

describe('normalizeDevDomain', () => {
  it('accepts normal dev hostnames', () => {
    expect(normalizeDevDomain('postline.test')).toBe('postline.test')
    expect(normalizeDevDomain('api.Postline.COM')).toBe('api.postline.com')
  })

  it('rejects localhost and IPs', () => {
    expect(normalizeDevDomain('postline.localhost')).toBeNull()
    expect(normalizeDevDomain('localhost')).toBeNull()
    expect(normalizeDevDomain('127.0.0.1')).toBeNull()
  })
})

describe('resolverBasenameForDomain', () => {
  it('uses registrable base, not whole TLD', () => {
    expect(resolverBasenameForDomain('api.postline.test')).toBe('postline.test')
    expect(resolverBasenameForDomain('postline.test')).toBe('postline.test')
    expect(resolverBasenameForDomain('api.myapp.com')).toBe('myapp.com')
  })

  it('does not create a resolver for localhost dev URLs', () => {
    expect(resolverBasenameForDomain('postline.localhost')).toBeNull()
  })
})

describe('resolverBasenamesForDomains', () => {
  it('deduplicates shared bases', () => {
    expect(resolverBasenamesForDomains([
      'postline.test',
      'api.postline.test',
      'cdn.postline.test',
    ])).toEqual(['postline.test'])
  })

  it('keeps distinct bases', () => {
    expect(resolverBasenamesForDomains(['foo.test', 'bar.test'])).toEqual(['bar.test', 'foo.test'])
  })
})

describe('devDomainsFromHosts', () => {
  it('filters localhost hosts', () => {
    expect(devDomainsFromHosts(['postline.test', 'postline.localhost'])).toEqual(['postline.test'])
  })
})

describe('contentLooksLikeRpxResolver', () => {
  it('detects rpx resolver file shape', () => {
    expect(contentLooksLikeRpxResolver(`nameserver 127.0.0.1\nport ${DNS_PORT}\n`)).toBe(true)
    expect(contentLooksLikeRpxResolver('nameserver 1.1.1.1\n')).toBe(false)
  })
})
