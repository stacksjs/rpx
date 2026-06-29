import type { ProxyRoute } from '../src/proxy-handler'
import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { enforceBasicAuth, parseHtpasswd, resolveAuth } from '../src/auth'
import { createProxyFetchHandler } from '../src/proxy-handler'
import { collectRouteEntries } from '../src/start'
import { resolveStaticRoute } from '../src/static-files'

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

function req(url: string, headers: Record<string, string> = {}): Request {
  const u = new URL(url)
  return new Request(url, { headers: { host: u.host, ...headers } })
}

const tempFiles: string[] = []
afterEach(async () => {
  for (const f of tempFiles.splice(0))
    await fsp.rm(f, { force: true }).catch(() => {})
})

async function htpasswdFile(body: string): Promise<string> {
  const file = path.join(os.tmpdir(), `rpx-htpasswd-${Math.abs(hashStr(body))}`)
  await fsp.writeFile(file, body)
  tempFiles.push(file)
  return file
}
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

describe('resolveAuth', () => {
  it('returns undefined when no config or no usable credentials are given', () => {
    expect(resolveAuth(undefined)).toBeUndefined()
    expect(resolveAuth({})).toBeUndefined()
    expect(resolveAuth({ realm: 'x' })).toBeUndefined()
  })

  it('verifies a single inline credential and defaults the realm', () => {
    const auth = resolveAuth({ username: 'admin', password: 's3cret' })!
    expect(auth.realm).toBe('Restricted')
    expect(auth.verify('admin', 's3cret')).toBe(true)
    expect(auth.verify('admin', 'wrong')).toBe(false)
    expect(auth.verify('root', 's3cret')).toBe(false)
  })

  it('honors a custom realm and a users[] list', () => {
    const auth = resolveAuth({ realm: 'Ops', users: [{ username: 'a', password: '1' }, { username: 'b', password: '2' }] })!
    expect(auth.realm).toBe('Ops')
    expect(auth.verify('a', '1')).toBe(true)
    expect(auth.verify('b', '2')).toBe(true)
    expect(auth.verify('a', '2')).toBe(false)
  })
})

describe('enforceBasicAuth', () => {
  const auth = resolveAuth({ username: 'admin', password: 'pw', realm: 'Cockpit' })!

  it('challenges with a 401 + WWW-Authenticate when no credentials are sent', () => {
    const res = enforceBasicAuth(req('https://dash.test/'), '/', auth)
    expect(res?.status).toBe(401)
    expect(res?.headers.get('www-authenticate')).toBe('Basic realm="Cockpit", charset="UTF-8"')
  })

  it('challenges on wrong credentials', () => {
    const res = enforceBasicAuth(req('https://dash.test/', { authorization: basic('admin', 'nope') }), '/', auth)
    expect(res?.status).toBe(401)
  })

  it('allows the request (undefined) on correct credentials', () => {
    expect(enforceBasicAuth(req('https://dash.test/', { authorization: basic('admin', 'pw') }), '/', auth)).toBeUndefined()
  })

  it('never gates ACME http-01 challenge requests (so on-demand TLS works)', () => {
    const res = enforceBasicAuth(req('https://dash.test/.well-known/acme-challenge/token'), '/.well-known/acme-challenge/token', auth)
    expect(res).toBeUndefined()
  })

  it('tolerates malformed Authorization headers without throwing', () => {
    expect(enforceBasicAuth(req('https://d.test/', { authorization: 'Basic !!!notbase64' }), '/', auth)?.status).toBe(401)
    expect(enforceBasicAuth(req('https://d.test/', { authorization: 'Bearer abc' }), '/', auth)?.status).toBe(401)
    expect(enforceBasicAuth(req('https://d.test/', { authorization: 'Basic' }), '/', auth)?.status).toBe(401)
  })

  it('escapes quotes/backslashes in the realm so the header cannot be broken out of', () => {
    const evil = resolveAuth({ username: 'u', password: 'p', realm: 'a"b\\c' })!
    const res = enforceBasicAuth(req('https://d.test/'), '/', evil)
    expect(res?.headers.get('www-authenticate')).toBe('Basic realm="abc", charset="UTF-8"')
  })
})

