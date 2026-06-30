/**
 * The on-demand site supervisor: boots a project's dev server the first time its
 * host is visited, holds the request behind a "starting…" splash until the
 * site's ready gate passes, publishes the routes so the daemon proxies it, and
 * stops the process again after an idle period.
 *
 * Lifecycle for an rpx-managed site (the common case):
 *   1. `onRequest(host)` resolves the host to a {@link ResolvedSite}; on the first
 *      hit it picks a free port per backend, spawns the dev command (its own
 *      process group, output to a per-site log), and returns `{ kind: 'starting' }`.
 *   2. A background readiness loop probes the `readyGate` ports until they answer
 *      (or the startup deadline / an early process exit fails the site).
 *   3. On ready it writes the registry entry (host → frontend port, with
 *      `pathRewrites` for the other backends) and waits for the daemon's routing
 *      table to pick it up; subsequent requests route normally.
 *   4. An idle reaper SIGTERMs the process group (→ SIGKILL) and removes the
 *      registry entry once `idleTimeoutMs` elapses with no traffic.
 *
 * A `selfRegisters` site skips port injection + route publishing — rpx only
 * boots the command (which writes its own registry entries) and reaps it on idle;
 * readiness is "the host became routable".
 *
 * Everything external — process launch, port probing, port selection, the clock,
 * registry writes, the routability check — is dependency-injected so the whole
 * state machine is unit-testable without spawning a process or binding a port.
 */
