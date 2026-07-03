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
import type { OnDemandSitesConfig, OnDemandTlsConfig, ProductionTlsConfig, ProxyOptions, SSLConfig, TlsOption } from './types'
import type { OnNoRoute, ProxyRoute, ProxyServer as ProxyServerLike } from './proxy-handler'
import { spawn as nodeSpawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { log } from './logger'
import {
  buildRegistryTlsProxyOptions,
  certIncludesSanHostnames,
  checkExistingCertificates,
  clearSslConfigCache,
  devSslToSniEntries,
  generateCertificate,
  SHARED_DEV_HOST_CERT_PATH,
} from './https'
import { createProxyFetchHandler, createProxyWebSocketHandler } from './proxy-handler'
import { readAcmeChallenge } from './acme-challenge'
import { buildHostRoutes, matchHostList, matchHostRoute, normalizePathPrefix } from './host-routes'
import type { HostRoutes } from './host-routes'
import { buildSniTlsConfig } from './sni'
import { OnDemandCertManager } from './on-demand'
import { createSiteResolver } from './site-resolver'
import { SiteSupervisor } from './site-supervisor'
import type { SiteSnapshot } from './site-supervisor'
import { renderFailedPage, renderStartingPage } from './site-splash'
import { resolveStaticRoute } from './static-files'
import { resolveAuth } from './auth'
import { gcStaleEntries, getRegistryDir, isPidAlive, readAll, watchRegistry } from './registry'
import type { RegistryEntry } from './registry'
import {
  reconcileStaleDevelopmentDns,
  syncDevelopmentDnsFromRegistry,
  tearDownDevelopmentDns,
} from './dns'
import { debugLog, shouldReusePort } from './utils'

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
  /**
   * On-demand sites: lazily boot a project's dev server the first time its host
   * is visited and proxy to it (Valet/puma-dev style). Opt-in via `enabled`.
   * Only honored by the single-process daemon (ignored when `workers > 1`).
   */
  onDemandSites?: OnDemandSitesConfig
  /**
   * Directory an external ACME client (e.g. a `tlsx acme:renew --webroot <dir>`
   * cron) drops http-01 challenge tokens into. When set, the `:80` listener
   * serves `/.well-known/acme-challenge/<token>` from `<webroot>/<token>` before
   * redirecting to HTTPS, so certs can be issued/renewed without freeing `:80`.
   * This is independent of `onDemandTls` (which uses an in-memory challenge
   * store) — both are checked, so webroot renewal works even when on-demand TLS
   * is disabled. Omit to disable webroot challenge serving.
   */
  acmeChallengeWebroot?: string
  /** PID-GC interval in ms. Defaults to 5000. */
  gcIntervalMs?: number
  /**
   * Run as a multi-core cluster: a coordinator owns the singletons (lock, certs,
   * DNS, hosts, :80 ACME/redirect) and spawns this many worker processes that
   * bind :443 with `reusePort` and serve traffic. Defaults to 1 (single process).
   * Also settable via `RPX_WORKERS`. On Linux the kernel load-balances accepted
   * connections across workers; on macOS `SO_REUSEPORT` doesn't, so it falls back
   * to effectively one active worker (still correct, just not parallel).
   */
  workers?: number
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
  /**
   * Snapshot of the on-demand sites this daemon is supervising (empty when
   * on-demand sites are disabled, or for the cluster coordinator / workers).
   */
  listSites: () => SiteSnapshot[]
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
  const auth = resolveAuth(entry.auth)
  if (entry.static) {
    return {
      static: resolveStaticRoute(entry.static, cleanUrls),
      cleanUrls,
      basePath,
      auth,
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
    auth,
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

async function bootstrapTls(opts: DaemonOptions, registryDir: string, extraHosts: string[] = [], force = false): Promise<SSLConfig> {
  const entries = await readAll(registryDir, opts.verbose)
  // `extraHosts` covers on-demand sites that are booting but haven't published a
  // registry route yet — so their "starting…" splash is served with a cert that
  // already names them (no browser warning before the app even loads).
  const registryHosts = [...new Set([...entries.map(e => e.to).filter(Boolean), ...extraHosts])]
  const primary = pickPrimaryRegistryHost(registryHosts)
  const hostnames = [...new Set([primary, ...registryHosts, 'rpx.localhost'])]

  const proxyOpts = buildRegistryTlsProxyOptions(registryHosts, primary, opts.verbose)
  if (typeof opts.https === 'object' && typeof proxyOpts.https === 'object')
    proxyOpts.https = { ...proxyOpts.https, ...opts.https }

  let sslConfig = await checkExistingCertificates(proxyOpts)
  // `force` regenerates even when the coverage check passes — needed for on-demand
  // hosts, because the dev cert's `*.localhost` wildcard makes the check think a
  // new `<app>.localhost` is already covered, yet Chrome rejects `*.localhost` and
  // demands an EXPLICIT per-host SAN. Forcing adds the host name literally.
  if (sslConfig && (force || !certIncludesSanHostnames(SHARED_DEV_HOST_CERT_PATH, hostnames))) {
    debugLog('daemon', `regenerating shared cert for host(s): ${hostnames.join(', ')}`, opts.verbose)
    clearSslConfigCache()
    sslConfig = null
  }

  if (!sslConfig) {
    debugLog('daemon', 'no usable cert on disk, generating one via tlsx', opts.verbose)
    await generateCertificate({ ...proxyOpts, forceRegenerate: true } as ProxyOptions & { forceRegenerate?: boolean })
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
  // Forward rpx/Stacks-rpx config env so on-demand-site overrides
  // (e.g. STACKS_RPX_SITE_ROOTS) survive the privileged re-exec — sudo otherwise
  // drops the environment. Passed as `env KEY=VAL` argv, so no shell-quoting risk.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'RPX_VERBOSE' && /^(?:RPX_|STACKS_RPX_)/.test(key))
      forwardedEnv.push(`${key}=${value}`)
  }

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
        // The supervisor lives in the elevated child too; not reachable here.
        listSites: () => [],
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
let crashGuardsInstalled = false

/**
 * A reverse proxy must outlive a single bad request. A stray uncaught exception
 * or unhandled rejection — a malformed upstream response, a registry-watcher
 * callback bug, a `void`-ed promise — would otherwise crash the whole daemon and
 * drop :443 for *every* host behind it. Log and keep serving; systemd still
 * restarts a genuinely fatal exit, but one bad request no longer takes the
 * gateway down. Idempotent so the worker/coordinator entry points can each call
 * it without stacking duplicate handlers.
 */
function installDaemonCrashGuards(): void {
  if (crashGuardsInstalled)
    return
  crashGuardsInstalled = true
  process.on('uncaughtException', (err) => {
    log.error(`rpx daemon: uncaught exception (continuing): ${(err as Error)?.stack ?? err}`)
  })
  process.on('unhandledRejection', (reason) => {
    log.error(`rpx daemon: unhandled rejection (continuing): ${reason}`)
  })
}

/**
 * The shared `:80` handler: serve ACME http-01 challenges, kick off on-demand
 * issuance for an approved-but-uncovered host, then 301 to HTTPS. The request
 * target is parsed defensively — scanners constantly send malformed/relative
 * targets, and a thrown `new URL` would reject the fetch handler and make Bun
 * drop the connection with no response. A bad target becomes a 400 instead.
 */
export function handleHttpRedirect(req: Request, onDemand: OnDemandCertManager | null, acmeChallengeWebroot?: string): Response {
  let u: URL
  try {
    u = new URL(req.url)
  }
  catch {
    return new Response('Bad Request', { status: 400 })
  }
  const host = (req.headers.get('host') ?? u.hostname).split(':')[0]

  if (u.pathname.startsWith('/.well-known/acme-challenge/')) {
    // On-demand TLS (rpx's own ACME client) keeps its tokens in memory.
    if (onDemand) {
      const keyAuth = onDemand.challengeStore.handlePath(u.pathname)
      if (keyAuth !== undefined)
        return new Response(keyAuth, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    // An external `tlsx acme:renew --webroot` drops tokens on disk. Serve those
    // too, independent of on-demand TLS, so webroot renewal works with no cert
    // manager running. Only redirect a challenge request once BOTH stores miss.
    if (acmeChallengeWebroot) {
      const keyAuth = readAcmeChallenge(acmeChallengeWebroot, u.pathname)
      if (keyAuth != null)
        return new Response(keyAuth, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (onDemand)
      return new Response('challenge not found', { status: 404 })
  }

  // First plaintext hit for an approved-but-uncovered host: kick off issuance so
  // the cert exists for the subsequent HTTPS request (don't block the redirect).
  if (onDemand && !onDemand.hasCert(host))
    onDemand.ensureCert(host).catch(() => {})

  return new Response(null, {
    status: 301,
    headers: { Location: `https://${host}${u.pathname}${u.search}` },
  })
}

// `opts` IS used throughout; pickier's no-unused-vars mis-fires on this fn after
// the on-demand serve refactor (its --fix would wrongly rename to `_opts`).
// eslint-disable-next-line pickier/no-unused-vars
export async function runDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  installDaemonCrashGuards()
  const verbose = opts.verbose ?? false
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const registryDir = opts.registryDir ?? path.join(rpxDir, 'registry.d')
  const httpsPort = opts.httpsPort ?? 443
  const httpPort = opts.httpPort ?? 80
  const hostname = opts.hostname ?? '0.0.0.0'
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS

  // A spawned cluster worker (RPX_DAEMON_WORKER=1) serves :443 only and is
  // configured entirely via RPX_WORKER_* env (set by the coordinator). Handled
  // before the privileged-port check because a worker never self-elevates — it
  // inherits the coordinator's privileges and gets its port from env.
  if (process.env.RPX_DAEMON_WORKER === '1') {
    return runDaemonWorker({
      rpxDir: process.env.RPX_WORKER_RPXDIR ?? rpxDir,
      registryDir: process.env.RPX_WORKER_REGISTRYDIR ?? registryDir,
      httpsPort: Number.parseInt(process.env.RPX_WORKER_HTTPSPORT ?? '', 10) || httpsPort,
      hostname: process.env.RPX_WORKER_HOSTNAME ?? hostname,
      verbose: process.env.RPX_WORKER_VERBOSE === '1' || verbose,
    })
  }

  // Privileged ports need root. If we were launched unprivileged (the usual
  // `./buddy dev` case), re-exec through sudo and hand off to the elevated
  // copy — it becomes the real daemon. Tests inject high ports and so skip this.
  const needsPrivilegedPort = (httpsPort > 0 && httpsPort < 1024) || (httpPort > 0 && httpPort < 1024)
  const alreadyRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (process.platform !== 'win32' && needsPrivilegedPort && !alreadyRoot)
    return elevateDaemonToRoot(rpxDir, httpsPort, httpPort, verbose)

  // Cluster coordinator: owns the singletons and spawns N workers that bind :443.
  const workers = Math.max(1, opts.workers ?? (Number.parseInt(process.env.RPX_WORKERS ?? '', 10) || 1))
  if (workers > 1) {
    if (opts.onDemandSites?.enabled)
      log.warn('rpx: on-demand sites are not supported in cluster mode (workers > 1); ignoring')
    return runDaemonCoordinator(opts, { rpxDir, registryDir, httpsPort, httpPort, hostname, verbose, gcIntervalMs, workers })
  }

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

  // On-demand sites (opt-in): when a request finds no live route, resolve the
  // host to a project, boot its dev server, and hold the request behind a
  // "starting…" splash until the freshly-published route goes live.
  // Hosts whose on-demand site is booting (but hasn't published a route yet) —
  // included in the dev cert SAN so their splash has a valid certificate.
  const onDemandCertHosts = new Set<string>()
  let supervisor: SiteSupervisor | null = null
  let onNoRoute: OnNoRoute | undefined
  if (opts.onDemandSites?.enabled) {
    supervisor = new SiteSupervisor({
      resolver: createSiteResolver(opts.onDemandSites),
      registryDir,
      rpxDir,
      verbose,
      startupTimeoutMs: opts.onDemandSites.startupTimeoutMs,
      // The routing table is rebuilt in place on every registry change; the
      // closure reads the current value so "is this host live yet?" stays fresh.
      isHostRoutable: host => matchHostList(routingTable, host) !== undefined,
      // Cover a booting host in the dev cert before its route exists.
      onSiteActivating: host => { void ensureHostInDevCert(host) },
    })
    onNoRoute = async (host) => {
      const status = await supervisor!.onRequest(host)
      switch (status.kind) {
        case 'ready':
          return { retry: true }
        case 'starting':
          return renderStartingPage({ host: status.host, sinceMs: status.sinceMs, logTail: status.logTail })
        case 'failed':
          return renderFailedPage({ host: status.host, error: status.error, logTail: status.logTail })
        case 'unknown':
        default:
          return undefined
      }
    }
    if (verbose)
      log.info('rpx: on-demand sites enabled')
  }

  const fetchHandler = createProxyFetchHandler(getRoute, verbose, onNoRoute)
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
  function tlsFor(entries: Array<{ serverName: string, cert: string, key: string }>): Bun.TLSOptions | Bun.TLSOptions[] {
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
      // Opt-in (RPX_REUSE_PORT): multi-instance :443 sharing on Linux. Off by
      // default — see shouldReusePort(). rpx never spawns its own cluster.
      reusePort: shouldReusePort(),
      tls: tlsFor(entries),
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

  const registryHostsForTls = (entries: RegistryEntry[]) =>
    [...new Set(entries.map(e => e.to).filter(Boolean))]

  const devTlsEntries = (entries: RegistryEntry[]) => {
    if (!devSslConfig)
      return sniTls
    return devSslToSniEntries([...registryHostsForTls(entries), ...onDemandCertHosts, 'rpx.localhost'], devSslConfig)
  }

  let httpsServer = serveHttps(
    onDemand
      ? onDemand.sniEntries()
      : (sniTls.length > 0 ? sniTls : devTlsEntries(initialEntries)),
  )

  /**
   * Bun has no working SNICallback and `server.reload({ tls })` does not update
   * certs at runtime (verified Bun 1.3.14/1.4.0). So to serve a freshly-issued
   * cert we tear the old listener down and re-bind with the augmented SNI set.
   * The rebind is sub-second; if the OS hasn't freed the port yet we retry on a
   * short async backoff. In-flight requests on the old listener drain
   * (`stop(false)`). Only ever invoked from the (async) issuance callback.
   */
  // Single-flight rebuild state. Concurrent on-demand issuances must never run
  // two `stop(false)`/`serveHttps()` swaps at once (they'd race the `httpsServer`
  // reference and could leave :443 unbound or serving a stale SNI set). Instead
  // we record the newest desired set and let one in-flight rebuild converge to it.
  let rebuildLatest: Array<{ serverName: string, cert: string, key: string }> | null = null
  let rebuilding = false

  async function rebuildTls(entries: Array<{ serverName: string, cert: string, key: string }>): Promise<void> {
    if (stopped)
      return
    rebuildLatest = entries // newest desired SNI set
    if (rebuilding)
      return // an in-flight rebuild will pick up `rebuildLatest` and converge
    rebuilding = true
    try {
      while (!stopped && rebuildLatest) {
        const target = rebuildLatest
        rebuildLatest = null
        debugLog('daemon', `rebuilding :443 with ${target.length} SNI cert(s)`, verbose)
        httpsServer.stop(false)
        let lastErr: unknown
        let rebound = false
        // A slow OS port release must not permanently unbind :443. Retry with
        // growing backoff for ~30s (25,50,100,200,400,then 500ms) instead of the
        // old 20×25ms (=0.5s), which gave up while the old socket was still held.
        const REBIND_MAX_ATTEMPTS = 60
        const REBIND_BACKOFF_CAP_MS = 500
        for (let attempt = 0; !stopped && !rebound; attempt++) {
          try {
            httpsServer = serveHttps(target)
            rebound = true
            break
          }
          catch (err) {
            // EADDRINUSE while the old socket releases — back off and retry.
            lastErr = err
            if (attempt >= REBIND_MAX_ATTEMPTS)
              break
            await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** Math.min(attempt, 4), REBIND_BACKOFF_CAP_MS)))
          }
        }
        if (!rebound)
          log.error(`rpx: CRITICAL — could not rebind :443 after ${REBIND_MAX_ATTEMPTS} attempts issuing cert; HTTPS unbound until the next cert event or a gateway restart: ${(lastErr as Error)?.message}`)
        // Loop: if a newer rebuild was requested mid-rebind, apply it next.
      }
    }
    finally {
      rebuilding = false
    }
  }

  let httpServer: ReturnType<typeof Bun.serve> | null = null
  if (httpPort > 0) {
    httpServer = Bun.serve({
      port: httpPort,
      hostname,
      fetch(req: Request) {
        return handleHttpRedirect(req, onDemand, opts.acmeChallengeWebroot)
      },
      error() {
        return new Response('Bad Request', { status: 400 })
      },
    })
  }

  if (verbose) {
    log.success(`rpx daemon listening on https://${hostname}:${httpsPort}${httpServer ? ` (http→https on :${httpPort})` : ''}`)
    log.info(`pid file: ${pidPath}`)
    log.info(`registry: ${registryDir}`)
  }

  async function syncDevTlsWithRegistry(entries: RegistryEntry[]): Promise<void> {
    if (stopped || sniTls.length > 0 || onDemand || !devSslConfig)
      return
    try {
      const refreshed = await bootstrapTls(opts, registryDir, [...onDemandCertHosts])
      devSslConfig = refreshed
      await rebuildTls(devTlsEntries(entries))
    }
    catch (err) {
      debugLog('daemon', `TLS sync on registry change failed: ${err}`, verbose)
    }
  }

  /**
   * Ensure the dev cert names `host` now — called when an on-demand site begins
   * booting, so its "starting…" splash is served with a valid certificate before
   * the site has published any route. No-op in real-SNI / on-demand-TLS modes, or
   * when the host is already covered.
   */
  async function ensureHostInDevCert(host: string): Promise<void> {
    if (stopped || sniTls.length > 0 || onDemand || !devSslConfig || !host)
      return
    if (onDemandCertHosts.has(host))
      return
    onDemandCertHosts.add(host)
    try {
      // Force regeneration so the host gets an EXPLICIT SAN (the cert's
      // `*.localhost` wildcard would otherwise satisfy the coverage check while
      // Chrome still rejects it).
      devSslConfig = await bootstrapTls(opts, registryDir, [...onDemandCertHosts], true)
      const entries = await readAll(registryDir, verbose)
      await rebuildTls(devTlsEntries(entries))
    }
    catch (err) {
      debugLog('daemon', `dev cert refresh for ${host} failed: ${err}`, verbose)
    }
  }

  const watcher = watchRegistry(
    (entries) => {
      rebuild(entries)
      void syncDevTlsWithRegistry(entries)
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
    // Stop any on-demand sites we booted (and deregister their routes) before
    // tearing the listeners down.
    await supervisor?.stopAll().catch((err) => {
      debugLog('daemon', `site supervisor stopAll failed: ${err}`, verbose)
    })
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
    listSites: () => supervisor?.list() ?? [],
  }
}

// ───────────────────────── cluster: coordinator + workers ─────────────────────

interface WorkerCtx {
  rpxDir: string
  registryDir: string
  httpsPort: number
  hostname: string
  verbose: boolean
}

interface CoordinatorCtx extends WorkerCtx {
  httpPort: number
  gcIntervalMs: number
  workers: number
}

type SniEntry = { serverName: string, cert: string, key: string }
interface ClusterSni { sni: SniEntry[], dev: { key: string, cert: string, ca?: string } | null }

/** Path of the file the coordinator publishes the live SNI set to for workers. */
function clusterSniPath(rpxDir: string): string {
  return path.join(rpxDir, 'cluster-sni.json')
}

/** Atomically publish the current cert material so a worker never reads a partial file. */
async function writeClusterSni(rpxDir: string, sni: SniEntry[], dev: ClusterSni['dev']): Promise<void> {
  const target = clusterSniPath(rpxDir)
  const tmp = `${target}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ sni, dev } satisfies ClusterSni), 'utf8')
  await fsp.rename(tmp, target)
}

async function readClusterSni(rpxDir: string): Promise<ClusterSni> {
  try {
    return JSON.parse(await fsp.readFile(clusterSniPath(rpxDir), 'utf8')) as ClusterSni
  }
  catch {
    return { sni: [], dev: null }
  }
}

/** Build the Bun.serve `tls` option from a published SNI set (or the dev fallback). */
function clusterTlsFor(cfg: ClusterSni): Bun.TLSOptions | Bun.TLSOptions[] | undefined {
  if (cfg.sni.length > 0)
    return cfg.sni.map(e => ({ serverName: e.serverName, cert: e.cert, key: e.key }))
  if (cfg.dev)
    return { key: cfg.dev.key, cert: cfg.dev.cert, ca: cfg.dev.ca, requestCert: false, rejectUnauthorized: false }
  return undefined // no certs published yet; handshakes fail until the first SIGHUP reload
}

/**
 * Command used to re-exec this process as a cluster worker. `RPX_WORKER_BIN`
 * overrides the script path — needed when `argv[1]` isn't the rpx entrypoint
 * (e.g. under a test runner, or an unusual deployment layout).
 */
function workerSpawnCommand(): string[] {
  const exec = process.execPath
  const binOverride = process.env.RPX_WORKER_BIN
  if (binOverride)
    return [exec, binOverride, 'daemon:start']
  const interpName = path.basename(exec).toLowerCase()
  const isInterpreter = interpName === 'bun' || interpName === 'node' || interpName.startsWith('bun-')
  if (isInterpreter && process.argv[1])
    return [exec, process.argv[1], 'daemon:start']
  return [exec, 'daemon:start']
}

/**
 * A cluster worker: binds :443 with `reusePort`, serves the proxy handler, keeps
 * its routing table in sync with the registry, and reloads its TLS certs from
 * the coordinator-published file on `SIGHUP`. It owns none of the singletons
 * (lock, DNS, hosts, :80, ACME issuance) — the coordinator does.
 */
export async function runDaemonWorker(ctx: WorkerCtx): Promise<DaemonHandle> {
  installDaemonCrashGuards()
  const { rpxDir, registryDir, httpsPort, hostname, verbose } = ctx

  let routingTable: HostRoutes<ProxyRoute> = new Map()
  const getRoute = (host: string, pathname: string): ProxyRoute | undefined =>
    matchHostRoute(routingTable, host, pathname)
  const rebuild = (entries: RegistryEntry[]): void => {
    routingTable = buildHostRoutes(entries.map(e => ({ host: e.to, path: e.path, route: entryToRoute(e) })))
  }
  rebuild(await readAll(registryDir, verbose))

  const fetchHandler = createProxyFetchHandler(getRoute, verbose)
  const wsHandler = createProxyWebSocketHandler(verbose)

  let stopped = false
  const serve = (cfg: ClusterSni): ReturnType<typeof Bun.serve> => Bun.serve({
    port: httpsPort,
    hostname,
    reusePort: true, // workers share :443; the kernel load-balances (on Linux)
    tls: clusterTlsFor(cfg),
    fetch(req: Request, server: unknown) {
      return fetchHandler(req, server as ProxyServerLike)
    },
    websocket: wsHandler,
    error(err: Error) {
      debugLog('daemon', `worker https error: ${err}`, verbose)
      return new Response(`Server Error: ${err.message}`, { status: 500 })
    },
  })

  let httpsServer = serve(await readClusterSni(rpxDir))

  // Bun can't hot-swap TLS, so reload = tear down + re-bind with the new certs
  // (same approach as the solo daemon's rebuildTls). reusePort keeps the rebind
  // from racing sibling workers off the port.
  async function reloadTls(): Promise<void> {
    if (stopped)
      return
    const cfg = await readClusterSni(rpxDir)
    // reusePort lets us bind the NEW listener *before* tearing the old one down,
    // so there is never a window with no listener on :443 (atomic swap). A SIGHUP
    // storm across siblings can't briefly black-hole the port any more.
    let next: ReturnType<typeof Bun.serve> | null = null
    for (let attempt = 0; attempt < 20 && !stopped; attempt++) {
      try {
        next = serve(cfg)
        break
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    if (!next) {
      debugLog('daemon', 'worker reloadTls: could not bind new listener; keeping current', verbose)
      return
    }
    const old = httpsServer
    httpsServer = next
    old.stop(false) // drain the old listener now that the new one is live
  }

  const watcher = watchRegistry(entries => rebuild(entries), { dir: registryDir, verbose })
  const onHup = (): void => { reloadTls().catch(() => {}) }
  process.on('SIGHUP', onHup)

  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  async function stop(): Promise<void> {
    if (stopped)
      return done
    stopped = true
    process.off('SIGHUP', onHup)
    watcher.close()
    httpsServer.stop(false)
    resolveDone()
    return done
  }
  const onSignal = (): void => { stop().then(() => process.exit(0)).catch(() => process.exit(0)) }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  if (verbose)
    log.success(`rpx worker (pid ${process.pid}) serving :${httpsPort}`)

  return {
    stop,
    done,
    httpsPort: typeof httpsServer.port === 'number' ? httpsServer.port : httpsPort,
    httpPort: 0,
    pidPath: '',
    ensureCert: () => Promise.resolve(false),
    listSites: () => [],
  }
}

/**
 * The cluster coordinator: owns the lock, certs, DNS, hosts, registry GC, and the
 * :80 listener (ACME http-01 + HTTP→HTTPS redirect). It does NOT bind :443 —
 * instead it spawns {@link CoordinatorCtx.workers} worker processes that do, and
 * republishes the SNI set (+ SIGHUPs the workers) whenever an on-demand cert is
 * issued. Workers that crash are respawned.
 */
async function runDaemonCoordinator(opts: DaemonOptions, ctx: CoordinatorCtx): Promise<DaemonHandle> {
  installDaemonCrashGuards()
  const { rpxDir, registryDir, httpsPort, httpPort, hostname, verbose, gcIntervalMs, workers } = ctx
  const pidPath = await acquireDaemonLock(rpxDir)

  // Bootstrap certs to disk + assemble the initial SNI set.
  let sniTls: SniEntry[] = []
  if (opts.productionCerts)
    sniTls = await buildSniTlsConfig(opts.productionCerts, verbose)
  let devSslConfig: SSLConfig | null = null
  if (sniTls.length === 0)
    devSslConfig = await bootstrapTls(opts, registryDir)
  const dev: ClusterSni['dev'] = devSslConfig
    ? { key: devSslConfig.key, cert: devSslConfig.cert, ca: Array.isArray(devSslConfig.ca) ? devSslConfig.ca.join('\n') : devSslConfig.ca }
    : null

  let stopped = false
  const procs: import('bun').Subprocess[] = []
  function signalWorkers(sig: NodeJS.Signals): void {
    for (const p of procs) {
      try { p.kill(sig) }
      catch { /* already gone */ }
    }
  }
  /** Republish certs then tell workers to reload. */
  async function publishSni(entries: SniEntry[]): Promise<void> {
    await writeClusterSni(rpxDir, entries, dev)
    signalWorkers('SIGHUP')
  }

  // On-demand TLS lives on the coordinator (it owns :80 + ACME). New certs are
  // republished to the workers.
  const onDemandCfg = opts.onDemandTls
  const onDemand: OnDemandCertManager | null = onDemandCfg?.enabled
    ? new OnDemandCertManager({
        config: onDemandCfg,
        certsDir: onDemandCfg.certsDir ?? opts.productionCerts?.certsDir ?? path.join(rpxDir, 'on-demand-certs'),
        initial: sniTls,
        verbose,
        onCertAdded: entries => { void publishSni(entries) },
      })
    : null

  await writeClusterSni(rpxDir, onDemand ? onDemand.sniEntries() : sniTls, dev)

  // DNS + hosts + registry GC (workers handle routing themselves).
  const initialEntries = await readAll(registryDir, verbose)
  await reconcileStaleDevelopmentDns({ rpxDir, verbose }).catch((err) => {
    debugLog('daemon', `DNS reconcile on start failed: ${err}`, verbose)
  })
  await syncDevelopmentDnsFromRegistry(initialEntries, { rpxDir, verbose, ownerPid: process.pid }).catch((err) => {
    debugLog('daemon', `DNS setup on start failed: ${err}`, verbose)
  })
  await gcStaleEntries(registryDir, verbose).catch(() => {})
  const watcher = watchRegistry(
    (entries) => {
      syncDevelopmentDnsFromRegistry(entries, { rpxDir, verbose, ownerPid: process.pid }).catch((err) => {
        debugLog('daemon', `DNS sync on registry change failed: ${err}`, verbose)
      })
    },
    { dir: registryDir, verbose },
  )
  const gcInterval = setInterval(() => {
    gcStaleEntries(registryDir, verbose).catch(() => {})
  }, gcIntervalMs)
  gcInterval.unref?.()

  // :80 — ACME http-01 challenges + HTTP→HTTPS redirect (kicks off on-demand).
  let httpServer: ReturnType<typeof Bun.serve> | null = null
  if (httpPort > 0) {
    httpServer = Bun.serve({
      port: httpPort,
      hostname,
      fetch(req: Request) {
        return handleHttpRedirect(req, onDemand, opts.acmeChallengeWebroot)
      },
      error() {
        return new Response('Bad Request', { status: 400 })
      },
    })
  }

  // Crash-loop guard: a worker that dies on startup (bad cert, port held
  // exclusively, OOM) must not be respawned in a tight fork loop. Count restarts
  // in a rolling window, back off exponentially, and give up past a threshold.
  const MAX_RESTARTS = 10
  const RESTART_WINDOW_MS = 60_000
  const MAX_BACKOFF_MS = 30_000
  let restartCount = 0
  let restartWindowStart = Date.now()

  // Spawn (and keep alive) the workers.
  function spawnWorker(): void {
    if (stopped)
      return
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      RPX_DAEMON_WORKER: '1',
      RPX_WORKERS: '1', // the child must not recurse into coordinator mode
      RPX_WORKER_RPXDIR: rpxDir,
      RPX_WORKER_REGISTRYDIR: registryDir,
      RPX_WORKER_HTTPSPORT: String(httpsPort),
      RPX_WORKER_HOSTNAME: hostname,
      RPX_WORKER_VERBOSE: verbose ? '1' : '0',
    }
    const proc = Bun.spawn(workerSpawnCommand(), {
      env,
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'ignore',
      onExit(exited, code) {
        if (stopped)
          return
        // Prune the dead handle so `procs` only ever holds live workers.
        const idx = procs.indexOf(exited)
        if (idx !== -1)
          procs.splice(idx, 1)

        const now = Date.now()
        if (now - restartWindowStart > RESTART_WINDOW_MS) {
          restartWindowStart = now
          restartCount = 0
        }
        restartCount++
        if (restartCount > MAX_RESTARTS) {
          log.error(`rpx: worker keeps exiting (code ${code}); giving up after ${MAX_RESTARTS} restarts in ${Math.round(RESTART_WINDOW_MS / 1000)}s`)
          return
        }
        const backoff = Math.min(MAX_BACKOFF_MS, 100 * 2 ** Math.min(restartCount, 8))
        debugLog('daemon', `worker exited (code ${code}); respawning in ${backoff}ms (restart ${restartCount}/${MAX_RESTARTS})`, verbose)
        const t = setTimeout(spawnWorker, backoff)
        t.unref?.()
      },
    })
    procs.push(proc)
  }
  for (let i = 0; i < workers; i++)
    spawnWorker()

  if (verbose) {
    log.success(`rpx coordinator listening on https://${hostname}:${httpsPort} via ${workers} worker(s)${httpServer ? ` (http→https on :${httpPort})` : ''}`)
    log.info(`pid file: ${pidPath}`)
  }

  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  async function stop(): Promise<void> {
    if (stopped)
      return done
    stopped = true
    clearInterval(gcInterval)
    watcher.close()
    httpServer?.stop(false)
    signalWorkers('SIGTERM')
    await Promise.race([
      Promise.all(procs.map(p => p.exited)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
    signalWorkers('SIGKILL')
    await tearDownDevelopmentDns({ rpxDir, verbose }).catch((err) => {
      debugLog('daemon', `DNS teardown failed: ${err}`, verbose)
    })
    await releaseDaemonLock(rpxDir)
    await fsp.unlink(clusterSniPath(rpxDir)).catch(() => {})
    if (verbose)
      log.info('rpx coordinator stopped')
    resolveDone()
    return done
  }
  const onSignal = (sig: NodeJS.Signals): void => {
    debugLog('daemon', `coordinator received ${sig}, shutting down`, verbose)
    stop().catch(() => {})
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return {
    stop,
    done,
    httpsPort,
    httpPort,
    pidPath,
    ensureCert: (host: string) => (onDemand ? onDemand.ensureCert(host) : Promise.resolve(false)),
    listSites: () => [],
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
