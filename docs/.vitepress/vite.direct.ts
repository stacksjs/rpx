import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import UnoCSS from 'unocss/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'

// Path to the mkcert-generated certificates
const sslDir = resolve(homedir(), '.stacks', 'ssl')
const certPath = resolve(sslDir, 'docs.stacks.localhost.crt')
const keyPath = resolve(sslDir, 'docs.stacks.localhost.key')

export default defineConfig({
  build: {
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },

  resolve: {
    dedupe: [
      'vue',
      '@vue/runtime-core',
    ],
  },

  server: {
    // Configure HTTPS with our trusted certificates
    https: {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    host: 'docs.stacks.localhost',
    strictPort: true,
  },

  plugins: [
    // Custom components
    Components({
      dirs: resolve(__dirname, 'theme/components'),
      include: [/\.vue$/, /\.vue\?vue/, /\.md$/],
      resolvers: [
        IconsResolver({
          componentPrefix: '',
        }),
      ],
      dts: resolve(__dirname, 'components.d.ts'),
      transformer: 'vue3',
    }),

    Icons({
      compiler: 'vue3',
      defaultStyle: 'display: inline-block',
    }),

    UnoCSS(resolve(__dirname, 'unocss.config.ts')),
  ],

  optimizeDeps: {
    exclude: [
      'body-scroll-lock',
    ],
  },
})
