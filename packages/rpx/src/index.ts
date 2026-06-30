import { startProxies as startProxiesFunc } from './start'

export { colors } from './colors'

export { config, config as defaultConfig } from './config'

export {
  addHosts,
  checkHosts,
  removeHosts,
} from './hosts'

export {
  SHARED_DEV_HOST_CERT_PATH,
  buildRegistryTlsProxyOptions,
  checkExistingCertificates,
  cleanupCertificates,
  clearSslConfigCache,
  devSslToSniEntries,
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

export { createProxyFetchHandler, createProxyWebSocketHandler, stripBasePath } from './proxy-handler'
export type { GetRoute, NoRouteOutcome, OnNoRoute, ProxyFetchHandler, ProxyRoute, ProxyServer } from './proxy-handler'
export { buildRedirectLocation, resolveRedirect } from './redirect'
export type { RedirectRouteConfig, ResolvedRedirect } from './redirect'
export { ACME_CHALLENGE_PREFIX, readAcmeChallenge } from './acme-challenge'

export { isWildcardPattern, matchesWildcard, matchHost } from './host-match'

export { createOriginGuard } from './origin-guard'
export type { OriginGuard, OriginGuardOptions } from './origin-guard'

export { enforceBasicAuth, parseHtpasswd, resolveAuth } from './auth'
export type { ResolvedAuth } from './auth'

export {
  buildHostRoutes,
  matchHostList,
  matchHostRoute,
  normalizePathPrefix,
  pathPrefixMatches,
} from './host-routes'
export type { HostRoutes, PathRoute } from './host-routes'

export {
  contentTypeFor,
  resolveStaticFile,
  resolveStaticRoute,
  safeRelativePath,
  serveStaticFile,
} from './static-files'
export type { ResolvedStaticRoute, StaticResolution } from './static-files'

export { buildSniTlsConfig, serverNameFromCertFilename } from './sni'
export type { SniTlsEntry } from './sni'

export { isLikelyHostname, matchesAllowedSuffix, OnDemandCertManager } from './on-demand'
export type { CertIssuer, OnDemandCertManagerOptions } from './on-demand'

export {
  createSiteResolver,
  detectProjectPreset,
  expandHome,
  listDiscoverableSites,
  projectNameFromHost,
  readSiteManifest,
  siteIdForHost,
} from './site-resolver'
export type {
  ResolvedSite,
  ResolverProbes,
  SiteDetector,
  SiteManifest,
  SitePreset,
  SiteResolver,
  SiteResolverDeps,
} from './site-resolver'

export { SiteSupervisor } from './site-supervisor'
export type {
  SiteLauncher,
  SiteProcessHandle,
  SiteRequestStatus,
  SiteSnapshot,
  SiteSupervisorOptions,
} from './site-supervisor'

export { escapeHtml, renderFailedPage, renderStartingPage } from './site-splash'

export { deriveIdFromTarget, runViaDaemon } from './daemon-runner'
export type { DaemonRunnerOptions, DaemonRunnerProxy } from './daemon-runner'

export { cleanup } from './start'

export { startProxies, startProxy, startServer } from './start'

export * from './types'

export * from './utils'

export default startProxiesFunc
