/**
 * Bridges the `startProxy` / `startProxies` entrypoints to the long-running
 * rpx daemon. When `viaDaemon: true` is set on a proxy config (or
 * `--via-daemon` is passed to the CLI), we don't bind our own `:443` —
 * instead we:
 *
 *   1. Write a registry entry per proxy under `~/.stacks/rpx/registry.d`.
 *   2. Ensure the daemon is running (lazy-spawn if needed).
 *   3. Block until SIGINT/SIGTERM, then unregister our entries.
 *
 * The daemon's PID-GC reaps anything we miss if this process dies `kill -9`.
 */
import type { PathRewrite } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as process from 'node:process'
import { ensureDaemonRunning } from './daemon'
import { log } from './logger'
import { getRegistryDir, isValidId, removeEntry, writeEntry } from './registry'
import { debugLog } from './utils'

export interface DaemonRunnerProxy {
  id?: string
  from: string
  to: string
  cleanUrls?: boolean
  changeOrigin?: boolean
  pathRewrites?: PathRewrite[]
}

export interface DaemonRunnerOptions {
  proxies: DaemonRunnerProxy[]
  verbose?: boolean
  /** Override the registry dir (tests). Defaults to `~/.stacks/rpx/registry.d`. */
  registryDir?: string
  /** Override the rpx state dir (tests). Defaults to `~/.stacks/rpx`. */
  rpxDir?: string
  /**
   * Skip the blocking await + signal handlers. Tests use this to register
   * entries, verify, and tear down without keeping the test runner alive.
   */
  detached?: boolean
  /** Override the daemon spawn command (tests). */
  spawnCommand?: string[]
}

/**
 * Sanitize an arbitrary `to` host into a valid registry id. Drops anything
 * that isn't `[a-zA-Z0-9._-]`, collapses runs to a single dash, and trims
 * leading/trailing dashes. Falls back to `'rpx'` if nothing's left.
 */
export function deriveIdFromTarget(to: string): string {
  const cleaned = to.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128)
  return cleaned.length > 0 ? cleaned : 'rpx'
}

/**
 * Register every proxy with the daemon and (unless `detached`) block until a
 * shutdown signal arrives. Throws if any id collides or the daemon fails to
 * spawn.
 */
export async function runViaDaemon(opts: DaemonRunnerOptions): Promise<void> {
  if (opts.proxies.length === 0)
    throw new Error('runViaDaemon: no proxies provided')

  const verbose = opts.verbose ?? false
  const registryDir = opts.registryDir
  const ids = new Set<string>()

  // Resolve and validate all ids up front so we don't half-register and bail.
  const resolved = opts.proxies.map((p) => {
    const id = p.id ?? deriveIdFromTarget(p.to)
    if (!isValidId(id))
      throw new Error(`invalid registry id "${id}" derived from to="${p.to}"`)
    if (ids.has(id))
      throw new Error(`duplicate registry id "${id}" — set an explicit \`id\` on one of the proxies`)
    ids.add(id)
    return { ...p, id }
  })

  for (const p of resolved) {
    await writeEntry({
      id: p.id,
      from: p.from,
      to: p.to,
      pid: process.pid,
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      cleanUrls: p.cleanUrls,
      changeOrigin: p.changeOrigin,
      pathRewrites: p.pathRewrites,
    }, registryDir, verbose)
  }

  const result = await ensureDaemonRunning({
    rpxDir: opts.rpxDir,
    verbose,
    spawnCommand: opts.spawnCommand,
  })

  for (const p of resolved)
    log.success(`https://${p.to}  →  ${p.from}`)
  log.info(`(via rpx daemon pid=${result.pid}; \`rpx daemon:status\` to inspect)`)

  if (opts.detached)
    return

  // Cleanup registry entries on shutdown so the daemon's routing table reflects
  // reality immediately (its PID-GC would catch us eventually, but this is
  // faster and avoids a stale-route window).
  let cleaned = false
  const dirForCleanup = registryDir ?? getRegistryDir()
  const idsForCleanup = resolved.map(p => p.id)

  const cleanup = async (): Promise<void> => {
    if (cleaned)
      return
    cleaned = true
    for (const id of idsForCleanup) {
      await removeEntry(id, registryDir, verbose).catch((err) => {
        debugLog('runner', `removeEntry(${id}) failed: ${err}`, verbose)
      })
    }
  }

  const onSignal = (sig: NodeJS.Signals): void => {
    debugLog('runner', `received ${sig}, unregistering ${idsForCleanup.length} entries`, verbose)
    cleanup().finally(() => process.exit(0))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // Last-resort sync cleanup if the process exits without our signal handlers
  // running (e.g. a thrown uncaught exception or `process.exit()` from elsewhere).
  process.once('exit', () => {
    if (cleaned)
      return
    for (const id of idsForCleanup) {
      try {
        fs.unlinkSync(path.join(dirForCleanup, `${id}.json`))
      }
      catch {}
    }
  })

  // Park forever; signal handlers do the actual exiting.
  await new Promise<void>(() => {})
}
