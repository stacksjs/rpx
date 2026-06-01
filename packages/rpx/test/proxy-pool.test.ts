import type { Server } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { FALLBACK, proxyViaPool } from '../src/proxy-pool'

let origin: Server
let hostPort: string
let totalConns = 0

beforeAll(() => {
  origin = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Track upstream socket churn so we can assert connection reuse.
    open() { totalConns++ },
    fetch(req) {
      const u = new URL(req.url)
      switch (u.pathname) {
        case '/small':
          return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
        case '/large':
          return new Response('x'.repeat(500_000), { headers: { 'content-type': 'text/plain' } })
        case '/chunked': {
          const enc = new TextEncoder()
          const stream = new ReadableStream({
            start(c) { c.enqueue(enc.encode('hello ')); c.enqueue(enc.encode('world')); c.close() },
          })
          return new Response(stream, { headers: { 'content-type': 'text/plain' } })
        }
        case '/head':
          return new Response('x'.repeat(1234), { headers: { 'x-foo': 'bar' } })
        case '/204':
          return new Response(null, { status: 204 })
        case '/echo':
          return new Response(req.body, { headers: { 'content-type': req.headers.get('content-type') || '' } })
        case '/dump-headers':
          return new Response(JSON.stringify(Object.fromEntries(req.headers)), { headers: { 'content-type': 'application/json' } })
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })
  hostPort = `127.0.0.1:${origin.port}`
})

afterAll(() => {
  origin.stop(true)
})

function call(method: string, path: string, opts: { body?: any, headers?: Record<string, string>, originOverride?: string } = {}) {
  const reqHeaders = new Headers()
  for (const [k, v] of Object.entries(opts.headers ?? {}))
    reqHeaders.set(k, v)
  return proxyViaPool({ hostPort, method, path, reqHeaders, forwardedHost: 'site.test', originOverride: opts.originOverride, body: opts.body ?? null })
}

describe('proxyViaPool', () => {
  it('forwards a small Content-Length response (fast path)', async () => {
    const res = await call('GET', '/small')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.text()).toBe('{"ok":true}')
  })

  it('streams a large Content-Length response intact', async () => {
    const res = await call('GET', '/large')
    expect((await res.text()).length).toBe(500_000)
  })

  it('decodes a chunked response and strips transfer-encoding', async () => {
    const res = await call('GET', '/chunked')
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(await res.text()).toBe('hello world')
  })

  it('returns no body for HEAD but keeps headers', async () => {
    const res = await call('HEAD', '/head')
    expect(res.headers.get('x-foo')).toBe('bar')
    expect(await res.text()).toBe('')
  })

  it('handles a 204 No Content', async () => {
    const res = await call('GET', '/204')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('forwards a request body with a declared Content-Length', async () => {
    const payload = JSON.stringify({ a: 1, b: 'two' })
    const res = await call('POST', '/echo', {
      body: new Response(payload).body,
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    })
    expect(await res.text()).toBe(payload)
  })

  it('forwards 404s from the upstream verbatim', async () => {
    const res = await call('GET', '/nope')
    expect(res.status).toBe(404)
  })

  it('applies host + x-forwarded-* overrides and strips client copies', async () => {
    const res = await call('GET', '/dump-headers', {
      headers: { 'x-forwarded-for': '9.9.9.9', 'x-forwarded-host': 'evil.test', 'x-custom': 'keep-me' },
    })
    const got = await res.json() as Record<string, string>
    expect(got.host).toBe(hostPort)
    expect(got['x-forwarded-for']).toBe('127.0.0.1') // override wins, not 9.9.9.9
    expect(got['x-forwarded-host']).toBe('site.test')
    expect(got['x-custom']).toBe('keep-me') // unrelated client headers pass through
  })

  it('reuses pooled connections across sequential requests', async () => {
    const before = totalConns
    for (let i = 0; i < 30; i++)
      await (await call('GET', '/small')).text()
    // 30 sequential requests should reuse a tiny number of connections, not open 30.
    expect(totalConns - before).toBeLessThan(5)
  })

  it('stays correct under a concurrent burst', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, async () => (await (await call('GET', '/small')).text()) === '{"ok":true}'),
    )
    expect(results.every(Boolean)).toBe(true)
  })

  it('declines Expect: 100-continue via FALLBACK', async () => {
    await expect(call('GET', '/small', { headers: { expect: '100-continue' } })).rejects.toBe(FALLBACK)
  })

  it('declines protocol upgrades via FALLBACK', async () => {
    await expect(call('GET', '/small', { headers: { upgrade: 'h2c' } })).rejects.toBe(FALLBACK)
  })

  it('declines an unbounded (no Content-Length) streaming upload via FALLBACK without locking the body', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close() } })
    await expect(call('POST', '/echo', { body })).rejects.toBe(FALLBACK)
    // The pool must not consume/lock the body, so the caller can fall back to fetch().
    expect(body.locked).toBe(false)
  })
})
