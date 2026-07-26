//! rpx dataplane: a native reverse-proxy hot path.
//!
//! Thesis: Bun's proxy is body-bound because every byte is copied through JS
//! userspace + GC (~3x behind nginx on HTML). A no-GC, no-per-request-alloc
//! native proxy should match nginx and crush Bun.
//!
//! A transparent 1:1 TCP proxy: each client connection gets its own upstream
//! connection, and bytes are pumped in both directions. Plaintext only; the Bun
//! control plane owns TLS, certs, routing, /etc/hosts, and DNS — the dataplane
//! just moves bytes fast.
//!
//! Built on Zig's `std.Io`: one lightweight task per connection (and one per
//! direction), multiplexed cooperatively by the `Io` backend. The default
//! backend is a thread pool (`std.Io.Threaded`, multi-core for free); swapping
//! it for `std.Io.Evented` gives the single-thread io_uring loop on Linux. This
//! replaces the old hand-rolled non-blocking `poll()` loop and its `splice()`
//! path (the new `std.Io` exposes no socket→socket splice; file→socket offload
//! lives on `Stream.Writer.sendFile`).
const std = @import("std");
const http = @import("http");
const build_options = @import("build_options");
const waf_engine = @import("waf_hook");
const tls_hook = @import("tls_hook");
const net = std.Io.net;

/// True once a TLS cert/key has been loaded; every accepted connection is then
/// TLS-terminated before HTTP handling. Set once in `main`, read-only after.
var tls_active: bool = false;

const BUF_SIZE: usize = 64 * 1024;
/// Cap on the request-head bytes we buffer for inspection before forwarding.
const HEAD_BUF_SIZE: usize = 16 * 1024;
const MAX_HEADERS: usize = 128;
/// Request bodies up to this size are buffered for WAF phase-2 inspection;
/// larger bodies stream through uninspected. Zero in a non-WAF build so the
/// plain proxy carries no extra per-connection buffer.
const BODY_CAP: usize = if (build_options.has_waf) 128 * 1024 else 0;

/// The upstream every accepted connection is proxied to. Set once in `main`;
/// read-only thereafter, so sharing it across connection tasks is safe.
var upstream_addr: net.IpAddress = undefined;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var args = std.process.Args.Iterator.init(init.minimal.args);
    _ = args.next(); // argv[0]
    const listen_port = parsePort(args.next()) orelse
        fatal("usage: rpx-dataplane <listenPort> <upstreamHost> <upstreamPort> [bindHost]");
    const up_host = args.next() orelse fatal("missing upstream host");
    const up_port = parsePort(args.next()) orelse fatal("missing upstream port");
    // Optional bind host; default to every interface (a real front-end). Pass
    // 127.0.0.1 to restrict to loopback (what the local bench uses).
    const bind_host = args.next() orelse "0.0.0.0";
    // Optional SecLang rules file; only meaningful in a -Dwaf build.
    const rules_path = args.next();

    if (build_options.has_waf) {
        const path = rules_path orelse fatal("this is a -Dwaf build: pass a rules file as the 5th argument");
        const rules = std.Io.Dir.cwd().readFileAlloc(io, path, init.gpa, .limited(16 * 1024 * 1024)) catch
            fatal("cannot read the rules file");
        defer init.gpa.free(rules);
        // Data files referenced by @pmFromFile resolve relative to the rules
        // file's directory (SecDataDir semantics).
        const data_dir = std.fs.path.dirname(path) orelse ".";
        if (!waf_engine.init(rules, data_dir)) fatal("rules failed to compile (run `zig-waf validate` for diagnostics)");
    }

    // Optional TLS termination: `--tls-cert <abs.pem> --tls-key <abs.pem>` (only
    // meaningful in a -Dtls build). When both are present every connection is
    // TLS-terminated before HTTP handling; the upstream stays plaintext.
    if (build_options.has_tls) {
        var scan = std.process.Args.Iterator.init(init.minimal.args);
        var cert_path: ?[]const u8 = null;
        var key_path: ?[]const u8 = null;
        while (scan.next()) |arg| {
            if (std.mem.eql(u8, arg, "--tls-cert")) cert_path = scan.next();
            if (std.mem.eql(u8, arg, "--tls-key")) key_path = scan.next();
        }
        if (cert_path) |cert| if (key_path) |key| {
            if (!tls_hook.init(io, cert, key)) fatal("cannot load the TLS certificate/key (need absolute PEM paths)");
            tls_active = true;
        };
    }

    upstream_addr = net.IpAddress.parse(up_host, up_port) catch fatal("invalid upstream host (expected an IP literal)");

    var listen_addr = net.IpAddress.parse(bind_host, listen_port) catch fatal("invalid bind host");
    var server = listen_addr.listen(io, .{ .reuse_address = true }) catch fatal("listen failed");
    defer server.deinit(io);

    // Every connection handler is a task in this group; cancelling the group on
    // shutdown tears the in-flight connections down.
    var group: std.Io.Group = .init;
    defer group.cancel(io);

    while (true) {
        const client = server.accept(io) catch |err| switch (err) {
            error.Canceled => return err,
            else => continue, // transient accept error — keep serving
        };
        group.concurrent(io, handleConn, .{ io, client }) catch {
            // Out of concurrency capacity: drop this connection rather than block.
            client.close(io);
        };
    }
}

