import { dts } from 'bun-plugin-dtsx'
import { chmod, readFile } from 'node:fs/promises'

console.log('Building...')

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  splitting: true,
  plugins: [dts()],
})

await Bun.build({
  entrypoints: ['./bin/cli.ts'],
  outdir: './dist/bin',
  format: 'esm',
  target: 'node',
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: '#!/usr/bin/env bun',
})

const cliOutput = await readFile('./dist/bin/cli.js', 'utf8')
const shebangs = cliOutput.match(/^#!.*$/gm) ?? []
if (!cliOutput.startsWith('#!/usr/bin/env bun\n') || shebangs.length !== 1)
  throw new Error(`Built rpx CLI must contain exactly one first-line Bun shebang; found ${shebangs.length}.`)

await chmod('./dist/bin/cli.js', 0o755)

console.log('Built')
