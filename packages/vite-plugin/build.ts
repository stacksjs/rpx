import { dts } from 'bun-plugin-dtsx'

console.log('Building vite-plugin...')

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  plugins: [dts()],
})

console.log('Built vite-plugin')