fn parsePort(s: ?[]const u8) ?u16 {
    const v = s orelse return null;
    return std.fmt.parseInt(u16, v, 10) catch null;
}

fn fatal(comptime msg: []const u8) noreturn {
    std.debug.print("rpx-dataplane: {s}\n", .{msg});
    std.process.exit(1);
}

/// The client side of a connection: a plaintext socket, or a terminated-TLS
/// session over it. Both present a `readSome`/`writeAll` byte interface, so the
/// HTTP handling is identical whether or not TLS is in use. (The upstream side
/// is always a plaintext `net.Stream`.)
const Client = union(enum) {
    plain: net.Stream,
    secure: *tls_hook.Session,

    /// Read up to `buf.len` bytes; 0 on EOF or error.
    fn readSome(self: Client, io: std.Io, buf: []u8) usize {
        switch (self) {
            .plain => |stream| {
                var vec: [1][]u8 = .{buf};
                return stream.read(io, &vec) catch 0;
            },
            .secure => |session| return session.readSome(io, buf),
        }
    }

    /// Write all of `bytes`; false on error.
    fn writeAll(self: Client, io: std.Io, bytes: []const u8) bool {
        switch (self) {
            .plain => |stream| {
                var out = stream.writer(io, &.{});
                out.interface.writeAll(bytes) catch return false;
                return true;
            },
            .secure => |session| return session.writeAll(io, bytes),
        }
    }

    /// Half-close the send side (plaintext) — TLS sends close_notify on deinit.
    fn shutdownSend(self: Client, io: std.Io) void {
        switch (self) {
            .plain => |stream| stream.shutdown(io, .send) catch {},
            .secure => {},
        }
    }

    fn deinit(self: Client, io: std.Io) void {
        switch (self) {
            .plain => {}, // the raw socket is closed by handleConn's defer
            .secure => |session| session.deinit(io),
        }
    }
};

