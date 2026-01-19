import type { BunPressConfig } from 'bunpress'

export default {
  title: 'rpx',
  description: 'A modern and smart reverse proxy',
  lang: 'en-US',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#5c6bc0' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'rpx - A Modern Reverse Proxy' }],
    ['meta', { property: 'og:description', content: 'A modern and smart reverse proxy for local development with SSL support, custom domains, and more' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'rpx Documentation' }],
    ['meta', { name: 'twitter:description', content: 'A modern and smart reverse proxy' }],
    ['meta', { name: 'keywords', content: 'reverse proxy, ssl, development, proxy' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'rpx',

    nav: [
      { text: 'Guide', link: '/intro' },
      { text: 'Features', link: '/features/reverse-proxy' },
      { text: 'Advanced', link: '/advanced/configuration' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/stacksjs/rpx' },
          { text: 'Changelog', link: 'https://github.com/stacksjs/rpx/releases' },
          { text: 'Contributing', link: 'https://github.com/stacksjs/contributing' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/intro' },
          { text: 'Installation', link: '/install' },
          { text: 'Usage', link: '/usage' },
          { text: 'Configuration', link: '/config' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Reverse Proxy', link: '/features/reverse-proxy' },
          { text: 'SSL Termination', link: '/features/ssl-termination' },
          { text: 'Load Balancing', link: '/features/load-balancing' },
          { text: 'Request Routing', link: '/features/request-routing' },
        ],
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Configuration', link: '/advanced/configuration' },
          { text: 'Custom Middleware', link: '/advanced/custom-middleware' },
          { text: 'Performance', link: '/advanced/performance' },
          { text: 'CI/CD Integration', link: '/advanced/ci-cd-integration' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/stacksjs/rpx' },
      { icon: 'discord', link: 'https://discord.gg/stacksjs' },
    ],

    editLink: {
      pattern: 'https://github.com/stacksjs/rpx/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2024-present Stacks.js Contributors',
    },

    search: {
      provider: 'local',
    },
  },
} satisfies BunPressConfig
