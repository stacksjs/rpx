import type { ResolverProbes } from '../src/site-resolver'
import type { OnDemandSitesConfig } from '../src/types'
import { describe, expect, it } from 'bun:test'
import {
  createSiteResolver,
  detectProjectPreset,
  expandHome,
  listDiscoverableSites,
  projectNameFromHost,
  siteIdForHost,
} from '../src/site-resolver'

/**
 * A fake filesystem: `dirs` are directories, `files` maps a path to its text
 * (presence ⇒ the file exists). Lets the resolver run without touching disk.
 */
function fakeProbes(opts: { dirs?: string[], files?: Record<string, string> } = {}): ResolverProbes {
  const dirs = new Set(opts.dirs ?? [])
  const files = opts.files ?? {}
  return {
    dirExists: p => dirs.has(p),
    fileExists: p => p in files || dirs.has(p),
    readText: p => (p in files ? files[p] : null),
  }
}

const HOME = '/home/dev'

describe('expandHome', () => {
  it('expands a bare ~ and ~/…', () => {
    expect(expandHome('~', HOME)).toBe(HOME)
    expect(expandHome('~/Code', HOME)).toBe('/home/dev/Code')
  })
  it('leaves absolute and relative paths untouched', () => {
    expect(expandHome('/abs/path', HOME)).toBe('/abs/path')
    expect(expandHome('Code/x', HOME)).toBe('Code/x')
  })
})

describe('siteIdForHost', () => {
  it('keeps registry-safe chars and trims separators', () => {
    expect(siteIdForHost('myapp.localhost')).toBe('myapp.localhost')
    expect(siteIdForHost('My App!.localhost')).toBe('My-App-.localhost')
    expect(siteIdForHost('-weird-.localhost-')).toBe('weird-.localhost')
  })
})

describe('projectNameFromHost', () => {
  const tlds = ['localhost', 'test']
  it('extracts a single-label project name', () => {
    expect(projectNameFromHost('myapp.localhost', tlds)).toBe('myapp')
    expect(projectNameFromHost('pet-store.test', tlds)).toBe('pet-store')
  })
  it('refuses nested subdomains and bare TLDs', () => {
    expect(projectNameFromHost('docs.myapp.localhost', tlds)).toBeNull()
    expect(projectNameFromHost('localhost', tlds)).toBeNull()
  })
  it('refuses non-dev TLDs', () => {
    expect(projectNameFromHost('myapp.com', tlds)).toBeNull()
  })
})

describe('detectProjectPreset', () => {
  it('classifies a Stacks app by its ./buddy launcher', () => {
    const probes = fakeProbes({ files: { '/p/buddy': '#!/usr/bin/env bun' } })
    const preset = detectProjectPreset('/p', probes)
    expect(preset?.command).toBe('./buddy dev')
    expect(preset?.env?.STACKS_PROXY_MANAGED).toBe('1')
    expect(preset?.urlEnv).toEqual(['APP_URL'])
    expect(preset?.routes?.map(r => r.path)).toEqual(['/', '/api', '/docs'])
  })
  it('classifies a Stacks app by a @stacksjs dependency', () => {
    const probes = fakeProbes({
      files: { '/p/package.json': JSON.stringify({ dependencies: { '@stacksjs/cli': '^1' } }) },
    })
    const preset = detectProjectPreset('/p', probes)
    expect(preset?.command).toBe('bun run dev')
    expect(preset?.routes?.length).toBe(3)
  })
  it('classifies a generic project with a dev script', () => {
    const probes = fakeProbes({
      files: { '/p/package.json': JSON.stringify({ scripts: { dev: 'vite' } }) },
    })
    const preset = detectProjectPreset('/p', probes)
    expect(preset?.command).toBe('bun run dev')
    expect(preset?.routes).toEqual([{ path: '/', portEnv: 'PORT', defaultPort: 3000, readyGate: true }])
  })
  it('returns null for a non-project directory', () => {
    expect(detectProjectPreset('/p', fakeProbes())).toBeNull()
    expect(detectProjectPreset('/p', fakeProbes({ files: { '/p/package.json': '{"name":"x"}' } }))).toBeNull()
  })
})

