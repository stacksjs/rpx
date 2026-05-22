import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCertSha256Fingerprint } from './cert-inspect'
import { debugLog, execSudoSync } from './utils'

/** Chrome/Edge need SSL + basic trust policies — plain trustRoot often leaves "trust settings: 0". */
export const MACOS_CA_TRUST_FLAGS = '-d -r trustRoot -p ssl -p basic'

export const MACOS_SYSTEM_KEYCHAIN = '/Library/Keychains/System.keychain'

/** Default CN label for the shared rpx Root CA in macOS keychain listings. */
export const RPX_ROOT_CA_COMMON_NAME = 'rpx.localhost'

export function getMacosLoginKeychainPath(): string {
  return join(homedir(), 'Library/Keychains/login.keychain-db')
}

export function getMacosTrustKeychains(): string[] {
  return [MACOS_SYSTEM_KEYCHAIN, getMacosLoginKeychainPath()]
}

export interface ListCertsByCommonNameOptions {
  keychain: string
  commonName?: string
}

export function listCertSha256HashesByCommonName(
  keychain: string,
  commonName: string = RPX_ROOT_CA_COMMON_NAME,
): string[] {
  const listing = execSync(
    `security find-certificate -a -c "${commonName}" -Z "${keychain}" 2>/dev/null || true`,
    { encoding: 'utf8' },
  )
  const hashes: string[] = []
  for (const line of listing.split('\n')) {
    const match = line.match(/SHA-256 hash:\s*([A-F0-9]+)/i)
    if (match)
      hashes.push(match[1]!.toUpperCase())
  }
  return hashes
}

export interface PruneStaleRootCasOptions {
  caPath: string
  commonName?: string
  keychains?: string[]
  verbose?: boolean
}

/**
 * Remove older rpx Root CA copies from keychains, keeping only the fingerprint
 * that matches the on-disk `caPath` file.
 */
export function pruneStaleRootCas(options: PruneStaleRootCasOptions): void {
  if (process.platform !== 'darwin')
    return

  const keep = readCertSha256Fingerprint(options.caPath)
  if (!keep)
    return

  const commonName = options.commonName ?? RPX_ROOT_CA_COMMON_NAME
  const keychains = options.keychains ?? getMacosTrustKeychains()

  for (const keychain of keychains) {
    for (const hash of listCertSha256HashesByCommonName(keychain, commonName)) {
      if (hash === keep)
        continue
      try {
        if (keychain.startsWith('/Library'))
          execSudoSync(`security delete-certificate -Z ${hash} "${keychain}"`)
        else
          execSync(`security delete-certificate -Z ${hash} "${keychain}"`, { stdio: 'ignore' })
        debugLog('ssl', `Removed stale Root CA ${hash} from ${keychain}`, options.verbose)
      }
      catch { /* already removed */ }
    }
  }
}

/**
 * True when the Root CA is trusted for SSL to `serverName` (macOS verify-cert).
 * On other platforms, falls back to fingerprint presence in trust stores.
 */
export function isRootCaTrustedForSsl(
  caPath: string,
  serverName: string,
  options?: { verbose?: boolean },
): boolean {
  if (process.platform !== 'darwin')
    return isRootCaFingerprintInKeychains(caPath, options)

  try {
    const out = execSync(
      `security verify-cert -c "${caPath}" -s "${serverName}" -l -L -R ssl 2>&1`,
      { encoding: 'utf8' },
    )
    const ok = out.includes('successful')
    debugLog('ssl', `verify-cert ${serverName}: ${ok ? 'trusted' : 'not trusted'}`, options?.verbose)
    return ok
  }
  catch {
    return false
  }
}

export function isRootCaFingerprintInKeychains(
  caPath: string,
  options?: { verbose?: boolean },
): boolean {
  const fp = readCertSha256Fingerprint(caPath)
  if (!fp)
    return false

  for (const keychain of getMacosTrustKeychains()) {
    try {
      const listing = execSync(`security find-certificate -a -Z "${keychain}" 2>/dev/null || true`, { encoding: 'utf8' })
      for (const line of listing.split('\n')) {
        if (line.toUpperCase().includes('SHA-256')) {
          const lineFp = line.split('=').pop()!.replace(/SHA-256\s+hash:\s*/gi, '').replace(/:/g, '').trim().toUpperCase()
          if (lineFp === fp) {
            debugLog('ssl', `Root CA fingerprint found in ${keychain}`, options?.verbose)
            return true
          }
        }
      }
    }
    catch { /* try next keychain */ }
  }

  return false
}

export interface TrustRootCaForBrowsersOptions {
  serverName: string
  commonName?: string
  verbose?: boolean
}

/**
 * Install the Root CA into login + system keychains with SSL/basic policies,
 * pruning stale copies first. Returns true when SSL verification succeeds or
 * the cert fingerprint is present in a keychain.
 */
export function trustRootCaForBrowsers(
  caPath: string,
  options: TrustRootCaForBrowsersOptions,
): boolean {
  if (process.platform !== 'darwin')
    return false

  const serverName = options.serverName
  pruneStaleRootCas({ caPath, commonName: options.commonName, verbose: options.verbose })

  const loginKeychain = getMacosLoginKeychainPath()
  try {
    execSync(
      `security add-trusted-cert ${MACOS_CA_TRUST_FLAGS} -k "${loginKeychain}" "${caPath}"`,
      { stdio: 'ignore' },
    )
  }
  catch { /* may already exist — re-apply trust below */ }

  try {
    execSudoSync(`security add-trusted-cert ${MACOS_CA_TRUST_FLAGS} -k ${MACOS_SYSTEM_KEYCHAIN} "${caPath}"`)
  }
  catch {
    return false
  }

  return isRootCaTrustedForSsl(caPath, serverName, { verbose: options.verbose })
    || isRootCaFingerprintInKeychains(caPath, { verbose: options.verbose })
}
