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
  clearSslConfigCache,
  forceTrustCertificate,
  generateCertificate,
  getRootCAPaths,
  getSharedDaemonCertPaths,
  httpsConfig,
  isCertTrusted,
  loadSSLConfig,
} from './https'

export {
  MACOS_CA_TRUST_FLAGS,
  MACOS_SYSTEM_KEYCHAIN,
  RPX_ROOT_CA_COMMON_NAME,
  getMacosLoginKeychainPath,
  getMacosTrustKeychains,
  isRootCaFingerprintInKeychains,
  isRootCaTrustedForSsl,
  listCertSha256HashesByCommonName,
  pruneStaleRootCas,
  trustRootCaForBrowsers,
} from './macos-trust'

export {
  certIncludesSanHostnames,
  normalizeSha256Fingerprint,
  parseSha256HashesFromSecurityListing,
  readCertCommonName,
  readCertSha256Fingerprint,
  verifyHttpsChain,
} from './cert-inspect'

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
  DNS_PORT,
  RPX_RESOLVER_MARKER,
  contentLooksLikeRpxResolver,
  isDnsServerRunning,
  reconcileStaleDevelopmentDns,
  removeLegacyTldResolvers,
  removeResolver,
  resolverFilePath,
  setupDevelopmentDns,
  setupResolver,
  startDnsServer,
  stopDnsServer,
  syncDevelopmentDnsFromRegistry,
  tearDownDevelopmentDns,
} from './dns'

export type { DevelopmentDnsOptions } from './dns'

export {
  DNS_STATE_VERSION,
  LEGACY_TLD_RESOLVER_LABELS,
  devDomainsFromHosts,
  normalizeDevDomain,
  resolverBasenameForDomain,
  resolverBasenamesForDomains,
} from './dns-state'

export {
  acquireDaemonLock,
  defaultDaemonSpawnCommand,
  ensureDaemonRunning,
  getDaemonPidPath,
  getDaemonRpxDir,
  isDaemonRunning,
  readDaemonPid,
  reconcileDevelopmentDnsOnIdle,
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
