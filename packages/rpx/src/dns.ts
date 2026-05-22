/**
 * Local development DNS for macOS.
 *
 * Uses domain-scoped `/etc/resolver/<base-domain>` files (never whole-TLD hijacks like
 * `/etc/resolver/com`) so real sites keep working when the rpx DNS server is down.
 */
import dgram from 'node:dgram'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as process from 'node:process'
import type { RegistryEntry } from './registry'
import { getDaemonRpxDir } from './daemon'
import {
  type DnsState,
  DNS_STATE_VERSION,
  devDomainsFromHosts,
  LEGACY_TLD_RESOLVER_LABELS,
  loadDnsState,
  resolverBasenamesForDomains,
  saveDnsState,
  clearDnsState,
} from './dns-state'
import { isPidAlive } from './registry'
import { debugLog } from './utils'

/** High port — does not require root. */
export const DNS_PORT = 15353

export const RPX_RESOLVER_MARKER = '# managed-by: rpx'

const MACOS_RESOLVER_DIR = '/etc/resolver'

export interface DevelopmentDnsOptions {
  domains: string[]
  rpxDir?: string
  verbose?: boolean
  /** Defaults to `process.pid` — stored so stale state can be reconciled after crashes. */
  ownerPid?: number
}

let dnsServer: dgram.Socket | null = null
let configuredDomains: Set<string> = new Set()

// ---------------------------------------------------------------------------
// DNS UDP server
// ---------------------------------------------------------------------------

interface DnsHeader {
  id: number
  flags: number
  qdcount: number
  ancount: number
  nscount: number
  arcount: number
}

interface DnsQuestion {
  name: string
  type: number
  class: number
}

function parseHeader(buffer: Buffer): DnsHeader {
  return {
    id: buffer.readUInt16BE(0),
    flags: buffer.readUInt16BE(2),
    qdcount: buffer.readUInt16BE(4),
    ancount: buffer.readUInt16BE(6),
    nscount: buffer.readUInt16BE(8),
    arcount: buffer.readUInt16BE(10),
  }
}

function parseName(buffer: Buffer, offset: number): { name: string, newOffset: number } {
  const labels: string[] = []
  let currentOffset = offset

  while (true) {
    const length = buffer[currentOffset]

    if (length === 0) {
      currentOffset++
      break
    }

    if ((length & 0xC0) === 0xC0) {
      const pointer = buffer.readUInt16BE(currentOffset) & 0x3FFF
      const { name } = parseName(buffer, pointer)
      labels.push(name)
      currentOffset += 2
      break
    }

    currentOffset++
    labels.push(buffer.subarray(currentOffset, currentOffset + length).toString('ascii'))
    currentOffset += length
  }

  return { name: labels.join('.'), newOffset: currentOffset }
}

function parseQuestion(buffer: Buffer, offset: number): { question: DnsQuestion, newOffset: number } {
  const { name, newOffset } = parseName(buffer, offset)
  const type = buffer.readUInt16BE(newOffset)
  const qclass = buffer.readUInt16BE(newOffset + 2)

  return {
    question: { name, type, class: qclass },
    newOffset: newOffset + 4,
  }
}

function encodeName(name: string): Buffer {
  const labels = name.split('.')
  const parts: Buffer[] = []

  for (const label of labels) {
    parts.push(Buffer.from([label.length]))
    parts.push(Buffer.from(label, 'ascii'))
  }
  parts.push(Buffer.from([0]))

  return Buffer.concat(parts)
}

