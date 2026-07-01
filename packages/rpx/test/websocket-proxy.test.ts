import type { ServerWebSocket } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createSharedProxyServer } from '../src/start'

type Server = ReturnType<typeof Bun.serve>

/**
 * End-to-end WebSocket proxying (issue #26): dev-server HMR connects over
 * `ws`/`wss`, so rpx must accept the upgrade on its listener and pipe frames to
 * the upstream in both directions. These tests drive the exact handler the
 * single-proxy, multi-proxy, single-port, and daemon paths all share
 * (`createSharedProxyServer`), binding only ephemeral ports.
 */
describe('WebSocket proxying (issue #26)', () => {
  let upstream: Server

  beforeAll(() => {
    // An upstream WS server that greets on open and echoes every frame — stands
    // in for a dev server's HMR socket.
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined }))
          return undefined
        return new Response('expected websocket upgrade', { status: 426 })
      },
      websocket: {
        open(ws: ServerWebSocket) {
          ws.send('hello-from-upstream')
        },
        message(ws: ServerWebSocket, msg) {
          ws.send(`echo:${typeof msg === 'string' ? msg : '(binary)'}`)
        },
      },
    })
  })

  afterAll(() => {
    upstream.stop(true)
  })

  it('proxies a websocket upgrade and pipes frames bidirectionally', async () => {
    // Route keyed by `127.0.0.1` so the client's auto Host header matches without
    // any header trickery; the upstream is the echo server above.
    const routeEntries = [{ host: '127.0.0.1', route: { sourceHost: `127.0.0.1:${upstream.port}` } }]
    const proxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    expect(proxy).not.toBeNull()

    try {
      const messages: string[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${proxy!.port}/`)

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket proxy timed out')), 5000)
        ws.addEventListener('open', () => ws.send('ping'))
        ws.addEventListener('message', (ev: MessageEvent) => {
          messages.push(String(ev.data))
          // Expect the upstream greeting plus the echo of our ping.
          if (messages.length >= 2) {
            clearTimeout(timer)
            ws.close()
            resolve()
          }
        })
        ws.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new Error('websocket proxy errored'))
        })
      })

      // Upstream-initiated frame reached the client (upstream → client).
      expect(messages).toContain('hello-from-upstream')
      // Client frame was forwarded and the echo came back (client → upstream → client).
      expect(messages).toContain('echo:ping')
    }
    finally {
      proxy!.stop(true)
    }
  })

  it('caps the pre-open pending buffer and closes an over-limit client with 1009', async () => {
    // An upstream that stalls the WS handshake, so frames the client sends the
    // instant it connects pile up in the proxy's pre-open `pending` buffer
    // instead of being forwarded — the exact condition the cap must bound.
    const slowUpstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req, server) {
        await Bun.sleep(400)
        if (server.upgrade(req, { data: undefined }))
          return undefined
        return new Response('expected websocket upgrade', { status: 426 })
      },
      websocket: { message() {} },
    })

    const prev = process.env.RPX_MAX_WS_PENDING_BYTES
    process.env.RPX_MAX_WS_PENDING_BYTES = '2048' // tiny cap so a few frames trip it
    const routeEntries = [{ host: '127.0.0.1', route: { sourceHost: `127.0.0.1:${slowUpstream.port}` } }]
    const proxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })

    try {
      const closeCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('expected the proxy to close the over-limit client')), 5000)
        const ws = new WebSocket(`ws://127.0.0.1:${proxy!.port}/`)
        ws.addEventListener('open', () => {
          // > 2048 bytes of frames before the (400ms-delayed) upstream opens.
          const chunk = 'x'.repeat(1024)
          for (let i = 0; i < 8; i++)
            ws.send(chunk)
        })
        ws.addEventListener('close', (ev: CloseEvent) => {
          clearTimeout(timer)
          resolve(ev.code)
        })
      })
      // 1009 = "message too big" — the buffer-limit close code the cap emits.
      expect(closeCode).toBe(1009)
    }
    finally {
      proxy!.stop(true)
      slowUpstream.stop(true)
      if (prev === undefined)
        delete process.env.RPX_MAX_WS_PENDING_BYTES
      else process.env.RPX_MAX_WS_PENDING_BYTES = prev
    }
  })

  it('returns 404 for an upgrade to a host with no route (no crash)', async () => {
    const routeEntries = [{ host: 'known.localhost', route: { sourceHost: `127.0.0.1:${upstream.port}` } }]
    const proxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: null, originGuard: null, verbose: false })
    try {
      // A plain (non-upgrade) request to an unknown host should 404 from the
      // same listener rather than tearing anything down.
      const res = await fetch(`http://127.0.0.1:${proxy!.port}/`, { headers: { host: 'unknown.localhost' } })
      expect(res.status).toBe(404)
    }
    finally {
      proxy!.stop(true)
    }
  })
})
