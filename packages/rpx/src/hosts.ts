import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as process from 'node:process'
import { promisify } from 'node:util'
import { isPidAlive } from './registry'
import { debugLog, getSudoPassword, isProcessElevated } from './utils'

const execAsync = promisify(exec)

/** `.localhost` names resolve to loopback per RFC 6761 — no /etc/hosts entry needed. */
export function isLoopbackDevelopmentHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.localhost.')
}

export const hostsFilePath: string = process.platform === 'win32'
  ? path.join(process.env.windir || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts'

/**
 * Inline marker identifying an /etc/hosts line rpx owns. New entries are
 * stamped with the owning process id so a garbage-collection pass (the
 * daemon's periodic sweep, or `removeStaleRpxHosts`) can reap lines whose
 * owner died without cleaning up:
 *
 *   127.0.0.1 example.test # rpx:pid=12345
 *
 * Older entries used a `# Added by rpx` comment above each address pair;
 * removal still understands that legacy layout.
 */
export const RPX_HOSTS_MARKER = '# rpx'
const LEGACY_HOSTS_MARKER = '# Added by rpx'
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

// Flag to track if we've already received sudo privileges in this session
let sudoPrivilegesAcquired = false

// Single function to execute sudo commands, with caching for permissions.
// Wraps in sh -c so pipes/redirects all run under sudo.
async function execSudo(command: string): Promise<string> {
  if (process.platform === 'win32')
    throw new Error('Administrator privileges required on Windows')

  if (isProcessElevated()) {
    const { stdout } = await execAsync(command)
    return stdout
  }

  const sudoPassword = getSudoPassword()
  const escaped = command.replace(/'/g, `'\\''`)

  try {
    if (sudoPassword) {
      const { stdout } = await execAsync(`echo '${sudoPassword}' | sudo -S sh -c '${escaped}' 2>/dev/null`)
      sudoPrivilegesAcquired = true
      return stdout
    }

    if (sudoPrivilegesAcquired) {
      try {
        const { stdout } = await execAsync(`sudo -n sh -c '${escaped}'`)
        return stdout
      }
      // eslint-disable-next-line unused-imports/no-unused-vars
      catch (error) {
        debugLog('hosts', 'Cached sudo privileges expired, requesting again', true)
      }
    }

    try {
      const { stdout } = await execAsync(`sudo -n sh -c '${escaped}'`)
      sudoPrivilegesAcquired = true
      return stdout
    }
    catch {
      throw new Error('sudo required but no cached credentials (set SUDO_PASSWORD in .env or run sudo -v)')
    }
  }
  catch (error) {
    throw new Error(`Failed to execute sudo command: ${(error as Error).message}`)
  }
}

export interface HostsLine {
  address: string
  names: string[]
  comment: string
  /** PID parsed from an inline `# rpx:pid=N` marker, if present. */
  rpxPid: number | null
  /** True when the line carries the inline rpx marker. */
  rpxManaged: boolean
}

/**
 * Parse one /etc/hosts line into address, hostnames, and rpx ownership.
 * Returns null for blank lines and pure comments. Host matching anywhere in
 * this module is exact token comparison — never substring — so removing
 * `example.test` can never touch `api.example.test`.
 */
export function parseHostsLine(line: string): HostsLine | null {
  const hashIndex = line.indexOf('#')
  const body = (hashIndex === -1 ? line : line.slice(0, hashIndex)).trim()
  if (!body)
    return null

  const comment = hashIndex === -1 ? '' : line.slice(hashIndex + 1).trim()
  const [address, ...names] = body.split(/\s+/)
  if (!address || names.length === 0)
    return null

  const marker = /^rpx(?::pid=(\d+))?$/.exec(comment)
  return {
    address,
    names,
    comment,
    rpxPid: marker?.[1] ? Number.parseInt(marker[1], 10) : null,
    rpxManaged: marker !== null,
  }
}

/** True when the line maps `host` exactly (one of its names) to loopback. */
export function hostsLineMapsHost(line: string, host: string): boolean {
  const parsed = parseHostsLine(line)
  return parsed !== null && LOOPBACK_ADDRESSES.has(parsed.address) && parsed.names.includes(host)
}

export interface HostsFilterResult {
  content: string
  removed: string[]
}

/**
 * Remove rpx-owned loopback lines for `hostsToRemove` from hosts-file content.
 *
 * Ownership rules:
 *   - Inline-marked lines (`# rpx:pid=N` / `# rpx`) are dropped when any of
 *     their exact hostnames is in the removal set.
 *   - Legacy `# Added by rpx` blocks own the address lines directly beneath
 *     them; matched lines are dropped and the comment is dropped only when
 *     its whole block went away (previously every legacy comment in the file
 *     was stripped even when its hosts stayed — orphaning unmarked lines).
 *   - Unmarked lines are never touched: a hand-written entry belongs to the
 *     user, and a missing marker must not become a deletion license.
 */
export function filterRpxHostsEntries(content: string, hostsToRemove: string[]): HostsFilterResult {
  const removal = new Set(hostsToRemove)
  const removed = new Set<string>()
  const lines = content.split('\n')
  const out: string[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string

    if (line.trim() === LEGACY_HOSTS_MARKER) {
      const block: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const blockLine = lines[j] as string
        if (blockLine.trim() === '' || blockLine.trim().startsWith('#'))
          break
        block.push(blockLine)
        j++
      }
      const kept = block.filter((blockLine) => {
        const parsed = parseHostsLine(blockLine)
        const hit = parsed !== null
          && LOOPBACK_ADDRESSES.has(parsed.address)
          && parsed.names.some(n => removal.has(n))
        if (hit) {
          for (const name of (parsed as HostsLine).names) {
            if (removal.has(name))
              removed.add(name)
          }
        }
        return !hit
      })
      // The comment survives only while it still owns at least one line.
      if (kept.length > 0 || block.length === 0)
        out.push(line, ...kept)
      i = j
      continue
    }

    const parsed = parseHostsLine(line)
    if (parsed?.rpxManaged && LOOPBACK_ADDRESSES.has(parsed.address) && parsed.names.some(n => removal.has(n))) {
      for (const name of parsed.names) {
        if (removal.has(name))
          removed.add(name)
      }
      i++
      continue
    }

    out.push(line)
    i++
  }

  while (out.length > 0 && (out[out.length - 1] as string).trim() === '')
    out.pop()

  return { content: `${out.join('\n')}\n`, removed: [...removed] }
}

export interface StaleRpxHostsResult {
  content: string
  removed: string[]
  stalePids: number[]
}

/**
 * Drop inline-marked lines whose owning PID is dead. Lines without a PID
 * stamp (legacy blocks, hand-written entries) are kept: without an owner to
 * probe there is no safe automatic removal signal.
 */
export function dropStaleRpxHostsLines(content: string, isAlive: (pid: number) => boolean): StaleRpxHostsResult {
  const removed: string[] = []
  const stalePids = new Set<number>()
  const out: string[] = []

  for (const line of content.split('\n')) {
    const parsed = parseHostsLine(line)
    if (
      parsed?.rpxManaged
      && parsed.rpxPid !== null
      && LOOPBACK_ADDRESSES.has(parsed.address)
      && !isAlive(parsed.rpxPid)
    ) {
      removed.push(...parsed.names)
      stalePids.add(parsed.rpxPid)
      continue
    }
    out.push(line)
  }

  while (out.length > 0 && (out[out.length - 1] as string).trim() === '')
    out.pop()

  return { content: `${out.join('\n')}\n`, removed, stalePids: [...stalePids] }
}

/** Read the hosts file, escalating to sudo only when the plain read fails. */
async function readHostsFile(verbose?: boolean): Promise<string> {
  try {
    return await fs.promises.readFile(hostsFilePath, 'utf-8')
  }
  catch {
    debugLog('hosts', 'Reading hosts file requires elevated permissions, using sudo', verbose)
    return execSudo(`cat "${hostsFilePath}"`)
  }
}

/** Write hosts-file content back through a temp file + sudo tee. */
async function writeHostsFile(content: string, verbose?: boolean): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `rpx-hosts-${Date.now()}.tmp`)
  try {
    await fs.promises.writeFile(tmpFile, content, 'utf8')
    await execSudo(`cat "${tmpFile}" | tee "${hostsFilePath}" > /dev/null`)
  }
  finally {
    await fs.promises.unlink(tmpFile).catch((err) => {
      debugLog('hosts', `Failed to remove temporary file: ${err}`, verbose)
    })
  }
}

