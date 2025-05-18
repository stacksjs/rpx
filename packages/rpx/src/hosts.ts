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

// Flag to track if we've already received sudo privileges in this session
let sudoPrivilegesAcquired = false

// Single function to execute sudo commands, with caching for permissions
async function execSudo(command: string): Promise<string> {
  if (process.platform === 'win32')
    throw new Error('Administrator privileges required on Windows')

  try {
    // If we've already acquired sudo privileges, try to use the cached credentials with -n flag
    if (sudoPrivilegesAcquired) {
      try {
        // Try using sudo with -n flag which will fail immediately if sudo requires a password
        const { stdout } = await execAsync(`sudo -n true && sudo -n ${command}`)
        return stdout
      }
      // eslint-disable-next-line unused-imports/no-unused-vars
      catch (error) {
        // If the -n version fails, fall back to regular sudo
        debugLog('hosts', 'Cached sudo privileges expired, requesting again', true)
      }
    }

    // Regular sudo prompt
    const { stdout } = await execAsync(`sudo ${command}`)
    sudoPrivilegesAcquired = true
    return stdout
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
    let existingContent: string
    try {
      existingContent = await fs.promises.readFile(hostsFilePath, 'utf-8')
    }
    catch (readErr) {
      debugLog('hosts', `Error reading hosts file: ${readErr}`, verbose)
      log.error(`Failed to read hosts file: ${readErr}`)

      // Try with sudo
      try {
        existingContent = await execSudo(`cat "${hostsFilePath}"`)
      }
      catch (sudoErr) {
        log.error(`Failed to read hosts file with sudo: ${sudoErr}`)
        throw new Error(`Cannot read hosts file: ${sudoErr}`)
      }
    }

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

    const tmpFile = path.join(os.tmpdir(), `rpx-hosts-${Date.now()}.tmp`)

    try {
      // Write to temporary file
      await fs.promises.writeFile(tmpFile, existingContent + hostEntries, 'utf8')

      // Use tee with sudo to write the content to hosts file
      await execSudo(`cat "${tmpFile}" | tee "${hostsFilePath}" > /dev/null`)
      log.success(`Added new hosts: ${newEntries.join(', ')}`)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      log.error('Failed to modify hosts file automatically')
      log.warn('Please add these entries to your hosts file manually:')
      newEntries.forEach((host) => {
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
      try {
        // Clean up the temp file
        await fs.promises.unlink(tmpFile)
      }
      catch (unlinkErr) {
        // Ignore cleanup errors
        debugLog('hosts', `Failed to remove temporary file: ${unlinkErr}`, verbose)
      }
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
    // Read existing hosts file content
    let content: string
    try {
      content = await fs.promises.readFile(hostsFilePath, 'utf-8')
    }
    catch (readErr) {
      debugLog('hosts', `Error reading hosts file: ${readErr}`, verbose)

      // Try with sudo
      try {
        content = await execSudo(`cat "${hostsFilePath}"`)
      }
      catch (sudoErr) {
        log.error(`Failed to read hosts file with sudo: ${sudoErr}`)
        throw new Error(`Cannot read hosts file: ${sudoErr}`)
      }
    }

    const lines = content.split('\n')
    let modified = false

    // Filter out our added entries and their comments
    const filteredLines = lines.filter((line) => {
      // Check if this line contains one of our hosts
      const isHostLine = hosts.some(host =>
        line.includes(` ${host}`)
        && (line.includes('127.0.0.1') || line.includes('::1')),
      )

      if (isHostLine) {
        modified = true
        return false
      }

      // If it's our comment line, remove it
      if (line.trim() === '# Added by rpx') {
        modified = true
        return false
      }

      return true
    })

    // If nothing was removed, we're done
    if (!modified) {
      debugLog('hosts', 'No matching hosts found to remove', verbose)
      return
    }

    // Remove empty lines at the end of the file
    while (filteredLines[filteredLines.length - 1]?.trim() === '')
      filteredLines.pop()

    // Ensure file ends with a single newline
    const newContent = `${filteredLines.join('\n')}\n`

    const tmpFile = path.join(os.tmpdir(), `rpx-hosts-${Date.now()}.tmp`)

    try {
      // Write to temporary file
      await fs.promises.writeFile(tmpFile, newContent, 'utf8')

      // Use tee with sudo to write the content to hosts file
      await execSudo(`cat "${tmpFile}" | tee "${hostsFilePath}" > /dev/null`)
      log.success('Hosts removed successfully')
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      log.error('Failed to modify hosts file automatically')
      log.warn('Please remove these entries from your hosts file manually:')
      hosts.forEach((host) => {
        log.warn(`127.0.0.1 ${host}`)
        log.warn(`::1 ${host}`)
      })
      throw new Error('Failed to modify hosts file automatically')
    }
    finally {
      try {
        // Clean up the temp file
        await fs.promises.unlink(tmpFile)
      }
      catch (unlinkErr) {
        // Ignore cleanup errors
        debugLog('hosts', `Failed to remove temporary file: ${unlinkErr}`, verbose)
      }
    }
  }
  catch (err) {
    log.error('Failed to clean up hosts file:', (err as Error).message)
    throw err
  }
}

export async function checkHosts(hosts: string[], verbose?: boolean): Promise<boolean[]> {
  debugLog('hosts', `Checking hosts: ${hosts}`, verbose)

  let content: string
  try {
    content = await fs.promises.readFile(hostsFilePath, 'utf-8')
  }
  catch (readErr) {
    debugLog('hosts', `Error reading hosts file: ${readErr}`, verbose)

    // Try with sudo
    try {
      const { stdout } = await execAsync(`sudo cat "${hostsFilePath}"`)
      content = stdout
    }
    catch (sudoErr) {
      log.error(`Failed to read hosts file with sudo: ${sudoErr}`)
      throw new Error(`Cannot read hosts file: ${sudoErr}`)
    }
  }

  return hosts.map((host) => {
    const ipv4Entry = `127.0.0.1 ${host}`
    const ipv6Entry = `::1 ${host}`
    return content.includes(ipv4Entry) || content.includes(ipv6Entry)
  })
}