/// Proxy one client connection. In a non-WAF build this is a transparent
/// bidirectional pump. In a -Dwaf build it is an HTTP/1.1 request loop: every
/// request on the connection (not just the first) is inspected through the WAF's
/// request phases, and every origin response through the response phases, so
/// keep-alive follow-ups cannot bypass the WAF. When a message is framed in a
/// way we cannot delimit (chunked, close-delimited, oversize, upgrade), we
/// forward what we have and fall back to a transparent pump for the remainder.
fn handleConn(io: std.Io, raw_client: net.Stream) void {
    defer raw_client.close(io);
    const upstream = upstream_addr.connect(io, .{ .mode = .stream }) catch return;
    defer upstream.close(io);

    // The real client IP/port must come from the raw socket, before any TLS wrap.
    var address_buf: [64]u8 = undefined;
    const peer: ?Peer = if (build_options.has_waf) peerAddress(raw_client, &address_buf) else null;

    // Terminate TLS when a cert is configured, else serve plaintext. A failed
    // handshake drops the connection.
    const client: Client = if (tls_active)
        .{ .secure = tls_hook.accept(io, raw_client) orelse return }
    else
        .{ .plain = raw_client };
    defer client.deinit(io);

    if (!build_options.has_waf) {
        pumpBoth(io, client, upstream);
        return;
    }

    const client_address = if (peer) |p| p.address else "127.0.0.1";
    const client_port: u16 = if (peer) |p| p.port else 1;

    // One head buffer, header table, and body buffer, reused for the request and
    // then the response of each exchange (the request is forwarded before the
    // response is read), keeping per-connection stack flat.
    var head_buf: [HEAD_BUF_SIZE]u8 = undefined;
    var header_storage: [MAX_HEADERS]http.Header = undefined;
    var body_buf: [HEAD_BUF_SIZE + BODY_CAP]u8 = undefined;

    while (true) switch (handleExchange(io, client, upstream, peer, client_address, client_port, &head_buf, &header_storage, &body_buf)) {
        .keep_alive => continue,
        .close => return,
        .stream => return pumpBoth(io, client, upstream),
    };
}

/// Pump both directions concurrently until each side closes. The client side may
/// be plaintext or TLS; the upstream side is always plaintext.
fn pumpBoth(io: std.Io, client: Client, upstream: net.Stream) void {
    var group: std.Io.Group = .init;
    defer group.cancel(io);
    group.async(io, pumpClientToUpstream, .{ io, client, upstream });
    pumpUpstreamToClient(io, upstream, client);
    group.await(io) catch {};
}

fn pumpUpstreamToClient(io: std.Io, upstream: net.Stream, client: Client) void {
    var buf: [BUF_SIZE]u8 = undefined;
    while (true) {
        var vec: [1][]u8 = .{&buf};
        const n = upstream.read(io, &vec) catch return;
        if (n == 0) {
            client.shutdownSend(io);
            return;
        }
        if (!client.writeAll(io, buf[0..n])) return;
    }
}

fn pumpClientToUpstream(io: std.Io, client: Client, upstream: net.Stream) void {
    var buf: [BUF_SIZE]u8 = undefined;
    var out = upstream.writer(io, &.{});
    while (true) {
        const n = client.readSome(io, &buf);
        if (n == 0) {
            upstream.shutdown(io, .send) catch {};
            return;
        }
        out.interface.writeAll(buf[0..n]) catch return;
    }
}

const Exchange = enum {
    /// The connection may carry another request — loop.
    keep_alive,
    /// The connection is done (EOF, a `Connection: close`, or a block).
    close,
    /// This message could not be delimited (chunked/close-framed/oversize/
    /// upgrade); forward the remainder as a transparent pump.
    stream,
};

