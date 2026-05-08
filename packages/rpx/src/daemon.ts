/**
 * The rpx daemon: a single long-running process that fronts :443 and :80, holds
 * the shared Root CA + host cert, and routes traffic per the registry.
 *
 * Lifecycle:
 *   1. acquireDaemonLock() — atomic create of `daemon.pid` (or take over a
 *      stale one whose writer is gone). Bails if a healthy daemon is already
 *      running.
 *   2. Bootstrap TLS (reuses the Root CA persisted by https.ts).
 *   3. Bun.serve :443 with the proxy fetch handler; HTTP→HTTPS redirect on :80.
 *   4. Watch the registry, rebuild the routing table on every change. Periodic
 *      PID GC reaps entries from writers that died `kill -9`.
 *   5. SIGINT/SIGTERM → drain in-flight, release lock, exit 0.
 *
 * Tests inject a `rpxDir`/`registryDir`/non-priv ports, so all the heavy I/O
 * paths are reachable without touching `~/.stacks/rpx` or :443.
 */
/* eslint-disable no-console */
import type { ProxyOptions, SSLConfig, TlsOption } from './types'
import type { ProxyRoute } from './proxy-handler'
import { spawn as nodeSpawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { log } from './logger'
import { checkExistingCertificates, generateCertificate } from './https'
import { createProxyFetchHandler } from './proxy-handler'
import { gcStaleEntries, getRegistryDir, isPidAlive, readAll, watchRegistry } from './registry'
import type { RegistryEntry } from './registry'
import { debugLog } from './utils'

export interface DaemonOptions {
  verbose?: boolean
  /** Override `~/.stacks/rpx`. Used by tests to avoid touching the real dir. */
  rpxDir?: string
  /** Override the registry directory. Defaults to `<rpxDir>/registry.d`. */
  registryDir?: string
  /** HTTPS listen port. Defaults to 443. */
  httpsPort?: number
  /** HTTP redirect port. Defaults to 80. Pass 0 to skip the redirect server. */
  httpPort?: number
  /** Listener bind address. Defaults to `0.0.0.0`. */
  hostname?: string
  /** TLS bootstrap options forwarded to httpsConfig. */
  https?: TlsOption
  /** PID-GC interval in ms. Defaults to 5000. */
  gcIntervalMs?: number
}

export interface DaemonHandle {
  /** Stop the daemon, drain in-flight, release the lock. */
  stop: () => Promise<void>
  /** Resolves when the daemon has fully shut down. */
  done: Promise<void>
  httpsPort: number
  httpPort: number
  pidPath: string
}

const DEFAULT_GC_INTERVAL_MS = 5000

export function getDaemonRpxDir(): string {
  return path.join(homedir(), '.stacks', 'rpx')
}

export function getDaemonPidPath(rpxDir: string = getDaemonRpxDir()): string {
  return path.join(rpxDir, 'daemon.pid')
}

/**
 * Read the PID stored in `daemon.pid`, or `null` if no file / unparseable.
 */
export async function readDaemonPid(rpxDir: string = getDaemonRpxDir()): Promise<number | null> {
  try {
    const raw = await fsp.readFile(getDaemonPidPath(rpxDir), 'utf8')
    const n = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(n) || n <= 0)
      return null
    return n
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw err
  }
}

/**
 * True if `daemon.pid` points at a process that is still alive.
 */
export async function isDaemonRunning(rpxDir: string = getDaemonRpxDir()): Promise<boolean> {
  const pid = await readDaemonPid(rpxDir)
  return pid !== null && isPidAlive(pid)
}

/**
 * Acquire the daemon's single-instance lock by atomically creating
 * `daemon.pid`. If the file exists but holds a stale PID we take it over;
 * otherwise we throw.
 *
 * `O_CREAT | O_EXCL` (`'wx'`) guarantees only one process wins the create
 * race, so we don't need an external lock library.
 */
