/**
 * Pooled raw-socket HTTP/1.1 client for the proxy hot path.
 *
 * `fetch()` is convenient but churns upstream connections under load: even with
 * a concurrency cap, Bun's fetch opens and closes connections far faster than the
 * OS recycles ephemeral ports, they pile into TIME_WAIT, and throughput collapses
 * by ~15x (verified: ~11k TIME_WAIT sockets, 45% errors at c=400). nginx avoids
 * this with a small, *reused* keepalive pool. This module gives rpx the same
 * model: persistent upstream sockets per `host:port`, reused across requests, so
 * the proxy stays flat under load instead of falling over.
 *
 * It is deliberately scoped to the common case (plain-HTTP upstream, ordinary
 * request/response). Anything unusual — streaming/large request uploads, `Expect`,
 * protocol upgrades — throws {@link FALLBACK} so the caller can defer to the
 * proven `fetch()` path. Correctness first; the fast path is the optimization.
 */
// `connect` is a Bun runtime builtin. A static value-import (`from 'bun'`) trips
// the declaration/bundle step at publish time ("Browser build cannot import Bun
// builtin: 'bun'"), so reach it through the `Bun` global instead — identical at
// runtime (rpx only ever runs under Bun), but invisible to the bundler.
const { connect } = Bun

/** Sentinel thrown when the pooled path declines a request; caller uses fetch(). */
export const FALLBACK: unique symbol = Symbol('rpx.pool.fallback')

/** Marker for "a socket closed before/at the start of the response" — retryable. */
const STALE = Symbol('rpx.pool.stale')
/**
 * Max transparent retries when a checked-out connection goes STALE (closed
 * before any response byte). Bounds the loop so a flapping/dead upstream fails
 * fast rather than spinning, while absorbing the routine connection churn a busy
 * upstream produces under concurrent bursts.
 */
const MAX_STALE_RETRIES = 4

/**
 * RFC 7231 idempotent methods. A STALE close (socket died before any response
 * byte) on a *freshly dialed* connection is always safe to retry — nothing was
 * processed. On a *reused* keepalive connection, though, a non-idempotent method
 * (POST/PATCH) might have been fully received and processed before the close, so
 * retrying could duplicate the side effect (double charge, double submit). We
 * therefore retry non-idempotent methods only on a fresh dial.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])
function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase())
}

/** Thrown when the upstream stalls past the configured timeout; caller maps to 504. */
export const TIMEOUT: unique symbol = Symbol('rpx.pool.timeout')

/**
 * Thrown when every connection to an upstream is busy and the wait for a free
 * slot exceeded {@link queueWaitMs}, or the waiter queue is already at its cap.
 * The caller maps it to a 503. This is the backstop that keeps a saturated or
 * stalled upstream from making the *listener* appear wedged: instead of parking
 * a request forever with no response (the production incident), rpx fails it
 * fast and loud so the listener keeps answering every other request.
 */
export const POOL_BUSY: unique symbol = Symbol('rpx.pool.busy')

/**
 * Max time (ms) a request waits for a free connection slot when an upstream is
 * at its connection cap, from `RPX_QUEUE_WAIT_MS` (default 30s). On expiry the
 * request gets a 503 rather than hanging indefinitely. This bound is what makes
 * a leaked/stalled slot a localized 503 instead of a global wedge.
 */
