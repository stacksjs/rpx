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
