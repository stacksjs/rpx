/**
 * imgx integration: on-the-fly image transformation driven by query params.
 *
 * When a route enables `imgx`, the proxy inspects image responses whose request
 * carries imgix/meema-style params (`?w=200&h=1200&q=80&format=webp`, see
 * {@link parseImgxParams}) and re-encodes the upstream bytes through the
 * pure-TypeScript `ts-images` pipeline (decode → resize/ops → encode) before
 * answering. The upstream itself never sees anything but the original request,
 * so any dev server, static dir, or app gains image resizing for free.
 *
 * Design constraints:
 *  - Never break serving: any parse/decode/encode failure falls back to the
 *    original upstream bytes (the response was already buffered by then).
 *  - Never buffer unbounded: responses larger than `maxInputBytes` pass through
 *    untouched, still streaming.
 *  - Never re-encode twice: transformed variants are cached in-memory, keyed by
 *    path + normalized params + a hash of the upstream bytes — an unchanged
 *    upstream is a cache hit, a changed one misses naturally, with no TTLs.
 *  - `ts-images` is imported lazily on the first transform so enabling the
 *    integration costs nothing at startup and rpx works without the package
 *    installed (transforms just pass through, with a one-time warning).
 */
import type { ImgxOptions } from './types'
import { debugLog } from './utils'

/** Query params that trigger a transform (as opposed to only modifying one). */
const TRIGGER_PARAMS = /[?&](?:w|h|width|height|q|fm|format|auto|blur|sharp|greyscale|grayscale|bri|sat|hue|tint|rot|flip|flop|lossless)=/

/** Response content types the ts-images codecs can decode. */
const DECODABLE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/avif',
])

/** Path extensions accepted when the upstream sends no content-type. */
const DECODABLE_EXTENSIONS: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp'

const OUTPUT_FORMATS = new Set<string>(['jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'])

/** imgix `fit` values rpx implements (`clamp`→clip and `fillmax`→fill degrade). */
type FitMode = 'clip' | 'max' | 'min' | 'crop' | 'scale' | 'fill'

type CropPosition = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

interface Rgba { r: number, g: number, b: number, a?: number }

/** A request's parsed transform, normalized and clamped. */
export interface ImgxTransform {
  width?: number
  height?: number
  fit: FitMode
  position: CropPosition
  aspectRatio?: number
  dpr: number
  quality?: number
  format?: OutputFormat
  autoFormat: boolean
  lossless?: boolean
  blur?: number
  sharpen: boolean
  grayscale: boolean
  brightness?: number
  saturation?: number
  hue?: number
  tint?: Rgba
  rotate?: number
  flip: boolean
  flop: boolean
  background?: Rgba
}

export interface ResolvedImgxOptions {
  /** Encode quality used when the request has no `q`. */
  quality: number
  /** Upper clamp for requested output width. */
  maxWidth: number
  /** Upper clamp for requested output height. */
  maxHeight: number
  /** Responses larger than this pass through untransformed (still streaming). */
  maxInputBytes: number
  /** In-memory cache of transformed variants for this route, or null when disabled. */
  cache: ImgxCache | null
}

/**
 * Bounded LRU for transformed variants. Keys embed a hash of the source bytes,
 * so entries never go stale — a changed upstream simply misses.
 */
export class ImgxCache {
  private entries = new Map<string, { bytes: Uint8Array, contentType: string }>()
  private totalBytes = 0

  constructor(private maxBytes: number, private maxEntries: number) {}

