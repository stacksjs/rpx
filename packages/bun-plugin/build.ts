import { dts } from 'bun-plugin-dtsx'

console.log('Building bun-plugin...')

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'bun',
  plugins: [dts()],
})

console.log('Built bun-plugin')
