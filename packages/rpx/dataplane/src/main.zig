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
const net = std.Io.net;

const BUF_SIZE: usize = 64 * 1024;

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

/// Proxy one client connection: open the upstream, then pump both directions
/// concurrently until each side closes.
fn handleConn(io: std.Io, client: net.Stream) void {
    defer client.close(io);
    const upstream = upstream_addr.connect(io, .{ .mode = .stream }) catch return;
    defer upstream.close(io);

    // One task pumps client→upstream while this fiber pumps upstream→client;
    // half-closes propagate independently (a slow response won't stall the
    // request side).
    var group: std.Io.Group = .init;
    defer group.cancel(io);
    group.async(io, pump, .{ io, client, upstream });
    pump(io, upstream, client);
    group.await(io) catch {};
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
