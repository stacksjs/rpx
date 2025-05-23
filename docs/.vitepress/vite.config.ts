import { resolve } from 'node:path'
// import Inspect from 'vite-plugin-inspect'
import UnoCSS from 'unocss/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import { SimplifiedVitePlugin } from 'vite-plugin-rpx'

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
    // Let Vite handle HMR natively
    // This avoids infinite WebSocket port allocation loops
  },

  plugins: [
    // custom
    // MarkdownTransform(),
    // Contributors(contributions),

    // plugins
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

    // SimplifiedVitePlugin({
    //   domain: 'docs.stacks.localhost', // pretty test URL
    //   https: true,
    //   cleanUrls: true,
    //   verbose: true,
    //   // Force trust the certificate in the system keychain and regenerate if needed
    //   trustCertificate: true,
    //   regenerateUntrustedCerts: true,
    //   sslDir: '~/.stacks/ssl', // Use the correct SSL directory
    // }),

    // Inspect(),
  ],

  optimizeDeps: {
    exclude: [
      // 'vue',
      'body-scroll-lock',
    ],
  },
})
