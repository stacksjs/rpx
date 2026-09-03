/**
 * TEMPORARY — #2267 canary. Not for merge.
 *
 * Loaded through `[test] preload` in the root bunfig.toml on the diag branch,
 * so this `beforeEach` runs inside every test file. `Bun.main` names the file
 * currently under test, so the canary fires once per file, before that file's
 * first test: it spawns `bun --version` through `node:child_process.spawn` —
 * the path that returns a dud ChildProcess (pid 12345, no process) at
 * gateway.test.ts's position — with a short budget, and logs whether a real
 * child ran. The first file whose canary is a DUD names the file BEFORE it as
 * the one that poisons the spawn path; the first OK after a DUD names the file
 * that clears it. The parent's pipe/thread state is dumped at both edges.
 *
 * Every line is prefixed `[2267-canary]`.
 */
import { beforeEach } from 'bun:test'
import { spawn } from 'node:child_process'
import * as process from 'node:process'
import { parentDump } from './spawn-diag'

const P = '[2267-canary]'
const BUDGET_MS = 3_000

let lastFile = ''
let fileIndex = 0
let wasDud = false

function canary(): Promise<string> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let out = ''
    let done = false
    const child = spawn(process.execPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    const finish = (verdict: string): void => {
      if (done)
        return
      done = true
      resolve(`${verdict} pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode} ${Math.round(performance.now() - t0)}ms`)
    }
    child.on('error', e => finish(`ERROR(${e.message})`))
    child.on('exit', code => finish(out.trim() ? `OK(${out.trim()})` : `EXIT-NO-OUTPUT(code=${code})`))
    setTimeout(() => {
      if (done)
        return
      try {
        child.kill('SIGKILL')
      }
      catch {}
      finish('DUD')
    }, BUDGET_MS)
  })
}

beforeEach(async () => {
  const file = Bun.main.split('/').pop() ?? Bun.main
  if (file === lastFile)
    return
  lastFile = file
  fileIndex++
  const result = await canary()
  const isDud = result.startsWith('DUD')
  console.log(P, `file#${fileIndex}`, file, '->', result)
  if (isDud !== wasDud) {
    console.log(P, isDud ? 'FIRST DUD — state right after the poisoning file:' : 'RECOVERED — state right after the clearing file:')
    console.log(P, `   ${parentDump()}`)
    wasDud = isDud
  }
})
