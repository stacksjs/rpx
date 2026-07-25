//! The no-WAF stand-in used when the build is not configured with `-Dwaf`.
//! Same interface as `waf_engine.zig`, but every call is a no-op so the
//! dataplane is a plain proxy with zero zig-waf dependency.

const http = @import("http");

pub fn init(_: []const u8) bool {
    return false;
}

pub fn inspect(_: http.RequestHead) bool {
    return false;
}
