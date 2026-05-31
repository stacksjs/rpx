/**
 * The request handlers used by the shared :443 server. Both the in-process
 * multi-proxy mode in `start.ts` and the long-running daemon delegate to this
 * module so routing semantics stay in one place.
 *
 * Routes are looked up via a caller-supplied `getRoute(hostname)` callback.
 * The callback indirection lets each caller use whatever data structure makes
 * sense (a fixed Map at startup, or a hot-swappable registry view) without
 * coupling this module to either.
 *
 * Three transports are supported per route:
 *   - HTTP(S) proxying via `fetch()` to an upstream `host:port`.
 *   - WebSocket proxying via `server.upgrade()` + an upstream `WebSocket`.
 *   - Static file serving from a local directory (`route.static`).
 */
import type { ServerWebSocket } from 'bun'
import type { ResolvedStaticRoute } from './static-files'
import type { PathRewrite } from './types'
import { serveStaticFile } from './static-files'
import { debugLog, resolvePathRewrite } from './utils'

export interface ProxyRoute {
  /**
   * Upstream `host:port` to forward requests to (e.g. `localhost:5173`).
   * Optional when `static` is set.
   */
  sourceHost?: string
  /** Strip `.html` suffix and 301 to clean URLs. */
  cleanUrls?: boolean
  /** Set the `origin` header to the target. */
  changeOrigin?: boolean
  /** Per-route path rewrites (vite/nginx-style prefix routing). */
  pathRewrites?: PathRewrite[]
  /** When set, serve files from a local directory instead of proxying. */
  static?: ResolvedStaticRoute
}

export type GetRoute = (hostname: string) => ProxyRoute | undefined

export type ProxyFetchHandler = (req: Request, server?: ProxyServer) => Promise<Response | undefined>

/** Minimal shape of the Bun server needed for WebSocket upgrades. */
export interface ProxyServer {
  // Loose `any` so it structurally accepts Bun's `Server<WebSocketData>` for
  // any data generic (the daemon/start callers parameterize differently).
  upgrade: (req: Request, options?: { data?: any, headers?: any }) => boolean
}

/** Data attached to an upgraded client socket so the ws handler can dial upstream. */
interface WsData {
  targetUrl: string
  forwardHeaders: Record<string, string>
}

/** Per-socket state: the upstream client + a buffer for early client frames. */
interface WsState {
  upstream: WebSocket
  upstreamOpen: boolean
  pending: Array<string | ArrayBufferLike | Uint8Array>
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
])

function extractHostname(req: Request): string {
  const hostHeader = req.headers.get('host') || ''
  // Strip port (`stacks.localhost:443` → `stacks.localhost`).
  return hostHeader.split(':')[0]
}

/**
 * Resolve the upstream target (`host` + `path`) for a request against a route,
 * applying any matching path rewrite.
 */
function resolveTarget(req: Request, route: ProxyRoute, verbose?: boolean): { targetHost: string, targetPath: string, search: string } {
  const url = new URL(req.url)
  let targetHost = route.sourceHost ?? ''
  let targetPath = url.pathname

  const rewriteMatch = resolvePathRewrite(url.pathname, route.pathRewrites)
  if (rewriteMatch) {
    targetHost = rewriteMatch.targetHost
    targetPath = rewriteMatch.targetPath
    debugLog('request', `Path rewrite: ${url.pathname} → ${targetHost}${targetPath}`, verbose)
  }

  return { targetHost, targetPath, search: url.search }
}

/**
 * Build a Bun.serve-compatible `fetch` handler that routes requests based on
 * the `Host` header. Returns 404 when no route matches and 502 on upstream
 * failures. When a request is a WebSocket upgrade and `server` is supplied, it
 * is upgraded (returns `undefined` so Bun completes the handshake) and the
 * traffic is handled by the `websocket` handler from {@link createProxyWebSocketHandler}.
 */
