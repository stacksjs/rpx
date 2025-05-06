# Bun Plugin

The `bun-plugin-rpx` provides seamless integration with Bun's development server, giving you pretty local domains for your Bun projects without manual configuration.

## Installation

```bash
# Using bun
bun install --dev bun-plugin-rpx

# Using npm
npm install --save-dev bun-plugin-rpx

# Using pnpm
pnpm add --save-dev bun-plugin-rpx

# Using yarn
yarn add --dev bun-plugin-rpx
```

## Usage

Add the plugin to your Bun project configuration:

```ts
// bunfig.toml or in your server setup
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin({
      domain: 'my-awesome-app.test', // Optional - uses project name from package.json if not specified
      https: true, // Optional - defaults to true
      verbose: false // Optional - for debugging
    })
  ]
}
```

## How It Works

The plugin works by:

1. Intercepting Bun's server startup to determine the port
2. Using the `rpx` CLI tool to set up the domain mapping
3. Automatically mapping the port to your custom domain
4. Setting up HTTPS certificates if enabled
5. Managing hosts file entries
6. Cleaning up when the server stops or the process exits

## Benefits

- **Zero-config Setup**: Just add the plugin and get a pretty domain
- **Automatic Domain Generation**: Uses your package.json name if no domain is specified
- **HTTPS Support**: Enables secure local development by default
- **Proper Cleanup**: Automatically removes hosts entries and cleans up when server stops

## Configuration Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `domain` | `string` | `$projectName.localhost` | The custom domain to use |
| `https` | `boolean` | `true` | Whether to enable HTTPS |
| `verbose` | `boolean` | `false` | Enable debug logging |

## Example

For a project named "my-awesome-app" in package.json:

```ts
import rpxPlugin from 'bun-plugin-rpx'

export default {
  plugins: [
    rpxPlugin() // Will use my-awesome-app.localhost automatically
  ]
}
```

Now when you run your Bun development server, instead of accessing it at `localhost:3000` (or whatever port), you'll be able to access it at `my-awesome-app.localhost`.
