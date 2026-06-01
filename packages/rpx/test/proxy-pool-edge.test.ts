/**
 * Edge-case coverage for the pooled raw-socket transport, exercised against a
 * *raw TCP* origin so each test can craft byte-exact upstream responses —
 * chunked framing, interim 1xx, Connection: close, HTTP/1.0, split reads,
 * oversized headers, duplicate headers, leftover/pipelined bytes, mid-body
 * close, and upstream timeouts.
 */
import type { Socket } from 'bun'
import { afterEach, describe, expect, it } from 'bun:test'
import { proxyViaPool, TIMEOUT } from '../src/proxy-pool'

interface ConnState { buf: string, connIndex: number, onDrain: (() => void) | null }

interface RawOrigin {
  port: number
  hostPort: string
  /** Total connections accepted (asserts reuse vs fresh dials). */
  conns: () => number
  /** Total requests received. */
  reqs: () => number
  stop: () => void
}

/**
 * Write `data` to a raw-origin socket in full, awaiting `drain` under
 * backpressure — so large header/body payloads aren't silently truncated.
 */
function send(socket: Socket<ConnState>, data: string): Promise<void> {
  const bytes = Buffer.from(data, 'latin1')
  let off = socket.write(bytes)
  if (off >= bytes.length)
    return Promise.resolve()
  return (async () => {
    while (off < bytes.length) {
      await new Promise<void>((resolve) => { socket.data.onDrain = resolve })
      off += socket.write(bytes.subarray(off))
    }
  })()
}

/**
 * A raw TCP server. `onRequest` is called once per request head received (bodies
 * aren't expected in these tests) with the socket so the test can write exact
 * response bytes — including malformed/partial ones a real upstream might send.
 */
function startRawOrigin(onRequest: (socket: Socket<ConnState>, ctx: { reqIndex: number, connIndex: number }) => void): RawOrigin {
  let reqIndex = 0
  let connIndex = 0
  const server = Bun.listen<ConnState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) { socket.data = { buf: '', connIndex: connIndex++, onDrain: null } },
      drain(socket) { const d = socket.data.onDrain; socket.data.onDrain = null; d?.() },
      data(socket, chunk) {
        socket.data.buf += chunk.toString('latin1')
        let idx = socket.data.buf.indexOf('\r\n\r\n')
        while (idx !== -1) {
          socket.data.buf = socket.data.buf.slice(idx + 4)
          onRequest(socket, { reqIndex: reqIndex++, connIndex: socket.data.connIndex })
          idx = socket.data.buf.indexOf('\r\n\r\n')
        }
      },
    },
  })
  const port = server.port
  return {
    port,
    hostPort: `127.0.0.1:${port}`,
    conns: () => connIndex,
    reqs: () => reqIndex,
    stop: () => server.stop(true),
  }
}

const origins: RawOrigin[] = []
function origin(onRequest: Parameters<typeof startRawOrigin>[0]): RawOrigin {
  const o = startRawOrigin(onRequest)
  origins.push(o)
  return o
}
afterEach(() => {
  while (origins.length) origins.pop()!.stop()
})