import type { ResolvedSite, SiteResolver } from './site-resolver'
import type { RegistryEntry } from './registry'
import type { PathRewrite } from './types'
import { closeSync, openSync, readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { normalizePathPrefix } from './host-routes'
import { findAvailablePort } from './port-manager'
import { getRegistryDir, removeEntry as defaultRemoveEntry, writeEntry as defaultWriteEntry } from './registry'
import { debugLog } from './utils'
import { log } from './logger'

/** A launched site process, abstracted so tests can inject a fake. */
export interface SiteProcessHandle {
  /** OS pid of the launched process (its own group leader). */
  pid: number
  /** Resolves with the exit code (or `null`) when the process exits. */
  exited: Promise<number | null>
  /** Send a signal to the process group. */
  stop: (signal?: NodeJS.Signals) => void
}

/** Spawn a site's dev command. Injected for tests; default spawns a shell. */
export type SiteLauncher = (spec: {
  command: string
  cwd: string
  env: Record<string, string>
  logPath: string
}) => SiteProcessHandle

export type SiteRequestStatus =
  | { kind: 'unknown' }
  | { kind: 'starting', host: string, sinceMs: number, source: 'config' | 'discovered', logTail: string }
  | { kind: 'ready', host: string }
  | { kind: 'failed', host: string, error: string, logTail: string }

/** A point-in-time view of one supervised site, for `rpx sites` / status. */
export interface SiteSnapshot {
  host: string
  dir: string
  status: 'starting' | 'ready' | 'failed'
  pid: number | null
  ports: Record<string, number>
  uptimeMs: number
  idleMs: number
  error?: string
}

export interface SiteSupervisorOptions {
  resolver: SiteResolver
  /** Registry directory shared with the daemon. Defaults to the rpx registry dir. */
  registryDir?: string
  /** rpx state dir; per-site logs go under `<rpxDir>/sites`. Defaults to `~/.stacks/rpx`. */
  rpxDir?: string
  verbose?: boolean
  /** Max ms to wait for the ready gate before failing the site. Default 120s. */
  startupTimeoutMs?: number
  /** Ready-gate poll interval (ms). Default 200. */
  pollIntervalMs?: number
  /** Idle-reaper sweep interval (ms). Default 30s. */
  reapIntervalMs?: number
  /** After a failure, ms before a new request restarts the site. Default 3s. */
  restartDelayMs?: number
  /** Grace before SIGTERM escalates to SIGKILL when stopping a site. Default 4s. */
  killGraceMs?: number
  // ── injection seams ──
  launcher?: SiteLauncher
  /** Probe whether a TCP port answers. Default {@link testPortConnectivity}. */
  probePort?: (port: number) => Promise<boolean>
  /** Pick a free port at/after `preferred`. Default {@link findAvailablePort}. */
  pickPort?: (preferred: number) => Promise<number>
  /** True when the daemon's routing table already covers `host`. */
  isHostRoutable?: (host: string) => boolean
  /**
   * Called when a site begins booting, before its route exists — lets the daemon
   * add the host to the dev cert SAN so even the "starting…" splash is served with
   * a valid certificate (no browser warning before the app loads).
   */
  onSiteActivating?: (host: string) => void
  now?: () => number
  writeEntry?: (entry: RegistryEntry, dir?: string, verbose?: boolean) => Promise<void>
  removeEntry?: (id: string, dir?: string, verbose?: boolean) => Promise<void>
}

interface SiteState {
  site: ResolvedSite
  status: 'starting' | 'ready' | 'failed'
  handle: SiteProcessHandle | null
  ports: Map<string, number>
  routeIds: string[]
  startedAt: number
  lastAccess: number
  failedAt: number
  error?: string
  logPath: string
  /** Set once the process has exited (so the readiness loop stops probing). */
  exited: boolean
  ready: Promise<void>
}

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_REAP_INTERVAL_MS = 30_000
const DEFAULT_RESTART_DELAY_MS = 3_000
const KILL_GRACE_MS = 4_000

export class SiteSupervisor {
  private readonly resolver: SiteResolver
  private readonly registryDir: string
  private readonly rpxDir: string
  private readonly verbose: boolean
  private readonly startupTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly restartDelayMs: number
  private readonly killGraceMs: number
  private readonly launch: SiteLauncher
  private readonly probePort: (port: number) => Promise<boolean>
  private readonly pickPort: (preferred: number) => Promise<number>
  private readonly isHostRoutable: (host: string) => boolean
  private readonly onSiteActivating?: (host: string) => void
  private readonly now: () => number
  private readonly writeEntry: (entry: RegistryEntry, dir?: string, verbose?: boolean) => Promise<void>
  private readonly removeEntry: (id: string, dir?: string, verbose?: boolean) => Promise<void>

  private readonly sites = new Map<string, SiteState>()
  private readonly reaper: ReturnType<typeof setInterval>
  private stopped = false

  constructor(opts: SiteSupervisorOptions) {
    this.resolver = opts.resolver
    this.registryDir = opts.registryDir ?? getRegistryDir()
    this.rpxDir = opts.rpxDir ?? path.join(homedir(), '.stacks', 'rpx')
    this.verbose = opts.verbose ?? false
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.restartDelayMs = opts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS
    this.launch = opts.launcher ?? makeDefaultLauncher(this.verbose)
    this.probePort = opts.probePort ?? defaultReadinessProbe
    this.pickPort = opts.pickPort ?? (preferred => findAvailablePort(preferred, '127.0.0.1'))
    this.isHostRoutable = opts.isHostRoutable ?? (() => false)
    this.onSiteActivating = opts.onSiteActivating
    this.now = opts.now ?? Date.now
    this.writeEntry = opts.writeEntry ?? defaultWriteEntry
    this.removeEntry = opts.removeEntry ?? defaultRemoveEntry

    const reapInterval = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS
    this.reaper = setInterval(() => { void this.reapIdle() }, reapInterval)
    if (typeof this.reaper.unref === 'function')
      this.reaper.unref()
  }

  /**
   * Entry point for the daemon's no-route fallback. Resolves the host to a site,
   * boots it on first hit, and returns the current status (never blocks for the
   * full boot — the splash polls). `{ kind: 'unknown' }` means "not an on-demand
   * host" (fall through to 404).
   */
  async onRequest(host: string): Promise<SiteRequestStatus> {
    if (this.stopped)
      return { kind: 'unknown' }

    let state = this.sites.get(host)

    // A failed site retries on the next request once the restart delay elapses,
    // so a browser refresh is all it takes to try again after fixing the cause.
    if (state && state.status === 'failed' && this.now() - state.failedAt >= this.restartDelayMs) {
      this.sites.delete(host)
      state = undefined
    }

    if (!state) {
      const site = this.resolver.resolve(host)
      if (!site)
        return { kind: 'unknown' }
      state = await this.start(site)
    }

    state.lastAccess = this.now()

    if (state.status === 'ready')
      return { kind: 'ready', host }
    if (state.status === 'failed')
      return { kind: 'failed', host, error: state.error ?? 'failed to start', logTail: this.readLogTail(state) }
    return { kind: 'starting', host, sinceMs: this.now() - state.startedAt, source: state.site.source, logTail: this.readLogTail(state, 16) }
  }

  /** Boot a site: pick ports, spawn the command, and kick off the readiness loop. */
  private async start(site: ResolvedSite): Promise<SiteState> {
    // Tell the daemon to cover this host in the dev cert now, so the splash that's
    // about to be served already has a matching certificate.
    try {
      this.onSiteActivating?.(site.host)
    }
    catch { /* best-effort cert pre-warm */ }

    const ports = new Map<string, number>()
    if (!site.selfRegisters) {
      // Distinct free port per env name; routes that share an env share a port.
      for (const route of site.routes) {
        if (ports.has(route.portEnv))
          continue
        const port = await this.pickPort(route.defaultPort ?? 3000)
        ports.set(route.portEnv, port)
      }
    }

    const logPath = path.join(this.rpxDir, 'sites', `${site.id}.log`)
    await fsp.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {})

    const env = this.buildEnv(site, ports)
    let handle: SiteProcessHandle | null = null
    let startError: string | undefined
    try {
      handle = this.launch({ command: site.command, cwd: site.dir, env, logPath })
    }
    catch (err) {
      startError = `failed to spawn: ${(err as Error).message}`
    }

    const state: SiteState = {
      site,
      status: startError ? 'failed' : 'starting',
      handle,
      ports,
      routeIds: [],
      startedAt: this.now(),
      lastAccess: this.now(),
      failedAt: startError ? this.now() : 0,
      error: startError,
      logPath,
      exited: false,
      ready: Promise.resolve(),
    }
    this.sites.set(site.host, state)

    if (startError) {
      log.warn(`rpx: site ${site.host} ${startError}`)
      return state
    }

    log.info(`rpx: booting ${site.host} → ${site.command} (${site.dir})`)
    // One exit handler for the whole lifetime: fail a site that dies before it's
    // ready, or — once it's live — drop its route so the next visit reboots it.
    handle!.exited.then(code => this.onProcessExit(state, code)).catch(() => {})
    state.ready = this.driveReadiness(state).catch((err) => {
      debugLog('sites', `readiness loop for ${site.host} threw: ${err}`, this.verbose)
    })
    return state
  }

  /**
   * React to a site process exiting. If we initiated the stop (idle reap /
   * shutdown drop the state first) there's nothing to do. A still-booting site
   * fails; a live one has its route removed and state cleared so the next request
   * reboots it cleanly — a crashed dev server self-heals on the next visit.
   */
  private async onProcessExit(state: SiteState, code: number | null): Promise<void> {
    state.exited = true
    if (this.stopped || this.sites.get(state.site.host) !== state)
      return
    if (state.status === 'ready') {
      log.warn(`rpx: ${state.site.host} exited${code !== null ? ` (code ${code})` : ''} — will reboot on next request`)
      this.sites.delete(state.site.host)
      for (const id of state.routeIds)
        await this.removeEntry(id, this.registryDir, this.verbose).catch(() => {})
    }
    else if (state.status === 'starting') {
      this.fail(state, `process exited${code !== null ? ` with code ${code}` : ''} before becoming ready`)
    }
  }

  /** Probe the ready gate, publish routes, and flip the site to `ready` (or `failed`). */
  private async driveReadiness(state: SiteState): Promise<void> {
    const { site } = state
    const deadline = this.now() + this.startupTimeoutMs

    const ready = site.selfRegisters
      ? () => this.isHostRoutable(site.host)
      : await this.makeGateProbe(site, state.ports)

    while (this.now() < deadline && !this.stopped) {
      // `onProcessExit` fails/clears the state if the process died; stop probing.
      if (state.status !== 'starting' || state.exited)
        return
      if (await ready()) {
        await this.publishRoutes(state)
        if (state.status === 'starting') {
          state.status = 'ready'
          log.success(`rpx: ${site.host} ready`)
        }
        return
      }
      await delay(this.pollIntervalMs)
    }

    if (state.status === 'starting')
      this.fail(state, `did not become ready within ${Math.round(this.startupTimeoutMs / 1000)}s`)
  }

  /** A predicate that's true once every ready-gate backend's port answers. */
  private async makeGateProbe(site: ResolvedSite, ports: Map<string, number>): Promise<() => Promise<boolean>> {
    const gatePorts = site.routes
      .filter(r => r.readyGate ?? (normalizePathPrefix(r.path) === '/'))
      .map(r => ports.get(r.portEnv))
      .filter((p): p is number => typeof p === 'number')
    // No explicit gate (e.g. all backends opted out) → gate on every port.
    const probePorts = gatePorts.length > 0 ? gatePorts : [...ports.values()]
    return async () => {
      for (const port of probePorts) {
        if (!(await this.probePort(port)))
          return false
      }
      return probePorts.length > 0
    }
  }

  /**
   * Write the registry entry for a ready rpx-managed site (host → frontend port,
   * with `pathRewrites` for the other backends), then wait for the daemon's table
   * to pick it up so the triggering request can be retried seamlessly.
   */
  private async publishRoutes(state: SiteState): Promise<void> {
    const { site, ports } = state
    if (site.selfRegisters || site.routes.length === 0)
      return

    const defaultRoute = site.routes.find(r => normalizePathPrefix(r.path) === '/') ?? site.routes[0]
    const fromPort = ports.get(defaultRoute.portEnv)
    if (fromPort === undefined)
      return

    const pathRewrites: PathRewrite[] = []
    for (const route of site.routes) {
      if (route === defaultRoute)
        continue
      const port = ports.get(route.portEnv)
      if (port === undefined)
        continue
      pathRewrites.push({
        from: normalizePathPrefix(route.path),
        to: `localhost:${port}`,
        stripPrefix: route.stripPrefix ?? false,
      })
    }

    const entry: RegistryEntry = {
      id: site.id,
      from: `localhost:${fromPort}`,
      to: site.host,
      cwd: site.dir,
      createdAt: new Date(this.now()).toISOString(),
      pathRewrites: pathRewrites.length > 0 ? pathRewrites : undefined,
      // Owned by the site process: if the dev server dies, the daemon's PID-GC
      // reaps this route automatically (we also remove it explicitly on idle).
      pid: state.handle?.pid,
    }
    await this.writeEntry(entry, this.registryDir, this.verbose)
    state.routeIds = [site.id]

    // Give the daemon's registry watcher a moment to fold the entry into its
    // routing table, so the request that triggered the boot retries into a live
    // route instead of bouncing off the splash again.
    const tableDeadline = this.now() + 2_000
    while (this.now() < tableDeadline && !this.isHostRoutable(site.host)) {
      await delay(50)
    }
  }

  private fail(state: SiteState, error: string): void {
    state.status = 'failed'
    state.error = error
    state.failedAt = this.now()
    log.warn(`rpx: site ${state.site.host} failed — ${error}`)
    // Tear the process down so a retry starts clean.
    void this.killProcess(state)
  }

  /** Build the child env: process env + site env + injected ports. */
  private buildEnv(site: ResolvedSite, ports: Map<string, number>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string')
        env[k] = v
    }
    Object.assign(env, site.env)
    for (const [name, port] of ports)
      env[name] = String(port)
    env.RPX_SITE_HOST = site.host
    env.RPX_SITE_URL = `https://${site.host}`
    return env
  }

  private readLogTail(state: SiteState, lines = 40): string {
    try {
      const text = readFileSync(state.logPath, 'utf8')
      return text.split('\n').slice(-lines).join('\n').trim()
    }
    catch {
      return ''
    }
  }

  /** Stop one site: remove its published routes, then kill its process group. */
  async stop(host: string): Promise<void> {
    const state = this.sites.get(host)
    if (!state)
      return
    this.sites.delete(host)
    // Deregister the route first so the daemon stops handing traffic to a process
    // we're about to kill (a stale route → connection-refused → 502 window).
    for (const id of state.routeIds)
      await this.removeEntry(id, this.registryDir, this.verbose).catch(() => {})
    await this.killProcess(state)
    log.info(`rpx: stopped ${host}`)
  }

  private async killProcess(state: SiteState): Promise<void> {
    const handle = state.handle
    if (!handle)
      return
    state.handle = null
    try {
      handle.stop('SIGTERM')
    }
    catch { /* already gone */ }
    const timer = setTimeout(() => {
      try {
        handle.stop('SIGKILL')
      }
      catch { /* already gone */ }
    }, this.killGraceMs)
    if (typeof timer.unref === 'function')
      timer.unref()
    await Promise.race([handle.exited.catch(() => {}), delay(this.killGraceMs + 500)])
    clearTimeout(timer)
  }

  /** Stop sites idle past their timeout. */
  private async reapIdle(): Promise<void> {
    if (this.stopped)
      return
    const now = this.now()
    for (const [host, state] of this.sites) {
      const idle = state.site.idleTimeoutMs
      if (idle <= 0)
        continue
      const idleFor = now - state.lastAccess
      // A still-booting site only reaps once it has also blown the startup budget.
      const settled = state.status === 'ready' || now - state.startedAt > this.startupTimeoutMs
      if (settled && idleFor > idle) {
        debugLog('sites', `reaping ${host} (idle ${Math.round(idleFor / 1000)}s)`, this.verbose)
        await this.stop(host)
      }
    }
  }

  /** A snapshot of every supervised site, for status output. */
  list(): SiteSnapshot[] {
    const now = this.now()
    return [...this.sites.values()].map(s => ({
      host: s.site.host,
      dir: s.site.dir,
      status: s.status,
      pid: s.handle?.pid ?? null,
      ports: Object.fromEntries(s.ports),
      uptimeMs: now - s.startedAt,
      idleMs: now - s.lastAccess,
      error: s.error,
    }))
  }

  /** Stop the reaper and every running site (daemon shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true
    clearInterval(this.reaper)
    await Promise.allSettled([...this.sites.keys()].map(host => this.stop(host)))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Default readiness probe: an HTTP GET to the port that resolves `true` on ANY
 * response (200, 404, 500 — we only care that the server is *fielding* requests,
 * not what it answers). A plain TCP probe is fooled by dev servers (stx,
 * bun-router, Vite) that hold the socket in LISTEN for a moment — or while the
 * first request compiles — before the handler is wired, which would publish the
 * route too early and bounce the first real request off a 502.
 */
