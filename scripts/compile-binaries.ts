/**
 * Compile the standalone `rpx` binaries the GitHub release advertises.
 *
 * `release.yml` has listed five zips since the workflow was written, but
 * nothing ever produced them: `action-releaser` silently skips files that do
 * not exist, so every release published an empty downloads section and no job
 * ever failed. A Raspberry Pi told to "grab the arm64 binary" found a release
 * page with none. tlsx fixed the identical bug the same way.
 *
 * Output names match the package-level `compile:*` / `zip:*` scripts in
 * `packages/rpx/package.json` exactly, so either path yields the files the
 * workflow uploads.
 *
 * Usage: `bun scripts/compile-binaries.ts [target ...]` where a target is one
 * of `linux-x64`, `linux-arm64`, `windows-x64`, `darwin-x64`, `darwin-arm64`.
 * With no arguments every target is built.
 */
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const TARGETS = [
  { id: 'linux-x64', bun: 'bun-linux-x64', name: 'rpx-linux-x64' },
  { id: 'linux-arm64', bun: 'bun-linux-arm64', name: 'rpx-linux-arm64' },
  { id: 'windows-x64', bun: 'bun-windows-x64', name: 'rpx-windows-x64', ext: '.exe' },
  { id: 'darwin-x64', bun: 'bun-darwin-x64', name: 'rpx-darwin-x64' },
  { id: 'darwin-arm64', bun: 'bun-darwin-arm64', name: 'rpx-darwin-arm64' },
] as const

const requested = process.argv.slice(2)
const unknown = requested.filter(id => !TARGETS.some(t => t.id === id))
if (unknown.length > 0) {
  console.error(`unknown target(s): ${unknown.join(', ')} (expected: ${TARGETS.map(t => t.id).join(', ')})`)
  process.exit(2)
}
const targets = requested.length > 0 ? TARGETS.filter(t => requested.includes(t.id)) : TARGETS

const outDir = path.resolve('packages/rpx/bin')
mkdirSync(outDir, { recursive: true })

let failed = 0
for (const target of targets) {
  const binary = path.join(outDir, `${target.name}${'ext' in target ? target.ext : ''}`)
  const zip = path.join(outDir, `${target.name}.zip`)

  const compile = Bun.spawnSync([
    'bun',
    'build',
    'packages/rpx/bin/cli.ts',
    '--compile',
    '--minify',
    `--target=${target.bun}`,
    '--outfile',
    binary,
  ], { stdout: 'inherit', stderr: 'inherit' })

  if (compile.exitCode !== 0) {
    console.error(`FAIL ${target.name}: compile failed`)
    failed++
    continue
  }

  // `-j` drops the directory components so the archive holds a bare executable
  // rather than packages/rpx/bin/... paths.
  rmSync(zip, { force: true })
  const archive = Bun.spawnSync(['zip', '-j', '-q', zip, binary], { stdout: 'inherit', stderr: 'inherit' })
  if (archive.exitCode !== 0) {
    console.error(`FAIL ${target.name}: zip failed`)
    failed++
    continue
  }

  console.log(`ok ${path.basename(zip)}`)
}

if (failed > 0) {
  console.error(`${failed} target(s) failed`)
  process.exit(1)
}
