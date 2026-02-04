/**
 * Minimal DNS server for local development
 * Handles DNS queries for configured domains and responds with localhost IPs
 */
import dgram from 'node:dgram'
import { debugLog } from './utils'

// Use a high port that doesn't require root
const DNS_PORT = 15353

interface DnsHeader {
  id: number
  flags: number
  qdcount: number
  ancount: number
  nscount: number
  arcount: number
}

interface DnsQuestion {
  name: string
  type: number
  class: number
}

/**
 * Parse DNS header from buffer
 */
function parseHeader(buffer: Buffer): DnsHeader {
  return {
    id: buffer.readUInt16BE(0),
    flags: buffer.readUInt16BE(2),
    qdcount: buffer.readUInt16BE(4),
    ancount: buffer.readUInt16BE(6),
    nscount: buffer.readUInt16BE(8),
    arcount: buffer.readUInt16BE(10),
  }
}

/**
 * Parse domain name from DNS message
 */
function parseName(buffer: Buffer, offset: number): { name: string, newOffset: number } {
  const labels: string[] = []
  let currentOffset = offset

  while (true) {
    const length = buffer[currentOffset]

    if (length === 0) {
      currentOffset++
      break
    }

    // Check for pointer (compression)
    if ((length & 0xC0) === 0xC0) {
      const pointer = buffer.readUInt16BE(currentOffset) & 0x3FFF
      const { name } = parseName(buffer, pointer)
      labels.push(name)
      currentOffset += 2
      break
    }

    currentOffset++
    labels.push(buffer.subarray(currentOffset, currentOffset + length).toString('ascii'))
    currentOffset += length
  }

  return { name: labels.join('.'), newOffset: currentOffset }
}

/**
 * Parse DNS question section
 */
function parseQuestion(buffer: Buffer, offset: number): { question: DnsQuestion, newOffset: number } {
  const { name, newOffset } = parseName(buffer, offset)
  const type = buffer.readUInt16BE(newOffset)
  const qclass = buffer.readUInt16BE(newOffset + 2)

  return {
    question: { name, type, class: qclass },
    newOffset: newOffset + 4,
  }
}

/**
 * Encode domain name for DNS response
 */
function encodeName(name: string): Buffer {
  const labels = name.split('.')
  const parts: Buffer[] = []

  for (const label of labels) {
    parts.push(Buffer.from([label.length]))
    parts.push(Buffer.from(label, 'ascii'))
  }
  parts.push(Buffer.from([0])) // Null terminator

  return Buffer.concat(parts)
}

/**
 * Build DNS response
 */
function buildResponse(
  queryId: number,
  question: DnsQuestion,
  ip: string,
): Buffer {
  const parts: Buffer[] = []

  // Header
  const header = Buffer.alloc(12)
  header.writeUInt16BE(queryId, 0) // ID
  header.writeUInt16BE(0x8180, 2) // Flags: Response, Authoritative, No error
  header.writeUInt16BE(1, 4) // Questions: 1
  header.writeUInt16BE(1, 6) // Answers: 1
  header.writeUInt16BE(0, 8) // Authority: 0
  header.writeUInt16BE(0, 10) // Additional: 0
  parts.push(header)

  // Question section (echo back)
  parts.push(encodeName(question.name))
  const qtype = Buffer.alloc(4)
  qtype.writeUInt16BE(question.type, 0)
  qtype.writeUInt16BE(question.class, 2)
  parts.push(qtype)

  // Answer section
  parts.push(encodeName(question.name))

  const answer = Buffer.alloc(10)
  answer.writeUInt16BE(question.type, 0) // Type
  answer.writeUInt16BE(1, 2) // Class: IN
  answer.writeUInt32BE(300, 4) // TTL: 5 minutes

  if (question.type === 1) {
    // A record (IPv4)
    answer.writeUInt16BE(4, 8) // Data length
    parts.push(answer)
    const ipParts = ip.split('.').map(p => Number.parseInt(p, 10))
    parts.push(Buffer.from(ipParts))
  }
  else if (question.type === 28) {
    // AAAA record (IPv6)
    answer.writeUInt16BE(16, 8) // Data length
    parts.push(answer)
    // ::1 as bytes
    parts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
  }
  else {
    // Unsupported type - return NXDOMAIN
    header.writeUInt16BE(0x8183, 2) // Flags with NXDOMAIN
    header.writeUInt16BE(0, 6) // No answers
    return Buffer.concat([header, encodeName(question.name), qtype])
  }

  return Buffer.concat(parts)
}

/**
 * Build NXDOMAIN response for unknown domains
 */
function buildNxdomainResponse(queryId: number, question: DnsQuestion): Buffer {
  const parts: Buffer[] = []

  // Header with NXDOMAIN
  const header = Buffer.alloc(12)
  header.writeUInt16BE(queryId, 0) // ID
  header.writeUInt16BE(0x8183, 2) // Flags: Response, Authoritative, NXDOMAIN
  header.writeUInt16BE(1, 4) // Questions: 1
  header.writeUInt16BE(0, 6) // Answers: 0
  header.writeUInt16BE(0, 8) // Authority: 0
  header.writeUInt16BE(0, 10) // Additional: 0
  parts.push(header)

  // Question section (echo back)
  parts.push(encodeName(question.name))
  const qtype = Buffer.alloc(4)
  qtype.writeUInt16BE(question.type, 0)
  qtype.writeUInt16BE(question.class, 2)
  parts.push(qtype)

  return Buffer.concat(parts)
}

