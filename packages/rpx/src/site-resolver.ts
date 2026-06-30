/**
 * Resolve an incoming host to an on-demand *site* — a project rpx should boot on
 * first visit (see {@link import('./site-supervisor').SiteSupervisor}).
 *
 * Two ways a host resolves:
 *   1. **Explicit** — it matches a {@link SiteConfig} in `onDemand.sites` (exact
 *      host first, then the most-specific `*.suffix` wildcard).
 *   2. **Discovered** — by convention, `<name>.<tld>` maps to `<root>/<name>` for
 *      each configured root (default `~/Code`) and dev TLD (default `localhost`,
 *      `test`), when that directory exists and looks like a dev project.
 *
 * A discovered project's dev command + backend layout come from a *preset*
 * detector: a Stacks app (has a `./buddy` launcher or a `@stacksjs/*` dependency)
 * gets the frontend/`/api`/`/docs` layout; any project with a `dev` script gets a
 * single `bun run dev` backend; anything else doesn't resolve.
 *
 * Pure + dependency-injected (fs probes, the detector, `$HOME`) so the whole
 * matrix is unit-testable without a real filesystem.
 */
import type { OnDemandSitesConfig, SiteConfig, SiteRouteTemplate } from './types'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { matchHost } from './host-match'

const DEFAULT_ROOTS = ['~/Code']
const DEFAULT_TLDS = ['localhost', 'test']
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000

/** A fully-resolved site, ready for the supervisor to boot and route. */
export interface ResolvedSite {
  /** The public host this site answers (the concrete request host). */
  host: string
  /** Stable base id for registry entries, derived from {@link host}. */
  id: string
  /** Absolute project directory the command runs in. */
  dir: string
  /** Dev command to spawn. */
  command: string
  /**
   * Env merged over `process.env` (the supervisor still injects per-route ports
   * on top). Includes any preset {@link SitePreset.urlEnv} vars resolved to the
   * site URL.
   */
  env: Record<string, string>
  /** rpx-managed backends. Empty when {@link selfRegisters}. */
  routes: SiteRouteTemplate[]
  /** The command writes its own rpx routes; rpx only boots + reaps it. */
  selfRegisters: boolean
  /** Idle timeout (ms) before the site is stopped. `0` disables. */
  idleTimeoutMs: number
  /** How the site was resolved — for logging / the splash page. */
  source: 'config' | 'discovered'
}

/**
 * The dev-command shape for a recognized project kind. Returned by a
 * {@link SiteDetector}; the resolver folds it into a {@link ResolvedSite}.
 */
export interface SitePreset {
  /** Command to spawn (e.g. `'./buddy dev'`). */
  command: string
  /** Static env for the command. */
  env?: Record<string, string>
  /** Backends rpx manages (port injection + routing). */
  routes?: SiteRouteTemplate[]
  /** The command registers its own rpx routes; rpx only boots + reaps it. */
  selfRegisters?: boolean
  /**
   * Env var names to set to the site URL (`https://<host>`). Lets a preset hand
   * the framework its public origin without the resolver knowing the framework
   * (Stacks reads `APP_URL`, others their own).
   */
  urlEnv?: string[]
}

/** Detect a project kind from its directory. Returns `null` for "not a dev project". */
export type SiteDetector = (dir: string, deps: ResolverProbes) => SitePreset | null

/**
 * A per-project override of how rpx boots a site — so the dev startup can be
 * defined **manually** instead of relying on auto-detection. Read from a
 * `rpx.site.json` file in the project, or a `"rpx"` key in its `package.json`.
 * A manifest with a `command` fully defines the preset (and makes even a
 * directory that isn't otherwise a recognized project bootable).
 *
 * ```jsonc
 * // rpx.site.json
 * {
 *   "command": "pnpm dev",
 *   "env": { "NODE_ENV": "development" },
 *   "routes": [
 *     { "path": "/", "portEnv": "PORT", "defaultPort": 5173, "readyGate": true },
 *     { "path": "/api", "portEnv": "API_PORT", "defaultPort": 4000 }
 *   ]
 * }
 * ```
 */
