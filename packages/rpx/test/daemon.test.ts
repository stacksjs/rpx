import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import {
  acquireDaemonLock,
  ensureDaemonRunning,
  getDaemonPidPath,
  isDaemonRunning,
  readDaemonPid,
  releaseDaemonLock,
  runDaemon,
  stopDaemon,
} from '../src/daemon'
import { writeEntry } from '../src/registry'

let rpxDir: string

beforeEach(async () => {
  rpxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-daemon-test-'))
})

afterEach(async () => {
  await fsp.rm(rpxDir, { recursive: true, force: true }).catch(() => {})
})

describe('readDaemonPid', () => {
  it('returns null when no pid file exists', async () => {
    expect(await readDaemonPid(rpxDir)).toBeNull()
  })

  it('returns the parsed pid when the file is valid', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '12345\n')
    expect(await readDaemonPid(rpxDir)).toBe(12345)
  })

  it('returns null for malformed pid contents', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), 'not a pid')
    expect(await readDaemonPid(rpxDir)).toBeNull()
  })

  it('returns null for negative or zero pids', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '-1\n')
    expect(await readDaemonPid(rpxDir)).toBeNull()
    await fsp.writeFile(getDaemonPidPath(rpxDir), '0\n')
    expect(await readDaemonPid(rpxDir)).toBeNull()
  })
})

describe('isDaemonRunning', () => {
  it('false when no pid file', async () => {
    expect(await isDaemonRunning(rpxDir)).toBe(false)
  })

  it('false when pid file points at a dead pid', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '2000000000\n')
    expect(await isDaemonRunning(rpxDir)).toBe(false)
  })

  it('true when pid file points at the current process', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), `${process.pid}\n`)
    expect(await isDaemonRunning(rpxDir)).toBe(true)
  })
})

describe('acquireDaemonLock', () => {
  it('creates the pid file on first acquisition', async () => {
    const pidPath = await acquireDaemonLock(rpxDir)
    const stored = await readDaemonPid(rpxDir)
    expect(pidPath).toBe(getDaemonPidPath(rpxDir))
    expect(stored).toBe(process.pid)
  })

  it('refuses to start when a healthy daemon is already running', async () => {
    // Simulate a healthy lock held by the current process
    await fsp.writeFile(getDaemonPidPath(rpxDir), `${process.pid}\n`)
    expect(acquireDaemonLock(rpxDir)).rejects.toThrow(/already running/)
  })

  it('takes over a stale lock left by a dead pid', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '2000000000\n')
    const pidPath = await acquireDaemonLock(rpxDir)
    expect(pidPath).toBe(getDaemonPidPath(rpxDir))
    expect(await readDaemonPid(rpxDir)).toBe(process.pid)
  })

  it('takes over a malformed lock file', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), 'garbage\n')
    await acquireDaemonLock(rpxDir)
    expect(await readDaemonPid(rpxDir)).toBe(process.pid)
  })
})

describe('releaseDaemonLock', () => {
  it('removes the pid file', async () => {
    await acquireDaemonLock(rpxDir)
    await releaseDaemonLock(rpxDir)
    expect(await readDaemonPid(rpxDir)).toBeNull()
  })

  it('is a no-op when nothing is locked', async () => {
    await expect(releaseDaemonLock(rpxDir)).resolves.toBeUndefined()
  })
})

