/**
 * The interstitial pages rpx serves while an on-demand site boots (or after it
 * fails). Plain server-rendered HTML with a `<meta http-equiv="refresh">` so the
 * browser re-requests on its own — no client JS — and the moment the site's
 * routes are published the refresh lands on the real app instead.
 */

/** Escape the five HTML-significant characters for safe interpolation. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0c0f; color: #e7e9ee;
  }
  .card { width: min(92vw, 540px); padding: 2.25rem 2.5rem; }
  .row { display: flex; align-items: center; gap: .75rem; }
  h1 { font-size: 1.15rem; margin: 0; font-weight: 600; letter-spacing: -.01em }
  p { margin: .5rem 0 0; color: #9aa1ad }
  code { color: #cbd2dc; background: #16181d; padding: .1rem .4rem; border-radius: 5px }
  pre {
    margin: 1.25rem 0 0; padding: 1rem; max-height: 40vh; overflow: auto;
    background: #16181d; border: 1px solid #23262d; border-radius: 8px;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #aeb6c2;
    white-space: pre-wrap; word-break: break-word;
  }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid #3a3f4b; border-top-color: #8ab4f8;
    animation: spin .8s linear infinite;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #f87171 }
  @keyframes spin { to { transform: rotate(360deg) } }
`

function page(title: string, body: string, refreshSeconds: number): string {
  const refresh = refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main class="card">${body}</main></body>
</html>`
}

/**
 * The "starting…" splash (HTTP 503 + `Retry-After`). Auto-refreshes until the
 * site's routes go live, at which point the refresh hits the real app.
 */
export function renderStartingPage(opts: { host: string, sinceMs: number }): Response {
  const seconds = Math.max(1, Math.round(opts.sinceMs / 1000))
  const body = `
    <div class="row"><div class="spinner"></div><h1>Starting ${escapeHtml(opts.host)}…</h1></div>
    <p>rpx is booting this site's dev server on demand. This page reloads itself —
    it'll switch to the app as soon as it's ready (usually a few seconds).</p>
    <p>Booting for ${seconds}s.</p>`
  return new Response(page(`Starting ${opts.host}`, body, 2), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '2',
      'cache-control': 'no-store',
    },
  })
}

/**
 * The failure page (HTTP 502). Shows the tail of the site's log and keeps a slow
 * refresh so a fix + restart is picked up without a manual reload.
 */
export function renderFailedPage(opts: { host: string, error: string, logTail: string }): Response {
  const logBlock = opts.logTail
    ? `<pre>${escapeHtml(opts.logTail)}</pre>`
    : `<p>No output was captured.</p>`
  const body = `
    <div class="row"><div class="dot"></div><h1>${escapeHtml(opts.host)} failed to start</h1></div>
    <p>${escapeHtml(opts.error)}</p>
    ${logBlock}
    <p>Fix the cause and reload — rpx retries the boot on the next request.</p>`
  return new Response(page(`${opts.host} failed`, body, 5), {
    status: 502,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