  get(key: string): { bytes: Uint8Array, contentType: string } | undefined {
    const hit = this.entries.get(key)
    if (hit) {
      // Refresh recency: Map iteration order is insertion order.
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    return hit
  }

  set(key: string, value: { bytes: Uint8Array, contentType: string }): void {
    if (value.bytes.byteLength > this.maxBytes)
      return
    const existing = this.entries.get(key)
    if (existing) {
      this.entries.delete(key)
      this.totalBytes -= existing.bytes.byteLength
    }
    this.entries.set(key, value)
    this.totalBytes += value.bytes.byteLength
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined)
        break
      this.totalBytes -= this.entries.get(oldest)!.bytes.byteLength
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * Resolve a route's `imgx` config value into runtime options. `false`/absent
 * disables the integration for the route.
 */
export function resolveImgx(value: boolean | ImgxOptions | undefined): ResolvedImgxOptions | undefined {
  if (!value)
    return undefined
  const opts = value === true ? {} : value
  const cacheEnabled = opts.cache !== false
  return {
    quality: clampInt(opts.quality, 1, 100) ?? 80,
    maxWidth: clampInt(opts.maxWidth, 2, 16384) ?? 8192,
    maxHeight: clampInt(opts.maxHeight, 2, 16384) ?? 8192,
    maxInputBytes: opts.maxInputBytes && opts.maxInputBytes > 0 ? opts.maxInputBytes : 32 * 1024 * 1024,
    cache: cacheEnabled
      ? new ImgxCache(
          opts.cacheMaxBytes && opts.cacheMaxBytes > 0 ? opts.cacheMaxBytes : 64 * 1024 * 1024,
          opts.cacheMaxEntries && opts.cacheMaxEntries > 0 ? opts.cacheMaxEntries : 500,
        )
      : null,
  }
}

/** Cheap pre-check so requests without transform params never pay for parsing. */
export function hasImgxParams(search: string): boolean {
  return search.length > 1 && TRIGGER_PARAMS.test(search)
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value))
    return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value === '')
    return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** `''`, `1`, `true`, `yes` → true (bare `?flip` arrives as an empty string). */
function parseBool(value: string | null): boolean {
  if (value === null)
    return false
  return value === '' || value === '1' || value === 'true' || value === 'yes'
}

/**
 * Dimension params accept absolute pixels or, imgix-style, a 0–1 fraction of
 * the source dimension (resolved against the decoded image later).
 */
