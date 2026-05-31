/**
 * Build a Bun.serve TLS array for per-domain SNI from real PEM files on disk.
 *
 * Production deployments (Let's Encrypt) have one cert+key per domain. Bun's
 * `Bun.serve({ tls: [{ serverName, cert, key }, ...] })` selects the right cert
 * by SNI server name at handshake time, so a single listener can front many
 * domains with their own real certs.
 */
import type { DomainCert, ProductionTlsConfig } from './types'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { debugLog } from './utils'

/** One entry of the Bun.serve `tls` array. */
export interface SniTlsEntry {
  serverName: string
  cert: string
  key: string
}

/**
 * Map a PEM filename under a `certsDir` to its SNI server name. Returns `null`
 * for files that aren't `<name>.crt`. The wildcard convention
 * `_wildcard.<apex>.crt` maps to server name `*.<apex>`.
 */
export function serverNameFromCertFilename(filename: string): string | null {
  if (!filename.endsWith('.crt'))
    return null
  const base = filename.slice(0, -'.crt'.length)
  if (base.length === 0)
    return null
  if (base.startsWith('_wildcard.'))
    return `*.${base.slice('_wildcard.'.length)}`
  return base
}

async function readPair(serverName: string, certPath: string, keyPath: string, verbose?: boolean): Promise<SniTlsEntry | null> {
  try {
    const [cert, key] = await Promise.all([
      fsp.readFile(certPath, 'utf8'),
      fsp.readFile(keyPath, 'utf8'),
    ])
    return { serverName, cert, key }
  }
  catch (err) {
    debugLog('sni', `skipping ${serverName}: ${(err as Error).message}`, verbose)
    return null
  }
}

/**
 * Build the SNI TLS array from a {@link ProductionTlsConfig}. Reads PEM files
 * from an explicit `domains` map and/or a `certsDir` convention. Files that
 * can't be read are skipped (logged in verbose mode). Returns `[]` when nothing
 * usable is found so the caller can fall back to the dev cert flow.
 */
export async function buildSniTlsConfig(cfg: ProductionTlsConfig, verbose?: boolean): Promise<SniTlsEntry[]> {
  const bySrvName = new Map<string, DomainCert>()

  if (cfg.certsDir) {
    let names: string[] = []
    try {
      names = await fsp.readdir(cfg.certsDir)
    }
    catch (err) {
      debugLog('sni', `certsDir read failed (${cfg.certsDir}): ${(err as Error).message}`, verbose)
    }
    for (const name of names) {
      const serverName = serverNameFromCertFilename(name)
      if (!serverName)
        continue
      const base = name.slice(0, -'.crt'.length)
      bySrvName.set(serverName, {
        certPath: path.join(cfg.certsDir, name),
        keyPath: path.join(cfg.certsDir, `${base}.key`),
      })
    }
  }

  // Explicit `domains` entries take precedence over `certsDir` discoveries.
  if (cfg.domains) {
    for (const [serverName, pair] of Object.entries(cfg.domains))
      bySrvName.set(serverName, pair)
  }

  const entries: SniTlsEntry[] = []
  for (const [serverName, pair] of bySrvName) {
    const entry = await readPair(serverName, pair.certPath, pair.keyPath, verbose)
    if (entry)
      entries.push(entry)
  }
  return entries
}
