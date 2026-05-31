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
import type { OnDemandTlsConfig, ProductionTlsConfig, ProxyOptions, SSLConfig, TlsOption } from './types'
import type { ProxyRoute, ProxyServer as ProxyServerLike } from './proxy-handler'
import { spawn as nodeSpawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { log } from './logger'
import { checkExistingCertificates, generateCertificate } from './https'
import { createProxyFetchHandler, createProxyWebSocketHandler } from './proxy-handler'
import { buildHostRoutes, matchHostRoute, normalizePathPrefix } from './host-routes'
import type { HostRoutes } from './host-routes'
import { buildSniTlsConfig } from './sni'
import { OnDemandCertManager } from './on-demand'
import { resolveStaticRoute } from './static-files'
import { gcStaleEntries, getRegistryDir, isPidAlive, readAll, watchRegistry } from './registry'
import type { RegistryEntry } from './registry'
import {
  reconcileStaleDevelopmentDns,
  syncDevelopmentDnsFromRegistry,
  tearDownDevelopmentDns,
} from './dns'
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
  /**
   * Production per-domain SNI certs (real PEMs on disk). When usable certs are
   * found, the listener serves them per SNI server name instead of the dev
   * self-signed shared cert.
   */
  productionCerts?: ProductionTlsConfig
  /**
   * On-demand TLS: lazily issue real certs for approved unknown hosts via ACME
   * http-01 (served from this daemon's `:80` listener). Opt-in via `enabled`.
   * Seeded with the `productionCerts`/`certsDir` certs already on disk.
   */
  onDemandTls?: OnDemandTlsConfig
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
  /**
   * Pre-warm an on-demand cert for `host` (issue it now if approved & missing,
   * rebuilding the `:443` listener). Resolves `true` if a cert is available
   * afterwards. No-op resolving `false` when on-demand TLS isn't enabled. Lets a
   * tunnel server warm a subdomain's cert at registration time.
   */
  ensureCert: (host: string) => Promise<boolean>
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
  const cleanUrls = entry.cleanUrls ?? false
  const basePath = normalizePathPrefix(entry.path)
  if (entry.static) {
    return {
      static: resolveStaticRoute(entry.static, cleanUrls),
      cleanUrls,
      basePath,
    }
  }
  const from = entry.from ?? 'localhost:1'
  const fromUrl = new URL(from.startsWith('http') ? from : `http://${from}`)
  return {
    sourceHost: fromUrl.host,
    cleanUrls,
    changeOrigin: entry.changeOrigin ?? false,
    pathRewrites: entry.pathRewrites,
    basePath,
  }
}

/**
 * Bootstrap the daemon's TLS material. Reuses the persisted Root CA and any
 * existing trusted host cert; mints fresh ones if none exist.
 *
 * The host cert SAN list includes every hostname in the registry (e.g.
 * `postline.localhost`, `api.postline.localhost`). Chrome does not treat
 * `*.localhost` as matching `<app>.localhost`, so those names must be explicit.
 */
function pickPrimaryRegistryHost(hosts: string[]): string {
  const appHost = hosts.find(h => !/^api\./.test(h) && !/^docs\./.test(h) && !/^dashboard\./.test(h))
  return appHost ?? hosts[0] ?? 'rpx.localhost'
}