function queueWaitMs(): number {
  const v = Number.parseInt(process.env.RPX_QUEUE_WAIT_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}

/**
 * Hard ceiling on queued waiters per upstream, from `RPX_MAX_QUEUED` (default
 * `maxTotal * 8`). Beyond this, requests are rejected with 503 immediately
 * rather than appended — so a flood (or a fully wedged upstream) can't grow the
 * waiter array without bound and exhaust memory on top of the saturation.
 */
function maxQueued(maxTotal: number): number {
  const v = Number.parseInt(process.env.RPX_MAX_QUEUED ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : maxTotal * 8
}

/**
 * Reclaim a *checked-out* connection that has seen no I/O (no upstream bytes AND
 * no reader progress) for this many ms, from `RPX_CHECKOUT_IDLE_MS`. `0` (the
 * default) disables it — like the upstream timeout, an always-on idle bound would
 * sever a legitimately-quiet long-lived stream (SSE/long-poll). When set, it is a
 * backstop against a leaked slot if a client vanishes and Bun never cancels the
 * response stream: the periodic sweeper signals the stuck socket closed (via the
 * normal timeout path, so the stream still owns the single pool teardown).
 */
function checkoutIdleMs(): number {
  const v = Number.parseInt(process.env.RPX_CHECKOUT_IDLE_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Upstream inactivity timeout in seconds, from `RPX_UPSTREAM_TIMEOUT`. `0`
 * (the default) disables it — rpx commonly fronts dev servers doing SSE/HMR/
 * long-poll, where an inactivity timeout would sever legitimately-quiet streams.
 * The timer resets on every byte, so a streaming response that emits data
 * periodically never trips it; only a fully-stalled upstream does. Set a value
 * (e.g. `RPX_UPSTREAM_TIMEOUT=60`) in production to bound hung upstreams.
 */
function upstreamTimeoutSeconds(): number {
  const v = Number.parseInt(process.env.RPX_UPSTREAM_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Largest request body we will buffer in-memory to keep a request retry-safe. */
const MAX_BUFFERED_BODY = 1024 * 1024 // 1 MB

/**
 * Max open connections per upstream, from `RPX_MAX_UPSTREAM_CONNS` (default 256).
 * Requests beyond this queue for a free connection rather than opening more — the
 * ceiling that keeps a flood from churning sockets into TIME_WAIT. Raise it for
 * higher peak parallelism, lower it to cap upstream load.
 */
function maxTotalConns(): number {
  const v = Number.parseInt(process.env.RPX_MAX_UPSTREAM_CONNS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 256
}

/** How long an idle pooled connection is kept before it is closed (nginx's keepalive_timeout). */
const IDLE_TIMEOUT_MS = 30_000

/** Initial per-connection read buffer; grows on demand for larger header blocks. */
const INITIAL_BUF = 16384

/**
 * Hard cap on the response header block. A buggy or malicious upstream that
 * streams bytes without ever sending the terminating `\r\n\r\n` would otherwise
 * grow the per-connection buffer unbounded (doubling on each read) until the
 * proxy OOMs. If the header end isn't found within this many bytes, the
 * connection is torn down and the request fails with 502. 256 KB is far above
 * any legitimate header block.
 */
const MAX_HEADER_BYTES = 256 * 1024

/**
 * Backpressure water-marks for a streaming response body. When un-drained body
 * bytes (a slow downstream client) back up past the high-water mark, the upstream
 * socket is `pause()`d; it is `resume()`d once the reader drains below the
 * low-water mark. Without this a fast upstream + slow client buffers the *entire*
 * body in memory (the 1 MB cap above only bounds request *uploads*) → OOM under a
 * handful of concurrent slow readers.
 */
const BODY_HWM = 2 * 1024 * 1024
const BODY_LWM = 512 * 1024

/**
 * Bodies at least this large take the zero-copy fast path: hand the Response a
 * *view* of the read buffer and give the connection a fresh (smaller) buffer,
 * rather than copying the body out. Below it, a plain slice is cheaper than
 * allocating a replacement buffer.
 */
const BODY_HANDOFF_THRESHOLD = 8192
/** Replacement buffer size after a zero-copy hand-off (just needs the next headers). */
const HANDOFF_BUF = 4096

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Request headers never forwarded verbatim: HTTP/1.1 framing headers (we own the
 * connection lifecycle) plus the `x-forwarded-*` set, which the caller always
 * supplies as overrides — so client-sent copies must not be passed through.
 */
const STRIP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
])

/**
 * One pooled upstream socket. A connection serves a single request at a time
 * (HTTP/1.1, no pipelining); it is checked out of the pool for the duration of a
 * request and returned once the response body is fully read.
 */
class Conn {
  socket: import('bun').Socket<undefined> | null = null
  buf: Uint8Array = new Uint8Array(INITIAL_BUF)
  len = 0 // bytes filled
  pos = 0 // bytes consumed by the parser
  closed = false
  /** True until the first request has been written — lets the pool retry stale reuse. */
  fresh = true
  /** Set when the socket's inactivity timeout fired — surfaces as a 504, not a 502. */
  timedOut = false
  /** Epoch ms when this connection was last returned to the idle set (for sweeping). */
  idleSince = 0
  /** When set, push() routes body bytes here (streaming a content-length body). */
  bodyQueue: Uint8Array[] | null = null
  /** Body bytes still expected from the socket while {@link bodyQueue} is active. */
  bodyRemaining = 0
  /** Bytes in {@link bodyQueue} awaiting the downstream reader (for backpressure). */
  queuedBytes = 0
  /** True while a response body is streaming — gates read backpressure so it never
   *  fires during header parsing. */
  streamingBody = false
  /** Whether the upstream socket is currently paused for backpressure. */
  private paused = false
  /** Epoch ms of the last I/O on this connection while checked out — drives the
   *  checked-out reclaim (a stuck conn whose client vanished sees no I/O). */
  lastActivityAt = 0
  /** Resolves the in-flight reader when new bytes arrive or the socket closes. */
  private waiter: (() => void) | null = null
  /** Resolves the in-flight writer when the socket's send buffer drains. */
  drainWaiter: (() => void) | null = null

  /** Write `bytes` in full, awaiting `drain` when the send buffer backs up. */
  async writeAll(bytes: Uint8Array): Promise<void> {
    const socket = this.socket!
    let off = socket.write(bytes)
    while (off < bytes.length) {
      if (this.closed)
        throw STALE
      // Send buffer full — wait for drain before writing the remainder.
      await new Promise<void>((resolve) => { this.drainWaiter = resolve })
      off += socket.write(bytes.subarray(off))
    }
  }

  wakeDrain(): void {
    const w = this.drainWaiter
    if (w) {
      this.drainWaiter = null
      w()
    }
  }

  push(chunk: Uint8Array): void {
    // Body-streaming mode: route body bytes straight to the per-connection queue
    // the ReadableStream drains, instead of copying into `buf` and slicing back
    // out — halving body copies on the hot HTML/asset path. Bun reuses `chunk`
    // after this callback, so the slice (one necessary copy) keeps the bytes.
    if (this.bodyQueue) {
      const n = chunk.length <= this.bodyRemaining ? chunk.length : this.bodyRemaining
      if (n > 0) {
        this.bodyQueue.push(chunk.slice(0, n))
        this.queuedBytes += n
      }
      this.bodyRemaining -= n
      if (n < chunk.length) // bytes past the body (pipelined/over-long) — keep for finish logic
        this.appendToBuf(chunk.subarray(n))
      this.maybePause()
      this.lastActivityAt = Date.now()
      this.wake()
      return
    }
    this.appendToBuf(chunk)
    this.maybePause()
    this.lastActivityAt = Date.now()
    this.wake()
  }

  /** Un-drained body bytes: the queue for fixed-length, the read buffer otherwise. */
  private bufferedBodyBytes(): number {
    return this.bodyQueue ? this.queuedBytes : this.len - this.pos
  }

  /** Pause the upstream socket when a streaming body backs up past the high-water
   *  mark, so a slow client can't force the whole body into memory. No-op until a
   *  body is actually streaming (never throttles header parsing). */
  private maybePause(): void {
    if (this.streamingBody && !this.paused && this.bufferedBodyBytes() > BODY_HWM) {
      this.paused = true
      ;(this.socket as { pause?: () => void } | null)?.pause?.()
    }
  }

  /** Resume the upstream once the reader has drained below the low-water mark.
   *  Also marks reader progress so an actively-consumed stream is never reclaimed. */
  resumeIfDrained(): void {
    this.lastActivityAt = Date.now()
    if (this.paused && this.bufferedBodyBytes() <= BODY_LWM) {
      this.paused = false
      ;(this.socket as { resume?: () => void } | null)?.resume?.()
    }
  }

  /** Clear streaming/backpressure state and force-resume — called before a
   *  connection is returned to the idle pool, so a reused socket is never left
   *  paused (which would silently stall its next request). */
  clearStreaming(): void {
    this.streamingBody = false
    this.queuedBytes = 0
    if (this.paused) {
      this.paused = false
      ;(this.socket as { resume?: () => void } | null)?.resume?.()
    }
  }

  private appendToBuf(chunk: Uint8Array): void {
    const need = this.len + chunk.length
    if (need > this.buf.length) {
      const grown = new Uint8Array(Math.max(this.buf.length * 2, need))
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(chunk, this.len)
    this.len = need
  }

  markClosed(): void {
    this.closed = true
    // Release both a pending reader and a pending writer — neither can make
    // progress on a closed socket.
    this.wake()
    this.wakeDrain()
  }

  /** The socket's inactivity timeout fired: flag it (→ 504) and tear it down. */
  markTimedOut(): void {
    this.timedOut = true
    this.markClosed()
  }

  private wake(): void {
    const w = this.waiter
    if (w) {
      this.waiter = null
      w()
    }
  }

  /**
   * Resolve once the buffer has grown past `seen` bytes (i.e. *new* data has
   * arrived) or the socket has closed. Callers pass the length they have already
   * inspected — crucial for the header/chunk-line scanners, which don't advance
   * `pos` while searching: a plain "resolve if len>pos" would busy-spin on
   * microtasks (starving the I/O callback) when a line arrives split across TCP
   * segments. Waiting for `len > seen` instead yields to the event loop.
   */
  waitForData(seen: number): Promise<void> {
    if (this.len > seen || this.closed)
      return Promise.resolve()
    return new Promise<void>((resolve) => { this.waiter = resolve })
  }

  /** Resolve once the body queue has a chunk to drain or the socket has closed. */
  waitForBody(): Promise<void> {
    if ((this.bodyQueue !== null && this.bodyQueue.length > 0) || this.closed)
      return Promise.resolve()
    return new Promise<void>((resolve) => { this.waiter = resolve })
  }

  /** Drop already-consumed bytes so the buffer doesn't grow unbounded across reuse. */
  compact(): void {
    if (this.pos === 0)
      return
    if (this.pos === this.len) {
      this.pos = 0
      this.len = 0
      return
    }
    this.buf.copyWithin(0, this.pos, this.len)
    this.len -= this.pos
    this.pos = 0
  }

  destroy(): void {
    this.closed = true
    try { this.socket?.end() }
    catch { /* already gone */ }
    this.socket = null
  }
}

/**
 * A bounded keepalive connection pool for a single upstream `host:port`.
 *
 * It caps the *total* number of open connections at `maxTotal` and **queues**
 * requests that arrive while every connection is busy, handing each released
 * connection straight to the next waiter. Connections are only ever closed on
 * error or after sitting idle past the timeout — never on the hot release path.
 *
 * Bounding the total (rather than just the idle set) is what makes it
 * collapse-safe: a fixed set of connections is reused indefinitely, so there is
 * no per-request churn to pile sockets into TIME_WAIT and exhaust ephemeral
 * ports under a flood. The price is that at concurrency above `maxTotal`,
 * throughput is bounded by the pool size instead of growing unbounded — exactly
 * the trade nginx makes, and the reason it stays up under load.
 */
class UpstreamPool {
  private idle: Conn[] = []
  /** Requests waiting for a connection when all `maxTotal` are busy. */
  private waiters: Array<(c: Conn | null) => void> = []
  /** Open connections (idle + checked-out). Capped at {@link maxTotal}. */
  private open = 0
  /** Lazily-started interval that closes connections idle past {@link IDLE_TIMEOUT_MS}. */
  private sweeper: ReturnType<typeof setInterval> | null = null
  /** Max ms a request waits for a free slot before getting {@link POOL_BUSY}. */
  private readonly queueWaitMs = queueWaitMs()
  /** Hard ceiling on {@link waiters} length; beyond it, reject with {@link POOL_BUSY}. */
  private readonly maxWaiters: number
  /** Reclaim a checked-out connection idle this long; `0` disables (see {@link checkoutIdleMs}). */
  private readonly checkoutIdleMs = checkoutIdleMs()
  /** Currently checked-out connections — watched by the sweeper for stuck slots. */
  private readonly inUse = new Set<Conn>()

  constructor(private host: string, private port: number, private maxTotal: number, private readonly key: string = '') {
    this.maxWaiters = maxQueued(maxTotal)
  }

  /** Mark a connection as checked out and (when enabled) keep the sweeper alive
   *  so a stuck checkout can be reclaimed even with no idle connections around. */
  private trackCheckout(conn: Conn): void {
    conn.lastActivityAt = Date.now()
    if (this.checkoutIdleMs > 0) {
      this.inUse.add(conn)
      this.ensureSweeper()
    }
  }

  dial(): Promise<Conn> {
    const conn = new Conn()
    return connect({
      hostname: this.host,
      port: this.port,
      socket: {
        data: (_s, chunk) => conn.push(chunk),
        drain: () => conn.wakeDrain(),
        close: () => conn.markClosed(),
        end: () => conn.markClosed(),
        error: () => conn.markClosed(),
        connectError: () => conn.markClosed(),
        timeout: () => conn.markTimedOut(),
      },
    }).then((socket) => {
      const s = socket as unknown as {
        setNoDelay?: (v: boolean) => void
        timeout?: (seconds: number) => void
      }
      // Disable Nagle: proxy writes a complete request in one shot and wants it
      // on the wire immediately, not coalesced.
      s.setNoDelay?.(true)
      // Bound a fully-stalled upstream (opt-in; resets on every byte).
      const t = upstreamTimeoutSeconds()
      if (t > 0)
        s.timeout?.(t)
      conn.socket = socket as unknown as import('bun').Socket<undefined>
      return conn
    })
  }

  /** Pop a live idle connection synchronously (the hot path), or null if none. */
  acquireIdleSync(): Conn | null {
    while (this.idle.length) {
      const c = this.idle.pop()!
      if (!c.closed) {
        // Re-ref the socket: it is now active and must keep the loop alive while
        // we await the upstream response.
        c.socket?.ref()
        c.pos = 0
        c.len = 0
        this.trackCheckout(c)
        return c
      }
      this.open-- // a dead idle connection no longer counts toward the cap
    }
    return null
  }

  /**
   * Get a connection when the idle set is empty: dial a fresh one if under the
   * cap, otherwise wait for one to be released. Only awaited off the hot path.
   */
  async acquireOrDial(): Promise<Conn> {
    if (this.open >= this.maxTotal) {
      // Reject immediately once the queue is full — never let it grow unbounded.
      if (this.waiters.length >= this.maxWaiters)
        throw POOL_BUSY
      const c = await this.waitForSlot()
      if (c === POOL_BUSY)
        throw POOL_BUSY
      if (c) {
        c.pos = 0
        c.len = 0
        this.trackCheckout(c)
        return c
      }
      // Woken with null — a slot was freed by a closed connection; dial below.
    }
    this.open++
    try {
      const conn = await this.dial()
      this.trackCheckout(conn)
      return conn
    }
    catch (err) {
      this.open--
      this.wakeWaiter()
      throw err
    }
  }

  /**
   * Wait for a connection to be released to us, bounded by {@link queueWaitMs}.
   * Resolves with a reused {@link Conn}, `null` (a slot freed up — dial a fresh
   * one), or {@link POOL_BUSY} on timeout. On timeout the waiter is removed from
   * the queue so a freed slot is never handed to a request that already gave up.
   */
  private waitForSlot(): Promise<Conn | null | typeof POOL_BUSY> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (v: Conn | null | typeof POOL_BUSY): void => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      // The resolver stored in `waiters` clears the timer on a real wake-up.
      const waiter = (c: Conn | null): void => finish(c)
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i !== -1)
          this.waiters.splice(i, 1)
        finish(POOL_BUSY)
      }, this.queueWaitMs)
      timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  /** Hand a healthy connection to the next waiter, or return it to the idle set. */
  release(conn: Conn): void {
    this.inUse.delete(conn) // no longer checked out (may be re-tracked below if reused)
    if (conn.closed) {
      this.open--
      this.wakeWaiter()
      return
    }
    conn.clearStreaming() // never hand a paused socket to the next request
    conn.compact()
    conn.fresh = false
    const waiter = this.waiters.shift()
    if (waiter) {
      // Reuse directly for a queued request — connection stays checked out.
      conn.socket?.ref()
      this.trackCheckout(conn)
      waiter(conn)
      return
    }
    conn.idleSince = Date.now()
    // An idle pooled socket must not keep the process alive on its own; a single
    // periodic sweep (not a per-request timer) expires connections idle past the
    // timeout, mirroring nginx keepalive_timeout without per-request overhead.
    conn.socket?.unref()
    this.idle.push(conn)
    this.ensureSweeper()
  }

  /** Permanently drop a connection (protocol error / unreusable framing). */
  destroy(conn: Conn): void {
    this.inUse.delete(conn)
    conn.destroy()
    this.open--
    this.wakeWaiter()
  }

  /** A slot freed up — wake one waiter to dial a fresh connection. */
  private wakeWaiter(): void {
    const waiter = this.waiters.shift()
    if (waiter)
      waiter(null)
  }

  /** Start the idle sweeper on first use; it self-stops once the pool drains. */
  private ensureSweeper(): void {
    if (this.sweeper)
      return
    // Sweep often enough to reclaim a stuck checkout within ~checkoutIdleMs, but
    // never more often than the idle-keepalive cadence needs.
    const interval = this.checkoutIdleMs > 0 ? Math.min(IDLE_TIMEOUT_MS, this.checkoutIdleMs) : IDLE_TIMEOUT_MS
    this.sweeper = setInterval(() => this.sweep(), interval)
    // Don't let the sweeper keep the process alive.
    this.sweeper.unref?.()
  }

  /** Close connections idle longer than the timeout; stop sweeping when empty. */
  private sweep(): void {
    const now = Date.now()
    const cutoff = now - IDLE_TIMEOUT_MS
    if (this.idle.length) {
      const survivors: Conn[] = []
      for (const c of this.idle) {
        if (c.closed || c.idleSince <= cutoff) {
          c.destroy()
          this.open--
        }
        else {
          survivors.push(c)
        }
      }
      this.idle = survivors
    }
    // Reclaim a *checked-out* connection that has gone silent (no upstream bytes
    // AND no reader progress) — a leaked slot whose client likely vanished. We
    // only *signal* it closed (markTimedOut); the in-flight reader/handler then
    // performs the single pool.destroy, so the open-count stays correct.
    if (this.checkoutIdleMs > 0 && this.inUse.size) {
      const stuck = now - this.checkoutIdleMs
      for (const c of this.inUse) {
        if (!c.closed && c.lastActivityAt > 0 && c.lastActivityAt <= stuck)
          c.markTimedOut()
      }
    }
    if (this.idle.length === 0 && this.inUse.size === 0 && this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
      // Drop the fully-drained pool from the global registry so a gateway that
      // fans out to many distinct upstreams over its lifetime doesn't accumulate
      // empty pool objects without bound. Guard against evicting a pool that has
      // already been replaced in the map (a new request re-created it).
      if (this.key && pools.get(this.key) === this)
        pools.delete(this.key)
    }
  }
}

const pools = new Map<string, UpstreamPool>()

/** Get (or create) the pool for `host:port`. */
function poolFor(hostPort: string, maxPerHost: number): UpstreamPool {
  let pool = pools.get(hostPort)
  if (!pool) {
    const idx = hostPort.lastIndexOf(':')
    const host = idx === -1 ? hostPort : hostPort.slice(0, idx)
    const port = idx === -1 ? 80 : Number(hostPort.slice(idx + 1))
    pool = new UpstreamPool(host, port, maxPerHost, hostPort)
    pools.set(hostPort, pool)
  }
  return pool
}

interface ParsedHead {
  status: number
  headerEnd: number // index of the start of CRLFCRLF
  headers: Array<[string, string]>
  contentLength: number // -1 if absent
  chunked: boolean
  closeConn: boolean // upstream asked to close (or HTTP/1.0)
  malformed: boolean // unparseable/conflicting framing — refuse rather than mis-frame
}

/** Scan for the end of the header block (\r\n\r\n). Returns the index of \r or -1. */
function findHeaderEnd(buf: Uint8Array, len: number, from: number): number {
  for (let i = from + 3; i < len; i++) {
    if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13)
      return i - 3
  }
  return -1
}

/** Parse a complete response header block sitting in `buf[start..headerEnd)`. */
function parseHead(buf: Uint8Array, start: number, headerEnd: number): ParsedHead {
  const text = decoder.decode(buf.subarray(start, headerEnd))
  const firstEol = text.indexOf('\r\n')
  const statusLine = firstEol === -1 ? text : text.slice(0, firstEol)
  // "HTTP/1.1 200 OK" → status is the token after the first space.
  const sp = statusLine.indexOf(' ')
  const status = Number.parseInt(statusLine.slice(sp + 1, sp + 5), 10)
  const http10 = statusLine.startsWith('HTTP/1.0')

  const headers: Array<[string, string]> = []
  let contentLength = -1
  let chunked = false
  let closeConn = http10
  let keepAliveSeen = false
  let malformed = false

  let pos = firstEol === -1 ? text.length : firstEol + 2
  while (pos < text.length) {
    let eol = text.indexOf('\r\n', pos)
    if (eol === -1)
      eol = text.length
    const line = text.slice(pos, eol)
    pos = eol + 2
    if (line === '')
      continue
    const colon = line.indexOf(':')
    if (colon === -1)
      continue
    const name = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()
    // Only the framing/strip headers (content-length, transfer-encoding,
    // connection, keep-alive) start with c/t/k — so skip the toLowerCase for
    // every other header (date, server, content-type-pass-through, etc.).
    const first = name.charCodeAt(0) | 0x20
    if (first === 99 || first === 116 || first === 107) {
      const lower = name.toLowerCase()
      if (lower === 'content-length') {
        // Accept only a clean, bounded, non-negative integer. A garbage value
        // ("12abc", overflow, negative) or a second, conflicting Content-Length
        // is a framing error — refuse it rather than mis-frame the body (and the
        // NEXT response on this reused connection). RFC 7230 §3.3.3.
        const n = /^\d+$/.test(value) ? Number(value) : Number.NaN
        if (!Number.isSafeInteger(n) || (contentLength >= 0 && contentLength !== n))
          malformed = true
        else
          contentLength = n
        continue
      }
      if (lower === 'transfer-encoding') {
        if (value.toLowerCase().includes('chunked'))
          chunked = true
        continue
      }
      if (lower === 'connection') {
        const v = value.toLowerCase()
        if (v.includes('close'))
          closeConn = true
        if (v.includes('keep-alive'))
          keepAliveSeen = true
        continue
      }
      if (lower === 'keep-alive')
        continue
    }
    headers.push([name, value])
  }
  if (http10 && keepAliveSeen)
    closeConn = false
  // A response carrying both a chunked Transfer-Encoding and a Content-Length is a
  // smuggling/mis-frame risk; we honor chunked (checked first in readResponse) and
  // drop the Content-Length so the two can't disagree.
  if (chunked && contentLength >= 0)
    contentLength = -1

  return { status, headerEnd, headers, contentLength, chunked, closeConn, malformed }
}

/**
 * Whether a response with this status / method carries no body (RFC 7230 §3.3.3).
 * Interim 1xx responses are handled separately (skipped) before this is reached.
 */
function isBodyless(status: number, isHead: boolean): boolean {
  return isHead || status === 204 || status === 304
}

export interface PoolRequest {
  /** Upstream `host:port`. */
  hostPort: string
  method: string
  /** Path + query (origin-form), e.g. `/api/x?y=1`. */
  path: string
  /** The original client request headers, forwarded minus framing/override keys. */
  reqHeaders: Headers
  /** Value for the upstream `x-forwarded-host` (the client-facing hostname). */
  forwardedHost: string
  /** When set (changeOrigin), the `origin` header value; also drops the client's. */
  originOverride?: string
  /** Request body stream, or null. */
  body: ReadableStream<Uint8Array> | null
  /** Max idle connections kept per upstream. */
  maxPerHost?: number
}

/**
 * Forward a request through the pooled transport and return the upstream
 * {@link Response}. Throws {@link FALLBACK} for cases it intentionally declines
 * (large/streaming uploads, `Expect`, upgrades) so the caller can use `fetch()`.
 */
export async function proxyViaPool(reqOpts: PoolRequest): Promise<Response> {
  const { hostPort, method, path, reqHeaders, forwardedHost, originOverride, body } = reqOpts
  const isHead = method === 'HEAD'

  // Decline anything that needs request-time negotiation or a hijacked socket.
  if (reqHeaders.get('expect') || reqHeaders.get('upgrade'))
    throw FALLBACK

  // Materialize the request body up-front (keeps retries safe) — but only when
  // it's small. Large/streaming uploads go through fetch(), which handles
  // backpressure properly.
  let bodyBytes: Uint8Array | null = null
  if (body) {
    // Only handle bodies with a known, modest Content-Length. Streaming or
    // unknown-length uploads are declined *before* the stream is touched, so the
    // caller can still hand the untouched body to fetch().
    const lenHeader = reqHeaders.get('content-length')
    const declared = lenHeader ? Number.parseInt(lenHeader, 10) : Number.NaN
    if (Number.isNaN(declared) || declared > MAX_BUFFERED_BODY)
      throw FALLBACK
    bodyBytes = await readBodyCapped(body)
    if (bodyBytes === null)
      throw FALLBACK // exceeded cap while reading (Content-Length under-declared)
  }

  const head = serializeRequest(method, path, reqHeaders, hostPort, forwardedHost, originOverride, bodyBytes)
  // Send the head and (buffered) body as one write so the common request is a
  // single syscall with no body-write await.
  let payload = head
  if (bodyBytes && bodyBytes.length) {
    payload = new Uint8Array(head.length + bodyBytes.length)
    payload.set(head)
    payload.set(bodyBytes, head.length)
  }
  const pool = poolFor(hostPort, reqOpts.maxPerHost ?? maxTotalConns())

  // Transparent retry on STALE. STALE means the upstream closed the socket
  // before sending any response byte (and, for a write-time close, possibly
  // before fully reading the request) — so the request was never answered and
  // retrying on a fresh connection is always safe regardless of method (the body
  // is buffered). This is not just the "reused keepalive socket closed between
  // requests" case: under load, servers cap keepalive or drop connections during
  // accept bursts, so a *freshly dialed* connection can also go stale before the
  // response. Gating the retry on `!conn.fresh` dropped exactly those requests.
  // Bound the retries so a genuinely dead upstream fails fast instead of
  // spinning — a real outage surfaces as a connect error from `acquireOrDial`
  // (not STALE), which propagates immediately.
  for (let attempt = 0; ; attempt++) {
    // Tiny incremental backoff between retries so a burst that briefly overran
    // the upstream's accept backlog (or churned ephemeral ports) staggers instead
    // of stampeding the same failure again. Costs nothing on the common path
    // (attempt 0).
    if (attempt > 0)
      await new Promise<void>((resolve) => { setTimeout(resolve, attempt) })

    // Reuse a pooled connection synchronously when one is available (no await on
    // the hot path); otherwise dial a fresh one or queue for a free slot. A dial
    // failure here is a transient connect error: no request bytes were sent, so
    // retrying is safe regardless of method. POOL_BUSY is genuine saturation —
    // fail fast (→ 503). A truly dead upstream keeps failing the dial and is
    // surfaced (→ 502) once the bounded retries are spent.
    let conn: Conn
    try {
      conn = pool.acquireIdleSync() ?? await pool.acquireOrDial()
    }
    catch (err) {
      if (err !== POOL_BUSY && attempt < MAX_STALE_RETRIES)
        continue
      throw err
    }

    try {
      const written = conn.socket!.write(payload)
      if (written < payload.length)
        await conn.writeAll(payload.subarray(written))
      return await readResponse(pool, conn, isHead)
    }
    catch (err) {
      // A reused (non-fresh) connection that goes STALE on a non-idempotent method
      // must NOT be retried — the upstream may have processed it before closing.
      const retryable = err === STALE && attempt < MAX_STALE_RETRIES && (conn.fresh || isIdempotent(method))
      pool.destroy(conn)
      if (retryable)
        continue
      if (err === STALE)
        throw new Error('upstream closed connection')
      throw err
    }
  }
}

/** Block until the full response header block (\r\n\r\n) is buffered. */
async function waitForHead(conn: Conn): Promise<number> {
  let headerEnd = findHeaderEnd(conn.buf, conn.len, conn.pos)
  while (headerEnd === -1) {
    if (conn.closed) {
      if (conn.timedOut)
        throw TIMEOUT
      // Nothing (or only a partial head) arrived — treat as a stale socket.
      if (conn.len === conn.pos)
        throw STALE
      throw new Error('upstream closed mid-header')
    }
    // Bound the header block: an upstream that streams bytes without ever
    // sending `\r\n\r\n` would otherwise grow `buf` unbounded until OOM.
    if (conn.len - conn.pos > MAX_HEADER_BYTES)
      throw new Error('upstream header block too large')
    await conn.waitForData(conn.len)
    headerEnd = findHeaderEnd(conn.buf, conn.len, conn.pos)
  }
  return headerEnd
}

/** Read the response head + body from `conn`, returning a streaming Response. */
async function readResponse(pool: UpstreamPool, conn: Conn, isHead: boolean): Promise<Response> {
  // Skip any interim 1xx responses (e.g. an unsolicited `103 Early Hints`); they
  // are header-only and precede the real response on the same connection. (`101`
  // can't occur here — we decline upgrades up front.)
  let head: ParsedHead
  for (;;) {
    const headerEnd = await waitForHead(conn)
    head = parseHead(conn.buf, conn.pos, headerEnd)
    conn.pos = headerEnd + 4
    if (head.status >= 100 && head.status < 200)
      continue
    break
  }

  // Unparseable/conflicting framing (bad Content-Length, duplicate disagreeing
  // lengths): refuse rather than guess and risk corrupting the next pooled
  // response. Destroy the connection so it's never reused.
  if (head.malformed) {
    pool.destroy(conn)
    throw new Error('upstream sent malformed response framing')
  }

  // Pass the [name, value][] array straight to Response as HeadersInit — no
  // intermediate Headers allocation on the hot path.
  const responseHeaders = head.headers

  if (isBodyless(head.status, isHead)) {
    finishConn(pool, conn, head.closeConn)
    return new Response(null, { status: head.status, headers: responseHeaders })
  }

  if (head.chunked)
    return new Response(chunkedStream(pool, conn, head.closeConn), { status: head.status, headers: responseHeaders })

  if (head.contentLength >= 0) {
    // Fast path: the whole body is already buffered — hand back bytes directly,
    // no ReadableStream machinery. (`finishConn` destroys the connection instead
    // of pooling it if there are leftover bytes after the body.)
    const available = conn.len - conn.pos
    if (available >= head.contentLength) {
      const bodyEnd = conn.pos + head.contentLength
      const leftover = conn.len > bodyEnd
      let out: Uint8Array | null = null
      if (head.contentLength >= BODY_HANDOFF_THRESHOLD) {
        // Large body: hand over a view and swap in a fresh (small) buffer, so we
        // don't copy the whole body just to wrap it in a Response.
        out = conn.buf.subarray(conn.pos, bodyEnd)
        conn.buf = new Uint8Array(HANDOFF_BUF)
      }
      else if (head.contentLength > 0) {
        out = conn.buf.slice(conn.pos, bodyEnd) // small body: a copy beats a fresh alloc
      }
      conn.pos = 0
      conn.len = 0
      // Leftover bytes after the body ⇒ pipelined/over-long ⇒ unsafe to reuse.
      if (head.closeConn || leftover)
        pool.destroy(conn)
      else
        pool.release(conn)
      return new Response(out, { status: head.status, headers: responseHeaders })
    }
    return new Response(fixedLengthStream(pool, conn, head.contentLength, head.closeConn), {
      status: head.status,
      headers: responseHeaders,
    })
  }

  // No framing info: body runs until the connection closes; not reusable.
  return new Response(untilCloseStream(conn), { status: head.status, headers: responseHeaders })
}

/**
 * Return a connection to the pool, or destroy it when it can't be safely reused:
 * the upstream asked to close, or there are leftover bytes after the body (a
 * pipelined/over-long response we don't support — reusing it would mis-frame the
 * next response).
 */
function finishConn(pool: UpstreamPool, conn: Conn, closeConn: boolean): void {
  if (closeConn || conn.pos !== conn.len)
    pool.destroy(conn)
  else
    pool.release(conn)
}

/**
 * Stream a Content-Length body via the connection's body queue. The already-
 * buffered prefix is copied out once; every later socket chunk is copied
 * straight into the queue by {@link Conn.push} (no second copy through `buf`),
 * which is the dominant saving when proxying HTML/asset-sized responses.
 */
function fixedLengthStream(pool: UpstreamPool, conn: Conn, contentLength: number, closeConn: boolean): ReadableStream<Uint8Array> {
  const buffered = conn.len - conn.pos // body bytes that arrived with the headers
  const first = buffered > 0 ? conn.buf.slice(conn.pos, conn.len) : null
  // Switch into body-streaming mode: clear the read buffer (its body bytes are
  // captured in `first`); subsequent socket data flows to bodyQueue.
  conn.pos = 0
  conn.len = 0
  conn.bodyQueue = []
  conn.bodyRemaining = contentLength - buffered
  conn.queuedBytes = 0
  conn.streamingBody = true

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    conn.bodyQueue = null
    // Bytes past the body landed back in `buf` ⇒ pipelined/over-long ⇒ don't reuse.
    if (closeConn || conn.len > 0)
      pool.destroy(conn)
    else
      pool.release(conn)
    controller.close()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first)
        controller.enqueue(first)
      if (conn.bodyRemaining === 0 && conn.bodyQueue!.length === 0)
        finish(controller)
    },
    async pull(controller) {
      for (;;) {
        const q = conn.bodyQueue
        if (q && q.length > 0) {
          const out = q.shift()!
          conn.queuedBytes -= out.length
          conn.resumeIfDrained() // reader is keeping up — un-pause the upstream
          controller.enqueue(out)
          if (conn.bodyRemaining === 0 && q.length === 0)
            finish(controller)
          return
        }
        if (conn.bodyRemaining === 0) {
          if (conn.bodyQueue)
            finish(controller)
          return
        }
        if (conn.closed) {
          conn.bodyQueue = null
          pool.destroy(conn)
          controller.error(new Error('upstream closed mid-body'))
          return
        }
        await conn.waitForBody()
      }
    },
    cancel() {
      conn.bodyQueue = null
      pool.destroy(conn)
    },
  })
}

