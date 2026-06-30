# On-Demand Sites

Stop running dev servers by hand. With on-demand sites, rpx boots a project's dev server the **first time you open its URL** in the browser, proxies to it, and stops it again once it's been idle for a while — Valet/puma-dev style, but for any framework.

Visit `myapp.localhost` and rpx finds `~/Code/myapp`, runs its dev command (frontend, API and docs), shows a "starting…" page that reloads itself, and switches to the live app the moment it's ready. You never run `bun run dev` again.

## Quick start

Start the daemon once in on-demand mode:

```sh
rpx daemon:start --on-demand
```

Then just open a project's URL:

```
https://myapp.localhost
```

That's it. The first hit boots `~/Code/myapp`, later hits proxy straight through, and the dev server is stopped after it goes idle. Run several apps the same way — each boots independently the first time you visit it.

List everything rpx can boot (and what's currently live):

```sh
rpx sites
```

```
on-demand sites (3) — scanned ~/Code:
  ● https://dashboard.localhost  (live)
      ./buddy dev  /Users/you/Code/dashboard
  ○ https://shop.localhost  (idle)
      ./buddy dev  /Users/you/Code/shop
  ○ https://blog.localhost  (idle)
      bun run dev  /Users/you/Code/blog
```

## How a host resolves to a project

Two ways, checked in this order:

1. **Explicit sites** — anything you list under `onDemand.sites` (exact host first, then the most-specific `*.suffix` wildcard).
2. **Convention discovery** — `<name>.<tld>` maps to `<root>/<name>` for each configured root (default `~/Code`) and dev TLD (default `localhost`, `test`), when that directory exists and looks like a dev project.

So with the defaults, `shop.localhost` maps to `~/Code/shop`. Only single-label hosts auto-discover; point nested subdomains (`docs.shop.localhost`) at an explicit site.

### Project detection

A discovered directory's dev command and backend layout come from a preset, in priority order:

- **Manual (`rpx.site.json`)** — a per-project manifest wins over everything (see below). Define the command, env, and backends yourself.
- **Stacks** — a `./buddy` launcher or a `@stacksjs/*` dependency. Boots the frontend at `/`, the API at `/api`, and docs at `/docs` using the conventional `PORT` / `PORT_API` / `PORT_DOCS` env, deferring proxy and TLS to rpx (`STACKS_PROXY_MANAGED=1`) and taking its public origin via `APP_URL`.
- **Generic** — any `package.json` with a `dev` script: a single `bun run dev` backend on `PORT`.
- **Otherwise** — the directory doesn't resolve (it's not a dev project).

### Defining the startup manually (`rpx.site.json`)

Drop a `rpx.site.json` in a project (or add a `"rpx"` key to its `package.json`) to define exactly how rpx boots it — overriding auto-detection, and making even a directory that isn't otherwise a recognized project bootable:

```jsonc
// <project>/rpx.site.json
{
  "command": "pnpm dev",
  "env": { "NODE_ENV": "development" },
  "routes": [
    { "path": "/", "portEnv": "PORT", "defaultPort": 5173, "readyGate": true },
    { "path": "/api", "portEnv": "API_PORT", "defaultPort": 4000 }
  ]
}
```

rpx injects a free port per `portEnv`, runs `command`, and routes each `path` to its port — same as an explicit `sites` entry, but it lives with the project. Omit `routes` for a single `/` backend, or set `"selfRegisters": true` for a command that writes its own rpx registry entries.

## Configuration

Configure on-demand sites in `rpx.config.ts` under `onDemand`. The `--on-demand` flag turns it on; the config supplies the details.