/// Handle one request/response exchange with a fresh WAF transaction. Buffers
/// are borrowed from the caller and reused across exchanges.
fn handleExchange(
    io: std.Io,
    client: Client,
    upstream: net.Stream,
    peer: ?Peer,
    client_address: []const u8,
    client_port: u16,
    head_buf: []u8,
    storage: []http.Header,
    body_buf: []u8,
) Exchange {
    var inspector = waf_engine.Inspector.begin(client_address, client_port);
    defer inspector.deinit();

    // --- request ---
    const req_prefix = readRequestHead(io, client, head_buf, storage);
    if (req_prefix.bytes.len == 0) return .close; // clean EOF between requests
    const req_head = req_prefix.head orelse {
        _ = forwardAll(io, upstream, req_prefix.bytes);
        return .stream; // unparsable head — forward transparently
    };

    var req_forward: []const u8 = req_prefix.bytes;
    var req_body: []const u8 = &.{};
    var req_body_buffered = false;
    if (readBody(io, client, req_head, req_prefix.bytes, body_buf)) |buffered| {
        req_forward = buffered.forward;
        req_body = buffered.body;
        req_body_buffered = true;
    }

    if (inspector.inspectRequest(req_head, req_body)) {
        sendForbidden(io, client);
        return .close;
    }

    // Snapshot what we need from the request head before its buffers are reused.
    const req_wants_close = wantsClose(req_head.header("connection"), req_head.version);
    const req_streams = isUpgrade(req_head) or (!req_body_buffered and requestHasBody(req_head));

    {
        var out = upstream.writer(io, &.{});
        forwardRequest(&out.interface, req_forward, req_head, peer) catch return .close;
    }
    if (req_streams) return .stream; // request body we couldn't buffer — pump the rest

    // --- response (reuses head_buf / storage / body_buf) ---
    const resp_prefix = readResponseHead(io, upstream, head_buf, storage);
    const resp_head = resp_prefix.head orelse {
        _ = client.writeAll(io, resp_prefix.bytes);
        return .stream;
    };

    var resp_forward: []const u8 = resp_prefix.bytes;
    var resp_body: []const u8 = &.{};
    var resp_delimited = false;
    if (readResponseBody(io, upstream, resp_head, resp_prefix.bytes, body_buf)) |buffered| {
        resp_forward = buffered.forward;
        resp_body = buffered.body;
        resp_delimited = true;
    } else if (responseIsBodyless(resp_head)) {
        resp_delimited = true; // 204/304/1xx or Content-Length: 0 — head is all
    }

    if (inspector.inspectResponse(resp_head, resp_body)) {
        sendForbidden(io, client);
        return .close;
    }

    const resp_wants_close = wantsClose(resp_head.header("connection"), resp_head.version);
    if (!client.writeAll(io, resp_forward)) return .close;

    if (!resp_delimited) return .stream; // chunked / close-framed body — pump the rest
    if (req_wants_close or resp_wants_close) return .close;
    return .keep_alive;
}

/// Write all of `bytes` to `stream`; returns false on a write error.
fn forwardAll(io: std.Io, stream: net.Stream, bytes: []const u8) bool {
    if (bytes.len == 0) return true;
    var out = stream.writer(io, &.{});
    out.interface.writeAll(bytes) catch return false;
    return true;
}

/// Whether the request declares a body (Content-Length > 0 or Transfer-Encoding).
fn requestHasBody(head: http.RequestHead) bool {
    if (contentLength(head)) |length| return length > 0;
    return head.header("transfer-encoding") != null;
}

/// Whether the request is an HTTP upgrade (WebSocket etc.) — bytes after the
/// head are an opaque tunnel, so we stop parsing and pump.
fn isUpgrade(head: http.RequestHead) bool {
    if (head.header("upgrade") != null) return true;
    if (head.header("connection")) |value| return containsTokenIgnoreCase(value, "upgrade");
    return false;
}

/// A response that carries no body regardless of headers, so its head fully
/// delimits it: 1xx, 204, and 304, or an explicit Content-Length of 0.
fn responseIsBodyless(head: http.ResponseHead) bool {
    if (head.status == 204 or head.status == 304 or (head.status >= 100 and head.status < 200)) return true;
    if (contentLengthResponse(head)) |length| return length == 0;
    return false;
}

/// Resolve HTTP keep-alive: HTTP/1.1 persists unless `Connection: close`;
/// HTTP/1.0 (and anything else) closes unless `Connection: keep-alive`.
fn wantsClose(connection: ?[]const u8, version: []const u8) bool {
    if (connection) |value| {
        if (containsTokenIgnoreCase(value, "close")) return true;
        if (containsTokenIgnoreCase(value, "keep-alive")) return false;
    }
    return !std.mem.eql(u8, version, "HTTP/1.1");
}

/// Case-insensitive substring search (for short header values).
fn containsTokenIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0 or needle.len > haystack.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[i .. i + needle.len], needle)) return true;
    }
    return false;
}

