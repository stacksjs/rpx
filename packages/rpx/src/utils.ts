import type { MultiProxyConfig, PathRewrite, ProxyConfigs, ProxyOption, ProxyOptions, SingleProxyConfig } from './types'
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
  const escaped = command.replace(/'/g, `'\\''`)

  if (sudoPassword) {
    return execSync(`echo '${sudoPassword}' | sudo -S sh -c '${escaped}' 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  return execSync(`sudo sh -c '${escaped}'`, { encoding: 'utf-8' })
}

export function debugLog(category: string, message: string, verbose?: boolean): void {
  if (verbose)
    logger.debug(`[rpx:${category}] ${message}`)
}

const REDACTED = '[redacted]'
const SENSITIVE_KEYS = new Set([
  'certificate',
  'privatekey',
  'key',
  'cert',
  'ca',
  'rootca',
  'password',
  'sudo_password',
])
const PEM_BLOCK_RE = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('password')
    || normalized.includes('secret')
    || normalized.includes('token')
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(item => redactSensitive(item))

  if (typeof value === 'string')
    return PEM_BLOCK_RE.test(value) ? REDACTED : value

  if (!value || typeof value !== 'object')
    return value

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED
      continue
    }

    output[key] = redactSensitive(nested)
  }

  return output
}

export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(redactSensitive(value), null, space)
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
 * Resolve a path against a list of `pathRewrites`.
 *
 * Returns `null` if no rewrite matches; otherwise returns `{ targetHost, targetPath }`
 * with the prefix preserved by default (or stripped when `stripPrefix === true`).
 *
 * Matching rule: rewrite matches if `pathname` is exactly `from` OR starts with
 * `from + '/'`. So `/api` matches `/api`, `/api/`, `/api/cart` — but not `/apidocs`.
 */
export function resolvePathRewrite(
  pathname: string,
  rewrites: PathRewrite[] | undefined,
): { targetHost: string, targetPath: string } | null {
  if (!rewrites || rewrites.length === 0)
    return null

  for (const rewrite of rewrites) {
    if (pathname === rewrite.from || pathname.startsWith(`${rewrite.from}/`)) {
      const targetHost = rewrite.to.startsWith('http') ? new URL(rewrite.to).host : rewrite.to
      const targetPath = rewrite.stripPrefix === true
        ? (pathname.slice(rewrite.from.length) || '/')
        : pathname
      return { targetHost, targetPath }
    }
  }

  return null
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
