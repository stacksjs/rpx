/* eslint-disable no-console */
/**
 * Proxy targets under test. Every target forwards to the same origin and is
 * reachable over plain HTTP on its own port, so the comparison isolates
 * request-forwarding overhead (TLS handshakes are a separate axis and would
 * only add noise here).
 *
 * Targets:
 *   - `rpx`     → rpx's real production request handler (`createProxyFetchHandler`
 *                 + `buildHostRoutes`/`matchHostRoute`) hosted on Bun.serve.
 *   - `bun-raw` → a minimal Bun.serve + fetch proxy: the theoretical floor for
 *                 this approach, to show how much rpx's routing layer costs.
 *   - `caddy`   → `caddy reverse_proxy` (skipped if caddy isn't installed).
 *   - `nginx`   → `nginx proxy_pass` with upstream keepalive (skipped if absent).
 */
import type { Subprocess } from 'bun'
import type { Origin } from './origin'
import type { BenchTarget } from './lib'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildHostRoutes, createProxyFetchHandler, matchHostRoute } from '../src'
import { freePort, hasBinary, HOST, killProc, spawnProc, waitForPort } from './lib'

/** rpx, exercised through its actual shared-server request handler. */
export async function startRpx(origin: Origin): Promise<BenchTarget> {
  const port = await freePort()
  // The same routing table rpx builds for its shared :443 server. Keyed under
  // the host oha/fetch will send (`127.0.0.1`), so `matchHostRoute` resolves it.
  const table = buildHostRoutes([{ host: HOST, route: { sourceHost: origin.host } }])
  const handler = createProxyFetchHandler((host, pathname) => matchHostRoute(table, host, pathname))

  const server = Bun.serve({
    port,
    hostname: HOST,
    fetch: (req, srv) => handler(req, srv as any),
  })

  await waitForPort(port)
  return { name: 'rpx', url: `http://${HOST}:${port}`, stop: () => server.stop(true) }
}

/** Minimal Bun.serve + fetch proxy — the floor for the fetch-based approach. */
export async function startBunRaw(origin: Origin): Promise<BenchTarget> {
  const port = await freePort()
  const base = `http://${origin.host}`
  const server = Bun.serve({
    port,
    hostname: HOST,
    fetch(req: Request) {
      const url = new URL(req.url)
      return fetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
      })
    },
  })
  await waitForPort(port)
  return { name: 'bun-raw', url: `http://${HOST}:${port}`, stop: () => server.stop(true) }
}

/** caddy via a generated Caddyfile (`reverse_proxy`). */
export async function startCaddy(origin: Origin): Promise<BenchTarget | null> {
  if (!hasBinary('caddy'))
    return null
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-bench-caddy-'))
  const cfgPath = path.join(dir, 'Caddyfile')
  fs.writeFileSync(cfgPath, [
    '{',
    '\tadmin off',
    '\tauto_https off',
    '}',
    `:${port} {`,
    `\treverse_proxy ${origin.host}`,
    '}',
    '',
  ].join('\n'))

  const proc: Subprocess = spawnProc(['caddy', 'run', '--config', cfgPath, '--adapter', 'caddyfile'])
  await waitForPort(port)
  return {
    name: 'caddy',
    url: `http://${HOST}:${port}`,
    stop: async () => {
      await killProc(proc)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** nginx via a generated config (`proxy_pass` with upstream keepalive). */
export async function startNginx(origin: Origin): Promise<BenchTarget | null> {
  if (!hasBinary('nginx'))
    return null
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-bench-nginx-'))
  for (const sub of ['logs', 'temp'])
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const cfgPath = path.join(dir, 'nginx.conf')
  fs.writeFileSync(cfgPath, `
worker_processes auto;
daemon off;
pid ${path.join(dir, 'nginx.pid')};
error_log ${path.join(dir, 'logs/error.log')} crit;
events { worker_connections 4096; }
http {
  access_log off;
  client_body_temp_path ${path.join(dir, 'temp/client')};
  proxy_temp_path ${path.join(dir, 'temp/proxy')};
  fastcgi_temp_path ${path.join(dir, 'temp/fastcgi')};
  uwsgi_temp_path ${path.join(dir, 'temp/uwsgi')};
  scgi_temp_path ${path.join(dir, 'temp/scgi')};
  upstream rpx_origin {
    server ${origin.host};
    keepalive 64;
  }
  server {
    listen ${port};
    location / {
      proxy_pass http://rpx_origin;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
    }
  }
}
`.trimStart())

  const proc: Subprocess = spawnProc(['nginx', '-p', dir, '-c', cfgPath])
  try {
    await waitForPort(port)
  }
  catch (err) {
    const stderr = proc.stderr ? await new Response(proc.stderr as any).text() : ''
    await killProc(proc)
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`nginx failed to start: ${stderr || (err as Error).message}`)
  }
  return {
    name: 'nginx',
    url: `http://${HOST}:${port}`,
    stop: async () => {
      await killProc(proc)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A direct-to-origin "no proxy" baseline so overhead is measured against zero. */
export function directBaseline(origin: Origin): BenchTarget {
  return { name: 'direct', url: origin.url, stop: () => {} }
}

/** Start every available target. Missing external proxies are skipped (logged). */
export async function startAllTargets(origin: Origin): Promise<BenchTarget[]> {
  const targets: BenchTarget[] = [directBaseline(origin)]
  targets.push(await startRpx(origin))
  targets.push(await startBunRaw(origin))

  const caddy = await startCaddy(origin).catch((e) => { console.error('caddy skipped:', e.message); return null })
  if (caddy)
    targets.push(caddy)
  else if (!hasBinary('caddy'))
    console.error('caddy not installed — skipping (brew install caddy)')

  const nginx = await startNginx(origin).catch((e) => { console.error('nginx skipped:', e.message); return null })
  if (nginx)
    targets.push(nginx)
  else if (!hasBinary('nginx'))
    console.error('nginx not installed — skipping (brew install nginx)')

  return targets
}
