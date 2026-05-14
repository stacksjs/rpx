import { dts } from 'bun-plugin-dtsx'
import { chmod, readFile, writeFile } from 'node:fs/promises'

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

const cliPath = './dist/bin/cli.js'
const cli = await readFile(cliPath, 'utf8')
if (!cli.startsWith('#!')) {
  await writeFile(cliPath, `#!/usr/bin/env bun\n${cli}`)
}
await chmod(cliPath, 0o755)

console.log('Built')