describe('htpasswd verification', () => {
  it('parses entries and ignores blanks/comments', () => {
    const map = parseHtpasswd('# comment\n\nalice:hash1\nbob:hash2\n')
    expect(map.get('alice')).toBe('hash1')
    expect(map.get('bob')).toBe('hash2')
    expect(map.size).toBe(2)
  })

  it('verifies bcrypt, SHA1, and plaintext entries', async () => {
    const bcrypt = Bun.password.hashSync('secret', 'bcrypt')
    const sha1 = `{SHA}${createHash('sha1').update('secret').digest('base64')}`
    const file = await htpasswdFile([`carol:${bcrypt}`, `bob:${sha1}`, 'dave:plainpw'].join('\n'))
    const auth = resolveAuth({ htpasswdFile: file })!
    expect(auth.verify('carol', 'secret')).toBe(true)
    expect(auth.verify('carol', 'nope')).toBe(false)
    expect(auth.verify('bob', 'secret')).toBe(true)
    expect(auth.verify('dave', 'plainpw')).toBe(true)
    expect(auth.verify('dave', 'x')).toBe(false)
    expect(auth.verify('eve', 'secret')).toBe(false)
  })

  it('verifies an Apache apr1 hash (matches `openssl passwd -apr1`)', async () => {
    // Vector generated with: openssl passwd -apr1 -salt abcd1234 secret
    const file = await htpasswdFile('alice:$apr1$abcd1234$KISB.4aBzP4pecxr2tTpg1')
    const auth = resolveAuth({ htpasswdFile: file })!
    expect(auth.verify('alice', 'secret')).toBe(true)
    expect(auth.verify('alice', 'wrong')).toBe(false)
  })

  it('falls back to inline credentials when the htpasswd file is unreadable', () => {
    const auth = resolveAuth({ username: 'admin', password: 'pw', htpasswdFile: '/no/such/file' })!
    expect(auth.verify('admin', 'pw')).toBe(true)
  })
})

describe('createProxyFetchHandler gates routes with auth', () => {
  it('gates a static route behind Basic auth before serving files', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-auth-static-'))
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>secret dashboard</h1>')
    tempFiles.push(dir)

    const route: ProxyRoute = {
      static: resolveStaticRoute(dir, false),
      cleanUrls: false,
      auth: resolveAuth({ username: 'admin', password: 'pw' }),
    }
    const handler = createProxyFetchHandler(() => route)

    const denied = await handler(req('https://dash.test/'))
    expect(denied?.status).toBe(401)
    expect(denied?.headers.get('www-authenticate')).toContain('Basic realm=')
    // The protected body must not leak in the 401.
    expect(await denied?.text()).not.toContain('secret dashboard')

    const allowed = await handler(req('https://dash.test/', { authorization: basic('admin', 'pw') }))
    expect(allowed?.status).toBe(200)
    expect(await allowed?.text()).toBe('<h1>secret dashboard</h1>')
  })

  it('gates a WebSocket upgrade on a protected route', async () => {
    const route: ProxyRoute = { sourceHost: 'localhost:3002', auth: resolveAuth({ username: 'admin', password: 'pw' }) }
    const handler = createProxyFetchHandler(() => route)
    let upgraded = false
    const server = { upgrade: () => { upgraded = true; return true } }

    const denied = await handler(req('https://api.test/socket', { upgrade: 'websocket', connection: 'Upgrade' }), server)
    expect(denied?.status).toBe(401)
    expect(upgraded).toBe(false)
  })
})

describe('collectRouteEntries threads per-proxy auth into the route', () => {
  it('builds a gated proxy route when the proxy option carries auth', async () => {
    const entries = await collectRouteEntries(
      [{ to: 'dash.example.com', from: 'localhost:7676', auth: { username: 'admin', password: 'pw' } }] as any,
      false, // hostsEnabled=false → no /etc/hosts side effects
      false,
    )
    const route = entries[0].route
    expect(route.auth).toBeDefined()
    expect(route.auth!.verify('admin', 'pw')).toBe(true)
    expect(route.auth!.verify('admin', 'x')).toBe(false)
  })

  it('builds a gated static route when the proxy option carries auth', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-auth-cre-'))
    tempFiles.push(dir)
    const entries = await collectRouteEntries(
      [{ to: 'dash.example.com', static: dir, auth: { username: 'admin', password: 'pw', realm: 'Cockpit' } }] as any,
      false,
      false,
    )
    const route = entries[0].route
    expect(route.static).toBeDefined()
    expect(route.auth?.realm).toBe('Cockpit')
    expect(route.auth!.verify('admin', 'pw')).toBe(true)
  })

  it('leaves the route public when no auth is configured', async () => {
    const entries = await collectRouteEntries(
      [{ to: 'public.example.com', from: 'localhost:8080' }] as any,
      false,
      false,
    )
    expect(entries[0].route.auth).toBeUndefined()
  })
})
