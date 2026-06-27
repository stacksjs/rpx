import tls from 'node:tls'
import { getCertificateFromCertPemOrPath, isCertValidForDomain } from '@stacksjs/tlsx'

// Cert inspection goes through tlsx / Node's built-in `crypto.X509Certificate`
// — never openssl. tlsx owns the parsing; rpx only adapts the results.

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
    return normalizeSha256Fingerprint(getCertificateFromCertPemOrPath(certPath).fingerprint256)
  }
  catch {
    return null
  }
}

export function readCertCommonName(certPath: string): string | null {
  try {
    // X509Certificate.subject is a newline/comma-separated DN, e.g. "CN=rpx Dev CA".
    const match = getCertificateFromCertPemOrPath(certPath).subject.match(/CN=([^\n,/]+)/)
    return match?.[1]?.trim() ?? null
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
 * True when the live server at `domain:port` presents a chain trusted by `caPath`.
 * Performs a real TLS handshake pinned to the CA (no shell, no openssl): if the
 * handshake authorizes against the CA, the chain is valid.
 */
export async function verifyHttpsChain(domain: string, caPath: string, port = 443): Promise<boolean> {
  const ca = caPath.includes('-----BEGIN')
    ? caPath
    : await (await import('node:fs/promises')).readFile(caPath, 'utf8').catch(() => '')
  if (!ca)
    return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (v: boolean): void => {
      if (settled)
        return
      settled = true
      resolve(v)
    }
    const socket = tls.connect({ host: domain, port, servername: domain, ca, rejectUnauthorized: true }, () => {
      finish(socket.authorized)
      socket.end()
    })
    socket.setTimeout(4000, () => {
      socket.destroy()
      finish(false)
    })
    socket.on('error', () => finish(false))
  })
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
