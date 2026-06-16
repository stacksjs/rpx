export const log: {
  info: (...args: unknown[]) => void
  success: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
  start: (...args: unknown[]) => void
  box: (...args: unknown[]) => void
} = {
  info: (...args: unknown[]) => console.log('[info]', ...args),
  success: (...args: unknown[]) => console.log('[success]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
  debug: (...args: unknown[]) => console.debug('[debug]', ...args),
  log: (...args: unknown[]) => console.log(...args),
  start: (...args: unknown[]) => console.log('[start]', ...args),
  box: (...args: unknown[]) => console.log('[box]', ...args),
}
