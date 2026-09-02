# LAN Gateway

This page walks through one setup end to end: a small Linux box on a home or
office network, a Raspberry Pi in the case this was built for, serving HTTPS
for a name and an IP address that no public certificate authority will ever
certify.

## Why a local authority is the only option

A public authority issues a certificate only after it proves you control the
name. An ACME http-01 challenge is fetched over the internet; a dns-01
challenge is read out of public DNS. Neither one reaches `pi-stacks.local` or
`192.168.1.20`, because nothing on the internet routes to a private network.
There is no certificate to buy for these names. Serving them over HTTPS means
running an authority the machines on that network trust, which is what
[`localCa`](/config#localca) does.

## 1. Start a gateway with a local CA

```bash
rpx gateway \
  --sites-dir /etc/rpx/sites.d \
  --local-ca-dir /etc/rpx/local-ca \
  --local-ca-hosts pi-stacks.local \
  --local-ca-ips 192.168.1.20 \
  --install-trust
```

On the first run this creates the Root CA and one leaf under
`/etc/rpx/local-ca`:

| File | What it is |
| --- | --- |
| `rpx-root-ca.crt` | The Root CA certificate, the file every client has to trust. |
| `rpx-root-ca.key` | The CA private key, mode `0600`. It never leaves the box. |
| `rpx-local-host.crt` | The leaf covering `pi-stacks.local` and `192.168.1.20`. |
| `rpx-local-host.key` | The leaf private key, mode `0600`. |

The leaf carries `pi-stacks.local` as a dNSName SAN and `192.168.1.20` as an
iPAddress SAN. It is served under the host's SNI name and as the listener's
default TLS context, so both `<https://pi-stacks.local/>` and
`<https://192.168.1.20/>` are answered with it. The IP case needs the default
context: a browser given an IP literal sends no SNI at all.

`--install-trust` installs the CA into this box's own trust store, so `curl`
and anything else running locally accepts the certificate. It needs root. A
trust store that cannot be written is a warning, not a startup failure.

## 2. Give the gateway something to route

A gateway with no fragments answers 404 to everything. Each app owns one file
under the sites directory, named for its slug:

```json
// /etc/rpx/sites.d/dashboard.json
{
  "slug": "dashboard",
  "proxies": [
    { "from": "localhost:3000", "to": "pi-stacks.local" }
  ]
}
```

Deploys replace their own file and nothing else. Fragments are merged in
filename order, duplicate routes are resolved first writer wins, and a
fragment that fails to parse is logged and skipped so one bad file cannot take
the other apps down. The full rules are in
[gateway mode](/config#merge-rules).

The gateway never touches `/etc/hosts`. On a box with real DNS, or with the
name published over mDNS, that file is not the routing table and rpx leaves it
alone.

## 3. Trust the CA on the other devices

Every laptop and phone that opens the site has to trust
`/etc/rpx/local-ca/rpx-root-ca.crt`, and each platform wants it in a different
container. rpx produces the CA; [tlsx](https://github.com/stacksjs/tlsx) is
what mints and trusts it, and its `export-ca` and `trust-instructions`
commands cover exporting the file and the per-platform steps, including the
extra step iOS needs after installing a profile.

## 4. Run it under systemd

The `rpx` CLI entry point currently hangs at startup on Linux
([stacksjs/rpx#2267](https://github.com/stacksjs/rpx/issues/2267)), so run the
gateway from a launcher that calls `startGateway` instead. The gateway
function itself is unaffected.

```ts
// /etc/rpx/gateway.ts
import { startGateway } from '@stacksjs/rpx'

await startGateway({
  sitesDir: '/etc/rpx/sites.d',
  localCa: {
    dir: '/etc/rpx/local-ca',
    hosts: ['pi-stacks.local'],
    ips: ['192.168.1.20'],
    installTrust: true,
  },
  maxTlsContexts: 64,
})
```

Compile it once, then point a unit at the binary so the hot path does no
TypeScript parsing:

```bash
bun build --production --compile --outfile /etc/rpx/gateway /etc/rpx/gateway.ts
```

```ini
# /etc/systemd/system/rpx.service
[Unit]
Description=rpx gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/etc/rpx/gateway
Environment=RPX_WORKERS=1
Environment=RPX_REUSE_PORT=0
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

It runs as root because it binds `:80` and `:443`.

## 5. Read the startup line

The gateway writes one line to stderr on every start, which `journalctl -u
rpx` captures:

```
[rpx gateway] 3 route(s) from /etc/rpx/sites.d; listening on :443 (https)
```

Read it before anything else. A gateway that came up holding no routes and a
gateway that never came up at all look the same from a browser, and this line
separates them. `[rpx gateway] failed to start:` means the listeners never
bound and carries the reason. The other lines worth knowing are listed under
[gateway mode](/config#what-it-prints-on-startup).

Then check the certificate from the box itself:

```bash
curl --cacert /etc/rpx/local-ca/rpx-root-ca.crt https://pi-stacks.local/
curl --cacert /etc/rpx/local-ca/rpx-root-ca.crt https://192.168.1.20/
```

Both should answer without `--insecure`. If the second one fails while the
first succeeds, the address is missing from `--local-ca-ips`.

## 6. Keep the memory bounded

A Pi shares its 4 to 8 GB with every app the gateway fronts, so run one
process and cap the certificate set:

```bash
RPX_WORKERS=1 RPX_REUSE_PORT=0
```

with `maxTlsContexts` (the `--max-tls-contexts` flag) at whatever covers the
hosts you actually route. Every SNI entry keeps a parsed certificate and key
alive in OpenSSL for the life of the listener, and a certificate directory
that has accumulated retired sites and mail certificates is memory the board
cannot spare. When the set exceeds the cap, the first N entries are kept, a
local CA leaf among them, and one warning names every host that was dropped.
See the [low-memory setting](/advanced/configuration#low-memory-setting).

## Renewal

The leaf is valid for 825 days by default and is re-minted on start when fewer
than 30 days remain (`validityDays` and `renewBeforeDays`). It is also
re-minted when a host or IP is added to the configuration, when its key stops
matching, or when the CA that signed it has been replaced. Restarting the
gateway is the whole renewal procedure; the Root CA itself stays put, so
already-trusting devices stay trusting.

## Serving plain HTTP instead

Behind something else that already terminates TLS, `--no-https` binds a single
plain HTTP listener on the HTTP port and nothing at all on the HTTPS port, no
redirect and no certificate work, even when a local CA is configured:

```bash
rpx gateway --sites-dir /etc/rpx/sites.d --no-https --http-port 8080
```

## Related

Stacks drives this whole sequence for a Raspberry Pi through its
`buddy server:*` commands, which flash the card, adopt the host and deploy the
fragments this gateway reads.