function parseDimension(value: string | null): number | undefined {
  const n = parseNumber(value)
  if (n === undefined || n <= 0)
    return undefined
  return n
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` (leading `#` optional) or a few CSS keywords. */
function parseColor(value: string | null): Rgba | undefined {
  if (!value)
    return undefined
  const keywords: Record<string, Rgba> = {
    white: { r: 255, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
    transparent: { r: 0, g: 0, b: 0, a: 0 },
  }
  const keyword = keywords[value.toLowerCase()]
  if (keyword)
    return keyword
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (!/^[0-9a-f]+$/i.test(hex))
    return undefined
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = hex.split('').map(c => Number.parseInt(c + c, 16))
    return { r, g, b, ...(a === undefined ? {} : { a }) }
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const g = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : undefined
    return { r, g, b, ...(a === undefined ? {} : { a }) }
  }
  return undefined
}

/** `crop=top,left` → ts-images' `top-left` anchor (unsupported modes → center). */
function parseCropPosition(value: string | null): CropPosition {
  if (!value)
    return 'center'
  const parts = new Set(value.split(',').map(p => p.trim().toLowerCase()))
  const vertical = parts.has('top') ? 'top' : parts.has('bottom') ? 'bottom' : ''
  const horizontal = parts.has('left') ? 'left' : parts.has('right') ? 'right' : ''
  if (vertical && horizontal)
    return `${vertical}-${horizontal}` as CropPosition
  if (vertical)
    return vertical as CropPosition
  if (horizontal)
    return horizontal as CropPosition
  return 'center'
}

/**
 * Parse the meema/imgix-compatible transform params out of a query string
 * (`search` includes the leading `?`). Returns `undefined` when no param that
 * triggers a transform is present — modifier-only queries (`?fit=crop`) and
 * unrelated queries cost nothing downstream.
 *
 * Supported params: `w`/`h` (px, or a 0–1 fraction of the source), `fit`
 * (`clip|max|min|crop|scale|fill`), `crop` (position keywords), `ar` (`16:9`),
 * `dpr`, `q`, `fm`/`format` (+`auto`), `auto=format|compress`, `lossless`,
 * `blur` (imgix 0–2000 scale), `sharp`, `greyscale`/`grayscale`, `bri`/`sat`
 * (−100..100), `hue` (degrees), `tint`, `rot`, `flip`, `flop`, `bg`.
 */
export function parseImgxParams(search: string): ImgxTransform | undefined {
  if (!hasImgxParams(search))
    return undefined
  const params = new URLSearchParams(search.slice(1))

  const auto = new Set((params.get('auto') ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean))

  let format: OutputFormat | undefined
  let autoFormat = auto.has('format')
  const rawFormat = (params.get('fm') ?? params.get('format'))?.toLowerCase()
  if (rawFormat === 'auto')
    autoFormat = true
  else if (rawFormat === 'jpg')
    format = 'jpeg'
  else if (rawFormat && OUTPUT_FORMATS.has(rawFormat))
    format = rawFormat as OutputFormat

  let fit = (params.get('fit') ?? params.get('f') ?? 'clip').toLowerCase()
  // imgix modes without a ts-images equivalent degrade to their closest match.
  if (fit === 'clamp')
    fit = 'clip'
  if (fit === 'fillmax')
    fit = 'fill'
  if (!['clip', 'max', 'min', 'crop', 'scale', 'fill'].includes(fit))
    fit = 'clip'

  let aspectRatio: number | undefined
  const ar = params.get('ar')
  if (ar) {
    const match = ar.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
    if (match) {
      const [, arw, arh] = match
      const ratio = Number(arw) / Number(arh)
      if (Number.isFinite(ratio) && ratio > 0)
        aspectRatio = ratio
    }
  }

  const quality = clampInt(parseNumber(params.get('q')), 1, 100)
  const compressQuality = auto.has('compress') && quality === undefined ? 75 : undefined

  const rawBlur = parseNumber(params.get('blur'))

  const transform: ImgxTransform = {
    width: parseDimension(params.get('w') ?? params.get('width')),
    height: parseDimension(params.get('h') ?? params.get('height')),
    fit: fit as FitMode,
    position: parseCropPosition(params.get('crop')),
    aspectRatio,
    dpr: Math.min(5, Math.max(0.1, parseNumber(params.get('dpr')) ?? 1)),
    quality: quality ?? compressQuality,
    format,
    autoFormat,
    lossless: params.has('lossless') ? parseBool(params.get('lossless')) : undefined,
    // imgix blur is 0–2000; ts-images takes a gaussian sigma. Same remap meema uses.
    blur: rawBlur && rawBlur > 0 ? Math.min(2000, rawBlur) * 0.22 : undefined,
    sharpen: parseBool(params.get('sharp')),
    grayscale: parseBool(params.get('greyscale')) || parseBool(params.get('grayscale')),
    // imgix bri/sat are −100..100 offsets; ts-images modulate takes multipliers.
    brightness: mapOffsetToMultiplier(parseNumber(params.get('bri'))),
    saturation: mapOffsetToMultiplier(parseNumber(params.get('sat'))),
    hue: parseNumber(params.get('hue')),
    tint: parseColor(params.get('tint')),
    rotate: parseNumber(params.get('rot')),
    flip: parseBool(params.get('flip')),
    flop: parseBool(params.get('flop')),
    background: parseColor(params.get('bg')),
  }

  const triggers = transform.width !== undefined
    || transform.height !== undefined
    || transform.quality !== undefined
    || transform.format !== undefined
    || transform.autoFormat
    || transform.lossless !== undefined
    || transform.blur !== undefined
    || transform.sharpen
    || transform.grayscale
    || transform.brightness !== undefined
    || transform.saturation !== undefined
    || transform.hue !== undefined
    || transform.tint !== undefined
    || transform.rotate !== undefined
    || transform.flip
    || transform.flop
  return triggers ? transform : undefined
}

function mapOffsetToMultiplier(offset: number | undefined): number | undefined {
  if (offset === undefined)
    return undefined
  return Math.max(0, 1 + Math.min(100, Math.max(-100, offset)) / 100)
}

/**
 * Lazy `ts-images` loader. The import is deferred to the first transform and
 * failures are remembered — a missing package means transforms pass through
 * with a single warning instead of a per-request error.
 */
type TsImages = typeof import('ts-images')
let tsImagesPromise: Promise<TsImages | null> | undefined

function loadTsImages(verbose?: boolean): Promise<TsImages | null> {
  tsImagesPromise ??= import('ts-images').catch((err) => {
    console.warn(`[rpx] imgx integration disabled: failed to load ts-images (${err instanceof Error ? err.message : err})`)
    debugLog('imgx', `ts-images import failed: ${err}`, verbose)
    return null
  })
  return tsImagesPromise
}

/** Test hook: reset the memoized ts-images import. */
export function resetImgxRuntime(): void {
  tsImagesPromise = undefined
}

function contentTypeOf(res: Response): string | undefined {
  const raw = res.headers.get('content-type')
  if (!raw)
    return undefined
  const semi = raw.indexOf(';')
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase()
}

function extensionType(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf('.')
  if (dot === -1)
    return undefined
  return DECODABLE_EXTENSIONS[pathname.slice(dot).toLowerCase()]
}

/**
 * Read a body into memory up to `cap` bytes. When the cap is exceeded the
 * already-read chunks are stitched back in front of the remaining stream so the
 * caller can return an untouched passthrough response.
 */
async function bufferBody(res: Response, cap: number): Promise<{ bytes: Uint8Array } | { overflow: ReadableStream<Uint8Array> | null }> {
  if (!res.body)
    return { overflow: null }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    chunks.push(value)
    total += value.byteLength
    if (total > cap) {
      const replay = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks)
            controller.enqueue(chunk)
        },
        async pull(controller) {
          const { done: d, value: v } = await reader.read()
          if (d)
            controller.close()
          else
            controller.enqueue(v)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return { overflow: replay }
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: out }
}

