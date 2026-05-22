import { dts } from 'bun-plugin-dtsx'
import { chmod } from 'node:fs/promises'

console.log('Building...')

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  minify: true,
  splitting: true,
  plugins: [dts()],
})

await Bun.build({
  entrypoints: ['./bin/cli.ts'],
  outdir: './dist/bin',
  format: 'esm',
  target: 'node',
  minify: true,
  banner: '#!/usr/bin/env bun',
})

await chmod('./dist/bin/cli.js', 0o755)

console.log('Built')
