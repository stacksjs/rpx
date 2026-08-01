import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'

export const DNS_STATE_VERSION = 1 as const
export const RPX_DNS_STATE_FILE = 'dns-state.json'

/** Single-label /etc/resolver files created by older rpx versions (whole-TLD hijack). */
export const LEGACY_TLD_RESOLVER_LABELS = [
  'com',
  'test',
  'dev',
  'app',
  'page',
  'local',
  'localhost',
  'example',
  'invalid',
] as const

export interface DnsState {
  version: typeof DNS_STATE_VERSION
  /** Basenames under /etc/resolver/ (e.g. `postline.test`, not `test`). */
  resolvers: string[]
  domains: string[]
  ownerPid: number | null
  updatedAt: string
}

export function defaultRpxDir(): string {
  return path.join(homedir(), '.stacks', 'rpx')
}

export function getDnsStatePath(rpxDir: string = defaultRpxDir()): string {
  return path.join(rpxDir, RPX_DNS_STATE_FILE)
}

export async function loadDnsState(rpxDir: string = defaultRpxDir()): Promise<DnsState | null> {
  try {
    const raw = await fsp.readFile(getDnsStatePath(rpxDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DnsState>
    if (parsed.version !== DNS_STATE_VERSION || !Array.isArray(parsed.resolvers))
      return null
    return {
      version: DNS_STATE_VERSION,
      resolvers: parsed.resolvers.filter((r): r is string => typeof r === 'string'),
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.filter((d): d is string => typeof d === 'string')
        : [],
      ownerPid: typeof parsed.ownerPid === 'number' ? parsed.ownerPid : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw err
  }
}

export async function saveDnsState(rpxDir: string, state: DnsState): Promise<void> {
  await fsp.mkdir(rpxDir, { recursive: true })
  await fsp.writeFile(getDnsStatePath(rpxDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function clearDnsState(rpxDir: string): Promise<void> {
  await fsp.rm(getDnsStatePath(rpxDir), { force: true })
}

/**
 * Normalize a dev hostname. Returns null for localhost / IPs — those use /etc/hosts only.
 */
export function normalizeDevDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.includes('127.0.0.1'))
    return null
  if (domain === 'localhost' || domain.endsWith('.localhost'))
    return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain))
    return null
  // Only real hostname characters. Basenames derived from this flow into
  // sudo-elevated `/etc/resolver` shell commands, so anything that could be a
  // shell metacharacter (quotes, `;`, `$`, spaces, …) must be rejected at the
  // source rather than trusted from a registry entry a local process can write.
  if (!/^[a-z0-9.-]+$/.test(domain))
    return null
  return domain
}

/**
 * Top-level domains that exist only for development.
 *
 * Nothing real resolves under these, so collapsing to the registrable base is
 * free: taking all of `postline.test` cannot shadow a name anyone else needs.
 * A public TLD is the opposite case - see `resolverBasenameForDomain`.
 */
export const DEV_ONLY_TLDS = new Set([
  'test',
  'localhost',
  'local',
  'example',
  'invalid',
  'internal',
  'home',
  'lan',
])

/**
 * macOS resolver basename for a dev domain.
 *
 * `/etc/resolver/<name>` captures that name **and every subdomain of it**, and a
 * captured name resolves only through rpx's DNS server. When that server is not
 * answering, every captured name stops resolving on the machine entirely.
 *
 * So the basename is the exact hostname for a real, publicly registered domain.
 * Collapsing `dashboard.stacksjs.com` to `stacksjs.com` claimed the apex and
 * with it every sibling - `mail.stacksjs.com`, `www.`, all of them - and when
 * rpx stopped answering, a mail client pointed at the real, running mail server
 * simply timed out, because the name no longer resolved. `dig` and `host` kept
 * working, which is what made it look like a server problem: they query DNS
 * directly and never consult `/etc/resolver`.
 *
 * Under a dev-only TLD the collapse is kept, because that is what makes one
 * `/etc/resolver/postline.test` serve `api.postline.test` too, and nothing real
 * can be shadowed there.
 *
 * This is the same reasoning that already forbids whole-TLD files like
 * `/etc/resolver/com`, applied one label further down.
 */
export function resolverBasenameForDomain(raw: string): string | null {
  const domain = normalizeDevDomain(raw)
  if (!domain)
    return null
  const parts = domain.split('.')
  if (parts.length < 2)
    return null

  const tld = parts[parts.length - 1]!
  if (DEV_ONLY_TLDS.has(tld))
    return parts.slice(-2).join('.')

  return domain
}

export function resolverBasenamesForDomains(domains: string[]): string[] {
  const basenames = new Set<string>()
  for (const raw of domains) {
    const basename = resolverBasenameForDomain(raw)
    if (basename)
      basenames.add(basename)
  }
  return Array.from(basenames).sort()
}

export function devDomainsFromHosts(hosts: string[]): string[] {
  const out = new Set<string>()
  for (const raw of hosts) {
    const domain = normalizeDevDomain(raw)
    if (domain)
      out.add(domain)
  }
  return Array.from(out).sort()
}
