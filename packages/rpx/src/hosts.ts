import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as process from 'node:process'
import { promisify } from 'node:util'
import { debugLog, getSudoPassword } from './utils'

const execAsync = promisify(exec)

export const hostsFilePath: string = process.platform === 'win32'
  ? path.join(process.env.windir || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts'

// Flag to track if we've already received sudo privileges in this session
let sudoPrivilegesAcquired = false

// Single function to execute sudo commands, with caching for permissions.
// Wraps in sh -c so pipes/redirects all run under sudo.
async function execSudo(command: string): Promise<string> {
  if (process.platform === 'win32')
    throw new Error('Administrator privileges required on Windows')

  const sudoPassword = getSudoPassword()
  const escaped = command.replace(/'/g, `'\\''`)

  try {
    if (sudoPassword) {
      const { stdout } = await execAsync(`echo '${sudoPassword}' | sudo -S sh -c '${escaped}' 2>/dev/null`)
      sudoPrivilegesAcquired = true
      return stdout
    }

    if (sudoPrivilegesAcquired) {
      try {
        const { stdout } = await execAsync(`sudo -n sh -c '${escaped}'`)
        return stdout
      }
      // eslint-disable-next-line unused-imports/no-unused-vars
      catch (error) {
        debugLog('hosts', 'Cached sudo privileges expired, requesting again', true)
      }
    }

    const { stdout } = await execAsync(`sudo sh -c '${escaped}'`)
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
    catch {
      // /etc/hosts typically requires elevated permissions — fall back to sudo
      debugLog('hosts', 'Reading hosts file requires elevated permissions, using sudo', verbose)

      try {
        existingContent = await execSudo(`cat "${hostsFilePath}"`)
      }
      catch (sudoErr) {
        console.log('  Could not read hosts file — skipping hosts setup')
        debugLog('hosts', `sudo read also failed: ${sudoErr}`, verbose)
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
      console.log(`  Hosts updated: ${newEntries.join(', ')}`)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      // Don't throw — just tell the user what to add manually
      console.log('  Could not update hosts file automatically')
      console.log('  Add these entries to /etc/hosts:')
      newEntries.forEach((host) => {
        console.log(`    127.0.0.1 ${host}`)
        console.log(`    ::1 ${host}`)
      })
      console.log(`  Or run: sudo nano ${hostsFilePath}`)
    }
    finally {
      try {
        await fs.promises.unlink(tmpFile)
      }
      catch {
        // Ignore cleanup errors
      }
    }
  }
  catch (err) {
    const error = err as Error
    debugLog('hosts', `Failed to manage hosts file: ${error.message}`, verbose)
    // Don't throw - hosts file management is best-effort
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
    catch {
      debugLog('hosts', 'Reading hosts file requires elevated permissions, using sudo', verbose)

      try {
        content = await execSudo(`cat "${hostsFilePath}"`)
      }
      catch (sudoErr) {
        debugLog('hosts', `sudo read also failed: ${sudoErr}`, verbose)
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
      debugLog('hosts', 'Hosts removed successfully', verbose)
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    catch (error) {
      debugLog('hosts', 'Could not clean up hosts file automatically', verbose)
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
    debugLog('hosts', `Failed to clean up hosts file: ${(err as Error).message}`, verbose)
    // Don't throw - hosts file cleanup is best-effort
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

    // Try with sudo using SUDO_PASSWORD if available
    try {
      const sudoPassword = getSudoPassword()
      let cmd: string
      if (sudoPassword) {
        cmd = `echo '${sudoPassword}' | sudo -S cat "${hostsFilePath}" 2>/dev/null`
      }
      else {
        cmd = `sudo -n cat "${hostsFilePath}" 2>/dev/null || cat "${hostsFilePath}" 2>/dev/null || echo ""`
      }
      const { stdout } = await execAsync(cmd)
      content = stdout
    }
    catch (sudoErr) {
      // Can't read hosts file - assume entries don't exist
      debugLog('hosts', `Cannot read hosts file, assuming entries don't exist: ${sudoErr}`, verbose)
      return hosts.map(() => false)
    }
  }

  return hosts.map((host) => {
    const ipv4Entry = `127.0.0.1 ${host}`
    const ipv6Entry = `::1 ${host}`
    return content.includes(ipv4Entry) || content.includes(ipv6Entry)
  })
}
