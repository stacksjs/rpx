//! The no-TLS stand-in, used when the build is not configured with `-Dtls`.
//! Same interface as `tls_engine.zig`, but TLS is unavailable: `init` fails and
//! `accept` never produces a session, so the dataplane serves plaintext only.

const std = @import("std");
const net = std.Io.net;

pub const enabled = false;

/// Load a certificate/key pair. Always fails in the no-TLS build.
pub fn init(_: std.Io, _: []const u8, _: []const u8) bool {
    return false;
}

/// A terminated-TLS session over a client connection. Never constructed here.
pub const Session = opaque {
    pub fn readSome(_: *Session, _: std.Io, _: []u8) usize {
        return 0;
    }
    pub fn writeAll(_: *Session, _: std.Io, _: []const u8) bool {
        return false;
    }
    pub fn deinit(_: *Session, _: std.Io) void {}
};

/// Attempt a server-side TLS handshake over `stream`; always null (no TLS).
pub fn accept(_: std.Io, _: net.Stream) ?*Session {
    return null;
}
