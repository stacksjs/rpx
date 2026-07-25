//! Server-side TLS termination via zig-tls (a pure-Zig TLS 1.2/1.3 stack built
//! on std.Io). Compiled into the dataplane only when the build is configured
//! with `-Dtls`. `init` loads the certificate/key pair once; `accept` performs
//! the handshake over an accepted client socket and returns a session whose
//! `readSome`/`writeAll` move plaintext (the raw socket carries ciphertext).

const std = @import("std");
const net = std.Io.net;
const tls = @import("tls");

pub const enabled = true;

/// The shared, immutable certificate/key pair; loaded once in `init` and read
/// concurrently by every connection's handshake.
var cert_key: ?tls.config.CertKeyPair = null;

/// Load the server certificate and private key from absolute PEM paths.
pub fn init(io: std.Io, cert_path: []const u8, key_path: []const u8) bool {
    const loaded = tls.config.CertKeyPair.fromFilePathAbsolute(std.heap.page_allocator, io, cert_path, key_path) catch return false;
    cert_key = loaded;
    return true;
}

/// A terminated-TLS session over one client connection. Heap-allocated so the
/// self-referential pointers are stable: `conn` holds `&reader.interface` /
/// `&writer.interface`, and those readers hold `&input_buf` / `&output_buf`.
pub const Session = struct {
    conn: tls.Connection,
    reader: net.Stream.Reader,
    writer: net.Stream.Writer,
    input_buf: [tls.input_buffer_len]u8,
    output_buf: [tls.output_buffer_len]u8,

    /// Read up to `buf.len` plaintext bytes; 0 on clean close or error.
    pub fn readSome(self: *Session, io: std.Io, buf: []u8) usize {
        _ = io; // io is captured in the reader/writer built at accept time
        return self.conn.read(buf) catch 0;
    }

    /// Write all of `bytes` as plaintext (encrypted onto the wire); false on
    /// error. Flush so the record reaches the socket immediately — otherwise a
    /// final response (e.g. a WAF 403) would be lost when the connection closes.
    pub fn writeAll(self: *Session, io: std.Io, bytes: []const u8) bool {
        _ = io;
        self.conn.writeAll(bytes) catch return false;
        self.writer.interface.flush() catch return false;
        return true;
    }

    pub fn deinit(self: *Session, io: std.Io) void {
        _ = io;
        self.conn.close() catch {};
        std.heap.page_allocator.destroy(self);
    }
};

/// Perform the server-side handshake over `stream`. Returns null when TLS is
/// unconfigured, allocation fails, or the handshake fails (caller drops the
/// connection). The returned session owns the raw stream's read/write path.
pub fn accept(io: std.Io, stream: net.Stream) ?*Session {
    const key = if (cert_key) |*value| value else return null;
    const self = std.heap.page_allocator.create(Session) catch return null;
    self.reader = stream.reader(io, &self.input_buf);
    self.writer = stream.writer(io, &self.output_buf);
    self.conn = tls.server(&self.reader.interface, &self.writer.interface, .{
        .auth = key,
    }) catch {
        std.heap.page_allocator.destroy(self);
        return null;
    };
    return self;
}