```ts
import type { OnDemandSitesConfig } from '@stacksjs/rpx'

const onDemand: OnDemandSitesConfig = {
  enabled: true,
  // Where to look for <name>.localhost projects (default: ['~/Code']).
  roots: ['~/Code', '~/work'],
  // Dev TLDs stripped to derive <name> (default: ['localhost', 'test']).
  tlds: ['localhost', 'test'],
  // Stop a site after this long with no traffic (default: 30 min).
  idleTimeoutMs: 1_800_000,
  // Give up (and show the failure page) if a site doesn't answer in time.
  startupTimeoutMs: 120_000,

  // Explicit sites — for projects outside the roots, custom commands, or wildcards.
  sites: [
    {
      to: 'api.localhost',
      dir: '~/services/api',
      command: 'bun run start',
      // Ports rpx injects + routes. Omit `routes` and set `selfRegisters: true`
      // for a command that writes its own rpx registry entries.
      routes: [{ path: '/', portEnv: 'PORT', defaultPort: 4000 }],
      idleTimeoutMs: 600_000,
    },
    {
      // Wildcard: boots one dir for any <x>.preview.localhost.
      to: '*.preview.localhost',
      dir: '~/previews',
      command: 'bun run dev',
      routes: [{ path: '/', portEnv: 'PORT' }],
    },
  ],
}

export default { onDemand }
```

Override the scan roots from the CLI without a config file:

```sh
rpx daemon:start --on-demand --roots ~/Code,~/work
```

### Per-site backends (`routes`)

Each entry in a site's `routes` is one backend mapped to a request path:

- `path` — path prefix under the host (e.g. `/api`); omit for the `/` default.
- `portEnv` — env var rpx sets to the chosen port (e.g. `PORT`, `PORT_API`).
- `defaultPort` — port to try first before searching for a free one.
- `stripPrefix` — strip `path` before forwarding (default `false`).
- `readyGate` — gate "ready" on this port answering (default `true` for `/`, off otherwise).

rpx picks a free port per `portEnv`, exports it into the command's env, and publishes the routes once every `readyGate` backend answers — so a slow docs build never holds the frontend behind the splash.

## Stacks: on by default

In a Stacks project, on-demand sites are **on by default** — the shared rpx daemon that `./buddy dev` starts lazily boots a sibling app's dev server the first time you open its `<name>.localhost` URL, so you never start them by hand. The default scan root is the directory your app lives in (its siblings).

- `STACKS_RPX_SITE_ROOTS=~/Code/Apps,~/work` — override the scan roots (comma-separated).
- `STACKS_RPX_ON_DEMAND=0` — turn it off entirely.

## Watching a site

```sh
rpx sites               # what's bootable + what's currently live
rpx logs myapp.localhost   # the site's boot log (also shown on the splash)
```

## How it works

When a request finds no live route, the daemon's no-route fallback kicks in:

1. Resolve the host to a project; on the first hit, pick a free port per backend and spawn the dev command in its own process group (output to `~/.stacks/rpx/sites/<host>.log`).
2. Return a `503` "starting…" page that auto-refreshes (a plain `<meta http-equiv="refresh">`, no client JS).
3. A background loop probes the ready-gate ports until they answer (or the startup deadline fails the site with a `502` showing the log tail).
4. On ready, write the registry entry (host to the frontend port, with `pathRewrites` for the other backends); the auto-refresh then lands on the live app.
5. An idle reaper stops the process group and removes the route once `idleTimeoutMs` elapses with no traffic.

A browser refresh is all it takes to retry a site that failed to start.

### Notes

- **HTTP-aware readiness.** The ready gate probes with an HTTP request (any response counts), not a bare TCP connect — so a dev server that holds the socket open while it compiles isn't proxied to until it actually answers.
- **Trusted HTTPS from the first hit.** A booting host is added to the dev cert's SAN with an explicit name before its splash is served, so even the "starting…" page loads without a certificate warning (browsers reject the `*.localhost` wildcard).
- **Self-healing.** If a live site's process crashes, its route is dropped and the next visit reboots it. A failed boot shows a `502` with the log tail; refresh to retry.
- **Privilege drop.** When the daemon self-elevated to bind `:443`, dev servers are spawned as the invoking user (`SUDO_UID` / `SUDO_GID`) so their files aren't created root-owned.
- **Single-process only.** On-demand sites are ignored in cluster mode (`--workers > 1`); it's a development feature.
- **Opt-in for raw rpx.** Without `--on-demand` the standalone daemon behaves exactly as before (it's on by default only in Stacks projects).
