/**
 * TEMPORARY — diagnostic for #2267, not for merge.
 *
 * On GitHub's Linux runners (and only there), a `bun bin/cli.ts --help` spawned
 * asynchronously from a bun test process that has the rpx graph loaded produces
 * zero bytes and never exits, while `spawnSync` of the same CLI from a file with
 * no rpx imports passes in ~100ms. Nothing reproduces it in an oven/bun
 * container. This file runs one variant after another in the failing parent
 * shape (it imports `../src/start` and `../src/gateway` on purpose), so a single
 * CI run says which knob matters, and dumps the stuck child's /proc state
 * before killing it. Every line is prefixed `[2267-diag]` so it is greppable in
 * the CI log. The test itself always passes; the log is the result.
 */
import { describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as process from 'node:process'
import { readGatewayFragments } from '../src/gateway'
import * as Start from '../src/start'

const CLI = path.join(import.meta.dir, '..', 'bin', 'cli.ts')
const BUDGET_MS = 12_000
const P = '[2267-diag]'

function say(...parts: unknown[]): void {
  console.log(P, ...parts)
}

interface Result {
  name: string
  outcome: string
  ms: number
  bytes: number
  head: string
  diag: string
}

type Stdio = Array<'ignore' | 'pipe' | 'inherit'>

function sh(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const dec = new TextDecoder()
    return `${dec.decode(r.stdout)}${dec.decode(r.stderr)}`.trim()
  }
  catch (e) {
    return `ERR ${e}`
  }
}