export async function addHosts(hosts: string[], verbose?: boolean): Promise<void> {
  const needsHostsFile = hosts.filter(h => !isLoopbackDevelopmentHost(h))
  const skipped = hosts.filter(h => isLoopbackDevelopmentHost(h))
  if (skipped.length > 0) {
    debugLog('hosts', `Skipping /etc/hosts for loopback dev names: ${skipped.join(', ')}`, verbose)
  }
  if (needsHostsFile.length === 0)
    return

  debugLog('hosts', `Adding hosts: ${needsHostsFile.join(', ')}`, verbose)
  debugLog('hosts', `Using hosts file at: ${hostsFilePath}`, verbose)

  try {
    let existingContent: string
    try {
      existingContent = await readHostsFile(verbose)
    }
    catch (sudoErr) {
      console.log('  Could not read hosts file — skipping hosts setup')
      debugLog('hosts', `sudo read also failed: ${sudoErr}`, verbose)
      throw new Error(`Cannot read hosts file: ${sudoErr}`)
    }

    // Exact per-host check: a line for `api.example.test` must not count as
    // covering `example.test` (and `example.test.evil` must not either).
    const existingLines = existingContent.split('\n')
    const newEntries = needsHostsFile.filter(host =>
      !existingLines.some(line => hostsLineMapsHost(line, host)),
    )

    if (newEntries.length === 0) {
      debugLog('hosts', 'All hosts already exist in hosts file', verbose)
      return
    }

    // Each line is stamped with this process's PID so the daemon's sweep (or
    // `removeStaleRpxHosts`) can reap it if this session dies without cleanup.
    const pid = process.pid
    const hostEntries = newEntries.map(host =>
      `\n127.0.0.1 ${host} ${RPX_HOSTS_MARKER}:pid=${pid}\n::1 ${host} ${RPX_HOSTS_MARKER}:pid=${pid}`,
    ).join('\n')

    try {
      await writeHostsFile(existingContent + hostEntries, verbose)
      console.log(`  Hosts updated: ${newEntries.join(', ')}`)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      // Don't throw — just tell the user what to add manually
      console.log('  Could not update hosts file automatically')
      console.log('  Add these entries to /etc/hosts:')
      newEntries.forEach((host) => {
        console.log(`    127.0.0.1 ${host}`)
        console.log(`    ::1 ${host}`)
      })
      console.log(`  Or run: sudo nano ${hostsFilePath}`)
    }
  }
  catch (err) {
    const error = err as Error
    debugLog('hosts', `Failed to manage hosts file: ${error.message}`, verbose)
    // Don't throw - hosts file management is best-effort
  }
}

