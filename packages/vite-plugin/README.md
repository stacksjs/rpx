<p align="center"><img src="https://github.com/stacksjs/rpx/blob/main/.github/art/cover.jpg?raw=true" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# Simplified Vite Plugin for Pretty URLs and HTTPS

This plugin provides a simplified approach to adding pretty URLs and HTTPS support to your Vite applications without the complexity of a full reverse proxy setup.

## Features

- **Pretty URLs**: Automatically serve `/about` as `/about.html` or `/about/index.html`
- **HTTPS Support**: Generate and use self-signed certificates
- **Custom Domain**: Add entries to `/etc/hosts` for local domains
- **No WebSocket Issues**: Works without the WebSocket port allocation loops that can happen with reverse proxies

## Installation

```bash
npm install vite-plugin-pretty-urls-https
# or
yarn add vite-plugin-pretty-urls-https
# or
bun add vite-plugin-pretty-urls-https
```

## Usage

### In your vite.config.js:

```js
import { defineConfig } from 'vite'
import { SimplifiedVitePlugin } from 'vite-plugin-pretty-urls-https'

export default defineConfig({
  plugins: [
    SimplifiedVitePlugin({
      // Enable/disable the plugin (default: true)
      enabled: true,

      // Custom domain (default: 'localhost')
      domain: 'myapp.localhost',

      // Enable HTTPS (default: false)
      https: true,

      // Enable clean URLs (default: false)
      cleanUrls: true,

      // Base SSL certificate directory (default: '~/.stacksjs/ssl')
      sslDir: '~/.stacksjs/ssl',

      // Enable verbose logging (default: false)
      verbose: true
    })
  ]
})
```

## Migrating from rpx

If you're currently using rpx and facing WebSocket port allocation issues, here's how to migrate to this simplified plugin:

### 1. Before (rpx)

```js
import { VitePluginRpx } from '@stacksjs/vite-plugin-rpx'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    VitePluginRpx({
      domain: 'myapp.localhost',
      https: true,
      cleanUrls: true
    })
  ]
})
```

### 2. After (simplified plugin)

```js
import { defineConfig } from 'vite'
import { SimplifiedVitePlugin } from 'vite-plugin-pretty-urls-https'

export default defineConfig({
  plugins: [
    SimplifiedVitePlugin({
      domain: 'myapp.localhost',
      https: true,
      cleanUrls: true
    })
  ]
})
```

Key differences:
- No WebSocket port allocation issues
- No separate proxy server running
- More streamlined approach
- Still retains pretty URLs and HTTPS functionality

## Difference from the complex proxy version

This plugin directly modifies Vite's server configuration rather than creating a separate proxy server:

1. **HTTPS**: Adds HTTPS directly to Vite's dev server
2. **Pretty URLs**: Uses middleware to rewrite URLs on the fly
3. **No WebSocket Issues**: Avoids the WebSocket port allocation problems that occur with proxies

## How it works

Unlike the full rpx package which creates a reverse proxy, this plugin:

1. **Pretty URLs**: Uses Vite middleware to try different URL patterns when a file isn't found
2. **HTTPS**: Configures Vite's built-in HTTPS server with certificates
3. **Custom Domain**: Adds entries to your hosts file (with permission)

This approach is much simpler and avoids the complex port allocation logic that can lead to WebSocket issues.

## Troubleshooting

### Certificate Issues

If your browser doesn't trust the certificates:

1. Navigate to `https://yourapp.localhost`
2. Accept the security warning
3. The certificate should be stored in your system keychain

If you need to regenerate certificates, delete the files from the SSL directory (default: `~/.stacksjs/ssl`).

### Hosts File

The plugin attempts to add entries to your `/etc/hosts` file but may require sudo. If you see permission errors, manually add:

```
127.0.0.1 yourapp.localhost
::1 yourapp.localhost
```

## License

MIT
