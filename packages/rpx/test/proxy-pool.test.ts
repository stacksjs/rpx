import type { Socket, TCPSocketListener } from 'bun'
import { connect } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { FALLBACK, POOL_BUSY, proxyViaPool } from '../src/proxy-pool'

let origin: ReturnType<typeof Bun.serve>
/** Counting TCP passthrough sitting in front of `origin`. */
let front: TCPSocketListener<FrontData>
let hostPort: string
let totalConns = 0

/**
 * Per-front-connection relay state. Each direction has its own out-queue so the
 * passthrough honors socket backpressure (Bun's `write` can be partial); the
 * `drain` handlers resume flushing. Without this, a large response (500 KB) is
 * silently truncated and the proxied request hangs.
 */
interface FrontData { upstream: Socket | null, toClient: Uint8Array[], toUpstream: Uint8Array[] }

/** Write as much of `queue` as the socket accepts, re-queuing any partial remainder. */
function flush<D>(sock: Socket<D>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0]
    const n = sock.write(chunk)
    if (n < chunk.length) {
      queue[0] = chunk.subarray(n) // socket buffer full; `drain` resumes the rest
      return
    }
    queue.shift()
  }
}

beforeAll(() => {
  origin = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      switch (u.pathname) {
        case '/small':
          return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
        case '/large':
          return new Response('x'.repeat(500_000), { headers: { 'content-type': 'text/plain' } })
        case '/huge': // exceeds the 2 MB backpressure high-water mark
          return new Response('y'.repeat(5_000_000), { headers: { 'content-type': 'text/plain' } })
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

  // Bun.serve exposes no per-connection hook for HTTP, so count upstream TCP
  // connections at the socket layer: a tiny passthrough increments `totalConns`
  // on each new inbound connection and pipes bytes to the real origin. The pool
  // dials this front, so the counter measures exactly how many upstream
  // connections the pool opened — letting the reuse test assert real pooling.
  front = Bun.listen<FrontData>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        totalConns++
        client.data = { upstream: null, toClient: [], toUpstream: [] }
        // Close over `client` so the upstream socket's data type stays plain —
        // no mutual generic between the two sockets.
        connect({
          hostname: '127.0.0.1',
          port: origin.port!, // always a TCP port in this test
          socket: {
            open(up) {
              client.data.upstream = up
              flush(up, client.data.toUpstream)
            },
            data: (_up, chunk) => {
              client.data.toClient.push(new Uint8Array(chunk)) // copy: Bun reuses the read buffer
              flush(client, client.data.toClient)
            },
            drain: (up) => { flush(up, client.data.toUpstream) },
            close: () => { client.end() },
            error: () => { client.end() },
          },
          // Under a concurrent burst, dialing the origin can transiently fail.
          // Catch the rejected connect() promise (the socket `error` handler only
          // covers a connection that opened): an unhandled rejection here would be
          // attributed by the test runner to whatever test is mid-flight.
        }).catch(() => { client.end() })
      },
      data(client, chunk) {
        client.data.toUpstream.push(new Uint8Array(chunk)) // copy: Bun reuses the read buffer
        if (client.data.upstream)
          flush(client.data.upstream, client.data.toUpstream)
      },
      drain(client) { flush(client, client.data.toClient) },
      close(client) { client.data.upstream?.end() },
      error(client) { client.data.upstream?.end() },
    },
  })
  hostPort = `127.0.0.1:${front.port}`
})

afterAll(() => {
  front.stop(true)
  origin.stop(true)
})

