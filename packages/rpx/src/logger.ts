import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const consolaMod = require('consola') as { consola: { info: (...args: any[]) => void, success: (...args: any[]) => void, warn: (...args: any[]) => void, error: (...args: any[]) => void, debug: (...args: any[]) => void, log: (...args: any[]) => void, start: (...args: any[]) => void, box: (...args: any[]) => void } }

export const log: {
  info: (...args: any[]) => void
  success: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
  debug: (...args: any[]) => void
  log: (...args: any[]) => void
  start: (...args: any[]) => void
  box: (...args: any[]) => void
} = consolaMod.consola
