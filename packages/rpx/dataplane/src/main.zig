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
const net = std.Io.net;

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

/// Proxy one client connection. In a non-WAF build this is a transparent
/// bidirectional pump. In a -Dwaf build it is an HTTP/1.1 request loop: every
/// request on the connection (not just the first) is inspected through the WAF's
/// request phases, and every origin response through the response phases, so
/// keep-alive follow-ups cannot bypass the WAF. When a message is framed in a
/// way we cannot delimit (chunked, close-delimited, oversize, upgrade), we
/// forward what we have and fall back to a transparent pump for the remainder.
fn handleConn(io: std.Io, client: net.Stream) void {
    defer client.close(io);
    const upstream = upstream_addr.connect(io, .{ .mode = .stream }) catch return;
    defer upstream.close(io);

    if (!build_options.has_waf) {
        pumpBoth(io, client, upstream);
        return;
    }

    // Resolve the real client IP/port once per connection for REMOTE_ADDR /
    // REMOTE_PORT. IPv6 peers fall back to a placeholder.
    var address_buf: [64]u8 = undefined;
    const peer: ?Peer = peerAddress(client, &address_buf);
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

/// Pump both directions of a connection concurrently until each side closes.
fn pumpBoth(io: std.Io, client: net.Stream, upstream: net.Stream) void {
    var group: std.Io.Group = .init;
    defer group.cancel(io);
    group.async(io, pump, .{ io, client, upstream });
    pump(io, upstream, client);
    group.await(io) catch {};
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
    client: net.Stream,
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
        _ = forwardAll(io, client, resp_prefix.bytes);
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
    if (!forwardAll(io, client, resp_forward)) return .close;

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
fn readRequestHead(io: std.Io, client: net.Stream, buf: []u8, storage: []http.Header) HeadPrefix {
    var filled: usize = 0;
    while (filled < buf.len) {
        if (http.parse(buf[0..filled], storage)) |maybe_head| {
            if (maybe_head) |head| return .{ .bytes = buf[0..filled], .head = head };
        } else |_| {
            return .{ .bytes = buf[0..filled], .head = null }; // malformed
        }
        var vec: [1][]u8 = .{buf[filled..]};
        const n = client.read(io, &vec) catch return .{ .bytes = buf[0..filled], .head = null };
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
fn readBody(io: std.Io, client: net.Stream, head: http.RequestHead, prefix_bytes: []const u8, buf: []u8) ?Buffered {
    const content_length = contentLength(head) orelse return null;
    if (content_length == 0) return null;
    const wire_total = head.head_len + content_length;
    if (wire_total > buf.len) return null; // too large — stream it uninspected

    @memcpy(buf[0..prefix_bytes.len], prefix_bytes);
    var filled = prefix_bytes.len;
    while (filled < wire_total) {
        var vec: [1][]u8 = .{buf[filled..wire_total]};
        const n = client.read(io, &vec) catch break;
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

/// Forward the buffered request to the origin, inserting `X-Forwarded-For` and
/// `X-Forwarded-Proto` just before the head's blank line when the request head
/// was parsed and the client's IPv4 address is known. Otherwise the bytes are
/// forwarded verbatim. (Client-supplied XFF is not yet stripped — follow-up.)
fn forwardRequest(out: anytype, forward: []const u8, head: ?http.RequestHead, peer: ?Peer) !void {
    if (head) |h| if (peer) |p| {
        var xff_buffer: [96]u8 = undefined;
        const xff = std.fmt.bufPrint(&xff_buffer, "X-Forwarded-For: {s}\r\nX-Forwarded-Proto: http\r\n", .{p.address}) catch "";
        const split = h.head_len -| 2; // just before the head's terminating blank line
        if (xff.len != 0 and split >= 4 and split <= forward.len) {
            try out.writeAll(forward[0..split]);
            try out.writeAll(xff);
            try out.writeAll(forward[split..]);
            return;
        }
    };
    try out.writeAll(forward);
}

const Peer = struct { address: []const u8, port: u16 };

/// The connected peer's IPv4 address (`a.b.c.d`, formatted into `buf`) and port,
/// for the WAF's REMOTE_ADDR / REMOTE_PORT. Returns null for an IPv6 peer or on
/// error, so the caller falls back to a placeholder; canonical IPv6 formatting
/// is a follow-up.
fn peerAddress(stream: net.Stream, buf: []u8) ?Peer {
    var storage: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(storage));
    std.posix.getpeername(stream.socket.handle, @ptrCast(&storage), &len) catch return null;
    if (storage.family != std.posix.AF.INET) return null;
    const in: *const std.posix.sockaddr.in = @ptrCast(@alignCast(&storage));
    const octets: [4]u8 = @bitCast(in.addr);
    const address = std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ octets[0], octets[1], octets[2], octets[3] }) catch return null;
    return .{ .address = address, .port = std.mem.bigToNative(u16, in.port) };
}

/// Write a minimal 403 response to a blocked client. Best-effort — errors are
/// ignored since the connection is being dropped anyway.
fn sendForbidden(io: std.Io, client: net.Stream) void {
    const response =
        "HTTP/1.1 403 Forbidden\r\n" ++
        "Content-Type: text/plain\r\n" ++
        "Content-Length: 10\r\n" ++
        "Connection: close\r\n" ++
        "\r\n" ++
        "Forbidden\n";
    var writer = client.writer(io, &.{});
    writer.interface.writeAll(response) catch {};
}

/// Move bytes from `src` to `dst` until EOF, then half-close `dst`'s send side
/// so the peer observes the end of the stream. A read/write error tears the
/// direction down; the connection's `defer close` cleans up the sockets.
fn pump(io: std.Io, src: net.Stream, dst: net.Stream) void {
    var buf: [BUF_SIZE]u8 = undefined;
    // An empty writer buffer makes writes go straight through to the socket
    // (no second copy), which is what a proxy wants.
    var writer = dst.writer(io, &.{});
    while (true) {
        var vec: [1][]u8 = .{&buf};
        const n = src.read(io, &vec) catch return;
        if (n == 0) {
            dst.shutdown(io, .send) catch {};
            return;
        }
        writer.interface.writeAll(buf[0..n]) catch return;
    }
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
