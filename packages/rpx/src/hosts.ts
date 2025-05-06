import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { consola as log } from 'consola'
import { debugLog } from './utils'

const execAsync = promisify(exec)

export const hostsFilePath: string = process.platform === 'win32'
  ? path.join(process.env.windir || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts'

// Single function to execute sudo commands
async function execSudo(command: string): Promise<void> {
  if (process.platform === 'win32')
    throw new Error('Administrator privileges required on Windows')

  try {
    await execAsync(`sudo ${command}`)
  }
  catch (error) {
    throw new Error(`Failed to execute sudo command: ${(error as Error).message}`)
  }
}

export async function addHosts(hosts: string[], verbose?: boolean): Promise<void> {
  debugLog('hosts', `Adding hosts: ${hosts.join(', ')}`, verbose)
  debugLog('hosts', `Using hosts file at: ${hostsFilePath}`, verbose)

  try {
    // Read existing hosts file content
    const existingContent = await fs.promises.readFile(hostsFilePath, 'utf-8')

    // Prepare new entries, only including those that don't exist
    const newEntries = hosts.filter((host) => {
      const ipv4Entry = `127.0.0.1 ${host}`
      const ipv6Entry = `::1 ${host}`
      return !existingContent.includes(ipv4Entry) && !existingContent.includes(ipv6Entry)
    })

    if (newEntries.length === 0) {
      debugLog('hosts', 'All hosts already exist in hosts file', verbose)
      log.info('All hosts are already in the hosts file')
      return
    }

    // Create content for new entries
    const hostEntries = newEntries.map(host =>
      `\n# Added by rpx\n127.0.0.1 ${host}\n::1 ${host}`,
    ).join('\n')

    const tmpFile = path.join(os.tmpdir(), 'hosts.tmp')
    await fs.promises.writeFile(tmpFile, existingContent + hostEntries, 'utf8')

    try {
      await execSudo(`cp "${tmpFile}" "${hostsFilePath}"`)
      log.success(`Added new hosts: ${newEntries.join(', ')}`)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      log.error('Failed to modify hosts file automatically')
      log.warn('Please add these entries to your hosts file manually:')
      hostEntries.split('\n').forEach(entry => log.warn(entry))

      if (process.platform === 'win32') {
        log.warn('\nOn Windows:')
        log.warn('1. Run notepad as administrator')
        log.warn('2. Open C:\\Windows\\System32\\drivers\\etc\\hosts')
      }
      else {
        log.warn('\nOn Unix systems:')
        log.warn(`sudo nano ${hostsFilePath}`)
      }

      throw new Error('Failed to modify hosts file: manual intervention required')
    }
    finally {
      fs.unlinkSync(tmpFile)
    }
  }
  catch (err) {
    const error = err as Error
    log.error(`Failed to manage hosts file: ${error.message}`)
    throw error
  }
}

export async function removeHosts(hosts: string[], verbose?: boolean): Promise<void> {
  debugLog('hosts', `Removing hosts: ${hosts.join(', ')}`, verbose)

  try {
    const content = await fs.promises.readFile(hostsFilePath, 'utf-8')
    const lines = content.split('\n')

    // Filter out our added entries and their comments
    const filteredLines = lines.filter((line, index) => {
      // If it's our comment, skip this line and the following IPv4/IPv6 entries
      if (line.trim() === '# Added by rpx') {
        // Skip next two lines (IPv4 and IPv6)
        lines.splice(index + 1, 2)
        return false
      }
      return true
    })

    // Remove empty lines at the end of the file
    while (filteredLines[filteredLines.length - 1]?.trim() === '')
      filteredLines.pop()

    // Ensure file ends with a single newline
    const newContent = `${filteredLines.join('\n')}\n`

    const tmpFile = path.join(os.tmpdir(), 'hosts.tmp')
    await fs.promises.writeFile(tmpFile, newContent, 'utf8')

    try {
      await execSudo(`cp "${tmpFile}" "${hostsFilePath}"`)
      log.success('Hosts removed successfully')
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      log.error('Failed to modify hosts file automatically')
      log.warn('Please remove these entries from your hosts file manually:')
      hosts.forEach((host) => {
        log.warn('# Added by rpx')
        log.warn(`127.0.0.1 ${host}`)
        log.warn(`::1 ${host}`)
      })

      if (process.platform === 'win32') {
        log.warn('\nOn Windows:')
        log.warn('1. Run notepad as administrator')
        log.warn('2. Open C:\\Windows\\System32\\drivers\\etc\\hosts')
      }
      else {
        log.warn('\nOn Unix systems:')
        log.warn(`sudo nano ${hostsFilePath}`)
      }

      throw new Error('Failed to modify hosts file: manual intervention required')
    }
    finally {
      fs.unlinkSync(tmpFile)
    }
  }
  catch (err) {
    const error = err as Error
    log.error(`Failed to remove hosts: ${error.message}`)
    throw error
  }
}

export async function checkHosts(hosts: string[], verbose?: boolean): Promise<boolean[]> {
  debugLog('hosts', `Checking hosts: ${hosts}`, verbose)

  const content = await fs.promises.readFile(hostsFilePath, 'utf-8')
  return hosts.map((host) => {
    const ipv4Entry = `127.0.0.1 ${host}`
    const ipv6Entry = `::1 ${host}`
    return content.includes(ipv4Entry) || content.includes(ipv6Entry)
  })
}
