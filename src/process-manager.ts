import type { ChildProcess } from 'node:child_process'
import type { StartOptions } from './types'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { debugLog } from './utils'

export interface ManagedProcess {
  command: string
  cwd: string
  process: ChildProcess | null
  env?: Record<string, string>
}

export class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map()

  async startProcess(id: string, options: StartOptions, verbose?: boolean): Promise<void> {
    if (this.processes.has(id)) {
      debugLog('start', `Process ${id} is already running`, verbose)
      return
    }

    const [cmd, ...args] = options.command.split(' ')
    const cwd = options.cwd || process.cwd()

    debugLog('start', `Starting process ${id}:`, verbose)
    debugLog('start', `  Command: ${cmd} ${args.join(' ')}`, verbose)
    debugLog('start', `  Working directory: ${cwd}`, verbose)
    debugLog('start', `  Environment variables: ${JSON.stringify(options.env)}`, verbose)

    const childProcess = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: 'inherit',
    })

    this.processes.set(id, {
      command: options.command,
      cwd,
      process: childProcess,
      env: options.env,
    })

    return new Promise((resolve, reject) => {
      childProcess.on('error', (err) => {
        debugLog('start', `Process ${id} failed to start: ${err}`, verbose)
        this.processes.delete(id)
        reject(err)
      })

      childProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          debugLog('start', `Process ${id} exited with code ${code}`, verbose)
          this.processes.delete(id)
          reject(new Error(`Process ${id} exited with code ${code}`))
        }
      })

      // Add stdout/stderr handlers if verbose
      if (verbose) {
        childProcess.stdout?.on('data', (data) => {
          debugLog('process', `[${id}] ${data.toString().trim()}`, true)
        })

        childProcess.stderr?.on('data', (data) => {
          debugLog('process', `[${id}] ERR: ${data.toString().trim()}`, true)
        })
      }

      // Resolve after a delay to allow the process to start
      setTimeout(() => {
        if (childProcess.killed) {
          this.processes.delete(id)
          reject(new Error(`Process ${id} was killed during startup`))
        }
        else {
          debugLog('start', `Process ${id} started successfully`, verbose)
          resolve()
        }
      }, 1000)
    })
  }

  async stopProcess(id: string, verbose?: boolean): Promise<void> {
    const managed = this.processes.get(id)
    if (!managed?.process) {
      debugLog('start', `No process found for ${id}`, verbose)
      return
    }

    debugLog('start', `Stopping process ${id}`, verbose)

    return new Promise((resolve) => {
      if (!managed.process) {
        resolve()
        return
      }

      managed.process.once('exit', () => {
        this.processes.delete(id)
        debugLog('start', `Process ${id} stopped`, verbose)
        resolve()
      })

      managed.process.kill('SIGTERM')

      // Force kill after 5 seconds if process hasn't exited
      setTimeout(() => {
        if (managed.process) {
          debugLog('start', `Force killing process ${id}`, verbose)
          managed.process.kill('SIGKILL')
        }
      }, 5000)
    })
  }

  async stopAll(verbose?: boolean): Promise<void> {
    debugLog('start', 'Stopping all processes', verbose)

    const promises = Array.from(this.processes.keys()).map(id =>
      this.stopProcess(id, verbose),
    )

    await Promise.all(promises)
  }

  isRunning(id: string): boolean {
    const managed = this.processes.get(id)
    return !!managed?.process && !managed.process.killed
  }
}

export const processManager: ProcessManager = new ProcessManager()