export function createProxyFetchHandler(getRoute: GetRoute, verbose?: boolean): ProxyFetchHandler {
  return async (req: Request, server?: ProxyServer): Promise<Response | undefined> => {
    const url = new URL(req.url)
    const hostname = extractHostname(req)

    const route = getRoute(hostname)
    if (!route) {
      debugLog('request', `No route found for host: ${hostname}`, verbose)
      return new Response(`No proxy configured for ${hostname}`, { status: 404 })
    }

    // Static file serving short-circuits everything else.
    if (route.static)
      return serveStaticFile(url.pathname, route.static)

    // WebSocket upgrade: hand the socket to Bun and dial the upstream on open.
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!server || !route.sourceHost)
        return new Response('WebSocket upgrade not supported here', { status: 400 })

      const { targetHost, targetPath, search } = resolveTarget(req, route, verbose)
      const targetUrl = `ws://${targetHost}${targetPath}${search}`

      const forwardHeaders: Record<string, string> = {}
      for (const [k, v] of req.headers) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'host')
          forwardHeaders[k] = v
      }
      forwardHeaders.host = targetHost
      forwardHeaders['x-forwarded-for'] = '127.0.0.1'
      forwardHeaders['x-forwarded-proto'] = 'https'
      forwardHeaders['x-forwarded-host'] = hostname

      const data: WsData = { targetUrl, forwardHeaders }
      const ok = server.upgrade(req, { data })
      if (ok) {
        debugLog('ws', `upgraded ${hostname}${targetPath} → ${targetUrl}`, verbose)
        return undefined
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (!route.sourceHost)
      return new Response(`No upstream configured for ${hostname}`, { status: 502 })

    const { targetHost, targetPath, search } = resolveTarget(req, route, verbose)
    const targetUrl = `http://${targetHost}${targetPath}${search}`

    try {
      const headers = new Headers(req.headers)
      headers.set('host', targetHost)
      if (route.changeOrigin)
        headers.set('origin', `http://${route.sourceHost}`)
      headers.set('x-forwarded-for', '127.0.0.1')
      headers.set('x-forwarded-proto', 'https')
      headers.set('x-forwarded-host', hostname)

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
      })

      // Strip `.html` and 301 to the clean URL when enabled.
      if (route.cleanUrls && url.pathname.endsWith('.html')) {
        const cleanPath = url.pathname.replace(/\.html$/, '')
        return new Response(null, {
          status: 301,
          headers: { Location: cleanPath },
        })
      }

      const responseHeaders = new Headers(response.headers)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    }
    catch (err) {
      debugLog('request', `Proxy error for ${hostname}: ${err}`, verbose)
      return new Response(`Proxy Error: ${err}`, { status: 502 })
    }
  }
}

/**
 * Build the `websocket` handler block for Bun.serve. It opens an upstream
 * `WebSocket` per client socket, buffers client→upstream frames until the
 * upstream connection is open, and pipes messages, closes and errors in both
 * directions with a clean teardown.
 */
export function createProxyWebSocketHandler(verbose?: boolean) {
  const state = new WeakMap<ServerWebSocket<WsData>, WsState>()

  return {
    open(ws: ServerWebSocket<WsData>): void {
      const { targetUrl, forwardHeaders } = ws.data
      let upstream: WebSocket
      try {
        // Bun's WebSocket accepts a `headers` option (control-channel auth etc.).
        upstream = new WebSocket(targetUrl, { headers: forwardHeaders } as any)
      }
      catch (err) {
        debugLog('ws', `failed to open upstream ${targetUrl}: ${err}`, verbose)
        ws.close(1011, 'upstream connect failed')
        return
      }
      upstream.binaryType = 'arraybuffer'
      const st: WsState = { upstream, upstreamOpen: false, pending: [] }
      state.set(ws, st)

      upstream.addEventListener('open', () => {
        st.upstreamOpen = true
        for (const frame of st.pending)
          upstream.send(frame as any)
        st.pending = []
      })
      upstream.addEventListener('message', (ev: MessageEvent) => {
        // Forward both binary (ArrayBuffer) and text frames to the client.
        ws.send(ev.data as any)
      })
      upstream.addEventListener('close', (ev: CloseEvent) => {
        try { ws.close(ev.code || 1000, ev.reason || '') }
        catch { /* already closing */ }
      })
      upstream.addEventListener('error', () => {
        debugLog('ws', `upstream error for ${targetUrl}`, verbose)
        try { ws.close(1011, 'upstream error') }
        catch { /* already closing */ }
      })
    },

    message(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
      const st = state.get(ws)
      if (!st)
        return
      const frame = typeof message === 'string' ? message : new Uint8Array(message)
      if (st.upstreamOpen)
        st.upstream.send(frame as any)
      else
        st.pending.push(frame)
    },

    close(ws: ServerWebSocket<WsData>, code: number, reason: string): void {
      const st = state.get(ws)
      if (!st)
        return
      state.delete(ws)
      try { st.upstream.close(code || 1000, reason || '') }
      catch { /* already closed */ }
    },
  }
}
