export const log: {
  info: (...args: any[]) => void
  success: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
  debug: (...args: any[]) => void
  log: (...args: any[]) => void
  start: (...args: any[]) => void
  box: (...args: any[]) => void
} = {
  info: (...args: any[]) => console.log('[info]', ...args),
  success: (...args: any[]) => console.log('[success]', ...args),
  warn: (...args: any[]) => console.warn('[warn]', ...args),
  error: (...args: any[]) => console.error('[error]', ...args),
  debug: (...args: any[]) => console.debug('[debug]', ...args),
  log: (...args: any[]) => console.log(...args),
  start: (...args: any[]) => console.log('[start]', ...args),
  box: (...args: any[]) => console.log('[box]', ...args),
}
