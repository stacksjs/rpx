import type { ProxyOption, StartOptions } from '../src/types'
import process from 'node:process'
import { CAC } from 'cac'
import { version } from '../package.json'
import { config } from '../src/config'
import { processManager } from '../src/process-manager'
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
  verbose?: boolean
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
  .option('--verbose', 'Enable verbose logging')
  .example('rpx start --from localhost:5173 --to my-project.localhost')
  .example('rpx start --from localhost:3000 --to my-project.localhost/api')
  .example('rpx start --from localhost:3000 --to localhost:3001')
  .example('rpx start --from localhost:5173 --to my-project.test --key-path /absolute/path/to/key --cert-path /absolute/path/to/cert')
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
      ? config.proxies.find(p => p.to === proxyId || `${p.from}-${p.to}` === proxyId)
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

cli.command('version', 'Show the version of the Reverse Proxy CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
