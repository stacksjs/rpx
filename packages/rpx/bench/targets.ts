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
import { freePort, hasBinary, HOST, killProc, spawnProc, waitForPort } from './lib'

const WORKER = path.join(import.meta.dir, 'worker.ts')

/** Per-target core counts. `cores` (if set) overrides everything for fairness. */
export interface TargetOptions {
  /** Apply the same worker/core count to every target (apples-to-apples). */
  cores?: number
}

/** Spawn `n` `reusePort` worker processes for a given worker mode. */
async function startCluster(name: string, mode: 'rpx' | 'bun', origin: Origin, n: number): Promise<BenchTarget> {
  const port = await freePort()
  const procs: Subprocess[] = []
  for (let i = 0; i < n; i++)
    procs.push(Bun.spawn(['bun', WORKER, mode, String(port), origin.host], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' }))
  await waitForPort(port)
  return {
    name,
    url: `http://${HOST}:${port}`,
    stop: async () => { await Promise.all(procs.map(p => killProc(p))) },
  }
}

/** rpx, exercised through its actual shared-server request handler. */
export function startRpx(origin: Origin, cores = 1): Promise<BenchTarget> {
  return startCluster('rpx', 'rpx', origin, cores)
}

/** Minimal Bun.serve + fetch proxy — the floor for the fetch-based approach. */
export function startBunRaw(origin: Origin, cores = 1): Promise<BenchTarget> {
  return startCluster('bun-raw', 'bun', origin, cores)
}

/** caddy via a generated Caddyfile (`reverse_proxy`). `cores` caps GOMAXPROCS. */
export async function startCaddy(origin: Origin, cores?: number): Promise<BenchTarget | null> {
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

  const env = cores ? { ...process.env, GOMAXPROCS: String(cores) } : process.env
  const proc: Subprocess = Bun.spawn(['caddy', 'run', '--config', cfgPath, '--adapter', 'caddyfile'], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
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
export async function startNginx(origin: Origin, cores?: number): Promise<BenchTarget | null> {
  if (!hasBinary('nginx'))
    return null
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-bench-nginx-'))
  for (const sub of ['logs', 'temp'])
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const cfgPath = path.join(dir, 'nginx.conf')
  fs.writeFileSync(cfgPath, `
worker_processes ${cores ?? 'auto'};
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

/**
 * Start every available target. Missing external proxies are skipped (logged).
 * When `opts.cores` is set, every target is pinned to that many cores for an
 * apples-to-apples comparison; otherwise rpx/bun-raw run single-core and
 * nginx/caddy use their native all-core defaults (status quo).
 */
export async function startAllTargets(origin: Origin, opts: TargetOptions = {}): Promise<BenchTarget[]> {
  const { cores } = opts
  const jsCores = cores ?? 1 // rpx/bun-raw default to single-core unless pinned
  const targets: BenchTarget[] = [directBaseline(origin)]
  targets.push(await startRpx(origin, jsCores))
  targets.push(await startBunRaw(origin, jsCores))

  const caddy = await startCaddy(origin, cores).catch((e) => { console.error('caddy skipped:', e.message); return null })
  if (caddy)
    targets.push(caddy)
  else if (!hasBinary('caddy'))
    console.error('caddy not installed — skipping (brew install caddy)')

  const nginx = await startNginx(origin, cores).catch((e) => { console.error('nginx skipped:', e.message); return null })
  if (nginx)
    targets.push(nginx)
  else if (!hasBinary('nginx'))
    console.error('nginx not installed — skipping (brew install nginx)')

  return targets
}
