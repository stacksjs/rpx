import type { ResolvedSite, SiteResolver } from '../src/site-resolver'
import type { SiteLauncher, SiteProcessHandle } from '../src/site-supervisor'
import type { RegistryEntry } from '../src/registry'
import { afterEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SiteSupervisor } from '../src/site-supervisor'

/** A controllable fake process: tests resolve `exit` to simulate it dying. */
function fakeProc(pid: number): { handle: SiteProcessHandle, signals: NodeJS.Signals[], exit: (code: number | null) => void } {
  const signals: NodeJS.Signals[] = []
  let resolveExit!: (code: number | null) => void
  const exited = new Promise<number | null>((r) => { resolveExit = r })
  return {
    signals,
    exit: code => resolveExit(code),
    handle: {
      pid,
      exited,
      // Realistic: a signalled dev server exits, so the supervisor's kill resolves.
      stop: (signal = 'SIGTERM') => {
        signals.push(signal)
        resolveExit(null)
      },
    },
  }
}

const stacksSite = (overrides: Partial<ResolvedSite> = {}): ResolvedSite => ({
  host: 'myapp.localhost',
  id: 'myapp.localhost',
  dir: '/home/dev/Code/myapp',
  command: './buddy dev',
  env: { STACKS_PROXY_MANAGED: '1', APP_URL: 'https://myapp.localhost' },
  routes: [
    { path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true },
    { path: '/api', portEnv: 'PORT_API', defaultPort: 3008, stripPrefix: false, readyGate: false },
    { path: '/docs', portEnv: 'PORT_DOCS', defaultPort: 3006, stripPrefix: true, readyGate: false },
  ],
  selfRegisters: false,
  idleTimeoutMs: 60_000,
  source: 'discovered',
  ...overrides,
})

function resolverFor(site: ResolvedSite | null): SiteResolver {
  return { resolve: host => (site && host === site.host ? site : null) }
}