/** Stream a body that runs until the upstream closes the connection (never reused). */
function untilCloseStream(conn: Conn): ReadableStream<Uint8Array> {
  conn.streamingBody = true // enable read backpressure for the close-delimited body
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (conn.len > conn.pos) {
          controller.enqueue(conn.buf.slice(conn.pos, conn.len))
          conn.pos = conn.len
          conn.resumeIfDrained() // reader kept up — un-pause the upstream
          return
        }
        if (conn.closed) {
          conn.destroy()
          controller.close()
          return
        }
        await conn.waitForData(conn.len)
      }
    },
    cancel() {
      conn.destroy()
    },
  })
}

/**
 * Decode a `Transfer-Encoding: chunked` body and stream the decoded bytes. Bun
 * re-frames the outgoing response to the client, so we hand it the dechunked
 * payload (with `transfer-encoding` already stripped from the headers).
 */
function chunkedStream(pool: UpstreamPool, conn: Conn, closeConn: boolean): ReadableStream<Uint8Array> {
  conn.streamingBody = true // enable read backpressure for the decoded body
  let remaining = 0 // bytes left in the current chunk
  let needTrailerCrlf = false // consume the CRLF after a chunk's data

  // Read the next CRLF-terminated line starting at conn.pos (chunk-size / trailer).
  async function readLine(): Promise<string> {
    for (;;) {
      for (let i = conn.pos; i + 1 < conn.len; i++) {
        if (conn.buf[i] === 13 && conn.buf[i + 1] === 10) {
          const line = decoder.decode(conn.buf.subarray(conn.pos, i))
          conn.pos = i + 2
          return line
        }
      }
      if (conn.closed)
        throw new Error('upstream closed mid-chunk-header')
      // Bound the chunk-size/trailer line: an upstream that never sends CRLF here
      // would otherwise grow `buf` unbounded (the header cap only covers the head).
      if (conn.len - conn.pos > MAX_HEADER_BYTES)
        throw new Error('upstream chunk header too large')
      await conn.waitForData(conn.len)
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (remaining > 0) {
          if (conn.len === conn.pos) {
            if (conn.closed) {
              pool.destroy(conn)
              controller.error(new Error('upstream closed mid-chunk'))
              return
            }
            await conn.waitForData(conn.len)
            continue
          }
          const take = Math.min(remaining, conn.len - conn.pos)
          controller.enqueue(conn.buf.slice(conn.pos, conn.pos + take))
          conn.pos += take
          remaining -= take
          conn.resumeIfDrained() // reader kept up — un-pause the upstream
          if (remaining === 0)
            needTrailerCrlf = true
          return
        }
        if (needTrailerCrlf) {
          await readLine() // the empty CRLF closing the chunk data
          needTrailerCrlf = false
        }
        const sizeLine = await readLine()
        const semi = sizeLine.indexOf(';')
        const size = Number.parseInt(semi === -1 ? sizeLine : sizeLine.slice(0, semi), 16)
        // A non-hex / negative chunk size would make `remaining` NaN and spin the
        // pull loop forever (NaN !== 0). Reject it as a framing error.
        if (!Number.isInteger(size) || size < 0) {
          pool.destroy(conn)
          controller.error(new Error('upstream sent malformed chunk size'))
          return
        }
        if (size === 0) {
          // Consume optional trailers up to the final blank line.
          for (;;) {
            const t = await readLine()
            if (t === '')
              break
          }
          finishConn(pool, conn, closeConn)
          controller.close()
          return
        }
        remaining = size
      }
    },
    cancel() {
      pool.destroy(conn)
    },
  })
}