/** Compute the exact output dimensions for a fit mode (rpx does its own math
 * so imgix semantics don't depend on ts-images' internal dimension rules). */
function planResize(
  srcW: number,
  srcH: number,
  t: ImgxTransform,
  opts: ResolvedImgxOptions,
): { width: number, height: number, fit: 'fill' | 'cover' | 'contain' } | undefined {
  let w = t.width
  let h = t.height
  if (w === undefined && h === undefined)
    return undefined

  // 0–1 fractions are relative to the source dimension.
  if (w !== undefined && w < 1)
    w = srcW * w
  if (h !== undefined && h < 1)
    h = srcH * h

  // Derive the missing dimension from `ar` (crop workflows) or the source AR.
  const aspect = srcW / srcH
  if (w === undefined)
    w = h! * (t.aspectRatio ?? aspect)
  else if (h === undefined)
    h = w / (t.aspectRatio ?? aspect)

  w *= t.dpr
  h! *= t.dpr

  w = Math.min(w, opts.maxWidth)
  h = Math.min(h!, opts.maxHeight)

  switch (t.fit) {
    case 'scale':
      // Distort to the exact box.
      break
    case 'crop':
      // Fill the box, cropping overflow at `position`.
      return { width: dim(w), height: dim(h), fit: 'cover' }
    case 'min': {
      // Like crop, but never enlarge beyond the source.
      const k = Math.min(srcW / w, srcH / h, 1)
      return { width: dim(w * k), height: dim(h * k), fit: 'cover' }
    }
    case 'fill':
      // Letterbox to the exact box with `bg` padding.
      return { width: dim(w), height: dim(h), fit: 'contain' }
    case 'max':
    case 'clip': {
      // Preserve AR inside the box; `max` additionally never enlarges.
      let scale = Math.min(w / srcW, h / srcH)
      if (t.fit === 'max')
        scale = Math.min(scale, 1)
      return { width: dim(srcW * scale), height: dim(srcH * scale), fit: 'fill' }
    }
  }
  return { width: dim(w), height: dim(h), fit: 'fill' }
}

function dim(value: number): number {
  return Math.max(1, Math.round(value))
}

