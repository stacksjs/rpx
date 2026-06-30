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
import type { ResolvedAuth } from './auth'
import type { ResolvedStaticRoute } from './static-files'
import type { PathRewrite } from './types'
import { enforceBasicAuth } from './auth'
import { FALLBACK, POOL_BUSY, proxyViaPool, TIMEOUT } from './proxy-pool'
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
  /**
   * Path prefix this route is mounted under (e.g. `/docs`). Used together with
   * {@link stripBasePathPrefix} to map request paths to the target. `/` (the
   * host default) is a no-op.
   */
  basePath?: string
  /**
   * Whether to strip {@link basePath} from the request pathname before
   * resolving the target.
   *
   * - Static routes default to `true`: a directory mounted at `/docs` serves
   *   its own `index.html` for `/docs` and `<root>/guide` for `/docs/guide`.
   * - Proxy routes default to `false`: most apps own their namespace (an app
   *   mounted at `/api` expects to still see `/api/...`), matching rpx's
   *   `PathRewrite.stripPrefix` default and nginx `proxy_pass` (no trailing
   *   slash) behavior.
   *
   * When unset, the per-transport default above applies.
   */
  stripBasePathPrefix?: boolean
  /**
   * Optional HTTP Basic auth gate. When set, requests to this route must carry
   * valid credentials or receive a `401` challenge — enforced before static,
   * WebSocket, or proxy handling so every transport is protected.
   */
  auth?: ResolvedAuth
}

/**
 * Resolve a route for an incoming request. `pathname` enables path-based
 * routing within a host (e.g. `/api/*` → app, `/docs*` → static dir). Callers
 * that only route by host can ignore the second argument — it's optional so
 * existing host-only `getRoute` callbacks remain valid.
 */
export type GetRoute = (hostname: string, pathname: string) => ProxyRoute | undefined

/**
 * Outcome of the no-route fallback ({@link OnNoRoute}):
 *   - a `Response` — serve it as-is (e.g. a "starting…" splash);
 *   - `{ retry: true }` — a route was just published, so re-resolve and proxy;
 *   - `undefined` — no fallback applies, fall through to 404.
 */
export type NoRouteOutcome = Response | { retry: true } | undefined

/**
 * Called when `getRoute` finds nothing for a request. Lets the daemon lazily
 * boot an on-demand site (see {@link import('./site-supervisor').SiteSupervisor})
 * and either hold the request behind a splash or signal that the route is now live.
 */
export type OnNoRoute = (hostname: string, pathname: string, req: Request) => Promise<NoRouteOutcome>

export type ProxyFetchHandler = (req: Request, server?: ProxyServer) => Promise<Response | undefined>

/** Minimal shape of the Bun server needed for WebSocket upgrades. */
export interface ProxyServer {
  // `unknown` data + standard HeadersInit so it structurally accepts Bun's
  // `Server<WebSocketData>` for any data generic (the daemon/start callers
  // parameterize differently) without resorting to `any`.
  upgrade: (req: Request, options?: { data?: unknown, headers?: Bun.HeadersInit }) => boolean
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
  // Strip port (`stacks.localhost:443` → `stacks.localhost`) without allocating
  // an array (`split`) on every request.
  const colon = hostHeader.indexOf(':')
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon)
}

/**
 * Strip the route's mount prefix (`basePath`) from a request pathname so a
 * target mounted under `/docs` sees `/` for `/docs` and `/guide` for
 * `/docs/guide`. A `/` (or empty) base strips nothing. The result always keeps
 * a leading `/`.
 */
export function stripBasePath(pathname: string, basePath?: string): string {
  if (!basePath || basePath === '/')
    return pathname
  if (pathname === basePath)
    return '/'
  if (pathname.startsWith(`${basePath}/`)) {
    const rest = pathname.slice(basePath.length)
    return rest === '' ? '/' : rest
  }
  return pathname
}

/**
 * Resolve the upstream target (`host` + `path`) for a request against a route,
 * applying any matching path rewrite. Takes the already-extracted `pathname` so
 * the hot path never re-parses the request URL.
 */
