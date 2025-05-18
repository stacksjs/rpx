import type { ProxyConfigs, ProxyOption, ProxyOptions, SingleProxyConfig, SSLConfig, TlsConfig } from './types'
import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import * as os from 'node:os'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import process from 'node:process'
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
    ? options.proxies[0].to || 'rpx.localhost'
    : options.to || 'rpx.localhost'

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
      const domain = proxy.to || 'rpx.localhost'
      generateWildcardPatterns(domain).forEach(pattern => domains.add(pattern))
    })
  }
  else if (isSingleProxyOptions(options)) {
    const domain = options.to || 'rpx.localhost'
    generateWildcardPatterns(domain).forEach(pattern => domains.add(pattern))
  }
  else {
    domains.add('rpx.localhost')
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

/**
 * Force trust a certificate - exposing for direct use
 */
export async function forceTrustCertificate(certPath: string): Promise<boolean> {
  if (process.platform === 'darwin')
    return forceTrustCertificateMacOS(certPath)

  if (process.platform === 'linux') {
    try {
      const { exec } = await import('node:child_process')
      return await new Promise((resolve) => {
        // Try Ubuntu/Debian way
        exec(
          `sudo cp "${certPath}" /usr/local/share/ca-certificates/ && sudo update-ca-certificates`,
          (error) => {
            if (!error) {
              resolve(true)
            }
            else {
              // Try Fedora/RHEL way
              exec(
                `sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust extract`,
                (err2) => {
                  resolve(!err2)
                },
              )
            }
          },
        )
      })
    }
    catch {
      return false
    }
  }

  return false
}

/**
 * Force trust a certificate on macOS using direct security command
 */
async function forceTrustCertificateMacOS(certPath: string): Promise<boolean> {
  if (process.platform !== 'darwin')
    return false

  try {
    log.info(`Attempting to trust certificate using macOS security command`)

    // Use execSync to avoid unresolved reference
    try {
      execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`)
      log.success('Successfully added certificate to system trust store')
      return true
    }
    catch (sysErr) {
      log.warn(`Could not add to system keychain: ${sysErr}`)

      // If system keychain fails, try with the user's login keychain
      try {
        execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`)
        log.success('Successfully added certificate to user login keychain')
        return true
      }
      catch (userErr) {
        log.warn(`Could not add to user keychain: ${userErr}`)
        return false
      }
    }
  }
  catch (err) {
    log.error(`Failed to trust certificate: ${err}`)
    return false
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

  // Save the certificate files first before trying to trust them
  // This prevents multiple trust attempts when files don't exist
  try {
    // Ensure the SSL directory exists
    const sslDir = hostConfig.basePath || join(homedir(), '.stacks', 'ssl')
    await fs.mkdir(sslDir, { recursive: true })

    // Write certificate files
    await Promise.all([
      fs.writeFile(hostConfig.certPath, hostCert.certificate),
      fs.writeFile(hostConfig.keyPath, hostCert.privateKey),
      fs.writeFile(hostConfig.caCertPath, caCert.certificate),
    ])

    debugLog('ssl', 'Certificate files saved successfully', options.verbose)
  }
  catch (err) {
    debugLog('ssl', `Error saving certificate files: ${err}`, options.verbose)
    throw new Error(`Failed to save certificate files: ${err}`)
  }

  // Now add to system trust store with a single operation
  // This will require only one sudo password prompt
  log.info('Adding certificate to system trust store (may require sudo permission)...')

  let isTrusted = false

  // We'll use a stronger approach to ensure the certificate is properly trusted
  if (process.platform === 'darwin') {
    try {
      // For macOS, add both CA and host certificates to system trust store for maximum compatibility
      try {
        // First try the CA certificate
        execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${hostConfig.caCertPath}"`)
        log.success('Successfully added CA certificate to system trust store')

        // Then force add the host certificate to login keychain which doesn't require sudo
        execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${hostConfig.certPath}"`)
        log.success('Successfully added host certificate to login keychain')

        // Force a keychain update
        execSync(`security verify-cert -c "${hostConfig.certPath}"`)

        isTrusted = true
      }
      catch (error) {
        log.warn(`Could not fully automate certificate trust: ${error}`)
        // Try with a more reliable approach
        isTrusted = await forceTrustCertificateMacOS(hostConfig.certPath)
      }

      // Create a simple trust-helper script for easy manual trust if needed
      const sslScriptDir = hostConfig.basePath || join(homedir(), '.stacks', 'ssl')
      const scriptPath = join(sslScriptDir, 'trust-rpx-cert.sh')
      const scriptContent = `#!/bin/bash
echo "Trusting RPX certificate for domains: ${domains.join(', ')}"
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${hostConfig.caCertPath}"
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${hostConfig.certPath}"
echo "Certificates trusted! Please restart your browser."
echo "If you still see certificate warnings, type 'thisisunsafe' on the warning page in Chrome/Arc browsers."
`
      await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 }) // Make it executable

      if (!isTrusted) {
        log.info(`Created a trust helper script at: ${scriptPath}`)
        log.info(`If you're still having certificate issues, run: sh ${scriptPath}`)
      }
    }
    catch (err) {
      log.warn(`Could not add certificate to trust store automatically: ${err}`)
    }
  }
  else if (process.platform === 'linux') {
    try {
      // On Linux, we need to copy to the trusted certificates directory
      const { exec } = await import('node:child_process')
      const certDir = '/usr/local/share/ca-certificates/rpx'

      // Create a more reliable trust script
      const trustScript = `
mkdir -p "${certDir}" 2>/dev/null || true
cp "${hostConfig.caCertPath}" "${certDir}/"
cp "${hostConfig.certPath}" "${certDir}/"
update-ca-certificates
echo "RPX certificates installed. Please restart your browser."
`
      // Use a temp file for the script
      const tmpScript = join(os.tmpdir(), `rpx-trust-${Date.now()}.sh`)
      await fs.writeFile(tmpScript, trustScript, { mode: 0o755 })

      // Run with one sudo prompt
      await new Promise((resolve) => {
        exec(`sudo bash "${tmpScript}"`, (error) => {
          if (error) {
            log.warn(`Could not trust certificates: ${error}`)
            resolve(false)
          }
          else {
            log.success('Successfully added certificates to system trust store')
            resolve(true)
          }
        })
      })

      // Clean up
      await fs.unlink(tmpScript).catch(() => {})

      isTrusted = true
    }
    catch (error) {
      log.warn(`Failed to trust certificates: ${error}`)
    }
  }
  else if (process.platform === 'win32') {
    // Windows certificate trust
    try {
      // Windows is different - use a PowerShell approach
      const winScript = `
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("${hostConfig.caCertPath.replace(/\//g, '\\')}")
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store("ROOT", "LocalMachine")
$store.Open("ReadWrite")
$store.Add($cert)
$store.Close()
Write-Host "Certificate trusted successfully!"
`
      const psPath = join(os.tmpdir(), 'rpx-trust.ps1')
      await fs.writeFile(psPath, winScript)

      execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`)
      log.success('Successfully added certificate to Windows trust store')
      isTrusted = true
    }
    catch (error) {
      log.warn(`Could not trust certificate: ${error}`)
    }
  }
  else {
    // Use the built-in trust mechanism for other platforms
    try {
      await addCertToSystemTrustStoreAndSaveCert(hostCert, caCert.certificate, hostConfig)
      // Assume this worked for now
      isTrusted = true
    }
    catch (err) {
      log.warn(`Could not add certificate to trust store: ${err}`)
    }
  }

  // Cache the SSL config for reuse
  cachedSSLConfig = {
    key: hostCert.privateKey,
    cert: hostCert.certificate,
    ca: caCert.certificate,
  }

  log.success(`Certificate generated successfully for ${domains.length} domain${domains.length > 1 ? 's' : ''}`)

  // Show Chrome bypass tip if trust might have issues
  if (!isTrusted) {
    log.warn('If you see certificate warnings in Chrome/Arc, type "thisisunsafe" on the warning page')
    log.warn('This will bypass the warning and you should only need to do it once')
  }
}

export function getSSLConfig(): { key: string, cert: string, ca?: string } | null {
  return cachedSSLConfig
}

// needs to accept the options
export async function checkExistingCertificates(options?: ProxyOptions): Promise<SSLConfig | null> {
  if (!options)
    return null

  if (cachedSSLConfig)
    return cachedSSLConfig

  // Use httpsConfig to get the path configuration
  const sslConfig = httpsConfig(options)

  try {
    // Check if certificate files exist
    const [keyExists, certExists, caExists] = await Promise.all([
      fs.access(sslConfig.keyPath).then(() => true).catch(() => false),
      fs.access(sslConfig.certPath).then(() => true).catch(() => false),
      sslConfig.caCertPath ? fs.access(sslConfig.caCertPath).then(() => true).catch(() => false) : Promise.resolve(false),
    ])

    if (!keyExists || !certExists) {
      debugLog('ssl', `Certificate files don't exist: key=${keyExists}, cert=${certExists}`, options.verbose)
      return null
    }

    // Check if certificate is trusted
    // But only if regenerateUntrustedCerts is enabled (default is true)
    const shouldCheckTrust = 'regenerateUntrustedCerts' in options ? options.regenerateUntrustedCerts !== false : true
    let certIsTrusted = shouldCheckTrust ? await isCertTrusted(sslConfig.certPath, options) : true

    if (!certIsTrusted) {
      debugLog('ssl', 'Certificate exists but is not trusted, will regenerate', options.verbose)

      // If not trusted and on macOS, force trust it first before regenerating
      if (process.platform === 'darwin') {
        try {
          log.info('Certificate found but not trusted. Attempting to add to macOS trust store...')
          await forceTrustCertificate(sslConfig.certPath)

          // Check again to see if forcing trust worked
          const nowTrusted = await isCertTrusted(sslConfig.certPath, options)
          if (nowTrusted) {
            log.success('Successfully trusted existing certificate')
            // Continue with loading the certificate below
            certIsTrusted = true
          }
        }
        catch (err) {
          debugLog('ssl', `Failed to force trust certificate: ${err}`, options.verbose)
        }
      }

      // If still not trusted, return null to trigger regeneration
      if (!certIsTrusted) {
        return null
      }
    }

    // Load the certificates
    const [key, cert, ca] = await Promise.all([
      fs.readFile(sslConfig.keyPath, 'utf8'),
      fs.readFile(sslConfig.certPath, 'utf8'),
      caExists && sslConfig.caCertPath ? fs.readFile(sslConfig.caCertPath, 'utf8') : Promise.resolve(undefined),
    ])

    // Validate root CA if present
    if (ca && !isValidRootCA(ca)) {
      debugLog('ssl', 'Invalid root CA certificate, will regenerate', options.verbose)
      return null
    }

    debugLog('ssl', 'Successfully loaded existing certificates', options.verbose)

    // Cache the result
    cachedSSLConfig = { key, cert, ca }
    return cachedSSLConfig
  }
  catch (err) {
    debugLog('ssl', `Error checking existing certificates: ${err}`, options.verbose)
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

/**
 * Checks if a certificate is trusted by the system (macOS only for now)
 * If options.regenerateUntrustedCerts is false, always returns true (skips trust check)
 */
export async function isCertTrusted(certPath: string, options?: { verbose?: boolean, regenerateUntrustedCerts?: boolean }): Promise<boolean> {
  try {
    debugLog('ssl', `Checking if certificate is trusted: ${certPath}`, options?.verbose)

    // Different check methods per platform
    if (process.platform === 'darwin') {
      // On macOS, use the security command to check if the cert is trusted
      try {
        // Get certificate fingerprint
        const certFingerprint = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${certPath}"`).toString().trim()
        const fingerprintValue = certFingerprint.split('=')[1]?.trim() || ''

        if (!fingerprintValue) {
          debugLog('ssl', 'Could not extract certificate fingerprint', options?.verbose)
          return false
        }

        // Check if the fingerprint exists in the system keychain and is trusted
        const keychainOutput = execSync(`security find-certificate -a -Z -p | openssl x509 -noout -fingerprint -sha256`).toString()

        // If the fingerprint is found in the trusted certs, consider it trusted
        if (keychainOutput.includes(fingerprintValue)) {
          debugLog('ssl', 'Certificate fingerprint found in system keychain', options?.verbose)
          return true
        }

        debugLog('ssl', 'Certificate fingerprint not found in system keychain', options?.verbose)
        return false
      }
      catch (error) {
        debugLog('ssl', `Error checking certificate trust: ${error}`, options?.verbose)
        return false
      }
    }
    else if (process.platform === 'win32') {
      // On Windows, use PowerShell to check the certificate store
      try {
        // Get certificate subject from file
        const certSubject = execSync(`openssl x509 -noout -subject -in "${certPath}"`).toString().trim()
        const subjectName = certSubject.split('=').slice(1).join('=').trim() || ''

        if (!subjectName) {
          debugLog('ssl', 'Could not extract certificate subject', options?.verbose)
          return false
        }

        // Check if the certificate exists in the trusted root store
        const powershellCmd = `powershell -Command "Get-ChildItem -Path Cert:\\LocalMachine\\Root | Where-Object { $_.Subject -like '*${subjectName}*' } | Select-Object Subject"`
        const storeOutput = execSync(powershellCmd).toString()

        if (storeOutput.includes(subjectName)) {
          debugLog('ssl', 'Certificate found in trusted root store', options?.verbose)
          return true
        }

        debugLog('ssl', 'Certificate not found in trusted root store', options?.verbose)
        return false
      }
      catch (error) {
        debugLog('ssl', `Error checking certificate trust on Windows: ${error}`, options?.verbose)
        return false
      }
    }
    else if (process.platform === 'linux') {
      // On Linux, check using OpenSSL against the system trust store
      try {
        // This is a simplified check and may need to be adjusted per distribution
        const certFingerprint = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${certPath}"`).toString().trim()
        const fingerprintValue = certFingerprint.split('=')[1]?.trim() || ''

        // Different distros store certs in different locations
        const trustStores = [
          '/etc/ssl/certs', // Debian/Ubuntu
          '/etc/pki/tls/certs', // RedHat/CentOS
        ]

        for (const store of trustStores) {
          try {
            const storeOutput = execSync(`find ${store} -type f -exec openssl x509 -noout -fingerprint -sha256 -in {} \\; 2>/dev/null | grep "${fingerprintValue}"`).toString()

            if (storeOutput.includes(fingerprintValue)) {
              debugLog('ssl', `Certificate fingerprint found in ${store}`, options?.verbose)
              return true
            }
          }
          catch {
            // Ignore errors searching specific stores
          }
        }

        debugLog('ssl', 'Certificate not found in system trust stores', options?.verbose)
        return false
      }
      catch (error) {
        debugLog('ssl', `Error checking certificate trust on Linux: ${error}`, options?.verbose)
        return false
      }
    }

    // Default to false for unsupported platforms
    debugLog('ssl', `Platform ${process.platform} not supported for certificate trust check`, options?.verbose)
    return false
  }
  catch (err) {
    debugLog('ssl', `Error checking if certificate is trusted: ${err}`, options?.verbose)
    return false
  }
}