const FORMAT_CONTENT_TYPES: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * Decide the encode format: explicit `fm`/`format` wins; `auto=format`
 * negotiates from `Accept` (webp when accepted — the ts-images avif encoder
 * needs a system `avifenc` to produce real AV1, so rpx doesn't auto-pick it);
 * otherwise keep the source format.
 */
function resolveOutputFormat(t: ImgxTransform, sourceFormat: string, accept: string | null): OutputFormat {
  if (t.format)
    return t.format
  if (t.autoFormat && accept && accept.includes('image/webp'))
    return 'webp'
  const normalized = sourceFormat === 'jpg' ? 'jpeg' : sourceFormat
  return OUTPUT_FORMATS.has(normalized) ? normalized as OutputFormat : 'png'
}

/** Serialize the parts of a transform that affect output bytes into a cache key. */
function transformKey(t: ImgxTransform, outputFormat: OutputFormat, quality: number): string {
  return [
    t.width, t.height, t.fit, t.position, t.aspectRatio, t.dpr,
    outputFormat, quality, t.lossless,
    t.blur, t.sharpen, t.grayscale, t.brightness, t.saturation, t.hue,
    t.tint && `${t.tint.r}.${t.tint.g}.${t.tint.b}`,
    t.rotate, t.flip, t.flop,
    t.background && `${t.background.r}.${t.background.g}.${t.background.b}.${t.background.a ?? 255}`,
  ].join('|')
}

/**
 * Post-upstream hook: given the request context and the upstream response,
 * return either the transformed image response or the original response
 * untouched. This must never throw — every failure path degrades to the
 * original bytes.
 */
export async function applyImgxTransform(
  req: Request,
  pathname: string,
  search: string,
  imgx: ResolvedImgxOptions | undefined,
  res: Response,
  verbose?: boolean,
): Promise<Response> {
  if (!imgx || req.method !== 'GET' || res.status !== 200 || res.headers.has('content-range'))
    return res

  const transform = parseImgxParams(search)
  if (!transform)
    return res

  const contentType = contentTypeOf(res)
  if (contentType ? !DECODABLE_TYPES.has(contentType) : !extensionType(pathname))
    return res

  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > imgx.maxInputBytes)
    return res

  let bytes: Uint8Array
  try {
    const buffered = await bufferBody(res, imgx.maxInputBytes)
    if (!('bytes' in buffered)) {
      debugLog('imgx', `response for ${pathname} exceeds maxInputBytes; passing through`, verbose)
      return new Response(buffered.overflow, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    bytes = buffered.bytes
  }
  catch (err) {
    debugLog('imgx', `failed to buffer ${pathname}: ${err}`, verbose)
    return new Response(null, { status: 502 })
  }

  const passthrough = () => new Response(bytes, { status: 200, statusText: res.statusText, headers: res.headers })

  const mod = await loadTsImages(verbose)
  if (!mod)
    return passthrough()

  try {
    const sourceFormat = await mod.getMetadata(bytes).then(meta => meta.format)
      .catch(() => contentType ? contentType.slice('image/'.length) : '')
    if (!sourceFormat)
      return passthrough()

    const outputFormat = resolveOutputFormat(transform, sourceFormat, req.headers.get('accept'))
    const quality = transform.quality ?? imgx.quality
    const cacheKey = `${pathname}|${transformKey(transform, outputFormat, quality)}|${Bun.hash(bytes).toString(36)}`

    const cached = imgx.cache?.get(cacheKey)
    if (cached) {
      debugLog('imgx', `cache hit for ${pathname}`, verbose)
      return buildResponse(res, cached.bytes, cached.contentType, transform, 'hit')
    }

    let img = await mod.decode(bytes)

    if (transform.rotate)
      img = mod.rotate(img, transform.rotate, transform.background ? { background: transform.background } : {})
    if (transform.flip)
      img = mod.flip(img)
    if (transform.flop)
      img = mod.flop(img)

    const plan = planResize(img.width, img.height, transform, imgx)
    if (plan && (plan.width !== img.width || plan.height !== img.height || plan.fit !== 'fill')) {
      img = mod.resize(img, {
        width: plan.width,
        height: plan.height,
        fit: plan.fit,
        position: transform.position,
        background: transform.background ?? { r: 255, g: 255, b: 255 },
      })
    }

    if (transform.blur)
      img = mod.blur(img, transform.blur)
    if (transform.sharpen)
      img = mod.sharpen(img)
    if (transform.grayscale)
      img = mod.grayscale(img)
    if (transform.brightness !== undefined || transform.saturation !== undefined || transform.hue !== undefined) {
      img = mod.modulate(img, {
        brightness: transform.brightness,
        saturation: transform.saturation,
        hue: transform.hue,
      })
    }
    if (transform.tint)
      img = mod.tint(img, transform.tint)

    const encoded = await mod.encode(img, outputFormat, {
      quality,
      ...(transform.lossless === undefined ? {} : { lossless: transform.lossless }),
    })
    const outBytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded)
    const outContentType = FORMAT_CONTENT_TYPES[outputFormat]

    imgx.cache?.set(cacheKey, { bytes: outBytes, contentType: outContentType })
    debugLog('imgx', `transformed ${pathname} (${bytes.byteLength}B ${sourceFormat} → ${outBytes.byteLength}B ${outputFormat})`, verbose)
    return buildResponse(res, outBytes, outContentType, transform, 'miss')
  }
  catch (err) {
    debugLog('imgx', `transform failed for ${pathname}, serving original: ${err}`, verbose)
    return passthrough()
  }
}

/** Assemble the transformed response, carrying upstream headers that still
 * apply and dropping the ones invalidated by re-encoding. */
function buildResponse(upstream: Response, bytes: Uint8Array, contentType: string, t: ImgxTransform, cache: 'hit' | 'miss'): Response {
  const headers = new Headers(upstream.headers)
  // The entity changed: upstream validators and framing no longer describe it.
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  headers.delete('etag')
  headers.delete('last-modified')
  headers.set('content-type', contentType)
  headers.set('content-length', String(bytes.byteLength))
  headers.set('x-rpx-imgx', cache)
  if (t.autoFormat && !t.format)
    headers.set('vary', headers.has('vary') ? `${headers.get('vary')}, accept` : 'accept')
  return new Response(bytes, { status: 200, headers })
}
