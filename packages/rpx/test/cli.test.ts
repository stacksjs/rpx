/**
 * CLI integration tests. We invoke `bun bin/cli.ts <subcommand>` as a
 * subprocess so the test exercises the same argv-parsing path that real users
 * hit. All commands run against a temp `--rpx-dir` so they never touch the
 * developer's `~/.stacks/rpx`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'

const CLI = path.join(import.meta.dir, '..', 'bin', 'cli.ts')

let rpxDir: string
let registryDir: string

beforeEach(async () => {
  rpxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-cli-test-'))
  registryDir = path.join(rpxDir, 'registry.d')
})

afterEach(async () => {
  await fsp.rm(rpxDir, { recursive: true, force: true }).catch(() => {})
})

interface Run {
  exitCode: number
  stdout: string
  stderr: string
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

describe('cli: daemon:status', () => {
  it('reports not running for a fresh dir', () => {
    const r = run(['daemon:status', '--rpx-dir', rpxDir, '--registry-dir', registryDir])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('not running')
    expect(r.stdout).toContain('no registered hosts')
  })

  it('emits valid JSON with --json', () => {
    const r = run(['daemon:status', '--rpx-dir', rpxDir, '--registry-dir', registryDir, '--json'])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.running).toBe(false)
    expect(parsed.pid).toBeNull()
    expect(parsed.rpxDir).toBe(rpxDir)
    expect(parsed.registryDir).toBe(registryDir)
    expect(parsed.entries).toEqual([])
  })

  it('lists registered entries after register', () => {
    run([
      'register',
      '--id', 'smoke',
      '--from', 'localhost:9999',
      '--to', 'smoke.localhost',
      '--skip-spawn',
      '--rpx-dir', rpxDir,
      '--registry-dir', registryDir,
    ])
    const r = run(['daemon:status', '--rpx-dir', rpxDir, '--registry-dir', registryDir, '--json'])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0].id).toBe('smoke')
    expect(parsed.entries[0].to).toBe('smoke.localhost')
    expect(parsed.entries[0].from).toBe('localhost:9999')
  })
})

describe('cli: register', () => {
  it('rejects missing required flags with exit 1', () => {
    const r = run(['register', '--registry-dir', registryDir])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('--id')
  })

  it('rejects an invalid id with exit 1', () => {
    const r = run([
      'register',
      '--id', '../escape',
      '--from', 'localhost:1',
      '--to', 'x.localhost',
      '--skip-spawn',
      '--registry-dir', registryDir,
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('invalid id')
  })

  it('writes an entry to disk with --skip-spawn', async () => {
    const r = run([
      'register',
      '--id', 'pet-store',
      '--from', 'localhost:5173',
      '--to', 'pet-store.localhost',
      '--clean-urls',
      '--change-origin',
      '--skip-spawn',
      '--rpx-dir', rpxDir,
      '--registry-dir', registryDir,
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('daemon spawn skipped')

    const written = await fsp.readFile(path.join(registryDir, 'pet-store.json'), 'utf8')
    const parsed = JSON.parse(written)
    expect(parsed.id).toBe('pet-store')
    expect(parsed.to).toBe('pet-store.localhost')
    expect(parsed.from).toBe('localhost:5173')
    expect(parsed.cleanUrls).toBe(true)
    expect(parsed.changeOrigin).toBe(true)
    // CLI register intentionally omits pid so the entry isn't reaped by the
    // daemon's PID-GC the moment this short-lived subprocess exits.
    expect(parsed.pid).toBeUndefined()
  })
})

describe('cli: unregister', () => {
  it('removes an existing entry', async () => {
    run([
      'register',
      '--id', 'training',
      '--from', 'localhost:5174',
      '--to', 'training.localhost',
      '--skip-spawn',
      '--rpx-dir', rpxDir,
      '--registry-dir', registryDir,
    ])
    const r = run(['unregister', 'training', '--registry-dir', registryDir])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('unregistered')
    await expect(fsp.access(path.join(registryDir, 'training.json'))).rejects.toThrow()
  })

  it('is a no-op when the id is unknown', () => {
    const r = run(['unregister', 'no-such-app', '--registry-dir', registryDir])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('no registry entry')
  })

  it('rejects an invalid id', () => {
    const r = run(['unregister', '../escape', '--registry-dir', registryDir])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('invalid id')
  })
})

describe('cli: daemon:stop', () => {
  it('reports not-running when no daemon is up', () => {
    const r = run(['daemon:stop', '--rpx-dir', rpxDir])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('not running')
  })
})
