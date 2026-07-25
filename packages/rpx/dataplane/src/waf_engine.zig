//! zig-waf request/response inspection over the C connector ABI.
//!
//! Compiled into the dataplane only when the build is configured with `-Dwaf`
//! (which also links `libzig-waf.a`, `liblmdb.a`, and the header). `init` stands
//! up a rules-loaded WAF; a per-connection `Inspector` holds one transaction so
//! the request phases (1-2) and the response phases (3-4) share the same
//! anomaly-score accumulation — the way CRS's blocking-evaluation stages expect.
//! The compiled plan is immutable, so evaluating from many connection tasks
//! concurrently is safe.

const std = @import("std");
const http = @import("http");
const c = @import("waf_c");

/// The shared, rules-loaded WAF; built once in `init`.
var handle: ?*c.zig_waf_t = null;

/// Compile `rules` (a SecLang config) and stand up the WAF, resolving any
/// `@pmFromFile` / `@ipMatchFromFile` data files against `data_dir` (the rules
/// file's directory). Returns false on a parse/compile error.
pub fn init(rules: []const u8, data_dir: []const u8) bool {
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
    if (c.zig_waf_create_with_rules_at(&config, rules.ptr, rules.len, data_dir.ptr, data_dir.len, &created) != c.ZIG_WAF_OK) return false;
    handle = created;
    return true;
}

/// A per-connection inspection context. It owns one WAF transaction across the
/// request and response phases; call `deinit` when the connection is done.
/// Every method fails open (returns false / does nothing) when the WAF is not
/// configured or the transaction could not be created, so a WAF hiccup never
/// takes the proxy down.
pub const Inspector = struct {
    tx: ?*c.zig_waf_transaction_t,

    /// Begin inspecting a connection: create a transaction and record the
    /// connection endpoints, using `client_address` for the WAF's REMOTE_ADDR
    /// (so @ipMatch / RBL / rate-limit rules see the real client). Returns an
    /// inert inspector when the WAF is disabled or a transaction cannot be
    /// created.
    pub fn begin(client_address: []const u8, client_port: u16) Inspector {
        const waf = handle orelse return .{ .tx = null };
        var tx: ?*c.zig_waf_transaction_t = null;
        if (c.zig_waf_transaction_create(waf, &tx) != c.ZIG_WAF_OK) return .{ .tx = null };
        const server = "127.0.0.1";
        _ = c.zig_waf_transaction_process_connection(tx, client_address.ptr, client_address.len, client_port, server, server.len, 80);
        return .{ .tx = tx };
    }

    pub fn deinit(self: *Inspector) void {
        if (self.tx) |tx| c.zig_waf_transaction_destroy(tx);
        self.tx = null;
    }

    /// Run `head` (and `body`, which may be empty) through the request-headers
    /// and request-body phases; true means an enforced intervention fired and
    /// the caller should reply 403 instead of forwarding to the origin.
    pub fn inspectRequest(self: *Inspector, head: http.RequestHead, body: []const u8) bool {
        const tx = self.tx orelse return false;
        if (c.zig_waf_transaction_process_uri(tx, head.target.ptr, head.target.len, head.method.ptr, head.method.len, head.version.ptr, head.version.len) != c.ZIG_WAF_OK)
            return false;
        for (head.headers) |field| {
            _ = c.zig_waf_transaction_add_request_header(tx, field.name.ptr, field.name.len, field.value.ptr, field.value.len);
        }

        _ = c.zig_waf_transaction_process_request_headers(tx);
        _ = c.zig_waf_transaction_evaluate_phase(tx, c.ZIG_WAF_PHASE_REQUEST_HEADERS);
        if (blocked(tx)) return true;

        if (body.len != 0) {
            _ = c.zig_waf_transaction_write_request_body(tx, body.ptr, body.len);
        }
        _ = c.zig_waf_transaction_process_request_body(tx);
        _ = c.zig_waf_transaction_evaluate_phase(tx, c.ZIG_WAF_PHASE_REQUEST_BODY);
        return blocked(tx);
    }

    /// Run the origin's response `head` (and `body`, which may be empty) through
    /// the response-headers and response-body phases; true means an enforced
    /// intervention fired (e.g. CRS data-leakage rules) and the caller should
    /// replace the origin response with a 403.
    pub fn inspectResponse(self: *Inspector, head: http.ResponseHead, body: []const u8) bool {
        const tx = self.tx orelse return false;
        for (head.headers) |field| {
            _ = c.zig_waf_transaction_add_response_header(tx, field.name.ptr, field.name.len, field.value.ptr, field.value.len);
        }
        _ = c.zig_waf_transaction_process_response_headers(tx, head.status, head.version.ptr, head.version.len);
        _ = c.zig_waf_transaction_evaluate_phase(tx, c.ZIG_WAF_PHASE_RESPONSE_HEADERS);
        if (blocked(tx)) return true;

        if (body.len != 0) {
            _ = c.zig_waf_transaction_write_response_body(tx, body.ptr, body.len);
        }
        _ = c.zig_waf_transaction_process_response_body(tx);
        _ = c.zig_waf_transaction_evaluate_phase(tx, c.ZIG_WAF_PHASE_RESPONSE_BODY);
        return blocked(tx);
    }
};

/// Whether the transaction has an enforced pending intervention.
fn blocked(tx: ?*c.zig_waf_transaction_t) bool {
    var decision: c.zig_waf_intervention_t = std.mem.zeroes(c.zig_waf_intervention_t);
    decision.struct_size = @sizeOf(c.zig_waf_intervention_t);
    decision.abi_version = c.ZIG_WAF_ABI_VERSION;
    // OK means an intervention exists; NOT_FOUND means allowed so far.
    return c.zig_waf_transaction_intervention(tx, &decision) == c.ZIG_WAF_OK and decision.enforced != 0;
}
