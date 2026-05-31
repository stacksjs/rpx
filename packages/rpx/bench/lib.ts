/* eslint-disable no-console */
/**
 * Shared helpers for the rpx benchmark suite: port allocation, readiness
 * probing, and a tiny child-process wrapper used to drive caddy/nginx/oha.
 */
import type { Subprocess } from 'bun'
import * as net from 'node:net'

/** A startable, stoppable benchmark target (origin or proxy). */
export interface BenchTarget {
  /** Short label shown in reports (e.g. `rpx`, `caddy`, `nginx`). */
  name: string
  /** Base URL benchmark traffic is sent to (e.g. `http://127.0.0.1:8011`). */
  url: string
  /** Tear the target down (close server / kill child process). */
  stop: () => Promise<void> | void
}

export const HOST = '127.0.0.1'

/** Ask the OS for a free TCP port by binding to :0 and reading it back. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, HOST, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      }
      else {
        srv.close(() => reject(new Error('could not determine free port')))
      }
    })
  })
}

/** Resolve once a TCP connect to host:port succeeds, or reject after `timeoutMs`. */
export async function waitForPort(port: number, host = HOST, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port, timeout: 500 })
      const done = (ok: boolean) => {
        sock.destroy()
        resolve(ok)
      }
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
    if (ok)
      return
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${host}:${port}`)
    await Bun.sleep(50)
  }
}

/** Whether a CLI binary is resolvable on PATH (used to skip missing proxies). */
export function hasBinary(bin: string): boolean {
  const which = Bun.spawnSync(['sh', '-c', `command -v ${bin}`])
  return which.exitCode === 0
}

/** Spawn a long-running child process with stdio captured for diagnostics. */
export function spawnProc(cmd: string[], opts: { cwd?: string } = {}): Subprocess {
  return Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
}

/** Kill a child process and wait for it to actually exit. */
export async function killProc(proc: Subprocess | undefined): Promise<void> {
  if (!proc)
    return
  try {
    proc.kill('SIGTERM')
    await Promise.race([proc.exited, Bun.sleep(2000)])
    if (proc.exitCode == null)
      proc.kill('SIGKILL')
  }
  catch {
    // already dead
  }
}

/** Pretty number with thousands separators and fixed precision. */
export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
