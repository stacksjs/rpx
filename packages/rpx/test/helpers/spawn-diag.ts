/**
 * TEMPORARY — shared helpers for the #2267 diagnostics. Not for merge.
 *
 * Not a test file (no `.test.` in the name), so `bun test` never runs it
 * directly; `gateway.test.ts` and `zz-2267-diagnostic.test.ts` import it.
 * Every line printed is prefixed `[2267-diag]` so it is greppable in CI logs.
 */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as process from 'node:process'

export const BUDGET_MS = 12_000
const P = '[2267-diag]'

export function say(...parts: unknown[]): void {
  console.log(P, ...parts)
}

export interface Result {
  name: string
  outcome: string
  ms: number
  bytes: number
  head: string
  diag: string
}

export type Stdio = Array<'ignore' | 'pipe' | 'inherit'>

export function sh(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const dec = new TextDecoder()
    return `${dec.decode(r.stdout)}${dec.decode(r.stderr)}`.trim()
  }
  catch (e) {
    return `ERR ${e}`
  }
}

export function readMaybe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** One line per thread of `pid`: `tid:<first lines of /proc/pid/task/tid/file>`. */
function perTask(pid: number, file: string): string {
  return sh(['sh', '-c', `for t in /proc/${pid}/task/*; do printf '%s:%s  ' "$(basename "$t")" "$( (cat "$t/${file}" 2>/dev/null || sudo -n cat "$t/${file}" 2>/dev/null) | head -6 | tr '\\n' '|')"; done`])
}

/** Everything /proc will tell us about a child that has gone quiet. */
export function procDump(pid: number): string {
  if (process.platform !== 'linux')
    return '(no /proc on this platform)'
  const lines: string[] = []
  const status = readMaybe(`/proc/${pid}/status`)
    .split('\n')
    .filter(l => /^(?:State|PPid|Threads|VmRSS|SigBlk|SigIgn|SigCgt)/.test(l))
    .join(' | ')
  lines.push(`status: ${status}`)
  lines.push(`wchan: ${readMaybe(`/proc/${pid}/wchan`)} | syscall: ${readMaybe(`/proc/${pid}/syscall`) || sh(['sudo', '-n', 'cat', `/proc/${pid}/syscall`])}`)
  lines.push(`stack: ${(readMaybe(`/proc/${pid}/stack`) || sh(['sudo', '-n', 'cat', `/proc/${pid}/stack`])).replace(/\n/g, ' | ')}`)
  lines.push(`task wchan: ${perTask(pid, 'wchan')}`)
  lines.push(`task syscall: ${perTask(pid, 'syscall')}`)
  lines.push(`task stack: ${perTask(pid, 'stack')}`)
  lines.push(`fds: ${sh(['sh', '-c', `ls -l /proc/${pid}/fd 2>/dev/null | tail -n +2 | awk '{print $9"->"$11}' | tr '\\n' ' '`])}`)
  lines.push(`cwd: ${sh(['readlink', `/proc/${pid}/cwd`])} | cmdline: ${readMaybe(`/proc/${pid}/cmdline`).replace(/\0/g, ' ')}`)
  lines.push(`children: ${sh(['sh', '-c', `ps -o pid,stat,wchan:30,etimes,cmd --ppid ${pid} 2>/dev/null | tail -n +2 | tr '\\n' ';'`])}`)
  lines.push(`io: ${readMaybe(`/proc/${pid}/io`).replace(/\n/g, ' ')}`)
  return lines.join('\n    ')
}

/**
 * The test process's own state at the moment a child went quiet. Uses the
 * numeric pid throughout: `/proc/self` inside a shelled-out command would name
 * the shell, not us.
 */
export function parentDump(): string {
  if (process.platform !== 'linux')
    return '(no /proc on this platform)'
  const pid = process.pid
  const lines: string[] = []
  const status = readMaybe(`/proc/${pid}/status`)
    .split('\n')
    .filter(l => /^(?:Threads|VmRSS|FDSize)/.test(l))
    .join(' | ')
  lines.push(`pid ${pid} | ${status}`)
  lines.push(`fd count: ${sh(['sh', '-c', `ls /proc/${pid}/fd | wc -l`])} | by kind: ${sh(['sh', '-c', `ls -l /proc/${pid}/fd 2>/dev/null | tail -n +2 | awk '{print $11}' | sed -E 's/:.*//; s/\\/.*//' | sort | uniq -c | tr '\\n' ' '`])}`)
  lines.push(`children: ${sh(['sh', '-c', `ps -o pid,stat,wchan:30,etimes,cmd --ppid ${pid} 2>/dev/null | tail -n +2 | tr '\\n' ';'`])}`)
  lines.push(`task wchan: ${perTask(pid, 'wchan')}`)
  lines.push(`task syscall: ${perTask(pid, 'syscall')}`)
  lines.push(`listening sockets: ${sh(['sh', '-c', '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | tail -n +2 | wc -l'])}`)
  return lines.join('\n    ')
}

