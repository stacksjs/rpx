/**
 * Registry of currently-active rpx proxies.
 *
 * Each running upstream (e.g. a `./buddy dev` invocation) writes a small JSON
 * file into `~/.stacks/rpx/registry.d/<id>.json` describing where to forward
 * traffic. The rpx daemon watches this directory and rebuilds its routing
 * table whenever entries appear, change, or disappear.
 *
 * Design choices worth knowing about:
 *   - One file per entry → no shared-file locking, no merge conflicts.
 *   - Atomic write via temp file + rename → readers never see partial JSON.
 *   - Each entry carries the writer's PID so the daemon can GC files left
 *     behind by a writer that was killed -9.
 *   - `id` is validated against a strict charset to keep it from escaping
 *     the registry directory.
 */
import type { PathRewrite } from './types'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { debugLog } from './utils'

export interface RegistryEntry {
  id: string
  from: string
  to: string
  /**
   * Optional. PID of the long-running process that owns this entry. When set,
   * the daemon's PID-GC reaps the entry the moment that process dies. Omit
   * (or set to `undefined`) for manually-managed entries created via
   * `rpx register` — those persist until explicit `rpx unregister`.
   */
  pid?: number
  cwd?: string
  createdAt: string
  pathRewrites?: PathRewrite[]
  cleanUrls?: boolean
  changeOrigin?: boolean
}

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/

/**
 * Default location for the registry directory. The daemon's PID file and log
 * sit alongside it under `~/.stacks/rpx/`.
 */
export function getRegistryDir(): string {
  return path.join(homedir(), '.stacks', 'rpx', 'registry.d')
}

/**
 * Validate an entry id. Rejects anything that could escape the registry dir
 * (path traversal, slashes) or that would round-trip oddly through a filename.
 */
export function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && ID_PATTERN.test(id)
}

function entryPath(dir: string, id: string): string {
  if (!isValidId(id))
    throw new Error(`invalid registry id: ${JSON.stringify(id)}`)
  return path.join(dir, `${id}.json`)
}

/**
 * Check whether a PID is alive. `kill(pid, 0)` returns without sending a
 * signal but throws ESRCH if the process is gone — exactly the probe we need.
 * EPERM means the process exists but we don't own it; treat as alive.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isValidEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== 'object')
    return false
  const e = value as Partial<RegistryEntry>
  // pid is optional. When present it must be a positive integer; when absent
  // (manual entries from `rpx register`) the daemon's PID-GC skips it.
  const pidOk = e.pid === undefined
    || (typeof e.pid === 'number' && Number.isInteger(e.pid) && e.pid > 0)
  return (
    typeof e.id === 'string' && isValidId(e.id)
    && typeof e.from === 'string' && e.from.length > 0
    && typeof e.to === 'string' && e.to.length > 0
    && pidOk
    && typeof e.createdAt === 'string'
  )
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Atomically write an entry to disk.
 *
 * Writes to a temp file in the same directory, then renames into place. POSIX
 * rename within the same filesystem is atomic, so a concurrent reader either
 * sees the old file or the new file — never a half-written one.
 */