export async function removeHosts(hosts: string[], verbose?: boolean): Promise<void> {
  debugLog('hosts', `Removing hosts: ${hosts.join(', ')}`, verbose)

  try {
    let content: string
    try {
      content = await readHostsFile(verbose)
    }
    catch (sudoErr) {
      debugLog('hosts', `sudo read also failed: ${sudoErr}`, verbose)
      throw new Error(`Cannot read hosts file: ${sudoErr}`)
    }

    const { content: newContent, removed } = filterRpxHostsEntries(content, hosts)

    if (removed.length === 0) {
      debugLog('hosts', 'No matching rpx-managed hosts found to remove', verbose)
      return
    }

    try {
      await writeHostsFile(newContent, verbose)
      debugLog('hosts', `Hosts removed successfully: ${removed.join(', ')}`, verbose)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      debugLog('hosts', 'Could not clean up hosts file automatically', verbose)
    }
  }
  catch (err) {
    debugLog('hosts', `Failed to clean up hosts file: ${(err as Error).message}`, verbose)
    // Don't throw - hosts file cleanup is best-effort
  }
}

export async function checkHosts(hosts: string[], verbose?: boolean): Promise<boolean[]> {
  debugLog('hosts', `Checking hosts: ${hosts}`, verbose)

  let content: string
  try {
    content = await fs.promises.readFile(hostsFilePath, 'utf-8')
  }
  catch (readErr) {
    debugLog('hosts', `Error reading hosts file: ${readErr}`, verbose)

    // Try with sudo using SUDO_PASSWORD if available
    try {
      const sudoPassword = getSudoPassword()
      let cmd: string
      if (sudoPassword) {
        cmd = `echo '${sudoPassword}' | sudo -S cat "${hostsFilePath}" 2>/dev/null`
      }
      else {
        cmd = `sudo -n cat "${hostsFilePath}" 2>/dev/null || cat "${hostsFilePath}" 2>/dev/null || echo ""`
      }
      const { stdout } = await execAsync(cmd)
      content = stdout
    }
    catch (sudoErr) {
      // Can't read hosts file - assume entries don't exist
      debugLog('hosts', `Cannot read hosts file, assuming entries don't exist: ${sudoErr}`, verbose)
      return hosts.map(() => false)
    }
  }

  const lines = content.split('\n')
  return hosts.map(host => lines.some(line => hostsLineMapsHost(line, host)))
}

