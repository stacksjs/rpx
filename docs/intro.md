<p align="center"><img src="https://github.com/stacksjs/rpx/blob/main/.github/art/cover.jpg?raw=true" alt="Social Card of this repo"></p>

# A Better Developer Experience

> A zero-config reverse proxy for local development with SSL support, custom domains, and more.

## Features

- Simple, lightweight Reverse Proxy
- Custom Domains _(with wildcard support)_
- Zero-Config Setup
- SSL Support _(HTTPS by default)_
- Auto HTTP-to-HTTPS Redirection
- Self `/etc/hosts` Management
- Bun Plugin for seamless integration

## Usage Options

### CLI

```bash
# Simple usage
rpx --from localhost:3000 --to my-app.test

# With HTTPS (enabled by default)
rpx --from localhost:5173 --to my-app.test --https
```

### Library

```typescript
import { startProxy } from '@stacksjs/rpx'

startProxy({
  from: 'localhost:3000',
  to: 'my-app.test',
  https: true
})
```

### Bun Plugin

```typescript
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'my-app.test', // Optional, uses package.json name if not specified
      https: true // Optional, default is true
    })
  ]
}
```

## Changelog

Please see our [releases](https://github.com/stacksjs/stacks/releases) page for more information on what has changed recently.

## Stargazers

[![Stargazers](https://starchart.cc/stacksjs/rpx.svg?variant=adaptive)](https://starchart.cc/stacksjs/rpx)

## Contributing

Please review the [Contributing Guide](https://github.com/stacksjs/contributing) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/stacks/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

Two things are true: Stacks OSS will always stay open-source, and we do love to receive postcards from wherever Stacks is used! 🌍 _We also publish them on our website. And thank you, Spatie_

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## Credits

- [Chris Breuer](https://github.com/chrisbbreuer)
- [All Contributors](https://github.com/stacksjs/rpx/graphs/contributors)

## License

The MIT License (MIT). Please see [LICENSE](https://github.com/stacksjs/stacks/tree/main/LICENSE.md) for more information.

Made with 💙

<!-- Badges -->

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/rpx/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/rpx -->