let dnsServer: dgram.Socket | null = null
let configuredDomains: Set<string> = new Set()

/**
 * Start the DNS server
 */
export async function startDnsServer(domains: string[], verbose?: boolean): Promise<boolean> {
  if (dnsServer) {
    debugLog('dns', 'DNS server already running', verbose)
    return true
  }

  configuredDomains = new Set(domains.map(d => d.toLowerCase()))

  return new Promise((resolve) => {
    dnsServer = dgram.createSocket('udp4')

    dnsServer.on('error', (err) => {
      debugLog('dns', `DNS server error: ${err.message}`, verbose)
      if (err.message.includes('EACCES') || err.message.includes('permission')) {
        debugLog('dns', 'DNS server requires root privileges to bind to port 53', verbose)
      }
      dnsServer?.close()
      dnsServer = null
      resolve(false)
    })

    dnsServer.on('message', (msg, rinfo) => {
      try {
        const header = parseHeader(msg)
        const { question } = parseQuestion(msg, 12)

        debugLog('dns', `Query for ${question.name} type ${question.type} from ${rinfo.address}`, verbose)

        // Check if this domain should be handled
        const domainLower = question.name.toLowerCase()
        let shouldHandle = false

        for (const configured of configuredDomains) {
          if (domainLower === configured || domainLower.endsWith(`.${configured}`)) {
            shouldHandle = true
            break
          }
        }

        // Also handle any .test domain
        if (domainLower.endsWith('.test')) {
          shouldHandle = true
        }

        let response: Buffer
        if (shouldHandle && (question.type === 1 || question.type === 28)) {
          response = buildResponse(header.id, question, '127.0.0.1')
          debugLog('dns', `Responding with localhost for ${question.name}`, verbose)
        }
        else {
          response = buildNxdomainResponse(header.id, question)
          debugLog('dns', `NXDOMAIN for ${question.name}`, verbose)
        }

        dnsServer?.send(response, rinfo.port, rinfo.address)
      }
      catch (err) {
        debugLog('dns', `Error processing DNS query: ${err}`, verbose)
      }
    })

    dnsServer.on('listening', () => {
      const address = dnsServer?.address()
      debugLog('dns', `DNS server listening on ${address?.address}:${address?.port}`, verbose)
      resolve(true)
    })

    // Try to bind to port 53 with sudo
    try {
      dnsServer.bind(DNS_PORT, '127.0.0.1')
    }
    catch (err) {
      debugLog('dns', `Failed to bind DNS server: ${err}`, verbose)
      resolve(false)
    }
  })
}

/**
 * Stop the DNS server
 */
export function stopDnsServer(verbose?: boolean): void {
  if (dnsServer) {
    debugLog('dns', 'Stopping DNS server', verbose)
    dnsServer.close()
    dnsServer = null
  }
}

/**
 * Check if DNS server is running
 */
export function isDnsServerRunning(): boolean {
  return dnsServer !== null
}

/**
 * Set up the macOS resolver for .test domains
 * Creates /etc/resolver/test pointing to our local DNS server
 */
export async function setupResolver(verbose?: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') {
    debugLog('dns', 'Resolver setup only needed on macOS', verbose)
    return true
  }

  const resolverContent = `nameserver 127.0.0.1
port ${DNS_PORT}
`

  const { execSudoSync, getSudoPassword } = await import('./utils')

  try {
    // Create /etc/resolver directory if it doesn't exist
    const sudoPassword = getSudoPassword()
    if (sudoPassword) {
      // Use bash -c to properly handle the echo with newlines
      const cmd = `bash -c 'mkdir -p /etc/resolver && echo -e "nameserver 127.0.0.1\\nport ${DNS_PORT}" > /etc/resolver/test'`
      execSudoSync(cmd)
      debugLog('dns', 'Created /etc/resolver/test for .test TLD', verbose)
      return true
    }
    else {
      debugLog('dns', 'SUDO_PASSWORD not set, cannot create resolver file', verbose)
      return false
    }
  }
  catch (err) {
    debugLog('dns', `Failed to create resolver file: ${err}`, verbose)
    return false
  }
}

/**
 * Remove the macOS resolver for .test domains
 */
export async function removeResolver(verbose?: boolean): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  const { execSudoSync, getSudoPassword } = await import('./utils')

  try {
    const sudoPassword = getSudoPassword()
    if (sudoPassword) {
      execSudoSync('rm -f /etc/resolver/test')
      debugLog('dns', 'Removed /etc/resolver/test', verbose)
    }
  }
  catch (err) {
    debugLog('dns', `Failed to remove resolver file: ${err}`, verbose)
  }
}
