import type { SudoCheckOptions } from './types'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { checkExistingCertificates, checkHosts } from '@stacksjs/rpx'

export const execAsync: typeof exec.__promisify__ = promisify(exec)

/**
 * Check if the operation requires sudo access
 */
export async function needsSudoAccess(options: SudoCheckOptions): Promise<boolean> {
  try {
    // Check if we need to generate certificates
    if (options.https) {
      const existingCerts = await checkExistingCertificates({
        to: options.domain,
        verbose: options.verbose,
      })

      if (!existingCerts) {
        return true
      }
    }

    // Check if we need to modify hosts file
    if (!options.domain.includes('localhost') && !options.domain.includes('127.0.0.1')) {
      const hostsExist = await checkHosts([options.domain], options.verbose)
      // Only need sudo if hosts don't exist and we don't have write permission
      if (!hostsExist[0]) {
        try {
          // Try to write a test file to check permissions
          await execAsync('sudo -n touch /etc/hosts')
          return false
        }
        catch {
          return true
        }
      }
    }

    return false
  }
  catch (error) {
    // If we can't check, don't assume we need sudo
    if (options.verbose)
      console.error('Error checking sudo requirements:', error)

    return false
  }
}
