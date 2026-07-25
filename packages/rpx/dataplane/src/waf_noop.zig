//! The no-WAF stand-in used when the build is not configured with `-Dwaf`.
//! Same interface as `waf_engine.zig`, but every call is a no-op so the
//! dataplane is a plain proxy with zero zig-waf dependency.

const http = @import("http");

pub fn init(_: []const u8, _: []const u8) bool {
    return false;
}

/// Mirror of `waf_engine.Inspector` with inert methods.
pub const Inspector = struct {
    pub fn begin(_: []const u8, _: u16) Inspector {
        return .{};
    }

    pub fn deinit(_: *Inspector) void {}

    pub fn inspectRequest(_: *Inspector, _: http.RequestHead, _: []const u8) bool {
        return false;
    }

    pub fn inspectResponse(_: *Inspector, _: http.ResponseHead, _: []const u8) bool {
        return false;
    }
};