describe('createSiteResolver — discovery', () => {
  const baseConfig: OnDemandSitesConfig = { enabled: true, roots: ['~/Code'], tlds: ['localhost', 'test'] }

  it('discovers a Stacks app under ~/Code by host convention', () => {
    const probes = fakeProbes({
      dirs: ['/home/dev/Code/myapp'],
      files: { '/home/dev/Code/myapp/buddy': '#!/usr/bin/env bun' },
    })
    const resolver = createSiteResolver(baseConfig, { ...probes, homeDir: HOME })
    const site = resolver.resolve('myapp.localhost')
    expect(site).not.toBeNull()
    expect(site!.dir).toBe('/home/dev/Code/myapp')
    expect(site!.command).toBe('./buddy dev')
    expect(site!.source).toBe('discovered')
    expect(site!.env.APP_URL).toBe('https://myapp.localhost')
    expect(site!.env.STACKS_PROXY_MANAGED).toBe('1')
    expect(site!.routes.map(r => r.path)).toEqual(['/', '/api', '/docs'])
    expect(site!.id).toBe('myapp.localhost')
  })

  it('strips the port from the request host', () => {
    const probes = fakeProbes({
      dirs: ['/home/dev/Code/myapp'],
      files: { '/home/dev/Code/myapp/package.json': JSON.stringify({ scripts: { dev: 'vite' } }) },
    })
    const resolver = createSiteResolver(baseConfig, { ...probes, homeDir: HOME })
    expect(resolver.resolve('myapp.localhost:443')?.host).toBe('myapp.localhost')
  })

  it('returns null when the directory does not exist', () => {
    const resolver = createSiteResolver(baseConfig, { ...fakeProbes(), homeDir: HOME })
    expect(resolver.resolve('ghost.localhost')).toBeNull()
  })

  it('returns null when the directory exists but is not a dev project', () => {
    const probes = fakeProbes({ dirs: ['/home/dev/Code/plain'] })
    const resolver = createSiteResolver(baseConfig, { ...probes, homeDir: HOME })
    expect(resolver.resolve('plain.localhost')).toBeNull()
  })

  it('does not discover nested subdomains', () => {
    const probes = fakeProbes({
      dirs: ['/home/dev/Code/myapp'],
      files: { '/home/dev/Code/myapp/buddy': '' },
    })
    const resolver = createSiteResolver(baseConfig, { ...probes, homeDir: HOME })
    expect(resolver.resolve('docs.myapp.localhost')).toBeNull()
  })

  it('applies the default idle timeout', () => {
    const probes = fakeProbes({
      dirs: ['/home/dev/Code/myapp'],
      files: { '/home/dev/Code/myapp/buddy': '' },
    })
    const resolver = createSiteResolver({ ...baseConfig, idleTimeoutMs: 12345 }, { ...probes, homeDir: HOME })
    expect(resolver.resolve('myapp.localhost')?.idleTimeoutMs).toBe(12345)
  })
})

describe('createSiteResolver — explicit sites', () => {
  it('matches an exact explicit host before discovery', () => {
    const config: OnDemandSitesConfig = {
      enabled: true,
      sites: [{ to: 'api.localhost', dir: '/srv/api', command: 'bun run start', selfRegisters: true }],
    }
    const resolver = createSiteResolver(config, { ...fakeProbes(), homeDir: HOME })
    const site = resolver.resolve('api.localhost')
    expect(site).not.toBeNull()
    expect(site!.dir).toBe('/srv/api')
    expect(site!.command).toBe('bun run start')
    expect(site!.selfRegisters).toBe(true)
    expect(site!.routes).toEqual([])
    expect(site!.source).toBe('config')
  })

  it('matches a wildcard explicit host', () => {
    const config: OnDemandSitesConfig = {
      enabled: true,
      sites: [{ to: '*.preview.localhost', dir: '~/previews', command: 'bun run dev', routes: [{ path: '/', portEnv: 'PORT' }] }],
    }
    const resolver = createSiteResolver(config, { ...fakeProbes(), homeDir: HOME })
    const site = resolver.resolve('feature-x.preview.localhost')
    expect(site).not.toBeNull()
    expect(site!.host).toBe('feature-x.preview.localhost')
    expect(site!.dir).toBe('/home/dev/previews')
    expect(site!.routes).toEqual([{ path: '/', portEnv: 'PORT' }])
  })

  it('honors a per-site idle timeout override', () => {
    const config: OnDemandSitesConfig = {
      enabled: true,
      idleTimeoutMs: 1000,
      sites: [{ to: 'x.localhost', dir: '/x', command: 'c', selfRegisters: true, idleTimeoutMs: 99 }],
    }
    const resolver = createSiteResolver(config, { ...fakeProbes(), homeDir: HOME })
    expect(resolver.resolve('x.localhost')?.idleTimeoutMs).toBe(99)
  })
})

describe('listDiscoverableSites', () => {
  it('enumerates discovered projects under the roots and explicit sites', () => {
    const probes = fakeProbes({
      dirs: ['/home/dev/Code/myapp', '/home/dev/Code/plain', '/home/dev/Code/site'],
      files: {
        '/home/dev/Code/myapp/buddy': '',
        '/home/dev/Code/site/package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        // 'plain' has neither → not a project, excluded.
      },
    })
    const config: OnDemandSitesConfig = {
      enabled: true,
      roots: ['~/Code'],
      tlds: ['localhost'],
      sites: [{ to: 'explicit.localhost', dir: '/srv/x', command: 'bun run start', selfRegisters: true }],
    }
    const sites = listDiscoverableSites(config, {
      ...probes,
      homeDir: HOME,
      readdir: dir => (dir === '/home/dev/Code' ? ['myapp', 'plain', 'site'] : []),
    })
    const hosts = sites.map(s => s.host).sort()
    expect(hosts).toEqual(['explicit.localhost', 'myapp.localhost', 'site.localhost'])
    expect(sites.find(s => s.host === 'myapp.localhost')?.command).toBe('./buddy dev')
    expect(sites.find(s => s.host === 'explicit.localhost')?.source).toBe('config')
  })

  it('skips wildcard explicit sites (cannot enumerate)', () => {
    const config: OnDemandSitesConfig = {
      enabled: true,
      roots: ['~/none'],
      sites: [{ to: '*.preview.localhost', dir: '~/p', command: 'c', selfRegisters: true }],
    }
    const sites = listDiscoverableSites(config, { ...fakeProbes(), homeDir: HOME, readdir: () => [] })
    expect(sites).toEqual([])
  })
})
