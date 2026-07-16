import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createImageData, decode, encode } from 'ts-images'
import { ImgxCache, hasImgxParams, parseImgxParams, resolveImgx } from '../src/imgx'
import { createProxyFetchHandler } from '../src/proxy-handler'
import { resolveStaticRoute } from '../src/static-files'

function req(url: string, headers: Record<string, string> = {}): Request {
  const u = new URL(url)
  return new Request(url, { headers: { host: u.host, ...headers } })
}

/** A solid-color RGBA test image encoded as PNG. */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  const img = createImageData(width, height)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 200
    img.data[i + 1] = 40
    img.data[i + 2] = 40
    img.data[i + 3] = 255
  }
  return encode(img, 'png', {})
}

describe('parseImgxParams', () => {
  it('returns undefined without trigger params', () => {
    expect(parseImgxParams('')).toBeUndefined()
    expect(parseImgxParams('?foo=bar')).toBeUndefined()
    // Modifier-only params don't trigger a transform on their own.
    expect(parseImgxParams('?fit=crop&dpr=2&bg=fff')).toBeUndefined()
  })

  it('parses the meema-style core params', () => {
    const t = parseImgxParams('?w=200&h=1200&q=80')
    expect(t).toBeDefined()
    expect(t!.width).toBe(200)
    expect(t!.height).toBe(1200)
    expect(t!.quality).toBe(80)
    expect(t!.fit).toBe('clip')
    expect(t!.dpr).toBe(1)
  })

  it('clamps quality and dpr, and keeps 0-1 fractions', () => {
    expect(parseImgxParams('?q=500')!.quality).toBe(100)
    expect(parseImgxParams('?q=0')!.quality).toBe(1)
    expect(parseImgxParams('?w=16&dpr=99')!.dpr).toBe(5)
    expect(parseImgxParams('?w=0.5')!.width).toBe(0.5)
  })

  it('normalizes format aliases and auto', () => {
    expect(parseImgxParams('?fm=jpg')!.format).toBe('jpeg')
    expect(parseImgxParams('?format=webp')!.format).toBe('webp')
    expect(parseImgxParams('?fm=auto')!.autoFormat).toBe(true)
    expect(parseImgxParams('?auto=format')!.autoFormat).toBe(true)
    // Unknown formats don't trigger a transform by themselves.
    expect(parseImgxParams('?fm=tiff')).toBeUndefined()
  })

  it('maps fit fallbacks and crop positions', () => {
    expect(parseImgxParams('?w=10&fit=clamp')!.fit).toBe('clip')
    expect(parseImgxParams('?w=10&fit=fillmax')!.fit).toBe('fill')
    expect(parseImgxParams('?w=10&fit=crop&crop=top,left')!.position).toBe('top-left')
    expect(parseImgxParams('?w=10&fit=crop&crop=faces')!.position).toBe('center')
  })

  it('pre-checks cheaply via hasImgxParams', () => {
    expect(hasImgxParams('?w=1')).toBe(true)
    expect(hasImgxParams('?word=1')).toBe(false)
    expect(hasImgxParams('')).toBe(false)
  })
})