function call(hostPort: string, method = 'GET', path = '/') {
  return proxyViaPool({ hostPort, method, path, reqHeaders: new Headers(), forwardedHost: 'site.test', body: null })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('pooled transport — response framing edge cases', () => {
  it('decodes chunked with chunk-extensions and trailers, stripping framing headers', async () => {
    const o = origin((s) => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n')
      s.write('5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: v\r\n\r\n')
    })
    const res = await call(o.hostPort)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello world')
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('content-type')).toBe('text/plain')
  })

  it('handles a response whose headers arrive split across multiple TCP segments', async () => {
    const o = origin(async (s) => {
      s.write('HTTP/1.1 200 OK\r\nCon')
      await sleep(15)
      s.write('tent-Length: 5\r\n')
      await sleep(15)
      s.write('\r\nhel')
      await sleep(15)
      s.write('lo')
    })
    const res = await call(o.hostPort)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })

  it('skips an interim 1xx (103 Early Hints) and returns the final response', async () => {
    const o = origin((s) => {
      s.write('HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n')
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
    })
    const res = await call(o.hostPort)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('skips multiple consecutive interim responses', async () => {
    const o = origin((s) => {
      s.write('HTTP/1.1 100 Continue\r\n\r\n')
      s.write('HTTP/1.1 103 Early Hints\r\n\r\n')
      s.write('HTTP/1.1 201 Created\r\nContent-Length: 4\r\n\r\ndone')
    })
    const res = await call(o.hostPort)
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('done')
  })

  it('treats 204 and 304 as bodyless regardless of any content-length', async () => {
    const o204 = origin(s => s.write('HTTP/1.1 204 No Content\r\n\r\n'))
    const r204 = await call(o204.hostPort)
    expect(r204.status).toBe(204)
    expect(await r204.text()).toBe('')

    const o304 = origin(s => s.write('HTTP/1.1 304 Not Modified\r\nETag: "abc"\r\n\r\n'))
    const r304 = await call(o304.hostPort)
    expect(r304.status).toBe(304)
    expect(r304.headers.get('etag')).toBe('"abc"')
    expect(await r304.text()).toBe('')
  })

  it('parses a status line with no reason phrase', async () => {
    const o = origin(s => s.write('HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n'))
    const res = await call(o.hostPort)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('handles an oversized header block (grows the read buffer)', async () => {
    const big = 'x'.repeat(64 * 1024)
    const o = origin(s => send(s, `HTTP/1.1 200 OK\r\nX-Big: ${big}\r\nContent-Length: 2\r\n\r\nhi`))
    const res = await call(o.hostPort)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-big')).toBe(big)
    expect(await res.text()).toBe('hi')
  })

  it('preserves duplicate Set-Cookie headers', async () => {
    const o = origin(s => s.write('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n'))
    const res = await call(o.hostPort)
    const cookies = res.headers.getSetCookie()
    expect(cookies).toContain('a=1')
    expect(cookies).toContain('b=2')
  })

  it('streams a large content-length body that arrives in many segments', async () => {
    const total = 200_000
    const o = origin(async (s) => {
      await send(s, `HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\n\r\n`)
      for (let sent = 0; sent < total; sent += 40_000) {
        await send(s, 'y'.repeat(Math.min(40_000, total - sent)))
        await sleep(3)
      }
    })
    const res = await call(o.hostPort)
    expect((await res.text()).length).toBe(total)
  })
})

describe('pooled transport — connection lifecycle', () => {
  it('reuses one connection across sequential requests', async () => {
    const o = origin(s => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'))
    for (let i = 0; i < 5; i++)
      await (await call(o.hostPort)).text()
    expect(o.conns()).toBe(1) // all five reused one socket
    expect(o.reqs()).toBe(5)
  })

  it('does NOT reuse a connection that sent Connection: close', async () => {
    const o = origin((s) => {
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nby')
      s.end()
    })
    await (await call(o.hostPort)).text()
    await sleep(20)
    await (await call(o.hostPort)).text()
    expect(o.conns()).toBe(2) // each request opened a fresh socket
  })

  it('does NOT reuse a connection with leftover/pipelined bytes after the body', async () => {
    // Body is 2 bytes but the upstream sent extra trailing bytes — the socket is
    // in an unknown state and must not be pooled.
    const o = origin(s => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhiLEFTOVER'))
    const r1 = await call(o.hostPort)
    expect(await r1.text()).toBe('hi')
    await sleep(20)
    await (await call(o.hostPort)).text()
    expect(o.conns()).toBe(2)
  })

  it('honors HTTP/1.0 keep-alive (reuse) vs default-close', async () => {
    const reuse = origin(s => s.write('HTTP/1.0 200 OK\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\nx'))
    await (await call(reuse.hostPort)).text()
    await sleep(10)
    await (await call(reuse.hostPort)).text()
    expect(reuse.conns()).toBe(1)

    const close = origin((s) => {
      s.write('HTTP/1.0 200 OK\r\nContent-Length: 1\r\n\r\nx') // HTTP/1.0 defaults to close
      s.end()
    })
    await (await call(close.hostPort)).text()
    await sleep(20)
    await (await call(close.hostPort)).text()
    expect(close.conns()).toBe(2)
  })

  it('recovers when the upstream drops a pooled keepalive connection between requests', async () => {
    let n = 0
    const o = origin((s) => {
      n++
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n')
      s.write(String(n % 10))
      if (n === 1) {
        // Pool it as reusable, then drop it from the server side a moment later.
        setTimeout(() => s.end(), 10)
      }
    })
    expect(await (await call(o.hostPort)).text()).toBe('1')
    await sleep(40) // let the upstream close the idle socket
    // Next request must still succeed (skip-dead or stale-retry on a fresh socket).
    expect(await (await call(o.hostPort)).text()).toBe('2')
  })
})

describe('pooled transport — failure modes', () => {
  it('errors the body stream when the upstream closes before Content-Length is met', async () => {
    const o = origin((s) => {
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort')
      setTimeout(() => s.end(), 10)
    })
    const res = await call(o.hostPort)
    expect(res.status).toBe(200) // headers were valid; truncation surfaces on the body
    await expect(res.text()).rejects.toBeDefined()
  })

  it('surfaces TIMEOUT when the upstream stalls past RPX_UPSTREAM_TIMEOUT', async () => {
    const prev = process.env.RPX_UPSTREAM_TIMEOUT
    process.env.RPX_UPSTREAM_TIMEOUT = '1'
    try {
      const o = origin(() => { /* accept the request but never respond */ })
      await expect(call(o.hostPort)).rejects.toBe(TIMEOUT)
    }
    finally {
      if (prev === undefined)
        delete process.env.RPX_UPSTREAM_TIMEOUT
      else
        process.env.RPX_UPSTREAM_TIMEOUT = prev
    }
  }, 10_000)
})
