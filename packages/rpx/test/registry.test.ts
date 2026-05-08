import type { RegistryEntry } from '../src/registry'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import {
  gcStaleEntries,
  isPidAlive,
  isValidId,
  readAll,
  readEntry,
  removeEntry,
  watchRegistry,
  writeEntry,
} from '../src/registry'

let tmpDir: string

function entry(id: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id,
    from: 'localhost:5173',
    to: `${id}.localhost`,
    pid: process.pid,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-registry-test-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('isValidId', () => {
  it('accepts plain ids', () => {
    expect(isValidId('pet-store')).toBe(true)
    expect(isValidId('training_2')).toBe(true)
    expect(isValidId('app.v1')).toBe(true)
  })

  it('rejects path traversal and slashes', () => {
    expect(isValidId('../escape')).toBe(false)
    expect(isValidId('a/b')).toBe(false)
    expect(isValidId('a\\b')).toBe(false)
  })

  it('rejects empty and oversized ids', () => {
    expect(isValidId('')).toBe(false)
    expect(isValidId('x'.repeat(129))).toBe(false)
  })
})

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('reports an obviously-dead pid as dead', () => {
    // PID 0 / negative PIDs are never valid user processes
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    // A very high PID that's almost certainly unallocated
    expect(isPidAlive(2_000_000_000)).toBe(false)
  })
})

describe('writeEntry / readEntry round-trip', () => {
  it('persists and reads back an entry', async () => {
    const e = entry('pet-store')
    await writeEntry(e, tmpDir)
    const got = await readEntry('pet-store', tmpDir)
    expect(got).toEqual(e)
  })

  it('returns null for missing entries', async () => {
    expect(await readEntry('does-not-exist', tmpDir)).toBeNull()
  })

  it('rejects an entry with an invalid id', async () => {
    expect(writeEntry(entry('../bad'), tmpDir)).rejects.toThrow()
  })

  it('rejects entries missing required fields', async () => {
    const bad = { id: 'x', from: 'localhost:5173' } as unknown as RegistryEntry
    expect(writeEntry(bad, tmpDir)).rejects.toThrow()
  })
})

describe('removeEntry', () => {
  it('deletes an existing entry', async () => {
    await writeEntry(entry('pet-store'), tmpDir)
    await removeEntry('pet-store', tmpDir)
    expect(await readEntry('pet-store', tmpDir)).toBeNull()
  })

  it('is a no-op when the entry is missing', async () => {
    await expect(removeEntry('nope', tmpDir)).resolves.toBeUndefined()
  })
})

describe('readAll', () => {
  it('returns an empty list for a missing directory', async () => {
    const ghost = path.join(tmpDir, 'does-not-exist')
    expect(await readAll(ghost)).toEqual([])
  })

  it('returns all valid entries', async () => {
    await writeEntry(entry('pet-store'), tmpDir)
    await writeEntry(entry('training'), tmpDir)
    const all = await readAll(tmpDir)
    expect(all.map(e => e.id).sort()).toEqual(['pet-store', 'training'])
  })

  it('skips and removes malformed JSON files', async () => {
    await fsp.writeFile(path.join(tmpDir, 'broken.json'), '{ not valid')
    await writeEntry(entry('ok'), tmpDir)
    const all = await readAll(tmpDir)
    expect(all.map(e => e.id)).toEqual(['ok'])
    // Malformed file should have been pruned
    expect(await readEntry('broken', tmpDir)).toBeNull()
  })

  it('ignores non-json files', async () => {
    await fsp.writeFile(path.join(tmpDir, 'README'), 'noise')
    await writeEntry(entry('ok'), tmpDir)
    const all = await readAll(tmpDir)
    expect(all.map(e => e.id)).toEqual(['ok'])
  })
})

describe('gcStaleEntries', () => {
  it('removes entries whose PID is dead and keeps live ones', async () => {
    await writeEntry(entry('alive', { pid: process.pid }), tmpDir)
    await writeEntry(entry('dead', { pid: 2_000_000_000 }), tmpDir)
    const removed = await gcStaleEntries(tmpDir)
    expect(removed).toBe(1)
    const survivors = await readAll(tmpDir)
    expect(survivors.map(e => e.id)).toEqual(['alive'])
  })

  it('returns zero when nothing is stale', async () => {
    await writeEntry(entry('alive'), tmpDir)
    expect(await gcStaleEntries(tmpDir)).toBe(0)
  })

  it('skips entries without a pid (manual entries opt out of GC)', async () => {
    // Build an entry with no pid field at all — pid is optional and its
    // absence opts the entry out of PID-based GC.
    const manual: RegistryEntry = {
      id: 'manual',
      from: 'localhost:5173',
      to: 'manual.localhost',
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
    }
    await writeEntry(manual, tmpDir)
    // Plus a dead-pid entry to prove GC still works for entries that DO opt in.
    await writeEntry(entry('dead', { pid: 2_000_000_000 }), tmpDir)

    expect(await gcStaleEntries(tmpDir)).toBe(1)
    const survivors = await readAll(tmpDir)
    expect(survivors.map(e => e.id).sort()).toEqual(['manual'])
  })
})

describe('watchRegistry', () => {
  it('fires once on startup with the current entries', async () => {
    await writeEntry(entry('preexisting'), tmpDir)

    const seen: string[][] = []
    const handle = watchRegistry(
      (entries) => { seen.push(entries.map(e => e.id).sort()) },
      { dir: tmpDir, debounceMs: 30 },
    )

    // Wait a touch longer than the debounce so the startup fire lands
    await new Promise(r => setTimeout(r, 80))
    handle.close()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toEqual(['preexisting'])
  })

  it('coalesces rapid changes through the debounce', async () => {
    const seen: string[][] = []
    const handle = watchRegistry(
      (entries) => { seen.push(entries.map(e => e.id).sort()) },
      { dir: tmpDir, debounceMs: 60 },
    )

    // Drain the startup fire first
    await new Promise(r => setTimeout(r, 100))
    const seenAfterStartup = seen.length

    // Burst of writes within the debounce window
    await writeEntry(entry('a'), tmpDir)
    await writeEntry(entry('b'), tmpDir)
    await writeEntry(entry('c'), tmpDir)

    await new Promise(r => setTimeout(r, 150))
    handle.close()

    const burstFires = seen.length - seenAfterStartup
    // We allow up to 2 fires (one for the burst, occasionally a stragger from
    // the rename event) but never N=3 for three writes.
    expect(burstFires).toBeGreaterThan(0)
    expect(burstFires).toBeLessThanOrEqual(2)
    // The final state should reflect all three writes
    expect(seen[seen.length - 1]).toEqual(['a', 'b', 'c'])
  })

  it('reflects deletions', async () => {
    await writeEntry(entry('keep'), tmpDir)
    await writeEntry(entry('drop'), tmpDir)

    const seen: string[][] = []
    const handle = watchRegistry(
      (entries) => { seen.push(entries.map(e => e.id).sort()) },
      { dir: tmpDir, debounceMs: 30 },
    )

    await new Promise(r => setTimeout(r, 80))
    await removeEntry('drop', tmpDir)
    await new Promise(r => setTimeout(r, 100))
    handle.close()

    expect(seen[seen.length - 1]).toEqual(['keep'])
  })
})
