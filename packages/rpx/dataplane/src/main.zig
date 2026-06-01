//! rpx dataplane (prototype): a native reverse-proxy hot path.
//!
//! Thesis: Bun's proxy is body-bound because every byte is copied through JS
//! userspace + GC (~3x behind nginx on HTML). For *proxying*, nginx also copies
//! through userspace — so a no-GC, no-per-request-alloc native proxy should match
//! nginx, and on Linux `splice()` (kernel→kernel, zero-copy) goes *past* it,
//! since we then move bytes nginx still copies.
//!
//! This v0 is a transparent 1:1 TCP proxy (each client connection gets its own
//! upstream connection) driven by a single-threaded non-blocking `poll()` loop.
//! Run N copies with SO_REUSEPORT for multi-core (the bench does this, like it
//! does for the Bun workers). Plaintext only; the Bun control plane owns TLS,
//! certs, routing, /etc/hosts, DNS — the dataplane just moves bytes fast.
//!
//! Data movement is abstracted behind `Direction`: a userspace copy everywhere
//! (portable, runs on macOS), and `splice()` via a pipe on Linux (the path that
//! beats nginx). Select with `-Doptimize=ReleaseFast` for real numbers.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;

const use_splice = builtin.os.tag == .linux;
const BUF_SIZE: usize = 64 * 1024;
const MAX_CONNS: usize = 4096;

var upstream_addr: std.net.Address = undefined;

pub fn main() !void {
    var args = std.process.args();
    _ = args.next(); // argv[0]
    const listen_port = parsePort(args.next()) orelse fatal("usage: rpx-dataplane <listenPort> <upstreamHost> <upstreamPort>");
    const up_host = args.next() orelse fatal("missing upstream host");
    const up_port = parsePort(args.next()) orelse fatal("missing upstream port");

    upstream_addr = try resolve(up_host, up_port);

    const listen_fd = try openListener(listen_port);
    defer posix.close(listen_fd);

    try eventLoop(listen_fd);
}

fn parsePort(s: ?[]const u8) ?u16 {
    const v = s orelse return null;
    return std.fmt.parseInt(u16, v, 10) catch null;
}

fn fatal(comptime msg: []const u8) noreturn {
    std.debug.print("rpx-dataplane: {s}\n", .{msg});
    std.process.exit(1);
}

fn resolve(host: []const u8, port: u16) !std.net.Address {
    // The bench always points at 127.0.0.1; parse it directly (no resolver dep).
    return std.net.Address.parseIp(host, port) catch blk: {
        const list = try std.net.getAddressList(std.heap.page_allocator, host, port);
        defer list.deinit();
        if (list.addrs.len == 0) return error.UnknownHost;
        break :blk list.addrs[0];
    };
}

fn openListener(port: u16) !posix.fd_t {
    const addr = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, port);
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM | posix.SOCK.NONBLOCK, posix.IPPROTO.TCP);
    errdefer posix.close(fd);
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
    // SO_REUSEPORT: kernel load-balances accepted connections across the N copies
    // the bench spawns — the same multi-core model nginx/rpx use.
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEPORT, &std.mem.toBytes(@as(c_int, 1)));
    try posix.bind(fd, &addr.any, addr.getOsSockLen());
    try posix.listen(fd, 1024);
    return fd;
}

