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
  it('uses the registrable base under a dev-only TLD, not the whole TLD', () => {
    // Nothing real resolves under .test, so one file serving the base and all
    // its subdomains costs nothing and shadows nobody.
    expect(resolverBasenameForDomain('api.postline.test')).toBe('postline.test')
    expect(resolverBasenameForDomain('postline.test')).toBe('postline.test')
  })

  /**
   * A real domain gets the exact hostname, never its apex.
   *
   * `/etc/resolver/<name>` captures that name and every subdomain of it, and a
   * captured name resolves only through rpx's DNS server - so when that server
   * is not answering, every captured name stops resolving on the machine.
   *
   * Collapsing `dashboard.stacksjs.com` to `stacksjs.com` therefore took the
   * apex and every sibling with it. A mail client pointed at a real, running
   * mail server at `mail.stacksjs.com` timed out, because the name no longer
   * resolved. `dig` and `host` kept working the whole time - they query DNS
   * directly and never consult /etc/resolver - which is what made it read as a
   * server problem.
   */
  it('uses the exact hostname under a public TLD, so siblings keep resolving', () => {
    expect(resolverBasenameForDomain('dashboard.stacksjs.com')).toBe('dashboard.stacksjs.com')
    expect(resolverBasenameForDomain('api.myapp.com')).toBe('api.myapp.com')
  })

  it('still allows a real apex when that is what was asked for', () => {
    expect(resolverBasenameForDomain('myapp.com')).toBe('myapp.com')
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

  /**
   * Under a public TLD each host is its own file. More files, but a sibling
   * rpx was never asked to serve is never captured - which is the whole point.
   */
  it('keeps real hosts separate rather than merging them onto the apex', () => {
    expect(resolverBasenamesForDomains([
      'dashboard.stacksjs.com',
      'docs.stacksjs.com',
    ])).toEqual(['dashboard.stacksjs.com', 'docs.stacksjs.com'])
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
