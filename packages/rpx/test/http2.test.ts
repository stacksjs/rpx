/**
 * HTTP/2 on the shared TLS listener (`RPX_HTTP2=1`). Over HTTP/1.1 a browser
 * opens at most six sockets per origin, so a page's API calls, event stream,
 * prefetches and bundles queue behind each other; over h2 they share one
 * connection. These tests run real handshakes: h2 is negotiated over ALPN,
 * HTTP/1.1 stays available on the same port, and the things a proxy is most
 * likely to break across protocols (Host routing, streamed bodies, uploads,
 * repeated headers, hop-by-hop headers, WebSocket upgrades) still work.
 */
import type { ServerWebSocket } from 'bun'
import type { SniTlsEntry } from '../src/sni'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as http2 from 'node:http2'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { createSharedProxyServer } from '../src/start'

type Server = ReturnType<typeof Bun.serve>

const HOSTS = ['a.rpx-h2.test', 'b.rpx-h2.test']

/** The protocol the listener picks for a client offering `protocols` over ALPN. */
function negotiated(port: number, servername: string, protocols: string[]): Promise<string | false> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ALPNProtocols: protocols, rejectUnauthorized: false }, () => {
      resolve(socket.alpnProtocol ?? false)
      socket.end()
    })
    socket.on('error', reject)
  })
}

interface H2Answer { status: number, headers: http2.IncomingHttpHeaders, body: string }

/** One request over an HTTP/2 session (node:http2 is a real h2 client). */
function h2Request(session: http2.ClientHttp2Session, headers: http2.OutgoingHttpHeaders, body?: string): Promise<H2Answer> {
  return new Promise((resolve, reject) => {
    const stream = session.request(headers)
    let status = 0
    let responseHeaders: http2.IncomingHttpHeaders = {}
    const chunks: Buffer[] = []
    stream.on('response', (h) => {
      responseHeaders = h
      status = Number(h[':status'])
    })
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') }))
    stream.on('error', reject)
    stream.end(body)
  })
}