describe('runDaemon end-to-end', () => {
  // Ports chosen high to avoid privileged-port + collision issues. Each test
  // picks a distinct pair so they can run in parallel safely.
  const HTTPS_PORT = 18545
  const UPSTREAM_PORT = 18546

  it('routes traffic to a registered upstream and reroutes when the registry changes', async () => {
    // Stub upstream HTTP server — anything we get back proves the daemon
    // forwarded the request through TLS termination + Host-header routing.
    const upstream = Bun.serve({
      port: UPSTREAM_PORT,
      hostname: '127.0.0.1',
      fetch(req: Request) {
        const url = new URL(req.url)
        return new Response(`hello ${url.pathname} via ${req.headers.get('x-forwarded-host') ?? '?'}`)
      },
    })

    const registryDir = path.join(rpxDir, 'registry.d')

    // Pre-write an entry before the daemon starts so the initial routing
    // table is non-empty.
    await writeEntry({
      id: 'pet-store',
      from: `localhost:${UPSTREAM_PORT}`,
      to: 'pet-store.localhost',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }, registryDir)

    const daemon = await runDaemon({
      rpxDir,
      registryDir,
      httpsPort: HTTPS_PORT,
      httpPort: 0,
      hostname: '127.0.0.1',
      https: { basePath: rpxDir },
      verbose: false,
      gcIntervalMs: 60_000, // don't fire during the test
    })

    try {
      // Initial route works
      const res1 = await fetch(`https://127.0.0.1:${HTTPS_PORT}/foo`, {
        headers: { host: 'pet-store.localhost' },
        tls: { rejectUnauthorized: false },
      })
      expect(res1.status).toBe(200)
      const text1 = await res1.text()
      expect(text1).toContain('hello /foo via pet-store.localhost')

      // Unknown host returns 404 from the daemon
      const res404 = await fetch(`https://127.0.0.1:${HTTPS_PORT}/`, {
        headers: { host: 'no-such-app.localhost' },
        tls: { rejectUnauthorized: false },
      })
      expect(res404.status).toBe(404)

      // Registering a new entry should reroute live (debounce ≤ ~150ms)
      await writeEntry({
        id: 'training',
        from: `localhost:${UPSTREAM_PORT}`,
        to: 'training.localhost',
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }, registryDir)
      await new Promise(r => setTimeout(r, 250))

      const res2 = await fetch(`https://127.0.0.1:${HTTPS_PORT}/health`, {
        headers: { host: 'training.localhost' },
        tls: { rejectUnauthorized: false },
      })
      expect(res2.status).toBe(200)
      const text2 = await res2.text()
      expect(text2).toContain('hello /health via training.localhost')

      expect(daemon.pidPath).toBe(getDaemonPidPath(rpxDir))
      expect(await isDaemonRunning(rpxDir)).toBe(true)
    }
    finally {
      await daemon.stop()
      upstream.stop(true)
    }

    // pid file released on stop
    expect(await readDaemonPid(rpxDir)).toBeNull()
  }, 30_000)
})

// Helper: write a tiny "fake daemon" script into the test dir. The script
// writes its own pid into the pid file, optionally swallows SIGTERM, and
// otherwise idles forever. Lets us drive ensureDaemonRunning / stopDaemon
// without booting the real Bun.serve stack.
async function writeFakeDaemon(dir: string, opts: { swallowSigterm?: boolean } = {}): Promise<string> {
  const scriptPath = path.join(dir, 'fake-daemon.ts')
  const swallow = opts.swallowSigterm
    ? `process.on('SIGTERM', () => {})`
    : `process.on('SIGTERM', () => { try { unlinkSync(pidPath) } catch {} ; process.exit(0) })`
  const body = `import { writeFileSync, unlinkSync } from 'node:fs'
const pidPath = process.argv[2]
writeFileSync(pidPath, String(process.pid) + '\\n')
${swallow}
process.on('SIGINT', () => { try { unlinkSync(pidPath) } catch {} ; process.exit(0) })
setInterval(() => {}, 60_000)
`
  await fsp.writeFile(scriptPath, body, 'utf8')
  return scriptPath
}

// Track pids we spawn ourselves so tests don't leak processes.
const adoptedPids: Set<number> = new Set()
function adopt(pid: number): void { adoptedPids.add(pid) }
afterEach(() => {
  for (const pid of adoptedPids) {
    try { process.kill(pid, 'SIGKILL') }
    catch {}
  }
  adoptedPids.clear()
})

