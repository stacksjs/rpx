import type { BaseProxyConfig, ProxyOption, StartOptions } from '../src/types'
import * as process from 'node:process'
import { CAC } from 'cac'
import { version } from '../package.json'
import { config } from '../src/config'
import {
  ensureDaemonRunning,
  getDaemonPidPath,
  getDaemonRpxDir,
  isDaemonRunning,
  readDaemonPid,
  runDaemon,
  stopDaemon,
} from '../src/daemon'
import { processManager } from '../src/process-manager'
import {
  getRegistryDir,
  isValidId,
  readAll,
  readEntry,
  removeEntry,
  writeEntry,
} from '../src/registry'
import { startProxies, startProxy } from '../src/start'
import { isMultiProxyConfig } from '../src/utils'

const cli = new CAC('rpx')

// Define CLI options interface to match our core types
interface CLIOptions {
  from?: string
  to?: string
  keyPath?: string
  certPath?: string
  caCertPath?: string
  hostsCleanup?: boolean
  certsCleanup?: boolean
  startCommand?: string
  startCwd?: string
  startEnv?: string
  changeOrigin?: boolean
  verbose?: boolean
  viaDaemon?: boolean
  id?: string
}

cli
  .command('start', 'Start the Reverse Proxy Server')
  .option('--from <from>', 'The URL to proxy from')
  .option('--to <to>', 'The URL to proxy to')
  .option('--key-path <path>', 'Absolute path to the SSL key')
  .option('--cert-path <path>', 'Absolute path to the SSL certificate')
  .option('--ca-cert-path <path>', 'Absolute path to the SSL CA certificate')
  .option('--hosts-cleanup', 'Cleanup /etc/hosts on exit')
  .option('--certs-cleanup', 'Cleanup SSL certificates on exit')
  .option('--start-command <command>', 'Command to start the dev server')
  .option('--start-cwd <path>', 'Current working directory for the dev server')
  .option('--start-env <env>', 'Environment variables for the dev server')
  .option('--change-origin', 'Change the origin of the host header to the target URL')
  .option('--via-daemon', 'Route through the shared rpx daemon instead of binding :443 directly')
  .option('--id <id>', 'Stable id used when registering with the daemon (auto-derived from --to)')
  .option('--verbose', 'Enable verbose logging')
  .example('rpx start --from localhost:5173 --to my-project.localhost')
  .example('rpx start --from localhost:3000 --to my-project.localhost/api')
  .example('rpx start --from localhost:3000 --to localhost:3001')
  .example('rpx start --from localhost:5173 --to my-project.test --key-path /absolute/path/to/key --cert-path /absolute/path/to/cert')
  .example('rpx start --from localhost:5173 --to my-project.localhost --change-origin')
  .action(async (options?: CLIOptions) => {
    if (!options?.from || !options.to) {
      return startProxies(config)
    }

    // Convert CLI options to ProxyOption
    const proxyOptions: ProxyOption = {
      from: options.from,
      to: options.to,
      https: {
        keyPath: options.keyPath,
        certPath: options.certPath,
        caCertPath: options.caCertPath,
      },
      cleanup: {
        certs: options.certsCleanup || false,
        hosts: options.hostsCleanup || false,
      },
      verbose: options.verbose || false,
      changeOrigin: options.changeOrigin || false,
      viaDaemon: options.viaDaemon || false,
      id: options.id,
    }

    // Add start options if provided
    if (options.startCommand) {
      const startOptions: StartOptions = {
        command: options.startCommand,
      }
      if (options.startCwd)
        startOptions.cwd = options.startCwd
      if (options.startEnv) {
        try {
          startOptions.env = JSON.parse(options.startEnv)
        }
        catch (err) {
          console.error('Failed to parse start-env JSON:', err)
          process.exit(1)
        }
      }
      proxyOptions.start = startOptions
    }

    return startProxy(proxyOptions)
  })

cli
  .command('watch:start <proxy>', 'Start the dev server for a specific proxy')
  .option('--verbose', 'Enable verbose logging')
  .action(async (proxyId: string, options: { verbose?: boolean }) => {
    // Find the proxy configuration
    const proxyConfig = isMultiProxyConfig(config)
      ? config.proxies.find((p: BaseProxyConfig) => p.to === proxyId || `${p.from}-${p.to}` === proxyId)
      : config.to === proxyId ? config : null

    if (!proxyConfig?.start) {
      console.error(`No watch configuration found for proxy: ${proxyId}`)
      process.exit(1)
    }

    try {
      await processManager.startProcess(proxyId, proxyConfig.start, options.verbose)
      console.log(`Started dev server for ${proxyId}`)
    }
    catch (err) {
      console.error(`Failed to start dev server for ${proxyId}:`, err)
      process.exit(1)
    }
  })

