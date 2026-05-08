import { startProxies as startProxiesFunc } from './start'

export { colors } from './colors'

export { config, config as defaultConfig } from './config'

export {
  addHosts,
  checkHosts,
  removeHosts,
} from './hosts'

export {
  checkExistingCertificates,
  cleanupCertificates,
  forceTrustCertificate,
  generateCertificate,
  httpsConfig,
  isCertTrusted,
  loadSSLConfig,
} from './https'

export { DefaultPortManager, findAvailablePort, isPortInUse, portManager } from './port-manager'

export {
  gcStaleEntries,
  getRegistryDir,
  isPidAlive,
  isValidId,
  readAll,
  readEntry,
  removeEntry,
  watchRegistry,
  writeEntry,
} from './registry'

export type { RegistryEntry, WatchHandle, WatchOptions } from './registry'

export {
  acquireDaemonLock,
  defaultDaemonSpawnCommand,
  ensureDaemonRunning,
  getDaemonPidPath,
  getDaemonRpxDir,
  isDaemonRunning,
  readDaemonPid,
  releaseDaemonLock,
  runDaemon,
  stopDaemon,
} from './daemon'

export type {
  DaemonHandle,
  DaemonOptions,
  EnsureDaemonOptions,
  EnsureDaemonResult,
  StopDaemonOptions,
  StopDaemonResult,
} from './daemon'

export { createProxyFetchHandler } from './proxy-handler'
export type { GetRoute, ProxyFetchHandler, ProxyRoute } from './proxy-handler'

export { deriveIdFromTarget, runViaDaemon } from './daemon-runner'
export type { DaemonRunnerOptions, DaemonRunnerProxy } from './daemon-runner'

export { cleanup } from './start'

export { startProxies, startProxy, startServer } from './start'

export * from './types'

export * from './utils'

export default startProxiesFunc