export interface SiteManifest {
  /** Dev command to spawn. When present, the manifest defines the whole preset. */
  command?: string
  /** Static env for the command. */
  env?: Record<string, string>
  /** Backends rpx manages (port injection + routing). */
  routes?: SiteRouteTemplate[]
  /** The command registers its own rpx routes; rpx only boots + reaps it. */
  selfRegisters?: boolean
  /** Env var names to set to the site URL (`https://<host>`). */
  urlEnv?: string[]
}

/** Filesystem probes the resolver and detector use — injected for tests. */
export interface ResolverProbes {
  dirExists: (p: string) => boolean
  fileExists: (p: string) => boolean
  readText: (p: string) => string | null
}

export interface SiteResolverDeps extends Partial<ResolverProbes> {
  /** Project-kind detector. Defaults to {@link detectProjectPreset}. */
  detect?: SiteDetector
  /** `$HOME` for `~` expansion. Defaults to `os.homedir()`. */
  homeDir?: string
  /** List the immediate subdirectory names of a root (for {@link listDiscoverableSites}). */
  readdir?: (p: string) => string[]
}

const defaultProbes: ResolverProbes = {
  dirExists: (p) => {
    try {
      return statSync(p).isDirectory()
    }
    catch {
      return false
    }
  },
  fileExists: (p) => {
    try {
      return existsSync(p)
    }
    catch {
      return false
    }
  },
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8')
    }
    catch {
      return null
    }
  },
}

/** Expand a leading `~` (or `~/…`) to the resolved home directory. */
export function expandHome(p: string, home: string): string {
  if (p === '~')
    return home
  if (p.startsWith('~/'))
    return join(home, p.slice(2))
  return p
}

/** Strip the port from a Host header value (`a.localhost:443` → `a.localhost`). */
function hostOnly(host: string): string {
  const colon = host.indexOf(':')
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase()
}

/** A registry-safe id derived from a host (`a.localhost` → `a.localhost`). */
export function siteIdForHost(host: string): string {
  return host.replace(/[^a-z0-9._-]/gi, '-').replace(/^[-.]+|[-.]+$/g, '') || 'site'
}

/**
 * The host's single project label for convention discovery: `<name>.<tld>` →
 * `name`. Multi-label hosts (`docs.app.localhost`) and bare TLDs don't discover —
 * point those at an explicit `sites` entry. Returns `null` when no TLD matches.
 */
export function projectNameFromHost(host: string, tlds: string[]): string | null {
  for (const tld of tlds) {
    const suffix = `.${tld}`
    if (host.endsWith(suffix)) {
      const name = host.slice(0, -suffix.length)
      // Exactly one label (no nested subdomains) and a plausible dir name.
      if (name.length > 0 && !name.includes('.') && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(name))
        return name
    }
  }
  return null
}

/**
 * Read a per-project {@link SiteManifest} so users can define the dev startup
 * manually. Checked sources, in order: a `rpx.site.json` file in the project,
 * then a `"rpx"` key in its `package.json`. Returns `null` when neither exists
 * (or both are malformed).
 */
export function readSiteManifest(dir: string, deps: ResolverProbes): SiteManifest | null {
  const fileRaw = deps.readText(join(dir, 'rpx.site.json'))
  if (fileRaw) {
    try {
      const parsed = JSON.parse(fileRaw)
      if (parsed && typeof parsed === 'object')
        return parsed as SiteManifest
    }
    catch {
      // fall through to the package.json key
    }
  }
  const pkgRaw = deps.readText(join(dir, 'package.json'))
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { rpx?: SiteManifest }
      if (pkg.rpx && typeof pkg.rpx === 'object')
        return pkg.rpx
    }
    catch {
      // malformed package.json — treated as no manifest
    }
  }
  return null
}