const HeadPrefix = struct {
    /// The bytes read from the client so far (the head, plus any body prefix
    /// that arrived in the same read). Already destined for the upstream.
    bytes: []u8,
    /// The parsed request head, or null if EOF/oversize/malformed intervened
    /// (in which case the bytes are forwarded transparently).
    head: ?http.RequestHead,
};

/// Read from `client` until the HTTP request head is complete, parsing it. On
/// a malformed head, an oversize head, or EOF-before-head, returns the bytes
/// read with a null head so the caller forwards them transparently.
fn readRequestHead(io: std.Io, client: Client, buf: []u8, storage: []http.Header) HeadPrefix {
    var filled: usize = 0;
    while (filled < buf.len) {
        if (http.parse(buf[0..filled], storage)) |maybe_head| {
            if (maybe_head) |head| return .{ .bytes = buf[0..filled], .head = head };
        } else |_| {
            return .{ .bytes = buf[0..filled], .head = null }; // malformed
        }
        const n = client.readSome(io, buf[filled..]);
        if (n == 0) return .{ .bytes = buf[0..filled], .head = null }; // EOF before head
        filled += n;
    }
    return .{ .bytes = buf[0..filled], .head = null }; // head larger than the buffer
}

const Buffered = struct {
    /// The head plus the full body, contiguous — forward this to the upstream.
    forward: []const u8,
    /// Just the body portion — feed this to the WAF's request-body phase.
    body: []const u8,
};

/// Buffer the request body (bounded by Content-Length and `buf`) so the WAF can
/// inspect phase 2, returning the head+body to forward and the body to inspect.
/// Returns null when there is no declared body or it is too large to buffer, in
/// which case the caller forwards `prefix_bytes` and streams the body uninspected.
fn readBody(io: std.Io, client: Client, head: http.RequestHead, prefix_bytes: []const u8, buf: []u8) ?Buffered {
    const content_length = contentLength(head) orelse return null;
    if (content_length == 0) return null;
    const wire_total = head.head_len + content_length;
    if (wire_total > buf.len) return null; // too large — stream it uninspected

    @memcpy(buf[0..prefix_bytes.len], prefix_bytes);
    var filled = prefix_bytes.len;
    while (filled < wire_total) {
        const n = client.readSome(io, buf[filled..wire_total]);
        if (n == 0) break; // client closed early — inspect what we have
        filled += n;
    }
    return .{ .forward = buf[0..filled], .body = buf[head.head_len..filled] };
}

fn contentLength(head: http.RequestHead) ?usize {
    const value = head.header("content-length") orelse return null;
    return std.fmt.parseInt(usize, std.mem.trim(u8, value, " \t"), 10) catch null;
}

const ResponsePrefix = struct {
    /// The response bytes read so far (head, plus any body prefix in the same
    /// read), destined for the client.
    bytes: []u8,
    /// The parsed response head, or null on EOF/oversize/malformed (bytes are
    /// then forwarded transparently).
    head: ?http.ResponseHead,
};

/// Read from `upstream` until the HTTP response head is complete, parsing it.
/// Mirrors `readRequestHead` for the origin→client direction.
fn readResponseHead(io: std.Io, upstream: net.Stream, buf: []u8, storage: []http.Header) ResponsePrefix {
    var filled: usize = 0;
    while (filled < buf.len) {
        if (http.parseResponse(buf[0..filled], storage)) |maybe_head| {
            if (maybe_head) |head| return .{ .bytes = buf[0..filled], .head = head };
        } else |_| {
            return .{ .bytes = buf[0..filled], .head = null }; // malformed
        }
        var vec: [1][]u8 = .{buf[filled..]};
        const n = upstream.read(io, &vec) catch return .{ .bytes = buf[0..filled], .head = null };
        if (n == 0) return .{ .bytes = buf[0..filled], .head = null }; // EOF before head
        filled += n;
    }
    return .{ .bytes = buf[0..filled], .head = null }; // head larger than the buffer
}