function buildResponse(queryId: number, question: DnsQuestion, ip: string): Buffer {
  const parts: Buffer[] = []

  const header = Buffer.alloc(12)
  header.writeUInt16BE(queryId, 0)
  header.writeUInt16BE(0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(1, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  parts.push(header)

  parts.push(encodeName(question.name))
  const qtype = Buffer.alloc(4)
  qtype.writeUInt16BE(question.type, 0)
  qtype.writeUInt16BE(question.class, 2)
  parts.push(qtype)

  parts.push(encodeName(question.name))

  const answer = Buffer.alloc(10)
  answer.writeUInt16BE(question.type, 0)
  answer.writeUInt16BE(1, 2)
  answer.writeUInt32BE(300, 4)

  if (question.type === 1) {
    answer.writeUInt16BE(4, 8)
    parts.push(answer)
    const ipParts = ip.split('.').map(p => Number.parseInt(p, 10))
    parts.push(Buffer.from(ipParts))
  }
  else if (question.type === 28) {
    answer.writeUInt16BE(16, 8)
    parts.push(answer)
    parts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
  }
  else {
    header.writeUInt16BE(0x8183, 2)
    header.writeUInt16BE(0, 6)
    return Buffer.concat([header, encodeName(question.name), qtype])
  }

  return Buffer.concat(parts)
}

function buildNxdomainResponse(queryId: number, question: DnsQuestion): Buffer {
  const parts: Buffer[] = []

  const header = Buffer.alloc(12)
  header.writeUInt16BE(queryId, 0)
  header.writeUInt16BE(0x8183, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  parts.push(header)

  parts.push(encodeName(question.name))
  const qtype = Buffer.alloc(4)
  qtype.writeUInt16BE(question.type, 0)
  qtype.writeUInt16BE(question.class, 2)
  parts.push(qtype)

  return Buffer.concat(parts)
}

export async function startDnsServer(domains: string[], verbose?: boolean): Promise<boolean> {
  if (process.platform !== 'darwin')
    return false

  const devDomains = devDomainsFromHosts(domains)
  if (devDomains.length === 0)
    return false

  if (dnsServer) {
    for (const d of devDomains)
      configuredDomains.add(d)
    debugLog('dns', 'DNS server already running — merged domains', verbose)
    return true
  }

  configuredDomains = new Set(devDomains)

  return new Promise((resolve) => {
    dnsServer = dgram.createSocket('udp4')

    dnsServer.on('error', (err) => {
      debugLog('dns', `DNS server error: ${err.message}`, verbose)
      dnsServer?.close()
      dnsServer = null
      resolve(false)
    })

    dnsServer.on('message', (msg, rinfo) => {
      try {
        const header = parseHeader(msg)
        const { question } = parseQuestion(msg, 12)

        debugLog('dns', `Query for ${question.name} type ${question.type} from ${rinfo.address}`, verbose)

        const domainLower = question.name.toLowerCase()
        let shouldHandle = false

        for (const configured of configuredDomains) {
          if (domainLower === configured || domainLower.endsWith(`.${configured}`)) {
            shouldHandle = true
            break
          }
        }

        let response: Buffer
        if (shouldHandle && (question.type === 1 || question.type === 28)) {
          response = buildResponse(header.id, question, '127.0.0.1')
          debugLog('dns', `Responding with localhost for ${question.name}`, verbose)
        }
        else {
          response = buildNxdomainResponse(header.id, question)
          debugLog('dns', `NXDOMAIN for ${question.name}`, verbose)
        }

        dnsServer?.send(response, rinfo.port, rinfo.address)
      }
      catch (err) {
        debugLog('dns', `Error processing DNS query: ${err}`, verbose)
      }
    })

    dnsServer.on('listening', () => {
      const address = dnsServer?.address()
      debugLog('dns', `DNS server listening on ${address?.address}:${address?.port}`, verbose)
      resolve(true)
    })

    try {
      dnsServer.bind(DNS_PORT, '127.0.0.1')
    }
    catch (err) {
      debugLog('dns', `Failed to bind DNS server: ${err}`, verbose)
      resolve(false)
    }
  })
}

export function stopDnsServer(verbose?: boolean): void {
  if (dnsServer) {
    debugLog('dns', 'Stopping DNS server', verbose)
    dnsServer.close()
    dnsServer = null
    configuredDomains = new Set()
  }
}

export function isDnsServerRunning(): boolean {
  return dnsServer !== null
}

// ---------------------------------------------------------------------------
// macOS resolver files
// ---------------------------------------------------------------------------

function resolverFileContent(): string {
  return `${RPX_RESOLVER_MARKER}\nnameserver 127.0.0.1\nport ${DNS_PORT}\n`
}

export function resolverFilePath(basename: string): string {
  return path.join(MACOS_RESOLVER_DIR, basename)
}

/** True when a resolver file points at the rpx local DNS port. */
export function contentLooksLikeRpxResolver(content: string): boolean {
  return content.includes('127.0.0.1') && content.includes(String(DNS_PORT))
}

async function readResolverFile(basename: string): Promise<string | null> {
  try {
    return await fsp.readFile(resolverFilePath(basename), 'utf8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw err
  }
}

async function flushDnsCache(verbose?: boolean): Promise<void> {
  if (process.platform !== 'darwin')
    return

  const { execSudoSync, getSudoPassword } = await import('./utils')

  if (!getSudoPassword()) {
    debugLog('dns', 'Cannot flush DNS cache without SUDO_PASSWORD', verbose)
    return
  }

  try {
    execSudoSync('dscacheutil -flushcache')
    execSudoSync('killall -HUP mDNSResponder 2>/dev/null || true')
    debugLog('dns', 'DNS cache flushed', verbose)
  }
  catch (err) {
    debugLog('dns', `Could not flush DNS cache: ${err}`, verbose)
  }
}

async function writeResolverFile(basename: string, verbose?: boolean): Promise<void> {
  const { execSudoSync } = await import('./utils')
  const content = resolverFileContent().replace(/\n/g, '\\n')
  const cmd = `bash -c 'mkdir -p ${MACOS_RESOLVER_DIR} && printf "%b" "${content}" > ${resolverFilePath(basename)}'`
  execSudoSync(cmd)
  debugLog('dns', `Created ${resolverFilePath(basename)}`, verbose)
}

async function removeResolverFile(basename: string, verbose?: boolean): Promise<void> {
  const { execSudoSync } = await import('./utils')
  execSudoSync(`rm -f ${resolverFilePath(basename)}`)
  debugLog('dns', `Removed ${resolverFilePath(basename)}`, verbose)
}

/**
 * @deprecated Use {@link setupDevelopmentDns}. Domain-scoped resolver files only.
 */
export async function setupResolver(verbose?: boolean, domains?: string[]): Promise<boolean> {
  return setupDevelopmentDns({ domains: domains ?? [], verbose })
}

async function installResolvers(basenames: string[], verbose?: boolean): Promise<boolean> {
  if (process.platform !== 'darwin')
    return true

  const { getSudoPassword } = await import('./utils')
  if (!getSudoPassword()) {
    debugLog('dns', 'SUDO_PASSWORD not set, cannot create resolver files', verbose)
    return false
  }

  try {
    for (const basename of basenames)
      await writeResolverFile(basename, verbose)
    await flushDnsCache(verbose)
    return true
  }
  catch (err) {
    debugLog('dns', `Failed to create resolver file: ${err}`, verbose)
    return false
  }
}

async function uninstallResolvers(basenames: string[], verbose?: boolean): Promise<void> {
  if (process.platform !== 'darwin')
    return

  const { getSudoPassword } = await import('./utils')
  if (!getSudoPassword())
    return

  try {
    for (const basename of basenames)
      await removeResolverFile(basename, verbose)
    await flushDnsCache(verbose)
  }
  catch (err) {
    debugLog('dns', `Failed to remove resolver files: ${err}`, verbose)
  }
}

/** Remove legacy whole-TLD resolver files (e.g. `/etc/resolver/com`). */
export async function removeLegacyTldResolvers(verbose?: boolean): Promise<string[]> {
  if (process.platform !== 'darwin')
    return []

  const removed: string[] = []
  for (const label of LEGACY_TLD_RESOLVER_LABELS) {
    const content = await readResolverFile(label)
    if (content && contentLooksLikeRpxResolver(content)) {
      await uninstallResolvers([label], verbose)
      removed.push(label)
    }
  }
  return removed
}

/**
 * Start the local DNS server and install domain-scoped macOS resolver files.
 */
export async function setupDevelopmentDns(opts: DevelopmentDnsOptions): Promise<boolean> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const domains = devDomainsFromHosts(opts.domains)
  if (domains.length === 0)
    return false

  const basenames = resolverBasenamesForDomains(domains)
  const started = await startDnsServer(domains, opts.verbose)
  if (!started)
    return false

  const installed = await installResolvers(basenames, opts.verbose)
  if (!installed)
    return false

  const state: DnsState = {
    version: DNS_STATE_VERSION,
    resolvers: basenames,
    domains,
    ownerPid: opts.ownerPid ?? process.pid,
    updatedAt: new Date().toISOString(),
  }
  await saveDnsState(rpxDir, state)
  return true
}

/**
 * Sync resolver + DNS state to the current set of registry hosts (daemon mode).
 */
export async function syncDevelopmentDnsFromRegistry(
  entries: RegistryEntry[],
  opts: { rpxDir?: string, verbose?: boolean, ownerPid?: number } = {},
): Promise<void> {
  const domains = entries.map(e => e.to).filter(Boolean)
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const wanted = resolverBasenamesForDomains(domains)
  const state = await loadDnsState(rpxDir)
  const previous = state?.resolvers ?? []
  const toRemove = previous.filter(b => !wanted.includes(b))

  if (toRemove.length > 0)
    await uninstallResolvers(toRemove, opts.verbose)

  if (wanted.length === 0) {
    stopDnsServer(opts.verbose)
    await clearDnsState(rpxDir)
    return
  }

  await setupDevelopmentDns({
    domains,
    rpxDir,
    verbose: opts.verbose,
    ownerPid: opts.ownerPid ?? process.pid,
  })
}

/**
 * Stop DNS and remove all resolver files recorded in state (plus legacy TLD files).
 */
export async function tearDownDevelopmentDns(opts: { rpxDir?: string, verbose?: boolean } = {}): Promise<void> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  stopDnsServer(opts.verbose)

  const state = await loadDnsState(rpxDir)
  const fromState = state?.resolvers ?? []
  await uninstallResolvers(fromState, opts.verbose)
  await removeLegacyTldResolvers(opts.verbose)
  await clearDnsState(rpxDir)
}

/**
 * @deprecated Use {@link tearDownDevelopmentDns}.
 */
export async function removeResolver(verbose?: boolean): Promise<void> {
  await tearDownDevelopmentDns({ verbose })
}

/**
 * Remove stale DNS overrides left after a crashed dev session or legacy TLD hijacks.
 * Safe to call before starting the daemon or `./buddy dev`.
 */
export async function reconcileStaleDevelopmentDns(opts: { rpxDir?: string, verbose?: boolean } = {}): Promise<void> {
  const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
  const state = await loadDnsState(rpxDir)
  const ownerAlive = state?.ownerPid != null && isPidAlive(state.ownerPid)

  if (state && !ownerAlive) {
    debugLog('dns', `reconcile: owner pid ${state.ownerPid} is gone — tearing down DNS`, opts.verbose)
    await tearDownDevelopmentDns(opts)
    return
  }

  const legacyRemoved = await removeLegacyTldResolvers(opts.verbose)
  if (legacyRemoved.length > 0)
    debugLog('dns', `reconcile: removed legacy TLD resolvers: ${legacyRemoved.join(', ')}`, opts.verbose)

  await flushDnsCache(opts.verbose)
}