/** Build a {@link SitePreset} from a manifest that defines a `command`. */
function presetFromManifest(manifest: SiteManifest): SitePreset {
  const selfRegisters = manifest.selfRegisters ?? false
  return {
    command: manifest.command!,
    env: manifest.env,
    urlEnv: manifest.urlEnv,
    selfRegisters,
    routes: manifest.routes ?? (selfRegisters ? undefined : [{ path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true }]),
  }
}

/**
 * Default detector: classify a project directory.
 *
 * - **Manual** — a {@link SiteManifest} (`rpx.site.json` or a `"rpx"` package.json
 *   key) with a `command` wins over everything, so the dev startup can be defined
 *   by hand (and an otherwise-unrecognized directory becomes bootable).
 * - **Stacks** — a `./buddy` launcher, or a `@stacksjs/*` dependency in
 *   `package.json`. Boots frontend (`/`), API (`/api`) and docs (`/docs`) with
 *   the conventional `PORT`/`PORT_API`/`PORT_DOCS` env, deferring proxy + TLS to
 *   rpx (`STACKS_PROXY_MANAGED=1`) and taking its public origin via `APP_URL`.
 * - **Generic** — any `package.json` with a `dev` script: a single `bun run dev`
 *   backend on `PORT`.
 * - Otherwise `null`.
 */
export function detectProjectPreset(dir: string, deps: ResolverProbes): SitePreset | null {
  // A hand-written manifest takes precedence over auto-detection.
  const manifest = readSiteManifest(dir, deps)
  if (manifest?.command)
    return presetFromManifest(manifest)

  const hasBuddy = deps.fileExists(join(dir, 'buddy'))
  const pkgRaw = deps.readText(join(dir, 'package.json'))
  let pkg: { scripts?: Record<string, string>, dependencies?: Record<string, string>, devDependencies?: Record<string, string> } | null = null
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw)
    }
    catch {
      pkg = null
    }
  }

  const deplist = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  const isStacks = hasBuddy || Object.keys(deplist).some(name => name === 'stacks' || name.startsWith('@stacksjs/'))

  if (isStacks) {
    return {
      command: hasBuddy ? './buddy dev' : 'bun run dev',
      env: { STACKS_PROXY_MANAGED: '1' },
      urlEnv: ['APP_URL'],
      routes: [
        { path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true },
        { path: '/api', portEnv: 'PORT_API', defaultPort: 3008, stripPrefix: false, readyGate: false },
        { path: '/docs', portEnv: 'PORT_DOCS', defaultPort: 3006, stripPrefix: true, readyGate: false },
      ],
    }
  }

  if (pkg?.scripts?.dev) {
    return {
      command: 'bun run dev',
      routes: [{ path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true }],
    }
  }

  return null
}

/** Resolve a host to a site (or `null`). Construct once, call per request. */
export interface SiteResolver {
  resolve: (host: string) => ResolvedSite | null
}

/**
 * Build a {@link SiteResolver} over an {@link OnDemandSitesConfig}. Explicit
 * `sites` are matched first (exact host, then wildcard), then convention
 * discovery under `roots`.
 */
