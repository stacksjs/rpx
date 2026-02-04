import type { MultiProxyConfig, ProxyConfigs, ProxyOption, ProxyOptions, SingleProxyConfig } from './types'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { Logger } from '@stacksjs/clarity'

const logger = new Logger('rpx', {
  showTags: false,
})

/**
 * Get sudo password from environment variable if set
 */
export function getSudoPassword(): string | undefined {
  return process.env.SUDO_PASSWORD
}

/**
 * Execute a command with sudo, using SUDO_PASSWORD if available
 */
export function execSudoSync(command: string): string {
  const sudoPassword = getSudoPassword()

  if (sudoPassword) {
    // Use -S flag to read password from stdin
    return execSync(`echo '${sudoPassword}' | sudo -S ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  // Fall back to regular sudo (will prompt for password if needed)
  return execSync(`sudo ${command}`, { encoding: 'utf-8' })
}

export function debugLog(category: string, message: string, verbose?: boolean): void {
  if (verbose)
    logger.debug(`[rpx:${category}] ${message}`)
}

/**
 * Extracts hostnames from proxy configuration
 */
export function extractHostname(options: ProxyOption | ProxyOptions): string[] {
  if (isMultiProxyOptions(options)) {
    return options.proxies.map((proxy) => {
      const domain = proxy.to || 'stacks.localhost'
      return domain.startsWith('http') ? new URL(domain).hostname : domain
    })
  }

  if (isSingleProxyOptions(options)) {
    const domain = options.to || 'stacks.localhost'
    return [domain.startsWith('http') ? new URL(domain).hostname : domain]
  }

  return ['stacks.localhost']
}

interface RootCA {
  certificate: string
  privateKey: string
}

export function isValidRootCA(value: unknown): value is RootCA {
  return (
    typeof value === 'object'
    && value !== null
    && 'certificate' in value
    && 'privateKey' in value
    && typeof (value as RootCA).certificate === 'string'
    && typeof (value as RootCA).privateKey === 'string'
  )
}

export function getPrimaryDomain(options?: ProxyOption | ProxyOptions): string {
  if (!options)
    return 'stacks.localhost'

  if (isMultiProxyOptions(options) && options.proxies.length > 0)
    return options.proxies[0].to || 'stacks.localhost'

  if (isSingleProxyOptions(options))
    return options.to || 'stacks.localhost'

  return 'stacks.localhost'
}

/**
 * Type guard for multi-proxy configuration
 */
export function isMultiProxyConfig(options: ProxyConfigs | ProxyOptions): options is MultiProxyConfig {
  return !!(options && 'proxies' in options && Array.isArray((options as MultiProxyConfig).proxies))
}

/**
 * Type guard to check if options are for multi-proxy configuration
 */
export function isMultiProxyOptions(options: ProxyOption | ProxyOptions): options is MultiProxyConfig {
  return 'proxies' in options && Array.isArray((options as MultiProxyConfig).proxies)
}

/**
 * Type guard to check if options are for single-proxy configuration
 */
export function isSingleProxyOptions(options: ProxyOption | ProxyOptions): options is SingleProxyConfig {
  return 'to' in options && typeof (options as SingleProxyConfig).to === 'string'
}

export function isSingleProxyConfig(options: ProxyConfigs | ProxyOptions): options is SingleProxyConfig {
  return !!(options && 'to' in options && !('proxies' in options))
}

/**
 * Safely delete a file if it exists
 */
export async function safeDeleteFile(filePath: string, verbose?: boolean): Promise<void> {
  try {
    // Try to delete the file directly without checking existence first
    await fs.unlink(filePath)
    debugLog('certificates', `Successfully deleted: ${filePath}`, verbose)
  }
  catch (err) {
    // Ignore errors where file doesn't exist
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLog('certificates', `Warning: Could not delete ${filePath}: ${err}`, verbose)
    }
  }
}