function resolveTarget(pathname: string, route: ProxyRoute, verbose?: boolean): { targetHost: string, targetPath: string } {
  let targetHost = route.sourceHost ?? ''
  // Proxy backends preserve their mount prefix by default (most apps own their
  // `/api` namespace), opting in to stripping via `stripBasePathPrefix`.
  // Explicit `pathRewrites` still apply on top of this.
  const stripBase = route.stripBasePathPrefix ?? false
  let targetPath = stripBase ? stripBasePath(pathname, route.basePath) : pathname

  const rewriteMatch = resolvePathRewrite(targetPath, route.pathRewrites)
  if (rewriteMatch) {
    targetHost = rewriteMatch.targetHost
    targetPath = rewriteMatch.targetPath
    debugLog('request', `Path rewrite: ${pathname} → ${targetHost}${targetPath}`, verbose)
  }

  return { targetHost, targetPath }
}

/**
 * Extract the origin-form path and query from a request URL without the cost of
 * constructing a `URL`. `req.url` is always absolute-form here
 * (`http://host/path?q`), so we slice from the first `/` after the authority.
 * The raw (un-decoded) path is forwarded verbatim, which is what a proxy wants.
 */
function splitPathQuery(rawUrl: string): { pathname: string, search: string } {
  const schemeEnd = rawUrl.indexOf('://')
  const pathStart = schemeEnd === -1 ? rawUrl.indexOf('/') : rawUrl.indexOf('/', schemeEnd + 3)
  if (pathStart === -1)
    return { pathname: '/', search: '' }
  const q = rawUrl.indexOf('?', pathStart)
  if (q === -1)
    return { pathname: rawUrl.slice(pathStart), search: '' }
  return { pathname: rawUrl.slice(pathStart, q), search: rawUrl.slice(q) }
}

/**
 * Build a Bun.serve-compatible `fetch` handler that routes requests based on
 * the `Host` header. Returns 404 when no route matches and 502 on upstream
 * failures. When a request is a WebSocket upgrade and `server` is supplied, it
 * is upgraded (returns `undefined` so Bun completes the handshake) and the
 * traffic is handled by the `websocket` handler from {@link createProxyWebSocketHandler}.
 */