function call(method: string, path: string, opts: { body?: ReadableStream<Uint8Array> | null, headers?: Record<string, string>, originOverride?: string, maxPerHost?: number } = {}) {
  const reqHeaders = new Headers()
  for (const [k, v] of Object.entries(opts.headers ?? {}))
    reqHeaders.set(k, v)
  return proxyViaPool({ hostPort, method, path, reqHeaders, forwardedHost: 'site.test', originOverride: opts.originOverride, body: opts.body ?? null, maxPerHost: opts.maxPerHost })
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

  it('rewrites the origin header when originOverride is set (changeOrigin) and drops the client copy', async () => {
    const res = await call('GET', '/dump-headers', {
      headers: { origin: 'https://client.example' },
      originOverride: 'http://127.0.0.1:5173',
    })
    const got = await res.json() as Record<string, string>
    // changeOrigin: the upstream sees the target origin, never the client's.
    expect(got.origin).toBe('http://127.0.0.1:5173')
    // Host is always rewritten to the upstream regardless of changeOrigin.
    expect(got.host).toBe(hostPort)
  })

  it('leaves the client origin untouched when originOverride is unset (changeOrigin off)', async () => {
    const res = await call('GET', '/dump-headers', {
      headers: { origin: 'https://client.example' },
    })
    const got = await res.json() as Record<string, string>
    expect(got.origin).toBe('https://client.example')
  })

  it('reuses pooled connections across sequential requests', async () => {
    const before = totalConns
    for (let i = 0; i < 30; i++)
      await (await call('GET', '/small')).text()
    // 30 sequential requests should reuse a tiny number of connections, not open 30.
    expect(totalConns - before).toBeLessThan(5)
  })

  it('stays correct under a concurrent burst', async () => {
    // Bound the pool (maxPerHost) so 200 simultaneous requests reuse/queue across
    // a fixed set of connections — the way a real proxy bounds per-upstream
    // connections — rather than firing 200 instantaneous dials that overrun the
    // single test listener's accept backlog. This keeps the test about
    // correctness under concurrency, not the OS's ability to absorb a stampede.
    //
    // Use allSettled (not Promise.all): with Promise.all, the first rejection
    // resolves the test while the other 199 promises are still in flight, so a
    // late rejection surfaces as an unhandled rejection attributed to whatever
    // test runs next. allSettled waits for every request to settle, keeping any
    // failure contained to this test.
    const settled = await Promise.allSettled(
      Array.from({ length: 200 }, async () => (await (await call('GET', '/small', { maxPerHost: 32 })).text())),
    )
    const bad = settled.filter(r => r.status === 'rejected' || r.value !== '{"ok":true}')
    if (bad.length) {
      const reasons = [...new Set(bad.map(r => r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : `body=${r.value}`))]
      throw new Error(`${bad.length}/200 burst requests failed: ${reasons.join(', ')}`)
    }
    expect(bad.length).toBe(0)
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

  it('rejects with POOL_BUSY when an upstream is saturated and the queue wait elapses', async () => {
    // The exact production failure mode: a stalled upstream holds the only slot,
    // so a second request can't acquire one. It must fail fast (→ 503) rather
    // than parking forever (which made the listener look wedged).
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() { await gate; return new Response('ok') } })
    const hp = `127.0.0.1:${slow.port}`
    const prev = process.env.RPX_QUEUE_WAIT_MS
    process.env.RPX_QUEUE_WAIT_MS = '50'
    try {
      // maxPerHost:1 → the first request occupies the only slot and blocks on the gate.
      const first = proxyViaPool({ hostPort: hp, method: 'GET', path: '/', reqHeaders: new Headers(), forwardedHost: 'x', body: null, maxPerHost: 1 })
      await new Promise(r => setTimeout(r, 20)) // let the dial + checkout settle
      let busy: unknown
      try {
        await proxyViaPool({ hostPort: hp, method: 'GET', path: '/', reqHeaders: new Headers(), forwardedHost: 'x', body: null, maxPerHost: 1 })
      }
      catch (e) { busy = e }
      expect(busy).toBe(POOL_BUSY)
      release()
      expect((await first).status).toBe(200)
    }
    finally {
      if (prev === undefined)
        delete process.env.RPX_QUEUE_WAIT_MS
      else process.env.RPX_QUEUE_WAIT_MS = prev
      slow.stop(true)
    }
  })

  it('rejects an upstream whose header block never terminates instead of buffering unbounded', async () => {
    // Raw TCP upstream that streams headers forever without the terminating
    // CRLFCRLF — without a cap this grows the read buffer until OOM.
    let written = 0
    const target = 400 * 1024 // > MAX_HEADER_BYTES (256 KB)
    const chunk = Buffer.from(`x-pad: ${'A'.repeat(4096)}\r\n`)
    const pump = (sock: Socket<undefined>): void => {
      try {
        while (written < target) {
          const n = sock.write(chunk)
          if (n <= 0)
            return // closed, or backpressure with nothing written
          written += n
          if (n < chunk.length)
            return // partial write — resume on drain
        }
      }
      catch { /* socket closed by the proxy after it gave up */ }
    }
    const server = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {},
        data(sock) { sock.write('HTTP/1.1 200 OK\r\n'); pump(sock) },
        drain(sock) { pump(sock) },
      },
    })
    const hp = `127.0.0.1:${server.port}`
    try {
      let err: unknown
      try {
        await proxyViaPool({ hostPort: hp, method: 'GET', path: '/', reqHeaders: new Headers(), forwardedHost: 'x', body: null, maxPerHost: 1 })
      }
      catch (e) { err = e }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('header block too large')
    }
    finally {
      server.stop(true)
    }
  })

  it('delivers a body larger than the backpressure high-water mark intact', async () => {
    // 5 MB > BODY_HWM (2 MB): the pool must pause/resume the upstream socket and
    // still hand back every byte in order — backpressure must not truncate.
    const res = await call('GET', '/huge')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.length).toBe(5_000_000)
    expect(body[0]).toBe('y')
    expect(body[body.length - 1]).toBe('y')
  })

  it('reuses the connection (no leak) after a paused/large transfer completes', async () => {
    // After a >HWM transfer that triggered pause(), the released socket must be
    // un-paused so the next request on it still gets a response.
    await (await call('GET', '/huge')).text()
    const res = await call('GET', '/small')
    expect(await res.text()).toBe('{"ok":true}')
  })

  it('refuses a response with a malformed Content-Length instead of mis-framing', async () => {
    const server = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {},
        data(sock) { sock.write('HTTP/1.1 200 OK\r\nContent-Length: 12abc\r\n\r\nhello') },
      },
    })
    const hp = `127.0.0.1:${server.port}`
    try {
      let err: unknown
      try {
        await proxyViaPool({ hostPort: hp, method: 'GET', path: '/', reqHeaders: new Headers(), forwardedHost: 'x', body: null, maxPerHost: 1 })
      }
      catch (e) { err = e }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('malformed response framing')
    }
    finally {
      server.stop(true)
    }
  })

  it('errors the body stream on a malformed chunk size instead of spinning', async () => {
    const server = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {},
        // valid head, then a non-hex chunk size
        data(sock) { sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\nhello') },
      },
    })
    const hp = `127.0.0.1:${server.port}`
    try {
      const res = await proxyViaPool({ hostPort: hp, method: 'GET', path: '/', reqHeaders: new Headers(), forwardedHost: 'x', body: null, maxPerHost: 1 })
      // headers parse fine (200); the error surfaces while reading the body
      let err: unknown
      try { await res.text() }
      catch (e) { err = e }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('malformed chunk size')
    }
    finally {
      server.stop(true)
    }
  })
})