describe('HTTP/2 on the shared TLS listener (RPX_HTTP2)', () => {
  let dir: string
  let sni: SniTlsEntry[]
  let upstream: Server
  let proxy: Server
  let plainProxy: Server
  const original = process.env.RPX_HTTP2

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-h2-'))
    sni = await Promise.all(HOSTS.map(async (serverName) => {
      const keyPath = path.join(dir, `${serverName}.key`)
      const certPath = path.join(dir, `${serverName}.crt`)
      const res = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', `/CN=${serverName}`, '-addext', `subjectAltName=DNS:${serverName}`])
      if (res.exitCode !== 0)
        throw new Error(`openssl failed: ${res.stderr.toString()}`)
      return { serverName, cert: await fsp.readFile(certPath, 'utf8'), key: await fsp.readFile(keyPath, 'utf8') }
    }))

    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === '/ws')
          return server.upgrade(req, { data: undefined }) ? undefined : new Response('expected websocket upgrade', { status: 426 })
        if (url.pathname === '/events') {
          let sent = 0
          return new Response(new ReadableStream({
            async pull(controller) {
              if (sent++ >= 3) {
                controller.close()
                return
              }
              controller.enqueue(new TextEncoder().encode(`data: ${sent}\n\n`))
              await Bun.sleep(20)
            },
          }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
        }
        if (url.pathname === '/upload')
          return req.text().then(text => Response.json({ length: text.length }))
        if (url.pathname === '/cookies') {
          const headers = new Headers({ 'connection': 'keep-alive', 'keep-alive': 'timeout=5' })
          headers.append('set-cookie', 'a=1; Path=/')
          headers.append('set-cookie', 'b=2; Path=/')
          return new Response('cookies', { headers })
        }
        return Response.json({ host: req.headers.get('host'), forwardedHost: req.headers.get('x-forwarded-host'), method: req.method, path: url.pathname })
      },
      websocket: {
        message(ws: ServerWebSocket, msg) {
          ws.send(`echo:${typeof msg === 'string' ? msg : '(binary)'}`)
        },
      },
    })

    const routeEntries = HOSTS.map(host => ({ host, route: { sourceHost: `127.0.0.1:${upstream.port}` } }))
    process.env.RPX_HTTP2 = '1'
    proxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: sni, originGuard: null, verbose: false })!
    delete process.env.RPX_HTTP2
    plainProxy = createSharedProxyServer({ routeEntries, listenPort: 0, sslConfig: sni, originGuard: null, verbose: false })!
  })

  afterAll(async () => {
    if (original === undefined)
      delete process.env.RPX_HTTP2
    else
      process.env.RPX_HTTP2 = original
    proxy?.stop(true)
    plainProxy?.stop(true)
    upstream?.stop(true)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('negotiates h2 over ALPN per SNI name, and HTTP/1.1 for clients that only offer it', async () => {
    expect(proxy).not.toBeNull()
    for (const host of HOSTS)
      expect(await negotiated(proxy.port as number, host, ['h2', 'http/1.1'])).toBe('h2')
    expect(await negotiated(proxy.port as number, HOSTS[0], ['http/1.1'])).toBe('http/1.1')
  })

  it('stays HTTP/1.1 only without RPX_HTTP2', async () => {
    expect(await negotiated(plainProxy.port as number, HOSTS[0], ['h2', 'http/1.1'])).not.toBe('h2')
  })

  it('routes by :authority and carries streams, uploads and repeated headers over one h2 connection', async () => {
    const session = http2.connect(`https://${HOSTS[0]}:${proxy.port}`, {
      createConnection: () => tls.connect({ host: '127.0.0.1', port: proxy.port as number, servername: HOSTS[0], ALPNProtocols: ['h2'], rejectUnauthorized: false }),
    })
    try {
      const [a, b, events, upload, cookies] = await Promise.all([
        h2Request(session, { ':path': '/hello', ':method': 'GET', ':authority': HOSTS[0] }),
        h2Request(session, { ':path': '/other', ':method': 'GET', ':authority': HOSTS[1] }),
        h2Request(session, { ':path': '/events', ':method': 'GET', ':authority': HOSTS[0] }),
        h2Request(session, { ':path': '/upload', ':method': 'POST', ':authority': HOSTS[0], 'content-type': 'text/plain' }, 'x'.repeat(300_000)),
        h2Request(session, { ':path': '/cookies', ':method': 'GET', ':authority': HOSTS[0] }),
      ])

      expect(a.status).toBe(200)
      expect(JSON.parse(a.body)).toMatchObject({ forwardedHost: HOSTS[0], method: 'GET', path: '/hello' })
      // A second name on the same connection (connection coalescing) still routes by its own authority.
      expect(JSON.parse(b.body)).toMatchObject({ forwardedHost: HOSTS[1], path: '/other' })

      expect(events.status).toBe(200)
      expect(events.headers['content-type']).toContain('text/event-stream')
      expect(events.body).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n')

      expect(JSON.parse(upload.body)).toEqual({ length: 300_000 })

      expect(cookies.body).toBe('cookies')
      expect(cookies.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
      // HTTP/2 forbids connection-specific headers; the proxy must not pass them on.
      expect(cookies.headers.connection).toBeUndefined()
      expect(cookies.headers['keep-alive']).toBeUndefined()
    }
    finally {
      session.close()
    }
  })

  it('keeps HTTP/1.1 requests and WebSocket upgrades working on the same port', async () => {
    const res = await fetch(`https://127.0.0.1:${proxy.port}/plain`, { headers: { host: HOSTS[0] }, tls: { rejectUnauthorized: false } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ forwardedHost: HOSTS[0], path: '/plain' })

    const ws = new WebSocket(`wss://127.0.0.1:${proxy.port}/ws`, { headers: { host: HOSTS[0] }, tls: { rejectUnauthorized: false } } as unknown as string[])
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket over the h2 listener timed out')), 5000)
      ws.addEventListener('open', () => ws.send('ping'))
      ws.addEventListener('message', (ev: MessageEvent) => {
        clearTimeout(timer)
        resolve(String(ev.data))
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('websocket error'))
      })
    })
    ws.close()
    expect(reply).toBe('echo:ping')
  })
})
