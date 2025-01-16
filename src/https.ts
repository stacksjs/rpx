import type { ProxyConfigs, ProxyOption, ProxyOptions, SingleProxyConfig, SSLConfig, TlsConfig } from './types'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error dtsx issue
import { addCertToSystemTrustStoreAndSaveCert, createRootCA, generateCertificate as generateCert } from '@stacksjs/tlsx'
import { consola as log } from 'consola'
import { config } from './config'
import { debugLog, getPrimaryDomain, isMultiProxyConfig, isMultiProxyOptions, isSingleProxyOptions, isValidRootCA, safeDeleteFile } from './utils'

let cachedSSLConfig: { key: string, cert: string, ca?: string } | null = null

/**
 * Resolves SSL paths based on configuration
 */
export function resolveSSLPaths(options: ProxyConfigs, defaultConfig: typeof config): TlsConfig {
  const domain = isMultiProxyConfig(options)
    ? options.proxies[0].to || 'stacks.localhost'
    : options.to || 'stacks.localhost'

  // If HTTPS is an object and has explicit paths defined, use those
  if (typeof options.https === 'object' && typeof defaultConfig.https === 'object') {
    const hasAllPaths = options.https.caCertPath && options.https.certPath && options.https.keyPath
    if (hasAllPaths) {
      // Create base TLS config
      const baseConfig = httpsConfig({
        ...options,
        to: domain,
        https: defaultConfig.https,
      })

      // Filter out undefined values from arrays
      const altNameIPs = options.https.altNameIPs?.filter((ip: any): ip is string => ip !== undefined) || baseConfig.altNameIPs
      const altNameURIs = options.https.altNameURIs?.filter((uri: any): uri is string => uri !== undefined) || baseConfig.altNameURIs

      // Override with provided paths
      return {
        ...baseConfig,
        caCertPath: options.https.caCertPath || baseConfig.caCertPath,
        certPath: options.https.certPath || baseConfig.certPath,
        keyPath: options.https.keyPath || baseConfig.keyPath,
        basePath: options.https.basePath || baseConfig.basePath,
        commonName: options.https.commonName || baseConfig.commonName,
        organizationName: options.https.organizationName || baseConfig.organizationName,
        countryName: options.https.countryName || baseConfig.countryName,
        stateName: options.https.stateName || baseConfig.stateName,
        localityName: options.https.localityName || baseConfig.localityName,
        validityDays: options.https.validityDays || baseConfig.validityDays,
        altNameIPs,
        altNameURIs,
        verbose: options.verbose || baseConfig.verbose,
      }
    }
  }

  // Otherwise, generate paths based on the domain
  return httpsConfig({
    ...options,
    to: domain,
  })
}

// Generate wildcard patterns for a domain
export function generateWildcardPatterns(domain: string): string[] {
  const patterns = new Set<string>()
  patterns.add(domain)

  const parts = domain.split('.')
  if (parts.length >= 2)
    patterns.add(`*.${parts.slice(1).join('.')}`)

  return Array.from(patterns)
}

/**
 * Generates SSL file paths based on domain
 */
export function generateSSLPaths(options?: ProxyOptions): {
  caCertPath: string
  certPath: string
  keyPath: string
} {
  const domain = getPrimaryDomain(options)
  let basePath = ''
  if (typeof options?.https === 'object') {
    basePath = options.https.basePath || ''
    return {
      caCertPath: options.https.caCertPath || join(basePath, `${domain}.ca.crt`),
      certPath: options.https.certPath || join(basePath, `${domain}.crt`),
      keyPath: options.https.keyPath || join(basePath, `${domain}.key`),
    }
  }

  const sslBase = basePath || join(homedir(), '.stacks', 'ssl')
  const sanitizedDomain = domain.replace(/\*/g, 'wildcard')

  return {
    caCertPath: join(sslBase, `${sanitizedDomain}.ca.crt`),
    certPath: join(sslBase, `${sanitizedDomain}.crt`),
    keyPath: join(sslBase, `${sanitizedDomain}.key`),
  }
}