export function envDump(): void {
  say('platform', process.platform, process.arch, 'bun', Bun.version, Bun.revision)
  say('execPath', process.execPath, '->', fs.realpathSync(process.execPath))
  say('cwd', process.cwd(), '| tmpdir', os.tmpdir(), '| cpus', os.cpus().length, '| uid', typeof process.getuid === 'function' ? process.getuid() : 'n/a', '| pid', process.pid)
  say('env TMPDIR=', process.env.TMPDIR, '| RUNNER_TEMP=', process.env.RUNNER_TEMP, '| BUN_RUNTIME_TRANSPILER_CACHE_PATH=', process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, '| HOME=', process.env.HOME)
  say('limits:', readMaybe('/proc/self/limits').split('\n').filter(l => /open files|processes/.test(l)).join(' | ') || 'n/a')
  say('sudo -n:', sh(['sudo', '-n', 'true']) === '' ? 'ok' : 'unavailable')
}

function shape(out: string): string {
  return out.slice(0, 100).replace(/\n/g, '⏎')
}

export function viaNodeSpawn(name: string, argv: string[], opts: { stdio: Stdio, env?: Record<string, string>, cwd?: string }, budget = BUDGET_MS): Promise<Result> {
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
      resolve({ name, outcome, ms: Math.round(performance.now() - t0), bytes: out.length, head: shape(out), diag })
    }
    child.on('error', e => finish(`spawn-error ${e.message}`))
    child.on('exit', (code, sig) => finish(`exit code=${code} signal=${sig}`))
    setTimeout(() => {
      if (settled)
        return
      const diag = `${child.pid ? procDump(child.pid) : '(no pid)'}\n    PARENT: ${parentDump()}`
      try {
        child.kill('SIGKILL')
      }
      catch {}
      finish(`HUNG >${budget}ms`, diag)
    }, budget)
  })
}

export async function viaBunSpawn(name: string, argv: string[], budget = BUDGET_MS): Promise<Result> {
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
  const timer = new Promise<string>(r => setTimeout(() => r('TIMEOUT'), budget))
  const raced = await Promise.race([done, timer])
  let diag = ''
  if (raced === 'TIMEOUT') {
    diag = `${procDump(proc.pid)}\n    PARENT: ${parentDump()}`
    try {
      proc.kill(9)
    }
    catch {}
  }
  return { name, outcome: raced === 'TIMEOUT' ? `HUNG >${budget}ms` : raced, ms: Math.round(performance.now() - t0), bytes: out.length, head: shape(out), diag }
}

export function viaSpawnSync(name: string, argv: string[], budget = BUDGET_MS): Result {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: budget })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const outcome = r.error
    ? `error ${r.error.message}`
    : (r.signal ? `HUNG >${budget}ms (killed ${r.signal})` : `exit code=${r.status}`)
  return { name, outcome, ms: Math.round(performance.now() - t0), bytes: out.length, head: shape(out), diag: '' }
}

/** The eight variants, sequentially, followed by a printed report. */
export async function runSweep(cli: string, where: string): Promise<Result[]> {
  const results: Result[] = []
  const base: Stdio = ['ignore', 'pipe', 'pipe']

  // G: is it bun-at-all, or the CLI graph? Cheapest discriminator first.
  results.push(await viaNodeSpawn('G  bun --version | node spawn ignore/pipe/pipe', ['--version'], { stdio: base }))
  // A: the exact gateway.test.ts shape.
  results.push(await viaNodeSpawn('A  cli --help    | node spawn ignore/pipe/pipe  (= gateway.test.ts baseline)', [cli, '--help'], { stdio: base }))
  // B: transpiler-cache hypothesis.
  results.push(await viaNodeSpawn('B  A + BUN_RUNTIME_TRANSPILER_CACHE_PATH=0', [cli, '--help'], { stdio: base, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }))
  // C: stdin-ignore hypothesis.
  results.push(await viaNodeSpawn('C  A + stdin pipe (ended) instead of ignore', [cli, '--help'], { stdio: ['pipe', 'pipe', 'pipe'] }))
  // F: cwd hypothesis (repo-root bunfig.toml, project files).
  results.push(await viaNodeSpawn('F  A + cwd=tmpdir', [cli, '--help'], { stdio: base, cwd: os.tmpdir() }))
  // I: bypass the pipes entirely; help text between the markers means the
  // child runs and the fault is in pipe plumbing.
  say(`--- I begin [${where}] (inherit stdout/stderr; any help text below is from the child) ---`)
  results.push(await viaNodeSpawn('I  A + stdout/stderr inherit', [cli, '--help'], { stdio: ['ignore', 'inherit', 'inherit'] }))
  say(`--- I end [${where}] ---`)
  // D: is it the node:child_process shim specifically?
  results.push(await viaBunSpawn('D  cli --help    | Bun.spawn', [cli, '--help']))
  // E: cli.test.ts's call shape, but from a parent that HAS the graph.
  results.push(viaSpawnSync('E  cli --help    | spawnSync (= cli.test.ts shape, parent has graph)', [cli, '--help']))

  say(`===== RESULTS [${where}] =====`)
  for (const r of results) {
    say(r.name)
    say(`   -> ${r.outcome} in ${r.ms}ms, ${r.bytes} bytes${r.head ? `, head: ${r.head}` : ''}`)
    if (r.diag)
      say(`   diag:\n    ${r.diag}`)
  }
  say(`===== END [${where}] =====`)
  return results
}