export function createSiteResolver(config: OnDemandSitesConfig, deps: SiteResolverDeps = {}): SiteResolver {
  const probes: ResolverProbes = {
    dirExists: deps.dirExists ?? defaultProbes.dirExists,
    fileExists: deps.fileExists ?? defaultProbes.fileExists,
    readText: deps.readText ?? defaultProbes.readText,
  }
  const detect = deps.detect ?? detectProjectPreset
  const home = deps.homeDir ?? homedir()
  const tlds = config.tlds ?? DEFAULT_TLDS
  const roots = (config.roots ?? DEFAULT_ROOTS).map(r => expandHome(r, home))
  const defaultIdle = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  // Explicit sites keyed by `to` for fast exact/wildcard lookup.
  const explicit = new Map<string, SiteConfig>()
  for (const site of config.sites ?? [])
    explicit.set(site.to, site)

  const idleFor = (site: SiteConfig): number => site.idleTimeoutMs ?? defaultIdle

  function fromExplicit(host: string): ResolvedSite | null {
    const site = matchHost(explicit, host)
    if (!site)
      return null
    const dir = isAbsolute(site.dir) ? site.dir : expandHome(site.dir, home)
    const selfRegisters = site.selfRegisters ?? false
    let routes = site.routes ?? []
    if (!selfRegisters && routes.length === 0) {
      const preset = detect(dir, probes)
      routes = preset?.routes ?? [{ path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true }]
    }
    const env = withUrlEnv({ ...(site.env ?? {}) }, undefined, host)
    return {
      host,
      id: siteIdForHost(host),
      dir,
      command: site.command,
      env,
      routes,
      selfRegisters,
      idleTimeoutMs: idleFor(site),
      source: 'config',
    }
  }

  function fromDiscovery(host: string): ResolvedSite | null {
    const name = projectNameFromHost(host, tlds)
    if (!name)
      return null
    for (const root of roots) {
      const dir = join(root, name)
      if (!probes.dirExists(dir))
        continue
      const preset = detect(dir, probes)
      if (!preset)
        continue
      const selfRegisters = preset.selfRegisters ?? false
      return {
        host,
        id: siteIdForHost(host),
        dir,
        command: preset.command,
        env: withUrlEnv({ ...(preset.env ?? {}) }, preset.urlEnv, host),
        routes: selfRegisters ? [] : (preset.routes ?? []),
        selfRegisters,
        idleTimeoutMs: defaultIdle,
        source: 'discovered',
      }
    }
    return null
  }

  return {
    resolve(rawHost: string): ResolvedSite | null {
      const host = hostOnly(rawHost)
      if (!host)
        return null
      return fromExplicit(host) ?? fromDiscovery(host)
    },
  }
}

/** Default `readdir`: immediate subdirectory names of `dir`, or `[]` on error. */
function defaultReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  }
  catch {
    return []
  }
}

/**
 * Enumerate the sites rpx can currently boot — explicit non-wildcard
 * {@link SiteConfig}s plus every project discovered by scanning the configured
 * roots. Powers `rpx sites`. Each entry is a fully-resolved {@link ResolvedSite}
 * (so the caller sees the dir, command, and host it would serve).
 */
export function listDiscoverableSites(config: OnDemandSitesConfig, deps: SiteResolverDeps = {}): ResolvedSite[] {
  const home = deps.homeDir ?? homedir()
  const tlds = config.tlds ?? DEFAULT_TLDS
  const roots = (config.roots ?? DEFAULT_ROOTS).map(r => expandHome(r, home))
  const readdir = deps.readdir ?? defaultReaddir
  const resolver = createSiteResolver(config, deps)

  const out: ResolvedSite[] = []
  const seen = new Set<string>()
  const add = (site: ResolvedSite | null) => {
    if (site && !seen.has(site.host)) {
      seen.add(site.host)
      out.push(site)
    }
  }

  // Explicit, concrete (non-wildcard) sites — wildcards can't be enumerated.
  for (const site of config.sites ?? []) {
    if (!site.to.includes('*'))
      add(resolver.resolve(site.to))
  }

  // Convention discovery: every project directory under each root, mapped to
  // `<name>.<primary-tld>`.
  const primaryTld = tlds[0] ?? 'localhost'
  for (const root of roots) {
    for (const name of readdir(root))
      add(resolver.resolve(`${name}.${primaryTld}`))
  }

  return out
}

/** Set each `urlEnv` var (if not already present) to the site URL. */
function withUrlEnv(env: Record<string, string>, urlEnv: string[] | undefined, host: string): Record<string, string> {
  if (!urlEnv)
    return env
  const url = `https://${host}`
  for (const key of urlEnv) {
    if (env[key] === undefined)
      env[key] = url
  }
  return env
}
