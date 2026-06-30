import { describe, expect, it } from 'bun:test'
import { escapeHtml, renderFailedPage, renderStartingPage } from '../src/site-splash'

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderStartingPage', () => {
  it('is a 503 with Retry-After and an auto-refresh', async () => {
    const res = renderStartingPage({ host: 'myapp.localhost', sinceMs: 3200 })
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('http-equiv="refresh"')
    expect(html).toContain('Starting myapp.localhost')
  })

  it('escapes the host into the page', async () => {
    const html = await renderStartingPage({ host: '<evil>.localhost', sinceMs: 0 }).text()
    expect(html).toContain('&lt;evil&gt;.localhost')
    expect(html).not.toContain('<evil>')
  })
})

describe('renderFailedPage', () => {
  it('is a 502 that shows the escaped error and log tail', async () => {
    const res = renderFailedPage({ host: 'myapp.localhost', error: 'boom & <x>', logTail: 'line1\n<script>' })
    expect(res.status).toBe(502)
    const html = await res.text()
    expect(html).toContain('myapp.localhost failed to start')
    expect(html).toContain('boom &amp; &lt;x&gt;')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('handles an empty log tail', async () => {
    const html = await renderFailedPage({ host: 'x.localhost', error: 'nope', logTail: '' }).text()
    expect(html).toContain('No output was captured')
  })
})
