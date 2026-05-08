import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { deriveIdFromTarget, runViaDaemon } from '../src/daemon-runner'
import { getDaemonPidPath, isDaemonRunning } from '../src/daemon'
import { readAll, readEntry } from '../src/registry'

let rpxDir: string
let registryDir: string
const adoptedPids: Set<number> = new Set()

beforeEach(async () => {
  rpxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-runner-test-'))
  registryDir = path.join(rpxDir, 'registry.d')
})

afterEach(async () => {
  for (const pid of adoptedPids) {
    try { process.kill(pid, 'SIGKILL') }
    catch {}
  }
  adoptedPids.clear()
  await fsp.rm(rpxDir, { recursive: true, force: true }).catch(() => {})
})

async function writeFakeDaemon(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'fake-daemon.ts')
  await fsp.writeFile(scriptPath, `import { writeFileSync, unlinkSync } from 'node:fs'
const pidPath = process.argv[2]
writeFileSync(pidPath, String(process.pid) + '\\n')
process.on('SIGTERM', () => { try { unlinkSync(pidPath) } catch {} ; process.exit(0) })
process.on('SIGINT', () => { try { unlinkSync(pidPath) } catch {} ; process.exit(0) })
setInterval(() => {}, 60_000)
`, 'utf8')
  return scriptPath
}

describe('deriveIdFromTarget', () => {
  it('passes valid hostnames through unchanged', () => {
    expect(deriveIdFromTarget('pet-store.localhost')).toBe('pet-store.localhost')
    expect(deriveIdFromTarget('training.localhost')).toBe('training.localhost')
    expect(deriveIdFromTarget('a.b.c.localhost')).toBe('a.b.c.localhost')
  })

  it('replaces path separators with dashes', () => {
    expect(deriveIdFromTarget('mysite.localhost/api')).toBe('mysite.localhost-api')
    expect(deriveIdFromTarget('a/b/c')).toBe('a-b-c')
  })

  it('trims dashes and falls back to "rpx" when nothing usable', () => {
    expect(deriveIdFromTarget('---')).toBe('rpx')
    expect(deriveIdFromTarget('')).toBe('rpx')
    expect(deriveIdFromTarget('///')).toBe('rpx')
  })

  it('caps to 128 chars', () => {
    const long = 'a'.repeat(500)
    expect(deriveIdFromTarget(long).length).toBeLessThanOrEqual(128)
  })
})

describe('runViaDaemon', () => {
  it('writes one registry entry per proxy and ensures the daemon', async () => {
    const script = await writeFakeDaemon(rpxDir)
    await runViaDaemon({
      proxies: [
        { from: 'localhost:5173', to: 'pet-store.localhost' },
        { from: 'localhost:5174', to: 'training.localhost', cleanUrls: true },
      ],
      verbose: false,
      registryDir,
      rpxDir,
      detached: true,
      spawnCommand: [process.execPath, script, getDaemonPidPath(rpxDir)],
    })

    const stored = await readAll(registryDir)
    const pid = (await import('node:fs/promises')).readFile(getDaemonPidPath(rpxDir), 'utf8')
    const pidNum = Number.parseInt((await pid).trim(), 10)
    adoptedPids.add(pidNum)

    expect(stored).toHaveLength(2)
    const byTo = new Map(stored.map(e => [e.to, e]))
    expect(byTo.get('pet-store.localhost')?.from).toBe('localhost:5173')
    expect(byTo.get('training.localhost')?.cleanUrls).toBe(true)
    expect(await isDaemonRunning(rpxDir)).toBe(true)
  })

  it('uses an explicit id when provided, otherwise derives from `to`', async () => {
    const script = await writeFakeDaemon(rpxDir)
    await runViaDaemon({
      proxies: [
        { id: 'custom-id', from: 'localhost:1', to: 'a.localhost' },
        { from: 'localhost:2', to: 'b.localhost' },
      ],
      registryDir,
      rpxDir,
      detached: true,
      spawnCommand: [process.execPath, script, getDaemonPidPath(rpxDir)],
    })

    const fsp2 = await import('node:fs/promises')
    const pidNum = Number.parseInt((await fsp2.readFile(getDaemonPidPath(rpxDir), 'utf8')).trim(), 10)
    adoptedPids.add(pidNum)

    const a = await readEntry('custom-id', registryDir)
    const b = await readEntry('b.localhost', registryDir)
    expect(a?.to).toBe('a.localhost')
    expect(b?.from).toBe('localhost:2')
  })

  it('throws on duplicate ids before any registry write', async () => {
    await expect(
      runViaDaemon({
        proxies: [
          { from: 'localhost:1', to: 'shared.localhost' },
          { from: 'localhost:2', to: 'shared.localhost' },
        ],
        registryDir,
        rpxDir,
        detached: true,
        spawnCommand: ['/never/runs'],
      }),
    ).rejects.toThrow(/duplicate registry id/)

    // No partial write — daemon never spawned, registry stays empty
    const entries = await readAll(registryDir)
    expect(entries).toEqual([])
    expect(await isDaemonRunning(rpxDir)).toBe(false)
  })

  it('throws when proxies is empty', async () => {
    await expect(
      runViaDaemon({ proxies: [], registryDir, rpxDir, detached: true }),
    ).rejects.toThrow(/no proxies/)
  })
})