/**
 * Serialize the request line + headers. The forwarded headers (host,
 * x-forwarded-*, optional origin) are written inline — no per-request overrides
 * array — and their keys are skipped in the client-header passthrough so values
 * aren't duplicated. Content-Length is injected when a buffered body has no
 * declared length.
 */
function serializeRequest(
  method: string,
  path: string,
  reqHeaders: Headers,
  hostValue: string,
  forwardedHost: string,
  originOverride: string | undefined,
  bodyBytes: Uint8Array | null,
): Uint8Array {
  let head = `${method} ${path} HTTP/1.1\r\nhost: ${hostValue}\r\n`
    + `x-forwarded-for: 127.0.0.1\r\nx-forwarded-proto: https\r\n`
    + `x-forwarded-host: ${forwardedHost}\r\n`
  if (originOverride !== undefined)
    head += `origin: ${originOverride}\r\n`

  let sawContentLength = false
  for (const [name, value] of reqHeaders) {
    const lower = name.toLowerCase()
    if (STRIP_REQUEST.has(lower))
      continue
    if (originOverride !== undefined && lower === 'origin')
      continue
    if (lower === 'content-length')
      sawContentLength = true
    head += `${name}: ${value}\r\n`
  }
  head += 'connection: keep-alive\r\n'
  if (bodyBytes && !sawContentLength)
    head += `content-length: ${bodyBytes.length}\r\n`
  head += '\r\n'
  return encoder.encode(head)
}

/** Read a request body fully, returning null if it exceeds {@link MAX_BUFFERED_BODY}. */
async function readBodyCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    if (value) {
      total += value.length
      if (total > MAX_BUFFERED_BODY) {
        reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  }
  if (chunks.length === 1)
    return chunks[0]
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