cli
  .command('watch:stop <proxy>', 'Stop the dev server for a specific proxy')
  .option('--verbose', 'Enable verbose logging')
  .action(async (proxyId: string, options: { verbose?: boolean }) => {
    try {
      await processManager.stopProcess(proxyId, options.verbose)
      console.log(`Stopped dev server for ${proxyId}`)
    }
    catch (err) {
      console.error(`Failed to stop dev server for ${proxyId}:`, err)
      process.exit(1)
    }
  })

cli
  .command('watch:stopall', 'Stop all running dev servers')
  .option('--verbose', 'Enable verbose logging')
  .action(async (options: { verbose?: boolean }) => {
    try {
      await processManager.stopAll(options.verbose)
      console.log('Stopped all dev servers')
    }
    catch (err) {
      console.error('Failed to stop all dev servers:', err)
      process.exit(1)
    }
  })

// ---------------------------------------------------------------------------
// daemon — long-running shared :443 server. Multi-app dev (./buddy dev) talks
// to this through the registry under `~/.stacks/rpx/registry.d`.
// ---------------------------------------------------------------------------

interface DaemonStartOptions {
  rpxDir?: string
  registryDir?: string
  httpsPort?: number
  httpPort?: number
  hostname?: string
  verbose?: boolean
}

cli
  .command('daemon:start', 'Start the rpx daemon in the foreground (binds :443 + :80)')
  .option('--rpx-dir <path>', 'Override the rpx state dir (default ~/.stacks/rpx)')
  .option('--registry-dir <path>', 'Override the registry dir (default <rpx-dir>/registry.d)')
  .option('--https-port <port>', 'HTTPS port (default 443)', { default: 443 })
  .option('--http-port <port>', 'HTTP redirect port; 0 to disable (default 80)', { default: 80 })
  .option('--hostname <host>', 'Bind address (default 0.0.0.0)', { default: '0.0.0.0' })
  .option('--verbose', 'Enable verbose logging')
  .action(async (opts: DaemonStartOptions) => {
    try {
      const handle = await runDaemon({
        rpxDir: opts.rpxDir,
        registryDir: opts.registryDir,
        httpsPort: typeof opts.httpsPort === 'string' ? Number.parseInt(opts.httpsPort, 10) : opts.httpsPort,
        httpPort: typeof opts.httpPort === 'string' ? Number.parseInt(opts.httpPort, 10) : opts.httpPort,
        hostname: opts.hostname,
        verbose: opts.verbose ?? true,
      })
      // Block until the daemon shuts down (via SIGINT/SIGTERM).
      await handle.done
      process.exit(0)
    }
    catch (err) {
      console.error(`Failed to start rpx daemon: ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('daemon:stop', 'Stop the running rpx daemon (SIGTERM, escalates to SIGKILL)')
  .option('--rpx-dir <path>', 'Override the rpx state dir (default ~/.stacks/rpx)')
  .option('--timeout <ms>', 'Max ms to wait for graceful shutdown', { default: 5000 })
  .option('--no-force', 'Do not escalate to SIGKILL after timeout')
  .option('--verbose', 'Enable verbose logging')
  .action(async (opts: { rpxDir?: string, timeout?: number | string, force?: boolean, verbose?: boolean }) => {
    const timeoutMs = typeof opts.timeout === 'string' ? Number.parseInt(opts.timeout, 10) : opts.timeout
    const result = await stopDaemon({
      rpxDir: opts.rpxDir,
      timeoutMs,
      forceAfterTimeout: opts.force !== false,
      verbose: opts.verbose,
    })
    if (!result.stopped && result.pid === null) {
      console.log('rpx daemon is not running')
      return
    }
    if (!result.stopped) {
      console.log(`rpx daemon pid=${result.pid} was already gone (cleaned stale lock)`)
      return
    }
    console.log(`rpx daemon pid=${result.pid} stopped${result.forced ? ' (SIGKILL)' : ''}`)
  })

cli
  .command('daemon:status', 'Print daemon state and currently registered hosts')
  .option('--rpx-dir <path>', 'Override the rpx state dir (default ~/.stacks/rpx)')
  .option('--registry-dir <path>', 'Override the registry dir (default <rpx-dir>/registry.d)')
  .option('--json', 'Emit machine-readable JSON instead of a human summary')
  .action(async (opts: { rpxDir?: string, registryDir?: string, json?: boolean }) => {
    const rpxDir = opts.rpxDir ?? getDaemonRpxDir()
    const pid = await readDaemonPid(rpxDir)
    const running = await isDaemonRunning(rpxDir)
    const registryDir = opts.registryDir
    const entries = await readAll(registryDir).catch(() => [])

    if (opts.json) {
      console.log(JSON.stringify({
        running,
        pid,
        pidFile: getDaemonPidPath(rpxDir),
        rpxDir,
        registryDir: registryDir ?? getRegistryDir(),
        entries,
      }, null, 2))
      return
    }

    if (!running) {
      console.log('rpx daemon: not running')
      if (pid !== null)
        console.log(`(stale pid file at ${getDaemonPidPath(rpxDir)} → pid ${pid})`)
    }
    else {
      console.log(`rpx daemon: running (pid=${pid})`)
      console.log(`pid file: ${getDaemonPidPath(rpxDir)}`)
    }
    console.log(`registry: ${registryDir ?? getRegistryDir()}`)
    if (entries.length === 0) {
      console.log('no registered hosts')
      return
    }
    console.log(`registered hosts (${entries.length}):`)
    for (const e of entries) {
      const ownerSuffix = e.pid !== undefined ? `, pid=${e.pid}` : ''
      console.log(`  https://${e.to}  →  ${e.from}  (id=${e.id}${ownerSuffix})`)
    }
  })

// ---------------------------------------------------------------------------
// register / unregister — writer-side. Used by `./buddy dev` to advertise an
// app to the daemon. Lazy-spawns the daemon on first register.
// ---------------------------------------------------------------------------

interface RegisterOptions {
  id?: string
  from?: string
  to?: string
  cwd?: string
  cleanUrls?: boolean
  changeOrigin?: boolean
  rpxDir?: string
  registryDir?: string
  skipSpawn?: boolean
  verbose?: boolean
}

cli
  .command('register', 'Register an upstream app with the rpx daemon')
  .option('--id <id>', 'Unique id for this entry (a-z, 0-9, dot, dash, underscore)')
  .option('--from <host:port>', 'Upstream host:port (e.g. localhost:5173)')
  .option('--to <host>', 'Public hostname (e.g. pet-store.localhost)')
  .option('--cwd <path>', 'Working directory of the upstream (informational)')
  .option('--clean-urls', 'Strip .html and 301 to the clean URL')
  .option('--change-origin', 'Rewrite Origin to the upstream')
  .option('--rpx-dir <path>', 'Override the rpx state dir (default ~/.stacks/rpx)')
  .option('--registry-dir <path>', 'Override the registry dir (default <rpx-dir>/registry.d)')
  .option('--skip-spawn', 'Do not lazy-spawn the daemon if it is not already running')
  .option('--verbose', 'Enable verbose logging')
  .example('rpx register --id pet-store --from localhost:5173 --to pet-store.localhost')
  .action(async (opts: RegisterOptions) => {
    if (!opts.id || !opts.from || !opts.to) {
      console.error('rpx register requires --id, --from, and --to')
      process.exit(1)
    }
    if (!isValidId(opts.id)) {
      console.error(`invalid id: ${JSON.stringify(opts.id)} (must match /^[a-zA-Z0-9._-]+$/, ≤128 chars)`)
      process.exit(1)
    }

    try {
      // No pid: `rpx register` is a fire-and-forget CLI invocation. The entry
      // persists until explicit `rpx unregister`. Long-running consumers (e.g.
      // `./buddy dev`) that want PID-GC should use `runViaDaemon` from the
      // library, which keeps the parent alive for the entry's lifetime.
      await writeEntry({
        id: opts.id,
        from: opts.from,
        to: opts.to,
        cwd: opts.cwd,
        createdAt: new Date().toISOString(),
        cleanUrls: opts.cleanUrls,
        changeOrigin: opts.changeOrigin,
      }, opts.registryDir, opts.verbose)
    }
    catch (err) {
      console.error(`failed to write registry entry: ${(err as Error).message}`)
      process.exit(1)
    }

    if (opts.skipSpawn) {
      console.log(`registered ${opts.to} → ${opts.from} (daemon spawn skipped)`)
      return
    }

    try {
      const result = await ensureDaemonRunning({
        rpxDir: opts.rpxDir,
        verbose: opts.verbose,
      })
      const action = result.spawned ? 'spawned' : 'attached to'
      console.log(`registered https://${opts.to} → ${opts.from} (${action} daemon pid=${result.pid})`)
    }
    catch (err) {
      console.error(`registered entry but daemon spawn failed: ${(err as Error).message}`)
      console.error('the entry remains in the registry; start the daemon manually with `rpx daemon:start`')
      process.exit(1)
    }
  })

cli
  .command('unregister <id>', 'Remove a previously registered app from the rpx daemon')
  .option('--registry-dir <path>', 'Override the registry dir (default ~/.stacks/rpx/registry.d)')
  .option('--verbose', 'Enable verbose logging')
  .action(async (id: string, opts: { registryDir?: string, verbose?: boolean }) => {
    if (!isValidId(id)) {
      console.error(`invalid id: ${JSON.stringify(id)}`)
      process.exit(1)
    }
    const existing = await readEntry(id, opts.registryDir, opts.verbose)
    if (!existing) {
      console.log(`no registry entry for id=${id}`)
      return
    }
    await removeEntry(id, opts.registryDir, opts.verbose)
    console.log(`unregistered ${existing.to} (id=${id})`)
  })

cli.command('version', 'Show the version of the Reverse Proxy CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