/// One half of a connection: move bytes from `src` to `dst`. Userspace copy
/// everywhere; on Linux a pipe + `splice()` makes it zero-copy (kernel→kernel).
const Direction = struct {
    src: posix.fd_t,
    dst: posix.fd_t,
    src_eof: bool = false,
    done: bool = false, // src_eof AND everything in flight has been written

    // copy path
    buf: if (use_splice) void else []u8 = if (use_splice) {} else undefined,
    len: usize = 0,
    off: usize = 0,

    // splice path
    pipe_r: if (use_splice) posix.fd_t else void = if (use_splice) -1 else {},
    pipe_w: if (use_splice) posix.fd_t else void = if (use_splice) -1 else {},
    in_pipe: usize = 0,

    fn init(self: *Direction, alloc: std.mem.Allocator) !void {
        if (use_splice) {
            const fds = try posix.pipe();
            self.pipe_r = fds[0];
            self.pipe_w = fds[1];
        } else {
            self.buf = try alloc.alloc(u8, BUF_SIZE);
        }
    }

    fn deinit(self: *Direction, alloc: std.mem.Allocator) void {
        if (use_splice) {
            if (self.pipe_r != -1) posix.close(self.pipe_r);
            if (self.pipe_w != -1) posix.close(self.pipe_w);
        } else {
            alloc.free(self.buf);
        }
    }

    /// Bytes buffered/in-flight, waiting to be written to `dst`.
    fn pending(self: *const Direction) usize {
        return if (use_splice) self.in_pipe else self.len - self.off;
    }

    /// Room to read more from `src` (don't read until what we have is written).
    fn wantRead(self: *const Direction) bool {
        return !self.src_eof and self.pending() == 0;
    }

    fn wantWrite(self: *const Direction) bool {
        return self.pending() > 0;
    }

    /// `src` is readable: pull bytes in. Returns false on hard error.
    fn onReadable(self: *Direction) bool {
        if (use_splice) {
            // socket → pipe (kernel buffer), no userspace copy.
            const n = linuxSplice(self.src, self.pipe_w, BUF_SIZE) catch |e| {
                return e == error.WouldBlock;
            };
            if (n == 0) {
                self.markEof();
            } else {
                self.in_pipe += n;
            }
            return true;
        } else {
            const n = posix.read(self.src, self.buf) catch |e| {
                return e == error.WouldBlock;
            };
            if (n == 0) {
                self.markEof();
            } else {
                self.len = n;
                self.off = 0;
            }
            return true;
        }
    }

    /// `dst` is writable: push buffered bytes out. Returns false on hard error.
    fn onWritable(self: *Direction) bool {
        if (use_splice) {
            const n = linuxSplice(self.pipe_r, self.dst, self.in_pipe) catch |e| {
                return e == error.WouldBlock;
            };
            self.in_pipe -= n;
        } else {
            const n = posix.write(self.dst, self.buf[self.off..self.len]) catch |e| {
                return e == error.WouldBlock;
            };
            self.off += n;
            if (self.off >= self.len) {
                self.len = 0;
                self.off = 0;
            }
        }
        // Source already hit EOF and we've now drained everything → propagate the
        // half-close downstream so the peer sees the end of the response.
        if (self.src_eof and self.pending() == 0 and !self.done) {
            self.done = true;
            posix.shutdown(self.dst, .send) catch {};
        }
        return true;
    }

    fn markEof(self: *Direction) void {
        self.src_eof = true;
        if (self.pending() == 0 and !self.done) {
            self.done = true;
            posix.shutdown(self.dst, .send) catch {};
        }
    }
};

const Conn = struct {
    client: posix.fd_t,
    upstream: posix.fd_t,
    c2u: Direction, // client → upstream
    u2c: Direction, // upstream → client

    fn finished(self: *const Conn) bool {
        return self.c2u.done and self.u2c.done;
    }
};

fn linuxSplice(from: posix.fd_t, to: posix.fd_t, max: usize) !usize {
    const SPLICE_F_MOVE: usize = 1;
    const SPLICE_F_NONBLOCK: usize = 2;
    const rc = std.os.linux.syscall6(
        .splice,
        @as(usize, @bitCast(@as(isize, from))),
        0,
        @as(usize, @bitCast(@as(isize, to))),
        0,
        max,
        SPLICE_F_MOVE | SPLICE_F_NONBLOCK,
    );
    const signed: isize = @bitCast(rc);
    if (signed >= 0) return @intCast(signed);
    const err: posix.E = @enumFromInt(@as(usize, @bitCast(-signed)));
    return switch (err) {
        .AGAIN => error.WouldBlock,
        else => error.SpliceFailed,
    };
}

