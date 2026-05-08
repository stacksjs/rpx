/**
 * The fetch handler used by the shared :443 server. Both the in-process
 * multi-proxy mode in `start.ts` and the long-running daemon delegate to this
 * module so routing semantics stay in one place.
 *
 * Routes are looked up via a caller-supplied `getRoute(hostname)` callback.
 * The callback indirection lets each caller use whatever data structure makes
 * sense (a fixed Map at startup, or a hot-swappable registry view) without
 * coupling this module to either.
 */
import type { PathRewrite } from './types'
import { debugLog } from './utils'
import { resolvePathRewrite } from './utils'

export interface ProxyRoute {
  /** Upstream `host:port` to forward requests to (e.g. `localhost:5173`). */
  sourceHost: string
  /** Strip `.html` suffix and 301 to clean URLs. */
  cleanUrls?: boolean
  /** Set the `origin` header to the target. */
  changeOrigin?: boolean
  /** Per-route path rewrites (vite/nginx-style prefix routing). */
  pathRewrites?: PathRewrite[]
}

export type GetRoute = (hostname: string) => ProxyRoute | undefined

export type ProxyFetchHandler = (req: Request) => Promise<Response>

/**
 * Build a Bun.serve-compatible `fetch` handler that routes requests based on
 * the `Host` header. Returns 404 when no route matches and 502 on upstream
 * failures.
 */
export function createProxyFetchHandler(getRoute: GetRoute, verbose?: boolean): ProxyFetchHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const hostHeader = req.headers.get('host') || ''
    // Strip port (`stacks.localhost:443` → `stacks.localhost`).
    const hostname = hostHeader.split(':')[0]

    const route = getRoute(hostname)
    if (!route) {
      debugLog('request', `No route found for host: ${hostname}`, verbose)
      return new Response(`No proxy configured for ${hostname}`, { status: 404 })
    }

    let targetHost = route.sourceHost
    let targetPath = url.pathname

    // Per-route path rewrites: prefix preserved by default, matching Vite /
    // nginx / http-proxy-middleware semantics. See `resolvePathRewrite`.
    const rewriteMatch = resolvePathRewrite(url.pathname, route.pathRewrites)
    if (rewriteMatch) {
      targetHost = rewriteMatch.targetHost
      targetPath = rewriteMatch.targetPath
      debugLog('request', `Path rewrite: ${url.pathname} → ${targetHost}${targetPath}`, verbose)
    }

    const targetUrl = `http://${targetHost}${targetPath}${url.search}`

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
