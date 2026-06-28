import { getCertCommonName, getCertSha256Fingerprint, isCertValidForDomain, verifyServerChain } from '@stacksjs/tlsx'

// Cert inspection lives in tlsx (Node's crypto.X509Certificate under the hood) —
// rpx just adapts the results to its null-on-failure contract. Never openssl.

/**
 * Normalize an X509 fingerprint (`AA:BB:..`) or a `security`-listing hash to
 * uppercase hex without separators, so values from different sources compare.
 */
export function normalizeSha256Fingerprint(raw: string): string {
  const value = raw.includes('=') ? raw.split('=').pop()! : raw
  return value.replace(/SHA-256\s+hash:\s*/gi, '').replace(/:/g, '').trim().toUpperCase()
}

export function readCertSha256Fingerprint(certPath: string): string | null {
  try {
    return getCertSha256Fingerprint(certPath)
  }
  catch {
    return null
  }
}

export function readCertCommonName(certPath: string): string | null {
  try {
    return getCertCommonName(certPath) || null
  }
  catch {
    return null
  }
}

export function certIncludesSanHostnames(certPath: string, hostnames: string[]): boolean {
  try {
    return hostnames.every(host => isCertValidForDomain(certPath, host))
  }
  catch {
    return false
  }
}

/**
 * True when the live server at `domain:port` presents a chain trusted by `caPath`
 * — a real TLS handshake pinned to the CA (tlsx `verifyServerChain`; no openssl).
 */
export function verifyHttpsChain(domain: string, caPath: string, port = 443): Promise<boolean> {
  return verifyServerChain(domain, caPath, port)
}

/**
 * Parse `security find-certificate -Z` listing lines into SHA-256 hashes.
 */
export function parseSha256HashesFromSecurityListing(listing: string): string[] {
  const hashes: string[] = []
  for (const line of listing.split('\n')) {
    const match = line.match(/SHA-256 hash:\s*([A-F0-9]+)/i)
    if (match)
      hashes.push(match[1]!.toUpperCase())
  }
  return hashes
}