export function createProxyFetchHandler(getRoute: GetRoute, verbose?: boolean, onNoRoute?: OnNoRoute): ProxyFetchHandler {
  const inner = async (req: Request, server?: ProxyServer): Promise<Response | undefined> => {
    const { pathname, search } = splitPathQuery(req.url)
    const hostname = extractHostname(req)

    let route = getRoute(hostname, pathname)
    if (!route && onNoRoute) {
      // No live route — give the daemon a chance to boot an on-demand site. It
      // either serves a splash/error page directly, or signals `retry` once the
      // freshly-published route is in the table so we proxy this same request.
      const outcome = await onNoRoute(hostname, pathname, req)
      if (outcome instanceof Response)
        return outcome
      if (outcome && outcome.retry)
        route = getRoute(hostname, pathname)
    }
    if (!route) {
      debugLog('request', `No route found for host: ${hostname}`, verbose)
      return new Response(`No proxy configured for ${hostname}`, { status: 404 })
    }

    // HTTP Basic auth gate — enforced before any transport so static, WebSocket,
    // and proxied responses are all protected. ACME challenges are exempt.
    if (route.auth) {
      const challenge = enforceBasicAuth(req, pathname, route.auth)
      if (challenge) {
        debugLog('request', `401 challenge for ${hostname}${pathname}`, verbose)
        return challenge
      }
    }

    // Static file serving short-circuits everything else. Strip the route's
    // mount prefix (default for static) so a dir mounted at `/docs` serves its
    // own root for `/docs`.
    if (route.static) {
      const strip = route.stripBasePathPrefix ?? true
      const staticPath = strip ? stripBasePath(pathname, route.basePath) : pathname
      return serveStaticFile(staticPath, route.static)
    }

    // WebSocket upgrade: hand the socket to Bun and dial the upstream on open.
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!server || !route.sourceHost)
        return new Response('WebSocket upgrade not supported here', { status: 400 })

      const { targetHost, targetPath } = resolveTarget(pathname, route, verbose)
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

    // Strip `.html` and 301 to the clean URL when enabled — before any upstream
    // work, since the redirect doesn't depend on the origin response.
    if (route.cleanUrls && pathname.endsWith('.html')) {
      const cleanPath = pathname.replace(/\.html$/, '')
      return new Response(null, {
        status: 301,
        headers: { Location: cleanPath },
      })
    }

    const { targetHost, targetPath } = resolveTarget(pathname, route, verbose)
    const originOverride = route.changeOrigin ? `http://${route.sourceHost}` : undefined

    // Forward through the pooled raw-socket transport: a reused keepalive pool
    // per upstream (like nginx's `keepalive`) that stays flat under load, where
    // fetch()'s connection churn exhausts ephemeral ports and collapses (~15x).
    // Forwarded headers (host, x-forwarded-*, origin) are serialized inline with
    // the passthrough headers — no intermediate Headers copy on the hot path. The
    // pool declines what it doesn't handle (streaming uploads, Expect, upgrades)
    // via FALLBACK, and bodyless requests can retry through fetch() as a backstop.
    const hasBody = req.body != null && req.method !== 'GET' && req.method !== 'HEAD'
    try {
      return await proxyViaPool({
        hostPort: targetHost,
        method: req.method,
        path: `${targetPath}${search}`,
        reqHeaders: req.headers,
        forwardedHost: hostname,
        originOverride,
        body: req.body,
      })
    }
    catch (err) {
      // Upstream stalled past the configured timeout → 504 (no fetch retry — it
      // would just stall again).
      if (err === TIMEOUT) {
        debugLog('request', `Upstream timeout for ${hostname}`, verbose)
        return new Response('Gateway Timeout', { status: 504 })
      }
      // Pool saturated: every connection to this upstream is busy and the wait
      // for a free slot timed out. Fail fast and loud (503) instead of parking
      // the request forever — a parked request with no response is what made the
      // listener appear "wedged" in production.
      if (err === POOL_BUSY) {
        debugLog('request', `Upstream pool saturated for ${hostname}`, verbose)
        return new Response('Service Unavailable', { status: 503, headers: { 'retry-after': '1' } })
      }
      if (err === FALLBACK || !hasBody) {
        try {
          const headers = new Headers(req.headers)
          headers.set('host', targetHost)
          headers.set('x-forwarded-for', '127.0.0.1')
          headers.set('x-forwarded-proto', 'https')
          headers.set('x-forwarded-host', hostname)
          if (originOverride !== undefined)
            headers.set('origin', originOverride)
          return await fetch(`http://${targetHost}${targetPath}${search}`, {
            method: req.method,
            headers,
            body: req.body,
            redirect: 'manual',
          })
        }
        catch (fetchErr) {
          debugLog('request', `Proxy error for ${hostname}: ${fetchErr}`, verbose)
          return new Response(`Proxy Error: ${fetchErr}`, { status: 502 })
        }
      }
      debugLog('request', `Proxy error for ${hostname}: ${err}`, verbose)
      return new Response(`Proxy Error: ${err}`, { status: 502 })
    }
  }

  // A reverse proxy must never drop a connection on an unexpected throw: an
  // async fetch handler that *rejects* makes Bun close the socket with no
  // response (the client sees an empty reply) and log a stack trace per hit.
  // Wrap the whole pipeline so a routing bug, a malformed request, or a static
  // helper that throws always degrades to a 502 instead of a dropped connection.
  return async (req: Request, server?: ProxyServer): Promise<Response | undefined> => {
    try {
      return await inner(req, server)
    }
    catch (err) {
      debugLog('request', `Unhandled proxy handler error: ${err}`, verbose)
      return new Response('Bad Gateway', { status: 502 })
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
        // Bun's WebSocket accepts a `headers` option (control-channel auth etc.)
        // that the DOM lib's constructor type doesn't model — describe that
        // extended constructor precisely instead of falling back to `any`.
        type BunWebSocketCtor = new (_url: string | URL, _options?: { headers?: Record<string, string> }) => WebSocket
        upstream = new (WebSocket as unknown as BunWebSocketCtor)(targetUrl, { headers: forwardHeaders })
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
          upstream.send(frame)
        st.pending = []
      })
      upstream.addEventListener('message', (ev: MessageEvent) => {
        // Forward both binary (ArrayBuffer) and text frames to the client.
        // `binaryType` is 'arraybuffer', so `ev.data` is `string | ArrayBuffer`.
        ws.send(ev.data as string | ArrayBuffer)
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
        st.upstream.send(frame)
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