describe('ImgxCache', () => {
  it('evicts least-recently-used entries beyond limits', () => {
    const cache = new ImgxCache(1024, 2)
    cache.set('a', { bytes: new Uint8Array(10), contentType: 'image/png' })
    cache.set('b', { bytes: new Uint8Array(10), contentType: 'image/png' })
    expect(cache.get('a')).toBeDefined() // refresh a
    cache.set('c', { bytes: new Uint8Array(10), contentType: 'image/png' })
    expect(cache.get('b')).toBeUndefined() // b was the LRU entry
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('bounds total bytes', () => {
    const cache = new ImgxCache(25, 10)
    cache.set('a', { bytes: new Uint8Array(10), contentType: 'image/png' })
    cache.set('b', { bytes: new Uint8Array(10), contentType: 'image/png' })
    cache.set('c', { bytes: new Uint8Array(10), contentType: 'image/png' })
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
  })
})

describe('imgx proxy integration', () => {
  let origin: ReturnType<typeof Bun.serve> | null = null
  let originHost = ''
  let png: Uint8Array

  beforeAll(async () => {
    png = await makePng(64, 48)
    origin = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request: Request) {
        const { pathname } = new URL(request.url)
        if (pathname === '/img.png')
          return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=60', 'etag': '"origin"' } })
        if (pathname === '/broken.png')
          return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } })
        if (pathname === '/plain.txt')
          return new Response('hello', { headers: { 'content-type': 'text/plain' } })
        return new Response('not found', { status: 404 })
      },
    })
    originHost = `127.0.0.1:${origin.port}`
  })

  afterAll(() => {
    origin?.stop(true)
  })

  function handlerWith(imgx: ReturnType<typeof resolveImgx>) {
    return createProxyFetchHandler(() => ({ sourceHost: originHost, imgx }))
  }

  it('resizes to a requested width preserving aspect ratio', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?w=32'))
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-type')).toBe('image/png')
    expect(res!.headers.get('x-rpx-imgx')).toBe('miss')
    // Upstream validators no longer describe the transformed entity.
    expect(res!.headers.get('etag')).toBeNull()
    expect(res!.headers.get('cache-control')).toBe('max-age=60')
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(32)
    expect(out.height).toBe(24)
  })

  it('crops to exact dimensions with fit=crop', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?w=20&h=20&fit=crop'))
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(20)
    expect(out.height).toBe(20)
  })

  it('treats 0-1 dimensions as fractions of the source', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?w=0.5'))
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(32)
    expect(out.height).toBe(24)
  })

  it('multiplies dimensions by dpr', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?w=16&dpr=2'))
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(32)
  })

  it('never enlarges with fit=max', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?w=500&fit=max'))
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(64)
    expect(out.height).toBe(48)
  })

  it('re-encodes to an explicit format', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png?fm=jpeg&q=50'))
    expect(res!.headers.get('content-type')).toBe('image/jpeg')
    const out = await decode(new Uint8Array(await res!.arrayBuffer()))
    expect(out.width).toBe(64)
    expect(out.height).toBe(48)
  })

  it('negotiates webp from Accept with auto=format', async () => {
    const res = await handlerWith(resolveImgx(true))(
      req('http://app.localhost/img.png?w=16&auto=format', { accept: 'image/avif,image/webp,*/*' }),
    )
    expect(res!.headers.get('content-type')).toBe('image/webp')
    expect(res!.headers.get('vary')).toContain('accept')
  })

  it('passes through when no transform params are present', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/img.png'))
    expect(res!.status).toBe(200)
    expect(res!.headers.get('x-rpx-imgx')).toBeNull()
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(png)
  })

  it('passes through non-image responses untouched', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/plain.txt?w=32'))
    expect(res!.headers.get('x-rpx-imgx')).toBeNull()
    expect(await res!.text()).toBe('hello')
  })

  it('ignores transform params when imgx is not enabled for the route', async () => {
    const res = await handlerWith(undefined)(req('http://app.localhost/img.png?w=32'))
    expect(res!.headers.get('x-rpx-imgx')).toBeNull()
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(png)
  })

  it('serves the original bytes when the image cannot be decoded', async () => {
    const res = await handlerWith(resolveImgx(true))(req('http://app.localhost/broken.png?w=32'))
    expect(res!.status).toBe(200)
    expect(res!.headers.get('x-rpx-imgx')).toBeNull()
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('passes through responses larger than maxInputBytes', async () => {
    const res = await handlerWith(resolveImgx({ maxInputBytes: 10 }))(req('http://app.localhost/img.png?w=32'))
    expect(res!.status).toBe(200)
    expect(res!.headers.get('x-rpx-imgx')).toBeNull()
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(png)
  })

  it('serves repeated transforms from the in-memory cache', async () => {
    const handler = handlerWith(resolveImgx(true))
    const first = await handler(req('http://app.localhost/img.png?w=24&h=24&fit=crop'))
    expect(first!.headers.get('x-rpx-imgx')).toBe('miss')
    const second = await handler(req('http://app.localhost/img.png?w=24&h=24&fit=crop'))
    expect(second!.headers.get('x-rpx-imgx')).toBe('hit')
    expect(new Uint8Array(await second!.arrayBuffer())).toEqual(new Uint8Array(await first!.arrayBuffer()))
  })

  it('honors per-request quality over the route default', async () => {
    const handler = handlerWith(resolveImgx(true))
    const high = await handler(req('http://app.localhost/img.png?fm=jpeg&q=95'))
    const low = await handler(req('http://app.localhost/img.png?fm=jpeg&q=10'))
    const highBytes = await high!.arrayBuffer()
    const lowBytes = await low!.arrayBuffer()
    expect(lowBytes.byteLength).toBeLessThan(highBytes.byteLength)
  })

  it('transforms images served from a static route', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpx-imgx-'))
    try {
      await fsp.writeFile(path.join(dir, 'photo.png'), png)
      const handler = createProxyFetchHandler(() => ({
        static: resolveStaticRoute(dir, false),
        imgx: resolveImgx(true),
      }))
      const res = await handler(req('http://app.localhost/photo.png?w=32'))
      expect(res!.status).toBe(200)
      expect(res!.headers.get('x-rpx-imgx')).toBe('miss')
      const out = await decode(new Uint8Array(await res!.arrayBuffer()))
      expect(out.width).toBe(32)
    }
    finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
