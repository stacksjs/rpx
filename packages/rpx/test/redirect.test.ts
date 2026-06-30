import type { ProxyRoute } from '../src/proxy-handler'
import { describe, expect, it } from 'bun:test'
import { createProxyFetchHandler } from '../src/proxy-handler'
import { buildRedirectLocation, resolveRedirect } from '../src/redirect'

function req(url: string, headers: Record<string, string> = {}): Request {
  const u = new URL(url)
  return new Request(url, { headers: { host: u.host, ...headers } })
}

describe('resolveRedirect', () => {
  it('treats a bare string as a permanent, path-preserving redirect', () => {
    expect(resolveRedirect('https://example.com')).toEqual({
      to: 'https://example.com',
      status: 301,
      preservePath: true,
    })
  })

  it('defaults a scheme-less target to https and trims trailing slashes', () => {
    expect(resolveRedirect('example.com/')).toEqual({
      to: 'https://example.com',
      status: 301,
      preservePath: true,
    })
  })

  it('honors explicit status and preservePath', () => {
    expect(resolveRedirect({ to: 'https://example.com', status: 308, preservePath: false })).toEqual({
      to: 'https://example.com',
      status: 308,
      preservePath: false,
    })
  })

  it('keeps an explicit non-https scheme', () => {
    expect(resolveRedirect('http://example.com').to).toBe('http://example.com')
  })
})

describe('buildRedirectLocation', () => {
  const target = resolveRedirect('https://verygoodadblock.org')

  it('appends path + query for deep links', () => {
    expect(buildRedirectLocation(target, '/articles/x', '?ref=1')).toBe('https://verygoodadblock.org/articles/x?ref=1')
  })

  it('keeps a single trailing slash for the root path', () => {
    expect(buildRedirectLocation(target, '/', '')).toBe('https://verygoodadblock.org/')
  })

  it('preserves a path prefix on the target', () => {
    const prefixed = resolveRedirect('https://example.com/app')
    expect(buildRedirectLocation(prefixed, '/foo', '')).toBe('https://example.com/app/foo')
  })

  it('drops the request path when preservePath is false', () => {
    const bare = resolveRedirect({ to: 'https://example.com', preservePath: false })
    expect(buildRedirectLocation(bare, '/anything', '?x=1')).toBe('https://example.com')
  })
})

describe('createProxyFetchHandler redirect routes', () => {
  it('answers a redirect route with a Location and no upstream', async () => {
    const route: ProxyRoute = { redirect: resolveRedirect('https://verygoodadblock.org') }
    const handler = createProxyFetchHandler(() => route)

    const res = await handler(req('https://very-good-adblock.org/promo?utm=x'))
    expect(res?.status).toBe(301)
    expect(res?.headers.get('location')).toBe('https://verygoodadblock.org/promo?utm=x')
  })

  it('challenges a redirect route gated by basic auth before redirecting', async () => {
    const route: ProxyRoute = {
      redirect: resolveRedirect('https://verygoodadblock.org'),
      auth: { realm: 'rpx', verify: (u, p) => u === 'admin' && p === 'secret' },
    }
    const handler = createProxyFetchHandler(() => route)

    const res = await handler(req('https://very-good-adblock.org/'))
    expect(res?.status).toBe(401)
  })
})
