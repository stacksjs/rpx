# Image Transforms (imgx)

rpx can transform image responses on the fly, driven by imgix/meema-style query params — powered by the [imgx](https://github.com/stacksjs/ts-images) pure-TypeScript pipeline. Enable it and every image your proxy (or static route) serves understands URLs like:

```txt
https://app.localhost/hero.png?w=200&h=1200&q=80
https://app.localhost/hero.png?w=640&fm=webp
https://app.localhost/hero.png?w=400&h=400&fit=crop&crop=top
```

The upstream never sees anything but the original request — any dev server, static directory, or app gains image resizing for free.

## Enabling

```ts
import { startProxy } from '@stacksjs/rpx'

await startProxy({
  from: 'localhost:5173',
  to: 'my-app.localhost',
  imgx: true, // defaults; or pass an options object
})
```

Per-proxy in multi-proxy configs (overrides the shared setting):

```ts
await startProxy({
  imgx: true,
  proxies: [
    { from: 'localhost:5173', to: 'app.localhost' },
    { from: 'localhost:3000', to: 'api.localhost', imgx: false },
  ],
})
```

Or from the CLI:

```bash
rpx start --from localhost:5173 --to my-app.localhost --imgx
```

## Supported query params

Sizing:

| Param | Meaning |
| --- | --- |
| `w`, `h` | Output width/height in px, or a `0–1` fraction of the source dimension |
| `fit` | `clip` (default, fit within preserving AR), `max` (clip, never enlarge), `crop` (fill + crop overflow), `min` (crop, never enlarge), `scale` (stretch), `fill` (letterbox with `bg`) |
| `crop` | Crop anchor for `fit=crop`: `top`, `bottom`, `left`, `right`, or combos (`top,left`) |
| `ar` | Aspect ratio (`16:9`) used to derive a missing dimension |
| `dpr` | Device pixel ratio multiplier, `0–5` (default `1`) |

Output:

| Param | Meaning |
| --- | --- |
| `q` | Quality `1–100` (default `80`, configurable) |
| `fm` / `format` | `jpeg`, `png`, `webp`, `avif`, `gif`, `bmp`, or `auto` |
| `auto` | `format` (negotiate from `Accept`, prefers WebP), `compress` |
| `lossless` | Lossless WebP/AVIF encoding |

Adjustments:

| Param | Meaning |
| --- | --- |
| `blur` | Gaussian blur, imgix `0–2000` scale |
| `sharp` | Sharpen |
| `greyscale` / `grayscale` | Convert to grayscale |
| `bri`, `sat` | Brightness/saturation offset `−100..100` |
| `hue` | Hue rotation in degrees |
| `tint` | Tint color (`tint=ff0000`) |
| `rot` | Rotate by degrees (`bg` fills the corners) |
| `flip`, `flop` | Vertical / horizontal mirror |
| `bg` | Background color for `fit=fill` and `rot` (hex or `white`/`black`/`transparent`) |

## Options

```ts
await startProxy({
  from: 'localhost:5173',
  to: 'my-app.localhost',
  imgx: {
    quality: 80, // encode quality when the request has no `q`
    maxWidth: 8192, // clamp on requested output width
    maxHeight: 8192, // clamp on requested output height
    maxInputBytes: 32 * 1024 * 1024, // larger responses pass through untouched
    cache: true, // cache transformed variants in memory
    cacheMaxBytes: 64 * 1024 * 1024, // total cache byte budget
    cacheMaxEntries: 500, // max cached variants
  },
})
```

## Behavior notes

- Only `GET` requests with a `200` image response (`jpeg`, `png`, `gif`, `bmp`, `webp`, `avif`) and at least one transform param are touched — everything else streams through untouched.
- Transformed variants are cached in memory, keyed by path, params, and a hash of the upstream bytes: an unchanged image is never re-encoded twice, and a changed one misses naturally (no TTLs to tune). Cache state is visible in the `x-rpx-imgx: hit|miss` response header.
- Any decode/encode failure falls back to serving the original bytes — the integration can slow an image down, but never break it.
- Upstream `ETag`/`Last-Modified` headers are dropped from transformed responses (they described the original entity); `Cache-Control` is passed through. `auto=format` responses set `Vary: accept`.
- WebP/AVIF encoding uses system `cwebp`/`avifenc` when available and falls back to the bundled pure-TS encoders; `auto=format` deliberately negotiates WebP (not AVIF) for that reason.