/// Buffer the response body (bounded by Content-Length and `buf`) so the WAF can
/// inspect phase 4. Returns null when there is no declared body or it is too
/// large / not length-framed (chunked, close-delimited), in which case the
/// caller forwards `prefix_bytes` and streams the body uninspected.
fn readResponseBody(io: std.Io, upstream: net.Stream, head: http.ResponseHead, prefix_bytes: []const u8, buf: []u8) ?Buffered {
    const content_length = contentLengthResponse(head) orelse return null;
    if (content_length == 0) return null;
    const wire_total = head.head_len + content_length;
    if (wire_total > buf.len) return null; // too large — stream it uninspected

    @memcpy(buf[0..prefix_bytes.len], prefix_bytes);
    var filled = prefix_bytes.len;
    while (filled < wire_total) {
        var vec: [1][]u8 = .{buf[filled..wire_total]};
        const n = upstream.read(io, &vec) catch break;
        if (n == 0) break; // origin closed early — inspect what we have
        filled += n;
    }
    return .{ .forward = buf[0..filled], .body = buf[head.head_len..filled] };
}

fn contentLengthResponse(head: http.ResponseHead) ?usize {
    const value = head.header("content-length") orelse return null;
    return std.fmt.parseInt(usize, std.mem.trim(u8, value, " \t"), 10) catch null;
}

/// Forward the buffered request to the origin with `X-Forwarded-For` and
/// `X-Forwarded-Proto` set to what this proxy observed.
///
/// Any client-supplied forwarding headers are **dropped**, not appended to. The
/// origin cannot tell which hop wrote which value in a comma-joined list, so
/// appending would let a client prepend an address of its choosing and have the
/// origin read it as the client address — spoofing whatever the origin does with
/// it: rate limits, geo rules, audit records, allowlists. The proxy is the only
/// party that knows who actually connected, so its observation replaces the
/// claim rather than joining it.
///
/// This proxy does not (yet) support being deployed behind another trusted
/// proxy. Doing that safely needs a configured list of trusted hops, and in its
/// absence the safe behaviour is to trust nothing forwarded.
///
/// When the head could not be parsed or the peer is unknown, the bytes are
/// forwarded verbatim — including any client XFF, since without a parsed head
/// there is no reliable way to remove it. That combination cannot be reached
/// from the inspection path, which requires a parsed head.
fn forwardRequest(out: anytype, forward: []const u8, head: ?http.RequestHead, peer: ?Peer) !void {
    if (head) |h| if (peer) |p| {
        var xff_buffer: [96]u8 = undefined;
        const xff = std.fmt.bufPrint(
            &xff_buffer,
            "X-Forwarded-For: {s}\r\nX-Forwarded-Proto: http\r\n",
            .{p.address},
        ) catch "";
        if (xff.len != 0 and h.head_len >= 4 and h.head_len <= forward.len) {
            try writeHeadWithoutForwardingHeaders(out, forward[0..h.head_len]);
            try out.writeAll(xff);
            try out.writeAll("\r\n"); // the head's terminating blank line
            try out.writeAll(forward[h.head_len..]);
            return;
        }
    };
    try out.writeAll(forward);
}

/// Header names a client must not be able to dictate, because the origin reads
/// them as statements by the proxy about who connected.
const stripped_request_headers = [_][]const u8{
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-real-ip",
};

/// Copy `head` (request line + headers, through its terminating blank line)
/// to `out`, omitting the forwarding headers and the blank line itself.
///
/// Splitting on CRLF is safe here because the head has already been parsed as
/// well-formed: a header line cannot contain a bare CR or LF.
fn writeHeadWithoutForwardingHeaders(out: anytype, head: []const u8) !void {
    var remaining = head;
    var first = true;
    while (remaining.len != 0) {
        const line_end = std.mem.indexOf(u8, remaining, "\r\n") orelse remaining.len;
        const line = remaining[0..line_end];
        remaining = remaining[@min(line_end + 2, remaining.len)..];
        if (line.len == 0) break; // the blank line; the caller writes its own

        // The request line is never a header, so it is never a candidate for
        // stripping — a target containing a colon must not be mistaken for one.
        const strip = !first and blk: {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse break :blk false;
            const name = std.mem.trim(u8, line[0..colon], " \t");
            for (stripped_request_headers) |candidate| {
                if (std.ascii.eqlIgnoreCase(name, candidate)) break :blk true;
            }
            break :blk false;
        };
        first = false;
        if (strip) continue;
        try out.writeAll(line);
        try out.writeAll("\r\n");
    }
}

