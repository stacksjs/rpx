//! zig-waf request inspection over the C connector ABI.
//!
//! Compiled into the dataplane only when the build is configured with `-Dwaf`
//! (which also links `libzig-waf.a`, `liblmdb.a`, and the header). `init` stands
//! up a rules-loaded WAF; `inspect` runs a request head through the engine and
//! returns true when the request must be blocked. The compiled plan is
//! immutable, so evaluating from many connection tasks concurrently is safe.

const std = @import("std");
const http = @import("http");
const c = @import("waf_c");

/// The shared, rules-loaded WAF; built once in `init`.
var handle: ?*c.zig_waf_t = null;

/// Compile `rules` (a SecLang config) and stand up the WAF. Returns false on a
/// parse/compile error.
pub fn init(rules: []const u8) bool {
    var config: c.zig_waf_config_t = std.mem.zeroes(c.zig_waf_config_t);
    config.struct_size = @sizeOf(c.zig_waf_config_t);
    config.abi_version = c.ZIG_WAF_ABI_VERSION;
    config.mode = c.ZIG_WAF_MODE_ENABLED;
    config.max_request_target_bytes = 64 * 1024;
    config.max_header_count = 256;
    config.max_header_bytes = 64 * 1024;
    config.max_request_body_bytes = 1024 * 1024;
    config.max_response_body_bytes = 1024 * 1024;
    var created: ?*c.zig_waf_t = null;
    if (c.zig_waf_create_with_rules(&config, rules.ptr, rules.len, &created) != c.ZIG_WAF_OK) return false;
    handle = created;
    return true;
}

/// Run `head` through the request-headers phase; true means an enforced
/// intervention fired and the caller should block. Fails open (returns false)
/// on any ABI error so a WAF hiccup never takes the proxy down.
pub fn inspect(head: http.RequestHead) bool {
    const waf = handle orelse return false;
    var tx: ?*c.zig_waf_transaction_t = null;
    if (c.zig_waf_transaction_create(waf, &tx) != c.ZIG_WAF_OK) return false;
    defer c.zig_waf_transaction_destroy(tx);

    const loopback = "127.0.0.1";
    _ = c.zig_waf_transaction_process_connection(tx, loopback, loopback.len, 1, loopback, loopback.len, 80);
    if (c.zig_waf_transaction_process_uri(tx, head.target.ptr, head.target.len, head.method.ptr, head.method.len, head.version.ptr, head.version.len) != c.ZIG_WAF_OK)
        return false;
    for (head.headers) |field| {
        _ = c.zig_waf_transaction_add_request_header(tx, field.name.ptr, field.name.len, field.value.ptr, field.value.len);
    }
    _ = c.zig_waf_transaction_process_request_headers(tx);
    _ = c.zig_waf_transaction_evaluate_phase(tx, c.ZIG_WAF_PHASE_REQUEST_HEADERS);

    var decision: c.zig_waf_intervention_t = std.mem.zeroes(c.zig_waf_intervention_t);
    decision.struct_size = @sizeOf(c.zig_waf_intervention_t);
    decision.abi_version = c.ZIG_WAF_ABI_VERSION;
    // OK means an intervention exists; NOT_FOUND means the request is allowed.
    return c.zig_waf_transaction_intervention(tx, &decision) == c.ZIG_WAF_OK and decision.enforced != 0;
}