async function defaultReadinessProbe(port: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: 'manual' })
    return true
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Default launcher: spawn the dev command via a shell in its own process group,
 * append output to the per-site log. When the daemon runs as root (it self-elevated
 * to bind :443), drop to the invoking user (`SUDO_UID`/`SUDO_GID`) so the dev
 * server's files aren't created root-owned.
 */
function makeDefaultLauncher(verbose: boolean): SiteLauncher {
  const drop = privilegeDrop()
  return ({ command, cwd, env, logPath }) => {
    const fd = openSync(logPath, 'a')
    try {
      const child = spawn('sh', ['-c', command], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', fd, fd],
        ...(drop ? { uid: drop.uid, gid: drop.gid } : {}),
      })
      const pid = child.pid
      if (pid === undefined)
        throw new Error('spawn returned no pid')
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => { resolve(code) })
        child.once('error', () => { resolve(null) })
      }).finally(() => {
        try {
          closeSync(fd)
        }
        catch { /* already closed */ }
      })
      debugLog('sites', `spawned pid ${pid}: sh -c ${command} (cwd ${cwd})`, verbose)
      return {
        pid,
        exited,
        stop: (signal = 'SIGTERM') => {
          // Negative pid → signal the whole process group (dev servers fork
          // children: frontend/api/docs). Fall back to the leader if that fails.
          try {
            process.kill(-pid, signal)
          }
          catch {
            try {
              child.kill(signal)
            }
            catch { /* already gone */ }
          }
        },
      }
    }
    catch (err) {
      try {
        closeSync(fd)
      }
      catch { /* ignore */ }
      throw err
    }
  }
}

/** uid/gid to drop to when running elevated, or `null` when not applicable. */
function privilegeDrop(): { uid: number, gid: number } | null {
  if (process.platform === 'win32')
    return null
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (!isRoot)
    return null
  const uid = Number.parseInt(process.env.SUDO_UID ?? '', 10)
  const gid = Number.parseInt(process.env.SUDO_GID ?? '', 10)
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0)
    return null
  return { uid, gid }
}