export async function acquireDaemonLock(rpxDir: string = getDaemonRpxDir()): Promise<string> {
  await fsp.mkdir(rpxDir, { recursive: true })
  const pidPath = getDaemonPidPath(rpxDir)

  while (true) {
    try {
      const fh = await fsp.open(pidPath, 'wx')
      try {
        await fh.write(`${process.pid}\n`)
      }
      finally {
        await fh.close()
      }
      return pidPath
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
        throw err
    }

    // File exists — figure out whether it's a real owner or a stale leftover.
    const existing = await readDaemonPid(rpxDir)
    if (existing !== null && isPidAlive(existing))
      throw new Error(`rpx daemon already running (pid=${existing})`)

    // Stale: remove and retry. The retry loses the race iff a different
    // process recreates the file in between, which we'll detect on the next
    // iteration.
    await fsp.unlink(pidPath).catch(() => {})
  }
}

export async function releaseDaemonLock(rpxDir: string = getDaemonRpxDir()): Promise<void> {
  await fsp.unlink(getDaemonPidPath(rpxDir)).catch(() => {})
}

/**
 * Translate a registry entry into the routing shape consumed by the proxy
 * fetch handler. The entry's `from` is normalized to `host:port`.
 */
function entryToRoute(entry: RegistryEntry): ProxyRoute {
  const fromUrl = new URL(entry.from.startsWith('http') ? entry.from : `http://${entry.from}`)
  return {
    sourceHost: fromUrl.host,
    cleanUrls: entry.cleanUrls ?? false,
    changeOrigin: entry.changeOrigin ?? false,
    pathRewrites: entry.pathRewrites,
  }
}

/**
 * Bootstrap the daemon's TLS material. Reuses the persisted Root CA and any
 * existing trusted host cert; mints fresh ones if none exist.
 *
 * The host cert is issued with the standard `*.localhost` SAN list (set by
 * `httpsConfig` via `getAllDomains`), so every `<app>.localhost` route is
 * covered without needing to regenerate when apps register.
 */
async function bootstrapTls(opts: DaemonOptions): Promise<SSLConfig> {
  const proxyOpts: ProxyOptions = {
    https: opts.https ?? true,
    to: 'rpx.localhost',
    verbose: opts.verbose,
    regenerateUntrustedCerts: true,
  }

  let sslConfig = await checkExistingCertificates(proxyOpts)
  if (!sslConfig) {
    debugLog('daemon', 'no usable cert on disk, generating one', opts.verbose)
    await generateCertificate(proxyOpts)
    sslConfig = await checkExistingCertificates(proxyOpts)
  }
  if (!sslConfig)
    throw new Error('failed to bootstrap TLS for rpx daemon')
  return sslConfig
}