async function bootstrapTls(opts: DaemonOptions, registryDir: string): Promise<SSLConfig> {
  const entries = await readAll(registryDir, opts.verbose)
  const registryHosts = [...new Set(entries.map(e => e.to))]
  const primary = pickPrimaryRegistryHost(registryHosts)
  const hostnames = [...new Set([primary, ...registryHosts, 'rpx.localhost'])]

  const sslDir = path.join(homedir(), '.stacks', 'ssl')
  const sharedCert = path.join(sslDir, 'rpx.localhost.crt')

  const proxyOpts: ProxyOptions = {
    https: typeof opts.https === 'object'
      ? { ...opts.https, certPath: sharedCert, keyPath: path.join(sslDir, 'rpx.localhost.key'), commonName: primary }
      : {
          certPath: sharedCert,
          keyPath: path.join(sslDir, 'rpx.localhost.key'),
          caCertPath: path.join(sslDir, 'rpx.localhost.ca.crt'),
          commonName: primary,
        },
    verbose: opts.verbose,
    regenerateUntrustedCerts: true,
    ...(hostnames.length > 1
      ? { proxies: hostnames.map(to => ({ from: 'localhost:1', to })) }
      : { to: primary, from: 'localhost:1' }),
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
 * Binding :443/:80 requires root. When the daemon is launched as a normal user
 * (the common case — `./buddy dev`), re-exec it through `sudo` so the elevated
 * copy can bind the privileged ports. HOME/PATH are forwarded explicitly (via
 * `env`) so the root daemon reads the *user's* `~/.stacks/rpx` state, certs and
 * registry instead of root's home. The password is fed on stdin only — never
 * placed in argv — so it can't leak via `ps`, and the root daemon doesn't need
 * it (it can already sudo).
 *
 * Returns a launcher handle: this unprivileged process has done its job once
 * the elevated daemon has written its pid, so `done` resolves immediately and
 * the launcher exits, leaving the root daemon running independently (its pid
 * file is how everyone else finds it).
 */
async function elevateDaemonToRoot(
  rpxDir: string,
  httpsPort: number,
  httpPort: number,
  verbose: boolean,
): Promise<DaemonHandle> {
  const sudoPassword = process.env.SUDO_PASSWORD
  const home = process.env.HOME ?? homedir()
  const inner = [process.execPath, ...process.argv.slice(1)]
  const forwardedEnv = [`HOME=${home}`, `PATH=${process.env.PATH ?? ''}`]
  if (verbose)
    forwardedEnv.push('RPX_VERBOSE=1')

  // `sudo -S` reads the password from stdin; `-n` (no password) relies on a
  // cached credential. Either way we never block on an interactive prompt.
  const sudoArgs = sudoPassword
    ? ['-S', '-p', '', 'env', ...forwardedEnv, ...inner]
    : ['-n', 'env', ...forwardedEnv, ...inner]

  debugLog('daemon', `elevating daemon via sudo for privileged ports ${httpsPort}/${httpPort}`, verbose)
  const child = nodeSpawn('sudo', sudoArgs, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })

  let spawnError: Error | null = null
  let sudoExitCode: number | null = null
  child.once('error', (err) => { spawnError = err })
  child.once('exit', (code) => { sudoExitCode = code ?? 0 })

  if (sudoPassword && child.stdin) {
    child.stdin.write(`${sudoPassword}\n`)
    child.stdin.end()
  }
  child.unref()

  const pidPath = getDaemonPidPath(rpxDir)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (spawnError)
      throw spawnError
    const pid = await readDaemonPid(rpxDir)
    if (pid !== null && isPidAlive(pid)) {
      if (verbose)
        log.success(`rpx daemon elevated to root (pid=${pid}, https on :${httpsPort})`)
      return {
        httpsPort,
        httpPort,
        pidPath,
        done: Promise.resolve(),
        stop: async () => {
          // The daemon is root-owned; a normal user can't signal it. `./buddy
          // dev` intentionally leaves the shared daemon running across sessions.
          try { process.kill(pid, 'SIGTERM') }
          catch { /* EPERM — root-owned shared daemon */ }
        },
        // On-demand issuance runs inside the elevated child's own runDaemon
        // handle; this caller-side stub can't reach it directly.
        ensureCert: () => Promise.resolve(false),
      }
    }
    // sudo exits fast when auth fails; while the daemon runs it stays alive.
    if (sudoExitCode !== null && sudoExitCode !== 0) {
      throw new Error(
        `rpx daemon could not elevate to bind :${httpsPort} (sudo exited ${sudoExitCode}). `
        + 'Set SUDO_PASSWORD in .env or run `sudo -v` first.',
      )
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`rpx daemon failed to elevate within 15000ms (rpxDir=${rpxDir})`)
}

/**
 * Start the daemon. Returns a handle that resolves `done` once the daemon has
 * cleanly shut down (signal received and listeners closed).
 *
 * The promise itself resolves as soon as the daemon is *ready* — i.e. both
 * listeners are bound and the initial routing table is populated. Use
 * `handle.done` for the lifetime promise.
 */
// `opts` IS used throughout; pickier's no-unused-vars mis-fires on this fn after
// the on-demand serve refactor (its --fix would wrongly rename to `_opts`).
// eslint-disable-next-line pickier/no-unused-vars
export async function runDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const verbose = opts.verbose ?? false
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const registryDir = opts.registryDir ?? path.join(rpxDir, 'registry.d')
  const httpsPort = opts.httpsPort ?? 443
  const httpPort = opts.httpPort ?? 80
  const hostname = opts.hostname ?? '0.0.0.0'
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS

  // Privileged ports need root. If we were launched unprivileged (the usual
  // `./buddy dev` case), re-exec through sudo and hand off to the elevated
  // copy — it becomes the real daemon. Tests inject high ports and so skip this.
  const needsPrivilegedPort = (httpsPort > 0 && httpsPort < 1024) || (httpPort > 0 && httpPort < 1024)
  const alreadyRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (process.platform !== 'win32' && needsPrivilegedPort && !alreadyRoot)
    return elevateDaemonToRoot(rpxDir, httpsPort, httpPort, verbose)

  const pidPath = await acquireDaemonLock(rpxDir)

  // Module-scoped state so the watcher and fetch handler share one routing view.
  // Routing table keyed by host pattern; each host owns an ordered list of
  // path-scoped routes. Lookup prefers an exact host match, then the
  // most-specific `*.suffix` wildcard (see `matchHostList`); within a host the
  // longest matching path prefix wins (see `matchHostRoute`).
  let routingTable: HostRoutes<ProxyRoute> = new Map()
  const getRoute = (host: string, pathname: string): ProxyRoute | undefined =>
    matchHostRoute(routingTable, host, pathname)

  function rebuild(entries: RegistryEntry[]): void {
    routingTable = buildHostRoutes(
      entries.map(e => ({ host: e.to, path: e.path, route: entryToRoute(e) })),
    )
    const hosts = Array.from(routingTable.keys())
    debugLog('daemon', `routing table now covers ${hosts.length} host(s): ${hosts.join(', ') || '<empty>'}`, verbose)
  }

  // Initial GC + load before binding so the very first request finds a route.
  await gcStaleEntries(registryDir, verbose).catch((err) => {
    debugLog('daemon', `initial gc failed: ${err}`, verbose)
  })
  const initialEntries = await readAll(registryDir, verbose)
  rebuild(initialEntries)

  await reconcileStaleDevelopmentDns({ rpxDir, verbose }).catch((err) => {
    debugLog('daemon', `DNS reconcile on start failed: ${err}`, verbose)
  })
  await syncDevelopmentDnsFromRegistry(initialEntries, { rpxDir, verbose, ownerPid: process.pid }).catch((err) => {
    debugLog('daemon', `DNS setup on start failed: ${err}`, verbose)
  })

  // Production per-domain SNI: serve real PEM certs (e.g. Let's Encrypt) keyed
  // by server name on the one listener. Falls back to the dev shared cert when
  // no usable production certs are configured.
  let sniTls: Array<{ serverName: string, cert: string, key: string }> = []
  if (opts.productionCerts) {
    sniTls = await buildSniTlsConfig(opts.productionCerts, verbose)
    if (verbose && sniTls.length > 0)
      log.info(`SNI: serving ${sniTls.length} real cert(s): ${sniTls.map(e => e.serverName).join(', ')}`)
  }

  const fetchHandler = createProxyFetchHandler(getRoute, verbose)
  const wsHandler = createProxyWebSocketHandler(verbose)

  // Bootstrap the dev shared cert once when there's no real SNI set, so a single
  // SNI listener with on-demand can still answer hosts that aren't covered yet.
  let devSslConfig: SSLConfig | null = null
  if (sniTls.length === 0)
    devSslConfig = await bootstrapTls(opts, registryDir)

  // On-demand TLS manager (opt-in). Holds the live SNI set; lazily issues real
  // certs for approved unknown hosts via ACME http-01 served from our :80
  // listener (Bun can't issue at handshake time — see on-demand.ts header).
  const onDemandCfg = opts.onDemandTls
  const onDemand: OnDemandCertManager | null = onDemandCfg?.enabled
    ? new OnDemandCertManager({
        config: onDemandCfg,
        certsDir: onDemandCfg.certsDir ?? opts.productionCerts?.certsDir ?? path.join(rpxDir, 'on-demand-certs'),
        initial: sniTls,
        verbose,
        // A new cert was issued/adopted — rebuild :443 with the augmented set.
        onCertAdded: (entries) => { void rebuildTls(entries) },
      })
    : null

  /** Build the TLS option for Bun.serve from the current SNI set (or dev cert). */
  function tlsFor(entries: Array<{ serverName: string, cert: string, key: string }>): unknown {
    if (entries.length > 0)
      return entries.map(e => ({ serverName: e.serverName, cert: e.cert, key: e.key }))
    // No real certs: fall back to the dev self-signed shared cert.
    return {
      key: devSslConfig!.key,
      cert: devSslConfig!.cert,
      ca: devSslConfig!.ca,
      requestCert: false,
      rejectUnauthorized: false,
    }
  }

  /** (Re)create the :443 listener. Factored so on-demand can rebuild it. */
  function serveHttps(entries: Array<{ serverName: string, cert: string, key: string }>): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      port: httpsPort,
      hostname,
      tls: tlsFor(entries) as any,
      fetch(req: Request, server: unknown) {
        return fetchHandler(req, server as ProxyServerLike)
      },
      websocket: wsHandler,
      error(err: Error) {
        debugLog('daemon', `https server error: ${err}`, verbose)
        return new Response(`Server Error: ${err.message}`, { status: 500 })
      },
    })
  }

  let httpsServer = serveHttps(onDemand ? onDemand.sniEntries() : sniTls)

  /**
   * Bun has no working SNICallback and `server.reload({ tls })` does not update
   * certs at runtime (verified Bun 1.3.14/1.4.0). So to serve a freshly-issued
   * cert we tear the old listener down and re-bind with the augmented SNI set.
   * The rebind is sub-second; if the OS hasn't freed the port yet we retry on a
   * short async backoff. In-flight requests on the old listener drain
   * (`stop(false)`). Only ever invoked from the (async) issuance callback.
   */
  async function rebuildTls(entries: Array<{ serverName: string, cert: string, key: string }>): Promise<void> {
    if (stopped)
      return
    debugLog('daemon', `rebuilding :443 with ${entries.length} SNI cert(s)`, verbose)
    httpsServer.stop(false)
    let lastErr: unknown
    for (let attempt = 0; attempt < 20 && !stopped; attempt++) {
      try {
        httpsServer = serveHttps(entries)
        return
      }
      catch (err) {
        // EADDRINUSE while the old socket releases — back off briefly, retry.
        lastErr = err
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    // Could not rebind: the old listener is already down. Surface the failure.
    log.error(`rpx: failed to rebuild :443 after issuing cert: ${(lastErr as Error)?.message}`)
  }

  let httpServer: ReturnType<typeof Bun.serve> | null = null
  if (httpPort > 0) {
    httpServer = Bun.serve({
      port: httpPort,
      hostname,
      fetch(req: Request) {
        const u = new URL(req.url)
        const host = (req.headers.get('host') ?? u.hostname).split(':')[0]

        // Serve ACME http-01 challenges for in-flight on-demand issuances.
        if (onDemand && u.pathname.startsWith('/.well-known/acme-challenge/')) {
          const keyAuth = onDemand.challengeStore.handlePath(u.pathname)
          if (keyAuth !== undefined)
            return new Response(keyAuth, { status: 200, headers: { 'content-type': 'text/plain' } })
          return new Response('challenge not found', { status: 404 })
        }

        // First plaintext hit for an approved-but-uncovered host: kick off
        // issuance so the cert exists for the subsequent HTTPS request. We don't
        // block the redirect on it (the browser retries over HTTPS anyway).
        if (onDemand && !onDemand.hasCert(host)) {
          onDemand.ensureCert(host).catch(() => {})
        }

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
    (entries) => {
      rebuild(entries)
      syncDevelopmentDnsFromRegistry(entries, { rpxDir, verbose, ownerPid: process.pid }).catch((err) => {
        debugLog('daemon', `DNS sync on registry change failed: ${err}`, verbose)
      })
    },
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
    await tearDownDevelopmentDns({ rpxDir, verbose }).catch((err) => {
      debugLog('daemon', `DNS teardown failed: ${err}`, verbose)
    })
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
    ensureCert: (host: string) => (onDemand ? onDemand.ensureCert(host) : Promise.resolve(false)),
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

  await reconcileStaleDevelopmentDns({ rpxDir, verbose }).catch((err) => {
    debugLog('daemon', `DNS reconcile before ensureDaemonRunning: ${err}`, verbose)
  })

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
    await reconcileStaleDevelopmentDns({ rpxDir, verbose }).catch(() => {})
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
  await tearDownDevelopmentDns({ rpxDir, verbose }).catch((err) => {
    debugLog('daemon', `DNS teardown after SIGKILL: ${err}`, verbose)
  })
  return { stopped: true, pid, forced: true }
}

/**
 * When the daemon is not running, ensure no stale macOS resolver overrides remain.
 */
export async function reconcileDevelopmentDnsOnIdle(opts: { rpxDir?: string, verbose?: boolean } = {}): Promise<void> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  if (await isDaemonRunning(rpxDir))
    return
  await reconcileStaleDevelopmentDns({ rpxDir, verbose: opts.verbose })
}