describe('SiteSupervisor', () => {
  let rpxDir: string
  const supervisors: SiteSupervisor[] = []

  afterEach(async () => {
    await Promise.all(supervisors.map(s => s.stopAll()))
    supervisors.length = 0
    if (rpxDir)
      await fsp.rm(rpxDir, { recursive: true, force: true }).catch(() => {})
  })

  async function mkdir(): Promise<string> {
    rpxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-sites-'))
    return rpxDir
  }

  it('returns unknown for a host that resolves to no site', async () => {
    await mkdir()
    const sup = new SiteSupervisor({ resolver: resolverFor(null), rpxDir, registryDir: rpxDir })
    supervisors.push(sup)
    expect(await sup.onRequest('nope.localhost')).toEqual({ kind: 'unknown' })
  })

  it('boots a site on first request and reports starting', async () => {
    await mkdir()
    const launched: string[] = []
    const proc = fakeProc(4242)
    const launcher: SiteLauncher = (spec) => {
      launched.push(spec.command)
      return proc.handle
    }
    let portReady = false
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher,
      pickPort: async preferred => preferred,
      probePort: async () => portReady,
      isHostRoutable: () => false,
      pollIntervalMs: 5,
    })
    supervisors.push(sup)

    const first = await sup.onRequest('myapp.localhost')
    expect(first.kind).toBe('starting')
    expect(launched).toEqual(['./buddy dev'])

    // A second request while booting doesn't relaunch.
    const second = await sup.onRequest('myapp.localhost')
    expect(second.kind).toBe('starting')
    expect(launched.length).toBe(1)

    portReady = true
    void portReady
  })

  it('injects the chosen ports into the launch env', async () => {
    await mkdir()
    let captured: Record<string, string> = {}
    const proc = fakeProc(1)
    const launcher: SiteLauncher = (spec) => {
      captured = spec.env
      return proc.handle
    }
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher,
      pickPort: async preferred => preferred,
      probePort: async () => false,
      pollIntervalMs: 5,
    })
    supervisors.push(sup)
    await sup.onRequest('myapp.localhost')
    expect(captured.PORT).toBe('3000')
    expect(captured.PORT_API).toBe('3008')
    expect(captured.PORT_DOCS).toBe('3006')
    expect(captured.APP_URL).toBe('https://myapp.localhost')
    expect(captured.RPX_SITE_HOST).toBe('myapp.localhost')
  })

  it('publishes a registry entry with pathRewrites once the ready gate passes', async () => {
    await mkdir()
    const proc = fakeProc(777)
    const written: RegistryEntry[] = []
    let routable = false
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher: () => proc.handle,
      pickPort: async preferred => preferred,
      probePort: async () => true, // gate passes immediately
      isHostRoutable: () => routable,
      writeEntry: async (entry) => { written.push(entry); routable = true },
      removeEntry: async () => {},
      pollIntervalMs: 5,
    })
    supervisors.push(sup)

    await sup.onRequest('myapp.localhost')
    // Let the readiness loop publish.
    await waitFor(() => written.length > 0)

    expect(written.length).toBe(1)
    const entry = written[0]
    expect(entry.id).toBe('myapp.localhost')
    expect(entry.from).toBe('localhost:3000')
    expect(entry.to).toBe('myapp.localhost')
    expect(entry.pid).toBe(777)
    expect(entry.pathRewrites).toEqual([
      { from: '/api', to: 'localhost:3008', stripPrefix: false },
      { from: '/docs', to: 'localhost:3006', stripPrefix: true },
    ])

    // Now routable → onRequest reports ready so the daemon retries routing.
    await waitFor(async () => (await sup.onRequest('myapp.localhost')).kind === 'ready')
  })

  it('fails the site when the process exits before becoming ready', async () => {
    await mkdir()
    const proc = fakeProc(9)
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher: () => proc.handle,
      pickPort: async preferred => preferred,
      probePort: async () => false,
      pollIntervalMs: 5,
    })
    supervisors.push(sup)
    await sup.onRequest('myapp.localhost')
    proc.exit(1)
    await waitFor(async () => (await sup.onRequest('myapp.localhost')).kind === 'failed', 2000)
    const status = await sup.onRequest('myapp.localhost')
    expect(status.kind).toBe('failed')
  })

  it('reaps an idle site, signalling and removing its routes', async () => {
    await mkdir()
    const proc = fakeProc(55)
    const removed: string[] = []
    let clock = 1_000_000
    let routable = false
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite({ idleTimeoutMs: 1000 })),
      rpxDir,
      registryDir: rpxDir,
      launcher: () => proc.handle,
      pickPort: async preferred => preferred,
      probePort: async () => true,
      isHostRoutable: () => routable,
      writeEntry: async () => { routable = true },
      removeEntry: async (id) => { removed.push(id) },
      now: () => clock,
      pollIntervalMs: 5,
      reapIntervalMs: 5,
      killGraceMs: 20,
    })
    supervisors.push(sup)

    await sup.onRequest('myapp.localhost')
    await waitFor(() => routable)
    // Advance the clock well past the idle timeout; the reaper should stop it.
    clock += 10_000
    await waitFor(() => removed.includes('myapp.localhost'), 2000)
    expect(proc.signals).toContain('SIGTERM')
    expect(removed).toContain('myapp.localhost')
  })

  it('reboots a site that crashes after going live', async () => {
    await mkdir()
    const procs = [fakeProc(100), fakeProc(200)]
    let launches = 0
    const removed: string[] = []
    let routable = false
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher: () => procs[launches++]!.handle,
      pickPort: async preferred => preferred,
      probePort: async () => true,
      isHostRoutable: () => routable,
      writeEntry: async () => { routable = true },
      removeEntry: async (id) => { removed.push(id) },
      pollIntervalMs: 5,
      killGraceMs: 20,
    })
    supervisors.push(sup)

    await sup.onRequest('myapp.localhost')
    await waitFor(async () => (await sup.onRequest('myapp.localhost')).kind === 'ready')
    expect(launches).toBe(1)

    // The live dev server crashes — its route is dropped and state cleared.
    procs[0]!.exit(1)
    await waitFor(() => removed.includes('myapp.localhost'))
    routable = false

    // The next request reboots it (a second launch).
    const after = await sup.onRequest('myapp.localhost')
    expect(after.kind).toBe('starting')
    expect(launches).toBe(2)
  })

  it('stopAll signals every running site', async () => {
    await mkdir()
    const proc = fakeProc(123)
    const sup = new SiteSupervisor({
      resolver: resolverFor(stacksSite()),
      rpxDir,
      registryDir: rpxDir,
      launcher: () => proc.handle,
      pickPort: async preferred => preferred,
      probePort: async () => false,
      pollIntervalMs: 5,
    })
    await sup.onRequest('myapp.localhost')
    await sup.stopAll()
    expect(proc.signals).toContain('SIGTERM')
  })
})

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred())
      return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('waitFor timed out')
}
