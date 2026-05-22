import { execSync } from 'node:child_process'

/**
 * Normalize openssl / security fingerprint output to uppercase hex without separators.
 */
export function normalizeSha256Fingerprint(raw: string): string {
  const value = raw.includes('=') ? raw.split('=').pop()! : raw
  return value.replace(/SHA-256\s+hash:\s*/gi, '').replace(/:/g, '').trim().toUpperCase()
}

export function readCertSha256Fingerprint(certPath: string): string | null {
  try {
    const out = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${certPath}"`, { encoding: 'utf8' })
    return normalizeSha256Fingerprint(out)
  }
  catch {
    return null
  }
}

export function readCertCommonName(certPath: string): string | null {
  try {
    const subject = execSync(`openssl x509 -in "${certPath}" -noout -subject -nameopt RFC2253`, { encoding: 'utf8' })
    const match = subject.match(/CN=([^,/]+)/)
    return match?.[1]?.trim() ?? null
  }
  catch {
    return null
  }
}

export function certIncludesSanHostnames(certPath: string, hostnames: string[]): boolean {
  try {
    const text = execSync(`openssl x509 -in "${certPath}" -noout -text`, { encoding: 'utf8' })
    return hostnames.every(host => text.includes(`DNS:${host}`))
  }
  catch {
    return false
  }
}

/**
 * True when :443 (or `port`) presents a chain trusted by `caPath` for `domain`.
 */
export function verifyHttpsChain(domain: string, caPath: string, port = 443): boolean {
  try {
    const out = execSync(
      `echo | openssl s_client -connect ${domain}:${port} -servername ${domain} -CAfile "${caPath}" 2>/dev/null | grep "Verify return code"`,
      { encoding: 'utf8', timeout: 4000 },
    )
    return out.includes(': 0 (ok)')
  }
  catch {
    return false
  }
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