export async function writeEntry(entry: RegistryEntry, dir: string = getRegistryDir(), verbose?: boolean): Promise<void> {
  if (!isValidEntry(entry))
    throw new Error(`invalid registry entry: ${JSON.stringify(entry)}`)

  await ensureDir(dir)
  const finalPath = entryPath(dir, entry.id)
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`
  const json = JSON.stringify(entry, null, 2)

  try {
    await fsp.writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o644 })
    await fsp.rename(tmpPath, finalPath)
    debugLog('registry', `wrote entry ${entry.id} → ${finalPath}`, verbose)
  }
  catch (err) {
    // Best-effort cleanup of the temp file if the rename never landed.
    await fsp.unlink(tmpPath).catch(() => {})
    throw err
  }
}

/**
 * Remove an entry by id. No-op if the file is already gone.
 */
export async function removeEntry(id: string, dir: string = getRegistryDir(), verbose?: boolean): Promise<void> {
  const target = entryPath(dir, id)
  try {
    await fsp.unlink(target)
    debugLog('registry', `removed entry ${id}`, verbose)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw err
  }
}

/**
 * Read a single entry by id. Returns `null` if missing or malformed (malformed
 * files are deleted so they don't keep poisoning subsequent reads).
 */
export async function readEntry(id: string, dir: string = getRegistryDir(), verbose?: boolean): Promise<RegistryEntry | null> {
  const target = entryPath(dir, id)
  try {
    const raw = await fsp.readFile(target, 'utf8')
    const parsed = JSON.parse(raw)
    if (!isValidEntry(parsed)) {
      debugLog('registry', `entry ${id} failed validation, removing`, verbose)
      await fsp.unlink(target).catch(() => {})
      return null
    }
    return parsed
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return null
    if (err instanceof SyntaxError) {
      debugLog('registry', `entry ${id} has invalid JSON, removing`, verbose)
      await fsp.unlink(target).catch(() => {})
      return null
    }
    throw err
  }
}

/**
 * Read all entries from the registry directory. Malformed files are pruned.
 * This does NOT GC stale PIDs — call `gcStaleEntries` for that explicitly.
 */
export async function readAll(dir: string = getRegistryDir(), verbose?: boolean): Promise<RegistryEntry[]> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw err
  }

  const out: RegistryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json'))
      continue
    const id = name.slice(0, -'.json'.length)
    if (!isValidId(id))
      continue
    const entry = await readEntry(id, dir, verbose)
    if (entry)
      out.push(entry)
  }
  return out
}

/**
 * Remove entries whose writer PID is no longer alive. Returns the count of
 * entries removed. Safe to call repeatedly; intended to run on daemon startup
 * and on a slow timer (e.g. every 5s) while the daemon is up.
 */
export async function gcStaleEntries(dir: string = getRegistryDir(), verbose?: boolean): Promise<number> {
  const entries = await readAll(dir, verbose)
  let removed = 0
  for (const entry of entries) {
    // Manually-managed entries (no pid) opt out of PID-GC. The user is
    // responsible for `rpx unregister` when they're done.
    if (entry.pid === undefined)
      continue
    if (!isPidAlive(entry.pid)) {
      debugLog('registry', `GC: pid ${entry.pid} for ${entry.id} is dead, removing`, verbose)
      await removeEntry(entry.id, dir, verbose).catch(() => {})
      removed++
    }
  }
  return removed
}

export interface WatchHandle {
  close: () => void
}

export interface WatchOptions {
  debounceMs?: number
  verbose?: boolean
}

/**
 * Watch the registry directory and invoke `onChange` with the full current
 * entry list whenever something changes. Events are debounced so a flurry of
 * rapid writes (e.g. several `./buddy dev` invocations starting in parallel)
 * triggers at most one rebuild.
 *
 * The watcher tolerates a missing directory at startup — it creates the dir
 * before opening the watch, so the first `writeEntry` doesn't race the daemon.
 */
export function watchRegistry(
  onChange: (entries: RegistryEntry[]) => void | Promise<void>,
  opts: WatchOptions & { dir?: string } = {},
): WatchHandle {
  const dir = opts.dir ?? getRegistryDir()
  const debounceMs = opts.debounceMs ?? 100
  const verbose = opts.verbose

  // Create the dir up front so fs.watch has something to attach to.
  fs.mkdirSync(dir, { recursive: true })

  let pending: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const fire = () => {
    pending = null
    if (closed)
      return
    readAll(dir, verbose)
      .then(entries => onChange(entries))
      .catch((err) => {
        debugLog('registry', `watcher onChange failed: ${err}`, verbose)
      })
  }

  const schedule = () => {
    if (closed)
      return
    if (pending)
      clearTimeout(pending)
    pending = setTimeout(fire, debounceMs)
  }

  const watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
    // Ignore temp files from our own atomic-write protocol.
    if (filename && /\.tmp\.\d+\.\d+$/.test(filename))
      return
    schedule()
  })

  watcher.on('error', (err) => {
    debugLog('registry', `watcher error: ${err}`, verbose)
  })

  // Fire once on startup so the daemon picks up entries that already exist.
  schedule()

  return {
    close: () => {
      closed = true
      if (pending)
        clearTimeout(pending)
      watcher.close()
    },
  }
}