const Peer = struct { address: []const u8, port: u16 };

/// The connected peer's address (formatted into `buf`) and port, for the WAF's
/// REMOTE_ADDR / REMOTE_PORT. IPv4 as a dotted quad, IPv6 in canonical text, and
/// an IPv4-mapped IPv6 address unmapped to the dotted quad it actually is.
/// Returns null only for an address family no rule can match, so the caller falls
/// back to a placeholder.
fn peerAddress(stream: net.Stream, buf: []u8) ?Peer {
    var storage: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(storage));
    std.posix.getpeername(stream.socket.handle, @ptrCast(&storage), &len) catch return null;
    switch (storage.family) {
        std.posix.AF.INET => {
            const in: *const std.posix.sockaddr.in = @ptrCast(@alignCast(&storage));
            const octets: [4]u8 = @bitCast(in.addr);
            return .{
                .address = formatIp4(buf, octets) orelse return null,
                .port = std.mem.bigToNative(u16, in.port),
            };
        },
        std.posix.AF.INET6 => {
            const in6: *const std.posix.sockaddr.in6 = @ptrCast(@alignCast(&storage));
            const port = std.mem.bigToNative(u16, in6.port);
            // An IPv4 client reaching a dual-stack listener arrives as
            // ::ffff:a.b.c.d. Reporting that form would break every IPv4 rule the
            // operator wrote — an `@ipMatch 10.0.0.0/8` allowlist silently stops
            // matching the hosts it was written for — so it is unmapped back to the
            // dotted quad it actually is.
            if (std.mem.eql(u8, in6.addr[0..12], &[_]u8{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff })) {
                const octets: [4]u8 = in6.addr[12..16].*;
                return .{ .address = formatIp4(buf, octets) orelse return null, .port = port };
            }
            // Canonical IPv6 text, via the standard library's formatter, so the
            // zero-run compression matches what an operator writes in a rule.
            // Deliberately without brackets or a port: REMOTE_ADDR is an address.
            const unresolved: net.Ip6Address.Unresolved = .{ .bytes = in6.addr, .interface_name = null };
            const address = std.fmt.bufPrint(buf, "{f}", .{unresolved}) catch return null;
            return .{ .address = address, .port = port };
        },
        else => return null, // a unix socket has no address a rule can match
    }
}

fn formatIp4(buf: []u8, octets: [4]u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{
        octets[0], octets[1], octets[2], octets[3],
    }) catch null;
}

/// Write a minimal 403 response to a blocked client. Best-effort — errors are
/// ignored since the connection is being dropped anyway.
fn sendForbidden(io: std.Io, client: Client) void {
    const response =
        "HTTP/1.1 403 Forbidden\r\n" ++
        "Content-Type: text/plain\r\n" ++
        "Content-Length: 10\r\n" ++
        "Connection: close\r\n" ++
        "\r\n" ++
        "Forbidden\n";
    _ = client.writeAll(io, response);
}

// ---- tests --------------------------------------------------------------

test "parsePort accepts valid ports and rejects the rest" {
    try std.testing.expectEqual(@as(?u16, 8080), parsePort("8080"));
    try std.testing.expectEqual(@as(?u16, 1), parsePort("1"));
    try std.testing.expectEqual(@as(?u16, null), parsePort(null));
    try std.testing.expectEqual(@as(?u16, null), parsePort("nope"));
    try std.testing.expectEqual(@as(?u16, null), parsePort("70000")); // > u16
}