/**
 * Hostnames on inline-marked rpx lines whose owning PID is dead. Read-only:
 * safe for unprivileged diagnostics (e.g. `buddy doctor`) since /etc/hosts is
 * world-readable. Returns [] when the file cannot be read.
 */
export async function findStaleRpxHosts(isAlive: (pid: number) => boolean = isPidAlive): Promise<string[]> {
  let content: string
  try {
    content = await fs.promises.readFile(hostsFilePath, 'utf-8')
  }
  catch {
    return []
  }

  const stale: string[] = []
  for (const line of content.split('\n')) {
    const parsed = parseHostsLine(line)
    if (
      parsed?.rpxManaged
      && parsed.rpxPid !== null
      && LOOPBACK_ADDRESSES.has(parsed.address)
      && !isAlive(parsed.rpxPid)
    ) {
      stale.push(...parsed.names)
    }
  }
  return [...new Set(stale)]
}

/**
 * Remove inline-marked rpx hosts lines whose owning PID is dead. Runs inside
 * the (root) daemon's periodic GC so entries orphaned by a killed dev session
 * disappear within seconds instead of hijacking the domain forever. Returns
 * the removed hostnames; [] when nothing was stale or the write failed.
 */
export async function removeStaleRpxHosts(opts: { verbose?: boolean, isAlive?: (pid: number) => boolean } = {}): Promise<string[]> {
  const isAlive = opts.isAlive ?? isPidAlive

  let content: string
  try {
    content = await readHostsFile(opts.verbose)
  }
  catch (err) {
    debugLog('hosts', `stale hosts GC: cannot read hosts file: ${err}`, opts.verbose)
    return []
  }

  const { content: newContent, removed, stalePids } = dropStaleRpxHostsLines(content, isAlive)
  if (removed.length === 0)
    return []

  try {
    await writeHostsFile(newContent, opts.verbose)
    debugLog('hosts', `stale hosts GC: removed ${removed.join(', ')} (dead pid(s): ${stalePids.join(', ')})`, opts.verbose)
    return [...new Set(removed)]
  }
  catch (err) {
    debugLog('hosts', `stale hosts GC: write failed: ${err}`, opts.verbose)
    return []
  }
}
