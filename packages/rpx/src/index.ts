import { startProxies as startProxiesFunc } from './start'

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

export { cleanup } from './start'

export { startProxies, startProxy, startServer } from './start'

export * from './types'

export * from './utils'

export default startProxiesFunc