export function getAllDomains(options: ProxyOption | ProxyOptions): Set<string> {
  const domains = new Set<string>()

  if (isMultiProxyOptions(options)) {
    options.proxies.forEach((proxy) => {
      const domain = proxy.to || 'stacks.localhost'
      generateWildcardPatterns(domain).forEach(pattern => domains.add(pattern))
    })
  }
  else if (isSingleProxyOptions(options)) {
    const domain = options.to || 'stacks.localhost'
    generateWildcardPatterns(domain).forEach(pattern => domains.add(pattern))
  }
  else {
    domains.add('stacks.localhost')
  }

  // Add localhost patterns
  domains.add('localhost')
  domains.add('*.localhost')

  return domains
}

/**
 * Load SSL certificates from files or use provided strings
 */
export async function loadSSLConfig(options: ProxyOption): Promise<SSLConfig | null> {
  debugLog('ssl', `Loading SSL configuration`, options.verbose)

  const mergedOptions = {
    ...config,
    ...options,
  }

  options.https = httpsConfig(mergedOptions)

  // Early return for non-SSL configuration
  if (!options.https?.keyPath && !options.https?.certPath) {
    debugLog('ssl', 'No SSL configuration provided', options.verbose)
    return null
  }

  if ((options.https?.keyPath && !options.https?.certPath) || (!options.https?.keyPath && options.https?.certPath)) {
    const missing = !options.https?.keyPath ? 'keyPath' : 'certPath'
    debugLog('ssl', `Invalid SSL configuration - missing ${missing}`, options.verbose)
    throw new Error(`SSL Configuration requires both keyPath and certPath. Missing: ${missing}`)
  }

  try {
    if (!options.https?.keyPath || !options.https?.certPath)
      return null

    // Try to read existing certificates
    try {
      debugLog('ssl', 'Reading SSL certificate files', options.verbose)
      const key = await fs.readFile(options.https?.keyPath, 'utf8')
      const cert = await fs.readFile(options.https?.certPath, 'utf8')

      debugLog('ssl', 'SSL configuration loaded successfully', options.verbose)
      return { key, cert }
    }
    catch (error) {
      debugLog('ssl', `Failed to read certificates: ${error}`, options.verbose)
      return null
    }
  }
  catch (err) {
    debugLog('ssl', `SSL configuration error: ${err}`, options.verbose)
    throw err
  }
}

export async function generateCertificate(options: ProxyOptions): Promise<void> {
  if (cachedSSLConfig) {
    debugLog('ssl', 'Using cached SSL configuration', options.verbose)
    return
  }

  // Get all unique domains from the configuration
  const domains: string[] = isMultiProxyOptions(options)
    ? options.proxies.map(proxy => proxy.to)
    : [(options as SingleProxyConfig).to]

  debugLog('ssl', `Generating certificate for domains: ${domains.join(', ')}`, options.verbose)

  // Generate Root CA first
  const rootCAConfig = httpsConfig(options, options.verbose)

  log.info('Generating Root CA certificate...')
  const caCert = await createRootCA(rootCAConfig)

  // Generate the host certificate with all domains
  const hostConfig = httpsConfig(options, options.verbose)
  log.info(`Generating host certificate for: ${domains.join(', ')}`)

  const hostCert = await generateCert({
    ...hostConfig,
    rootCA: {
      certificate: caCert.certificate,
      privateKey: caCert.privateKey,
    },
  })

  // Add to system trust store with all necessary options
  await addCertToSystemTrustStoreAndSaveCert(hostCert, caCert.certificate, hostConfig)

  // Cache the SSL config for reuse
  cachedSSLConfig = {
    key: hostCert.privateKey,
    cert: hostCert.certificate,
    ca: caCert.certificate,
  }

  log.success(`Certificate generated successfully for ${domains.length} domain${domains.length > 1 ? 's' : ''}`)
  debugLog('ssl', `Certificate includes domains: ${domains.join(', ')}`, options.verbose)
}