test "IpAddress.parse yields the requested port for v4 and v6 literals" {
    const v4 = try net.IpAddress.parse("127.0.0.1", 8080);
    try std.testing.expectEqual(@as(u16, 8080), v4.getPort());
    const v6 = try net.IpAddress.parse("::1", 443);
    try std.testing.expectEqual(@as(u16, 443), v6.getPort());
    // A non-address string is rejected (the exact error is version-specific).
    if (net.IpAddress.parse("not-an-ip", 80)) |_| return error.ExpectedParseFailure else |_| {}
}

test "forwarding replaces client-supplied forwarding headers rather than appending" {
    // A client that sends its own X-Forwarded-For is trying to tell the origin who
    // it is. The origin cannot tell which hop wrote which entry of a comma-joined
    // list, so appending would let the client's claim be read as the client address
    // and spoof whatever depends on it: rate limits, geo rules, allowlists, audit.
    const request =
        "GET /admin HTTP/1.1\r\n" ++
        "Host: example.com\r\n" ++
        "X-Forwarded-For: 10.0.0.1\r\n" ++
        "x-real-ip: 10.0.0.2\r\n" ++
        "X-Forwarded-Proto: https\r\n" ++
        "User-Agent: curl/8.4.0\r\n" ++
        "\r\n";

    var storage: [16]http.Header = undefined;
    const head = (try http.parse(request, &storage)).?;

    var buffer: [1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    try forwardRequest(&writer, request, head, .{ .address = "203.0.113.9", .port = 51234 });

    const forwarded = writer.buffered();
    // What the proxy observed is what the origin sees, exactly once.
    try std.testing.expect(std.mem.indexOf(u8, forwarded, "X-Forwarded-For: 203.0.113.9\r\n") != null);
    try std.testing.expectEqual(@as(?usize, null), std.mem.indexOf(u8, forwarded, "10.0.0.1"));
    try std.testing.expectEqual(@as(?usize, null), std.mem.indexOf(u8, forwarded, "10.0.0.2"));
    // The client's protocol claim goes too: "https" from a plaintext hop is a lie
    // the origin might use to decide a cookie is safe to set.
    try std.testing.expect(std.mem.indexOf(u8, forwarded, "X-Forwarded-Proto: http\r\n") != null);
    try std.testing.expectEqual(@as(?usize, null), std.mem.indexOf(u8, forwarded, "https"));

    // Everything else survives untouched, including the request line and the blank
    // line that ends the head.
    try std.testing.expect(std.mem.startsWith(u8, forwarded, "GET /admin HTTP/1.1\r\n"));
    try std.testing.expect(std.mem.indexOf(u8, forwarded, "Host: example.com\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, forwarded, "User-Agent: curl/8.4.0\r\n") != null);
    try std.testing.expect(std.mem.endsWith(u8, forwarded, "\r\n\r\n"));
    // Exactly one blank line: a second would end the head early and turn the rest
    // into a body the origin might parse as another request.
    try std.testing.expectEqual(@as(?usize, forwarded.len - 4), std.mem.indexOf(u8, forwarded, "\r\n\r\n"));
}

test "a body is forwarded unchanged, and a target containing a colon is not a header" {
    const request =
        "POST /a:b?x=1 HTTP/1.1\r\n" ++
        "Host: example.com\r\n" ++
        "Content-Length: 5\r\n" ++
        "\r\n" ++
        "hello";

    var storage: [16]http.Header = undefined;
    const head = (try http.parse(request, &storage)).?;

    var buffer: [1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    try forwardRequest(&writer, request, head, .{ .address = "203.0.113.9", .port = 51234 });
    const out = struct { items: []const u8 }{ .items = writer.buffered() };

    // The request line survives even though it contains a colon, which a naive
    // header split would treat as a header name and could strip.
    try std.testing.expect(std.mem.startsWith(u8, out.items, "POST /a:b?x=1 HTTP/1.1\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, out.items, "\r\n\r\nhello"));
    try std.testing.expect(std.mem.indexOf(u8, out.items, "Content-Length: 5\r\n") != null);
}