describe('ensureDaemonRunning', () => {
  it('returns the existing pid without spawning when a daemon is already alive', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), `${process.pid}\n`)
    const result = await ensureDaemonRunning({
      rpxDir,
      // Should never be invoked — fail loud if it is.
      spawnCommand: ['/definitely/not/a/binary'],
    })
    expect(result).toEqual({ pid: process.pid, spawned: false })
  })

  it('clears a stale pid and spawns a fresh daemon', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '2000000000\n')
    const script = await writeFakeDaemon(rpxDir)
    const result = await ensureDaemonRunning({
      rpxDir,
      spawnCommand: [process.execPath, script, getDaemonPidPath(rpxDir)],
      startupTimeoutMs: 3000,
    })
    adopt(result.pid)
    expect(result.spawned).toBe(true)
    expect(result.pid).not.toBe(2000000000)
    expect(await isDaemonRunning(rpxDir)).toBe(true)
  })

  it('spawns a daemon and waits for the pid file to appear', async () => {
    const script = await writeFakeDaemon(rpxDir)
    const result = await ensureDaemonRunning({
      rpxDir,
      spawnCommand: [process.execPath, script, getDaemonPidPath(rpxDir)],
      startupTimeoutMs: 3000,
    })
    adopt(result.pid)
    expect(result.spawned).toBe(true)
    expect(result.pid).toBeGreaterThan(0)
    const stored = await readDaemonPid(rpxDir)
    expect(stored).toBe(result.pid)
  })

  it('throws when the spawned process exits without ever writing a pid file', async () => {
    // `true` exits 0 immediately and never writes the pid file.
    await expect(
      ensureDaemonRunning({
        rpxDir,
        spawnCommand: ['true'],
        startupTimeoutMs: 250,
        pollIntervalMs: 25,
      }),
    ).rejects.toThrow(/failed to start within/)
  })

  it('surfaces ENOENT from a missing spawn binary', async () => {
    await expect(
      ensureDaemonRunning({
        rpxDir,
        spawnCommand: ['/totally/not/a/real/binary-rpx-test'],
        startupTimeoutMs: 1000,
        pollIntervalMs: 25,
      }),
    ).rejects.toThrow()
  })
})

describe('stopDaemon', () => {
  it('returns stopped: false when no pid file is present', async () => {
    const result = await stopDaemon({ rpxDir, timeoutMs: 200 })
    expect(result).toEqual({ stopped: false, pid: null, forced: false })
  })

  it('cleans up a stale pid file without signalling anything', async () => {
    await fsp.writeFile(getDaemonPidPath(rpxDir), '2000000000\n')
    const result = await stopDaemon({ rpxDir, timeoutMs: 200 })
    expect(result.stopped).toBe(false)
    expect(result.pid).toBe(2000000000)
    expect(await readDaemonPid(rpxDir)).toBeNull()
  })

  it('SIGTERMs a real subprocess and waits for it to exit cleanly', async () => {
    const script = await writeFakeDaemon(rpxDir)
    const pidPath = getDaemonPidPath(rpxDir)
    const child = nodeSpawn(process.execPath, [script, pidPath], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    adopt(child.pid!)

    // Wait for the child to write its pid file.
    const start = Date.now()
    while (Date.now() - start < 3000) {
      if ((await readDaemonPid(rpxDir)) !== null)
        break
      await new Promise(r => setTimeout(r, 25))
    }

    const result = await stopDaemon({ rpxDir, timeoutMs: 3000 })
    expect(result.stopped).toBe(true)
    expect(result.forced).toBe(false)
    expect(result.pid).toBe(child.pid!)
    expect(await readDaemonPid(rpxDir)).toBeNull()
  }, 10_000)

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const script = await writeFakeDaemon(rpxDir, { swallowSigterm: true })
    const pidPath = getDaemonPidPath(rpxDir)
    const child = nodeSpawn(process.execPath, [script, pidPath], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    adopt(child.pid!)

    const start = Date.now()
    while (Date.now() - start < 3000) {
      if ((await readDaemonPid(rpxDir)) !== null)
        break
      await new Promise(r => setTimeout(r, 25))
    }

    const result = await stopDaemon({ rpxDir, timeoutMs: 300, forceAfterTimeout: true })
    expect(result.stopped).toBe(true)
    expect(result.forced).toBe(true)
    expect(result.pid).toBe(child.pid!)
    // Give the OS a moment to reap.
    await new Promise(r => setTimeout(r, 50))
    expect(await readDaemonPid(rpxDir)).toBeNull()
  }, 10_000)
})
