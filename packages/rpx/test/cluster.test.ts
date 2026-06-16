/**
 * Multi-core cluster: a coordinator owns the singletons (lock, certs, DNS, hosts,
 * :80) and spawns worker processes that bind :443 with reusePort. These tests
 * use a pre-provisioned self-signed cert (so they don't depend on flaky cert
 * generation) and a real upstream, then verify both the worker serve path
 * (in-process) and the coordinator actually spawning workers that serve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runDaemon, runDaemonWorker } from '../src/daemon'
import { writeEntry } from '../src/registry'

let rpxDir: string
let registryDir: string
let certsDir: string
let upstream: ReturnType<typeof Bun.serve>
let cert: string
let key: string

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Bun-native free-port probe (node:net's Server is unreliable under the test
// runner here). Tiny TOCTOU window, fine for tests.
function freePort(): number {
  const srv = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {}, close() {} } })
  const port = srv.port
  srv.stop(true)
  return port
}

beforeAll(async () => {
  rpxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-cluster-'))
  registryDir = path.join(rpxDir, 'registry.d')
  certsDir = path.join(rpxDir, 'certs')
  await fsp.mkdir(registryDir, { recursive: true })
  await fsp.mkdir(certsDir, { recursive: true })

  // Self-signed cert for site.test (SNI name = filename). rejectUnauthorized is
  // off in the test client, so CN/SAN don't need to validate.
  const keyPath = path.join(certsDir, 'site.test.key')
  const crtPath = path.join(certsDir, 'site.test.crt')
  Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', crtPath, '-days', '1', '-nodes', '-subj', '/CN=site.test'])
  cert = await fsp.readFile(crtPath, 'utf8')
  key = await fsp.readFile(keyPath, 'utf8')

  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      return new Response(`hello from upstream ${u.pathname} (xfh=${req.headers.get('x-forwarded-host')})`)
    },
  })
  await writeEntry({
    id: 'site',
    from: `127.0.0.1:${upstream.port}`,
    to: 'site.test',
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }, registryDir)
})

afterAll(() => {
  upstream?.stop(true)
  fsp.rm(rpxDir, { recursive: true, force: true }).catch(() => {})
})

describe('cluster worker (in-process)', () => {
  it('serves :443 from the coordinator-published SNI set', async () => {
    await fsp.writeFile(
      path.join(rpxDir, 'cluster-sni.json'),
      JSON.stringify({ sni: [{ serverName: 'site.test', cert, key }], dev: null }),
    )
    const port = await freePort()
    const worker = await runDaemonWorker({ rpxDir, registryDir, httpsPort: port, hostname: '127.0.0.1', verbose: false })
    try {
      const res = await fetch(`https://127.0.0.1:${port}/foo`, { headers: { host: 'site.test' }, tls: { rejectUnauthorized: false } })
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('hello from upstream /foo')
      expect(body).toContain('xfh=site.test') // worker rewrote X-Forwarded-Host

      // 404 for an unknown host (proves routing is live in the worker).
      const miss = await fetch(`https://127.0.0.1:${port}/`, { headers: { host: 'nope.test' }, tls: { rejectUnauthorized: false } })
      expect(miss.status).toBe(404)
    }
    finally {
      await worker.stop()
    }
  })
})

describe('cluster coordinator (spawns real workers)', () => {
  it('spawns workers that bind :443 and serve traffic, then shuts them down', async () => {
    const port = await freePort()
    // Point spawned workers at the rpx CLI (argv[1] is the test runner here).
    process.env.RPX_WORKER_BIN = path.join(import.meta.dir, '..', 'bin', 'cli.ts')
    const handle = await runDaemon({
      workers: 2,
      httpsPort: port,
      httpPort: 0,
      rpxDir,
      registryDir,
      hostname: '127.0.0.1',
      productionCerts: { certsDir },
      verbose: false,
    })
    try {
      // Poll until a spawned worker is serving (process spawn + bind takes a moment).
      let served = false
      for (let i = 0; i < 80 && !served; i++) {
        try {
          const res = await fetch(`https://127.0.0.1:${port}/`, { headers: { host: 'site.test' }, tls: { rejectUnauthorized: false } })
          if (res.status === 200) {
            expect(await res.text()).toContain('hello from upstream')
            served = true
          }
          else {
            await res.text().catch(() => {})
          }
        }
        catch {
          // worker not bound yet
        }
        if (!served)
          await sleep(150)
      }
      expect(served).toBe(true)
    }
    finally {
      delete process.env.RPX_WORKER_BIN
      await handle.stop()
    }
  }, 30_000)
})