export function getSSLConfig(): { key: string, cert: string, ca?: string } | null {
  return cachedSSLConfig
}

// needs to accept the options
export async function checkExistingCertificates(options?: ProxyOptions): Promise<SSLConfig | null> {
  const name = getPrimaryDomain(options)
  const paths = generateSSLPaths(options)

  try {
    debugLog('ssl', `Checking certificates for ${name} at paths:`, options?.verbose)
    debugLog('ssl', `CA: ${paths.caCertPath}`, options?.verbose)
    debugLog('ssl', `Cert: ${paths.certPath}`, options?.verbose)
    debugLog('ssl', `Key: ${paths.keyPath}`, options?.verbose)

    const key = await fs.readFile(paths.keyPath, 'utf8')
    const cert = await fs.readFile(paths.certPath, 'utf8')
    let ca: string | undefined

    if (paths.caCertPath) {
      try {
        ca = await fs.readFile(paths.caCertPath, 'utf8')
      }
      catch (err) {
        debugLog('ssl', `Failed to read CA cert: ${err}`, options?.verbose)
      }
    }

    return { key, cert, ca }
  }
  catch (err) {
    debugLog('ssl', `Failed to read certificates: ${err}`, options?.verbose)
    return null
  }
}

export function httpsConfig(options: ProxyOption | ProxyOptions, verbose?: boolean): TlsConfig {
  const primaryDomain = getPrimaryDomain(options)
  debugLog('ssl', `Primary domain: ${primaryDomain}`, verbose)

  // Generate paths based on domain if not explicitly provided
  const defaultPaths = generateSSLPaths(options)

  // If HTTPS paths are explicitly provided, use those
  if (typeof options.https === 'object') {
    const config: TlsConfig = {
      domain: primaryDomain,
      hostCertCN: primaryDomain,
      basePath: options.https.basePath || '',
      caCertPath: options.https.caCertPath || defaultPaths.caCertPath,
      certPath: options.https.certPath || defaultPaths.certPath,
      keyPath: options.https.keyPath || defaultPaths.keyPath,
      altNameIPs: ['127.0.0.1', '::1'],
      altNameURIs: [],
      commonName: options.https.commonName || primaryDomain,
      organizationName: options.https.organizationName || 'Local Development',
      countryName: options.https.countryName || 'US',
      stateName: options.https.stateName || 'California',
      localityName: options.https.localityName || 'Playa Vista',
      validityDays: options.https.validityDays || 825,
      verbose: verbose || false,
      subjectAltNames: Array.from(getAllDomains(options)).map(domain => ({
        type: 2,
        value: domain,
      })),
    }

    // Add optional properties if they exist and are valid
    if (isValidRootCA(options.https.rootCA)) {
      config.rootCA = options.https.rootCA
    }

    return config
  }

  // Return default configuration
  return {
    domain: primaryDomain,
    hostCertCN: primaryDomain,
    basePath: '',
    ...defaultPaths,
    altNameIPs: ['127.0.0.1', '::1'],
    altNameURIs: [],
    commonName: primaryDomain,
    organizationName: 'Local Development',
    countryName: 'US',
    stateName: 'California',
    localityName: 'Playa Vista',
    validityDays: 825,
    verbose: verbose || false,
    subjectAltNames: Array.from(getAllDomains(options)).map(domain => ({
      type: 2,
      value: domain,
    })),
  }
}

/**
 * Clean up SSL certificates for a specific domain
 */
export async function cleanupCertificates(domain: string, verbose?: boolean): Promise<void> {
  const certPaths = generateSSLPaths({ to: domain, verbose })

  // Define all possible certificate files
  const filesToDelete = [
    certPaths.caCertPath,
    certPaths.certPath,
    certPaths.keyPath,
  ]

  debugLog('certificates', `Attempting to clean up relating certificates`, verbose)

  // Delete all files concurrently
  await Promise.all(filesToDelete.map(file => safeDeleteFile(file, verbose)))
}