/**
 * Start the daemon. Returns a handle that resolves `done` once the daemon has
 * cleanly shut down (signal received and listeners closed).
 *
 * The promise itself resolves as soon as the daemon is *ready* — i.e. both
 * listeners are bound and the initial routing table is populated. Use
 * `handle.done` for the lifetime promise.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const verbose = opts.verbose ?? false
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const registryDir = opts.registryDir ?? path.join(rpxDir, 'registry.d')
  const httpsPort = opts.httpsPort ?? 443
  const httpPort = opts.httpPort ?? 80
  const hostname = opts.hostname ?? '0.0.0.0'
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS

  const pidPath = await acquireDaemonLock(rpxDir)

  // Module-scoped state so the watcher and fetch handler share one routing view.
  let routingTable = new Map<string, ProxyRoute>()
  const getRoute = (host: string): ProxyRoute | undefined => routingTable.get(host)

  function rebuild(entries: RegistryEntry[]): void {
    const next = new Map<string, ProxyRoute>()
    for (const e of entries)
      next.set(e.to, entryToRoute(e))
    routingTable = next
    debugLog('daemon', `routing table now covers ${next.size} host(s): ${Array.from(next.keys()).join(', ') || '<empty>'}`, verbose)
  }

  // Initial GC + load before binding so the very first request finds a route.
  await gcStaleEntries(registryDir, verbose).catch((err) => {
    debugLog('daemon', `initial gc failed: ${err}`, verbose)
  })
  rebuild(await readAll(registryDir, verbose))

  const sslConfig = await bootstrapTls(opts)

  const httpsServer = Bun.serve({
    port: httpsPort,
    hostname,
    tls: {
      key: sslConfig.key,
      cert: sslConfig.cert,
      ca: sslConfig.ca,
      requestCert: false,
      rejectUnauthorized: false,
    },
    fetch: createProxyFetchHandler(getRoute, verbose),
    error(err: Error) {
      debugLog('daemon', `https server error: ${err}`, verbose)
      return new Response(`Server Error: ${err.message}`, { status: 500 })
    },
  })

  let httpServer: ReturnType<typeof Bun.serve> | null = null
  if (httpPort > 0) {
    httpServer = Bun.serve({
      port: httpPort,
      hostname,
      fetch(req: Request) {
        const u = new URL(req.url)
        const host = (req.headers.get('host') ?? u.hostname).split(':')[0]
        return new Response(null, {
          status: 301,
          headers: { Location: `https://${host}${u.pathname}${u.search}` },
        })
      },
    })
  }

  if (verbose) {
    log.success(`rpx daemon listening on https://${hostname}:${httpsPort}${httpServer ? ` (http→https on :${httpPort})` : ''}`)
    log.info(`pid file: ${pidPath}`)
    log.info(`registry: ${registryDir}`)
  }

  const watcher = watchRegistry(
    (entries) => { rebuild(entries) },
    { dir: registryDir, verbose },
  )

  const gcInterval = setInterval(() => {
    gcStaleEntries(registryDir, verbose)
      .then((removed) => {
        if (removed > 0)
          debugLog('daemon', `gc reaped ${removed} stale entries`, verbose)
      })
      .catch((err) => {
        debugLog('daemon', `periodic gc failed: ${err}`, verbose)
      })
  }, gcIntervalMs)
  // Don't keep the event loop alive just for GC.
  if (typeof gcInterval.unref === 'function')
    gcInterval.unref()

  let stopped = false
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })

  async function stop(): Promise<void> {
    if (stopped)
      return done
    stopped = true
    clearInterval(gcInterval)
    watcher.close()
    // `stop(false)` lets in-flight requests drain before closing the listener.
    httpsServer.stop(false)
    httpServer?.stop(false)
    await releaseDaemonLock(rpxDir)
    if (verbose)
      log.info('rpx daemon stopped')
    resolveDone()
    return done
  }

  const onSignal = (sig: NodeJS.Signals) => {
    debugLog('daemon', `received ${sig}, shutting down`, verbose)
    stop().catch(() => {})
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return {
    stop,
    done,
    httpsPort: typeof httpsServer.port === 'number' ? httpsServer.port : httpsPort,
    httpPort: httpServer && typeof httpServer.port === 'number' ? httpServer.port : httpPort,
    pidPath,
  }
}

export interface EnsureDaemonOptions {
  /** Override `~/.stacks/rpx`. */
  rpxDir?: string
  /**
   * Argv to spawn if no daemon is running. Defaults to re-invoking the current
   * Bun script with `daemon start`. Library consumers (e.g. `./buddy dev`)
   * should pass an explicit command resolving to the `rpx` binary on PATH.
   */
  spawnCommand?: string[]
  /** Working directory for the spawned daemon. Defaults to `process.cwd()`. */
  spawnCwd?: string
  /** Extra env for the spawned daemon. Merged on top of `process.env`. */
  spawnEnv?: Record<string, string>
  /** Max ms to wait for the spawned daemon's pid file to appear. Default 5000. */
  startupTimeoutMs?: number
  /** Polling interval while waiting for the daemon to register. Default 50ms. */
  pollIntervalMs?: number
  verbose?: boolean
}

export interface EnsureDaemonResult {
  pid: number
  /** True if we spawned a new daemon; false if one was already running. */
  spawned: boolean
}

/**
 * Best-effort default for the spawn command used by lazy-spawn. Compiled
 * binaries (`bun build --compile`) self-invoke; source-mode executions invoke
 * the same Bun + script that's running now.
 *
 * Library consumers should not rely on this — pass `spawnCommand` explicitly.
 */
export function defaultDaemonSpawnCommand(): string[] {
  const exec = process.execPath
  const interpName = path.basename(exec).toLowerCase()
  const isInterpreter = interpName === 'bun' || interpName === 'node' || interpName.startsWith('bun-')
  if (isInterpreter && process.argv[1])
    return [exec, process.argv[1], 'daemon:start']
  return [exec, 'daemon:start']
}

/**
 * Make sure a daemon is running, starting one as a detached child if needed.
 *
 * - If the pid file exists and points at a live process, returns immediately
 *   with `spawned: false`.
 * - Otherwise cleans any stale pid file, spawns the configured command with
 *   `detached: true` + `stdio: 'ignore'` + `unref()` so it survives the caller
 *   exiting, and polls the pid file until the new daemon registers itself.
 *
 * Throws if the daemon never appears within `startupTimeoutMs`.
 */