fn eventLoop(listen_fd: posix.fd_t) !void {
    const alloc = std.heap.page_allocator;
    var conns: [MAX_CONNS]?*Conn = .{null} ** MAX_CONNS;
    var n_conns: usize = 0;

    // pollfds: listener + up to 2 fds per connection.
    var pollfds: [1 + MAX_CONNS * 2]posix.pollfd = undefined;
    // Map each pollfd slot (beyond the listener) back to its conn + which fd.
    var slot_conn: [MAX_CONNS * 2]usize = undefined;
    var slot_is_client: [MAX_CONNS * 2]bool = undefined;

    while (true) {
        // Build the pollfd set for this iteration.
        pollfds[0] = .{ .fd = listen_fd, .events = posix.POLL.IN, .revents = 0 };
        var nfds: usize = 1;
        for (conns, 0..) |maybe, ci| {
            const c = maybe orelse continue;
            var cev: i16 = 0;
            var uev: i16 = 0;
            if (c.c2u.wantRead()) cev |= posix.POLL.IN; // read from client
            if (c.u2c.wantWrite()) cev |= posix.POLL.OUT; // write to client
            if (c.u2c.wantRead()) uev |= posix.POLL.IN; // read from upstream
            if (c.c2u.wantWrite()) uev |= posix.POLL.OUT; // write to upstream
            if (cev != 0) {
                pollfds[nfds] = .{ .fd = c.client, .events = cev, .revents = 0 };
                slot_conn[nfds - 1] = ci;
                slot_is_client[nfds - 1] = true;
                nfds += 1;
            }
            if (uev != 0) {
                pollfds[nfds] = .{ .fd = c.upstream, .events = uev, .revents = 0 };
                slot_conn[nfds - 1] = ci;
                slot_is_client[nfds - 1] = false;
                nfds += 1;
            }
        }

        _ = posix.poll(pollfds[0..nfds], -1) catch |e| {
            if (e == error.SignalInterrupt) continue;
            return e;
        };

        // Accept new connections.
        if (pollfds[0].revents & posix.POLL.IN != 0) {
            while (n_conns < MAX_CONNS) {
                const cfd = posix.accept(listen_fd, null, null, posix.SOCK.NONBLOCK) catch break;
                const conn = acceptConn(alloc, cfd) catch {
                    posix.close(cfd);
                    continue;
                };
                // Park it in the first free slot.
                for (&conns) |*slot| {
                    if (slot.* == null) {
                        slot.* = conn;
                        n_conns += 1;
                        break;
                    }
                }
            }
        }

        // Service ready connection fds.
        var i: usize = 1;
        while (i < nfds) : (i += 1) {
            const re = pollfds[i].revents;
            if (re == 0) continue;
            const ci = slot_conn[i - 1];
            const c = conns[ci] orelse continue;
            const is_client = slot_is_client[i - 1];
            var ok = true;
            if (re & (posix.POLL.IN | posix.POLL.HUP) != 0) {
                ok = if (is_client) c.c2u.onReadable() else c.u2c.onReadable();
            }
            if (ok and re & posix.POLL.OUT != 0) {
                ok = if (is_client) c.u2c.onWritable() else c.c2u.onWritable();
            }
            if (!ok or re & posix.POLL.ERR != 0) {
                closeConn(alloc, &conns, ci, &n_conns);
                continue;
            }
            if (c.finished()) {
                closeConn(alloc, &conns, ci, &n_conns);
            }
        }
    }
}

fn acceptConn(alloc: std.mem.Allocator, client_fd: posix.fd_t) !*Conn {
    const up_fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM | posix.SOCK.NONBLOCK, posix.IPPROTO.TCP);
    errdefer posix.close(up_fd);
    setNoDelay(client_fd);
    setNoDelay(up_fd);
    // Non-blocking connect to a localhost upstream completes ~immediately; treat
    // EINPROGRESS as success (poll will surface real failures as POLL.ERR).
    posix.connect(up_fd, &upstream_addr.any, upstream_addr.getOsSockLen()) catch |e| {
        if (e != error.WouldBlock and e != error.ConnectionPending) return e;
    };

    const conn = try alloc.create(Conn);
    errdefer alloc.destroy(conn);
    conn.* = .{
        .client = client_fd,
        .upstream = up_fd,
        .c2u = .{ .src = client_fd, .dst = up_fd },
        .u2c = .{ .src = up_fd, .dst = client_fd },
    };
    try conn.c2u.init(alloc);
    errdefer conn.c2u.deinit(alloc);
    try conn.u2c.init(alloc);
    return conn;
}

fn closeConn(alloc: std.mem.Allocator, conns: *[MAX_CONNS]?*Conn, ci: usize, n_conns: *usize) void {
    const c = conns[ci] orelse return;
    posix.close(c.client);
    posix.close(c.upstream);
    c.c2u.deinit(alloc);
    c.u2c.deinit(alloc);
    alloc.destroy(c);
    conns[ci] = null;
    n_conns.* -= 1;
}

fn setNoDelay(fd: posix.fd_t) void {
    posix.setsockopt(fd, posix.IPPROTO.TCP, posix.TCP.NODELAY, &std.mem.toBytes(@as(c_int, 1))) catch {};
}