function readMaybe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** Everything /proc will tell us about a child that has gone quiet. */
function procDump(pid: number): string {
  if (process.platform !== 'linux')
    return '(no /proc on this platform)'
  const lines: string[] = []
  const status = readMaybe(`/proc/${pid}/status`)
    .split('\n')
    .filter(l => /^(?:State|Threads|VmRSS|SigBlk|SigIgn|SigCgt|PPid)/.test(l))
    .join(' | ')
  lines.push(`status: ${status}`)
  lines.push(`wchan: ${readMaybe(`/proc/${pid}/wchan`)}`)
  lines.push(`stack: ${readMaybe(`/proc/${pid}/stack`) || sh(['sudo', '-n', 'cat', `/proc/${pid}/stack`])}`)
  lines.push(`threads: ${sh(['sh', '-c', `for t in /proc/${pid}/task/*; do echo "$(basename "$t"):$(cat "$t/wchan" 2>/dev/null || sudo -n cat "$t/wchan" 2>/dev/null)"; done | tr '\\n' ' '`])}`)
  lines.push(`thread stacks: ${sh(['sh', '-c', `for t in /proc/${pid}/task/*; do echo "== $(basename "$t")"; (cat "$t/stack" 2>/dev/null || sudo -n cat "$t/stack" 2>/dev/null) | head -8; done | tr '\\n' ' '`])}`)
  lines.push(`fds: ${sh(['sh', '-c', `ls -l /proc/${pid}/fd 2>/dev/null | tail -n +2 | awk '{print $9"->"$11}' | tr '\\n' ' '`])}`)
  lines.push(`cwd: ${sh(['readlink', `/proc/${pid}/cwd`])}`)
  lines.push(`cmdline: ${readMaybe(`/proc/${pid}/cmdline`).replace(/\0/g, ' ')}`)
  lines.push(`children: ${sh(['sh', '-c', `ps -o pid,stat,wchan:30,etimes,cmd --ppid ${pid} 2>/dev/null | tail -n +2 | tr '\\n' ';'`])}`)
  lines.push(`io: ${readMaybe(`/proc/${pid}/io`).replace(/\n/g, ' ')}`)
  return lines.join('\n    ')
}

function viaNodeSpawn(name: string, argv: string[], opts: { stdio: Stdio, env?: Record<string, string>, cwd?: string }): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let out = ''
    let settled = false
    const child = spawn(process.execPath, argv, {
      stdio: opts.stdio,
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
    })
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { out += c.toString() })
    if (opts.stdio[0] === 'pipe')
      child.stdin?.end()
    const finish = (outcome: string, diag = ''): void => {
      if (settled)
        return
      settled = true
      resolve({ name, outcome, ms: Math.round(performance.now() - t0), bytes: out.length, head: out.slice(0, 100).replace(/\n/g, '⏎'), diag })
    }
    child.on('error', e => finish(`spawn-error ${e.message}`))
    child.on('exit', (code, sig) => finish(`exit code=${code} signal=${sig}`))
    setTimeout(() => {
      if (settled)
        return
      const diag = child.pid ? procDump(child.pid) : '(no pid)'
      try {
        child.kill('SIGKILL')
      }
      catch {}
      finish(`HUNG >${BUDGET_MS}ms`, diag)
    }, BUDGET_MS)
  })
}

async function viaBunSpawn(name: string, argv: string[]): Promise<Result> {
  const t0 = performance.now()
  const proc = Bun.spawn([process.execPath, ...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env })
  let out = ''
  const dec = new TextDecoder()
  const pump = async (s: ReadableStream<Uint8Array> | null | undefined): Promise<void> => {
    if (!s)
      return
    for await (const c of s) out += dec.decode(c)
  }
  const done = Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , code]) => `exit code=${code}`)
  const timer = new Promise<string>(r => setTimeout(() => r('TIMEOUT'), BUDGET_MS))
  const raced = await Promise.race([done, timer])
  let diag = ''
  if (raced === 'TIMEOUT') {
    diag = procDump(proc.pid)
    try {
      proc.kill(9)
    }
    catch {}
  }
  return { name, outcome: raced === 'TIMEOUT' ? `HUNG >${BUDGET_MS}ms` : raced, ms: Math.round(performance.now() - t0), bytes: out.length, head: out.slice(0, 100).replace(/\n/g, '⏎'), diag }
}

function viaSpawnSync(name: string, argv: string[]): Result {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: BUDGET_MS })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const outcome = r.error
    ? `error ${r.error.message}`
    : (r.signal ? `HUNG >${BUDGET_MS}ms (killed ${r.signal})` : `exit code=${r.status}`)
  return { name, outcome, ms: Math.round(performance.now() - t0), bytes: out.length, head: out.slice(0, 100).replace(/\n/g, '⏎'), diag: '' }
}

describe('2267 diagnostic', () => {
  it('records how each spawn variant of the CLI behaves here', async () => {
    say('platform', process.platform, process.arch, 'bun', Bun.version, Bun.revision)
    say('execPath', process.execPath, '->', fs.realpathSync(process.execPath))
    say('cwd', process.cwd(), '| tmpdir', os.tmpdir(), '| cpus', os.cpus().length, '| uid', typeof process.getuid === 'function' ? process.getuid() : 'n/a')
    say('env TMPDIR=', process.env.TMPDIR, '| RUNNER_TEMP=', process.env.RUNNER_TEMP, '| BUN_RUNTIME_TRANSPILER_CACHE_PATH=', process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, '| HOME=', process.env.HOME)
    say('bunfig.toml in cwd:', fs.existsSync(path.join(process.cwd(), 'bunfig.toml')))
    say('limits:', readMaybe('/proc/self/limits').split('\n').filter(l => /open files|processes/.test(l)).join(' | ') || 'n/a')
    say('sudo -n:', sh(['sudo', '-n', 'true']) === '' ? 'ok' : 'unavailable')
    say('parent graph loaded:', typeof Start.startProxies, typeof readGatewayFragments)

    const results: Result[] = []
    const base: Stdio = ['ignore', 'pipe', 'pipe']

    // G: is it bun-at-all, or the CLI graph? Cheapest discriminator first.
    results.push(await viaNodeSpawn('G  bun --version | node spawn ignore/pipe/pipe', ['--version'], { stdio: base }))
    // A: the exact gateway.test.ts shape. Expected to hang on GitHub Linux.
    results.push(await viaNodeSpawn('A  cli --help    | node spawn ignore/pipe/pipe  (= gateway.test.ts baseline)', [CLI, '--help'], { stdio: base }))
    // B: transpiler-cache hypothesis.
    results.push(await viaNodeSpawn('B  A + BUN_RUNTIME_TRANSPILER_CACHE_PATH=0', [CLI, '--help'], { stdio: base, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }))
    // C: stdin-ignore hypothesis.
    results.push(await viaNodeSpawn('C  A + stdin pipe (ended) instead of ignore', [CLI, '--help'], { stdio: ['pipe', 'pipe', 'pipe'] }))
    // F: cwd hypothesis (repo-root bunfig.toml, project files).
    results.push(await viaNodeSpawn('F  A + cwd=tmpdir', [CLI, '--help'], { stdio: base, cwd: os.tmpdir() }))
    // I: bypass the pipes entirely; if help appears in the CI log between the
    // markers, the child runs and the fault is in pipe plumbing.
    say('--- I begin (inherit stdout/stderr; any help text below is from the child) ---')
    results.push(await viaNodeSpawn('I  A + stdout/stderr inherit', [CLI, '--help'], { stdio: ['ignore', 'inherit', 'inherit'] }))
    say('--- I end ---')
    // D: is it the node:child_process shim specifically?
    results.push(await viaBunSpawn('D  cli --help    | Bun.spawn', [CLI, '--help']))
    // E: cli.test.ts's call shape, but from a parent that HAS the graph.
    results.push(viaSpawnSync('E  cli --help    | spawnSync (= cli.test.ts shape, parent has graph)', [CLI, '--help']))

    say('===== RESULTS =====')
    for (const r of results) {
      say(r.name)
      say(`   -> ${r.outcome} in ${r.ms}ms, ${r.bytes} bytes${r.head ? `, head: ${r.head}` : ''}`)
      if (r.diag)
        say(`   diag:\n    ${r.diag}`)
    }
    say('===== END =====')

    expect(results).toHaveLength(8)
  }, 200_000)
})