export async function ensureDaemonRunning(opts: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const verbose = opts.verbose ?? false

  const existingPid = await readDaemonPid(rpxDir)
  if (existingPid !== null && isPidAlive(existingPid)) {
    debugLog('daemon', `ensureDaemonRunning: already running pid=${existingPid}`, verbose)
    return { pid: existingPid, spawned: false }
  }
  if (existingPid !== null) {
    debugLog('daemon', `ensureDaemonRunning: clearing stale pid=${existingPid}`, verbose)
    await releaseDaemonLock(rpxDir)
  }

  await fsp.mkdir(rpxDir, { recursive: true })

  const command = opts.spawnCommand ?? defaultDaemonSpawnCommand()
  if (command.length === 0)
    throw new Error('ensureDaemonRunning: spawnCommand is empty')

  debugLog('daemon', `spawning daemon: ${command.join(' ')}`, verbose)
  const child = nodeSpawn(command[0]!, command.slice(1), {
    detached: true,
    stdio: 'ignore',
    cwd: opts.spawnCwd ?? process.cwd(),
    env: opts.spawnEnv ? { ...process.env, ...opts.spawnEnv } : process.env,
  })
  child.unref()

  // Surface synchronous spawn failures (ENOENT for the binary, etc.) so the
  // caller doesn't have to wait the full timeout to see them.
  let spawnError: Error | null = null
  child.once('error', (err) => { spawnError = err })

  const timeoutMs = opts.startupTimeoutMs ?? 5000
  const pollMs = opts.pollIntervalMs ?? 50
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (spawnError)
      throw spawnError
    const pid = await readDaemonPid(rpxDir)
    if (pid !== null && isPidAlive(pid)) {
      debugLog('daemon', `daemon registered with pid=${pid}`, verbose)
      return { pid, spawned: true }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  if (spawnError)
    throw spawnError
  throw new Error(`rpx daemon failed to start within ${timeoutMs}ms (rpxDir=${rpxDir})`)
}

export interface StopDaemonOptions {
  rpxDir?: string
  /** Total ms to wait for the pid to die. Default 5000. */
  timeoutMs?: number
  /** Poll interval while waiting. Default 50ms. */
  pollIntervalMs?: number
  /** Send SIGKILL after `timeoutMs` if SIGTERM didn't take. Default true. */
  forceAfterTimeout?: boolean
  verbose?: boolean
}

export interface StopDaemonResult {
  /** True if a daemon was found and asked to stop. */
  stopped: boolean
  pid: number | null
  /** True if we had to escalate to SIGKILL. */
  forced: boolean
}

/**
 * Stop a running daemon by reading its pid and sending SIGTERM. Polls until
 * the process is gone (or escalates to SIGKILL if `forceAfterTimeout`). The
 * pid file is removed by the daemon's own SIGTERM handler — we clean up only
 * if we had to SIGKILL.
 */
export async function stopDaemon(opts: StopDaemonOptions = {}): Promise<StopDaemonResult> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const verbose = opts.verbose ?? false
  const timeoutMs = opts.timeoutMs ?? 5000
  const pollMs = opts.pollIntervalMs ?? 50
  const force = opts.forceAfterTimeout ?? true

  const pid = await readDaemonPid(rpxDir)
  if (pid === null || !isPidAlive(pid)) {
    if (pid !== null)
      await releaseDaemonLock(rpxDir)
    return { stopped: false, pid, forced: false }
  }

  try {
    process.kill(pid, 'SIGTERM')
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      await releaseDaemonLock(rpxDir)
      return { stopped: false, pid, forced: false }
    }
    throw err
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      debugLog('daemon', `daemon pid=${pid} stopped cleanly`, verbose)
      return { stopped: true, pid, forced: false }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  if (!force)
    throw new Error(`rpx daemon (pid=${pid}) did not exit within ${timeoutMs}ms`)

  debugLog('daemon', `daemon pid=${pid} did not exit, escalating to SIGKILL`, verbose)
  try {
    process.kill(pid, 'SIGKILL')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH')
      throw err
  }
  // SIGKILL bypasses the cleanup handler, so remove the pid file ourselves.
  await releaseDaemonLock(rpxDir)
  return { stopped: true, pid, forced: true }
}
