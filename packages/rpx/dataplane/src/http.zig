//! Minimal, allocation-free HTTP/1.1 request-head parsing.
//!
//! The dataplane is a byte pump, but to route by host, add `X-Forwarded-*`, and
//! run requests through a WAF it must understand the request head. `parse`
//! reads the request line and headers out of a byte buffer, borrowing every
//! slice from the input (no copies) and writing header pointers into a
//! caller-provided array (no allocation). It returns `null` when the head is
//! not yet complete, so a reader can call it again after buffering more bytes.

const std = @import("std");

pub const Header = struct {
    name: []const u8,
    value: []const u8,
};

pub const Error = error{ Malformed, TooManyHeaders };

pub const RequestHead = struct {
    method: []const u8,
    target: []const u8,
    version: []const u8,
    /// Borrowed from the caller's storage; valid as long as the input buffer is.
    headers: []const Header,
    /// Total byte length of the head, through the terminating CRLF CRLF. The
    /// request body (if any) begins at `input[head_len..]`.
    head_len: usize,

    /// First header value matching `name` case-insensitively, or null.
    pub fn header(self: RequestHead, name: []const u8) ?[]const u8 {
        for (self.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }
};

/// Parse an HTTP/1.1 request head from `input`, storing headers in `storage`.
/// Returns null if the head is incomplete (caller should read more and retry),
/// or an error if it is malformed.
pub fn parse(input: []const u8, storage: []Header) Error!?RequestHead {
    const marker = std.mem.indexOf(u8, input, "\r\n\r\n") orelse return null;
    const head_len = marker + 4;
    const head = input[0..marker];

    var lines = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = lines.next() orelse return error.Malformed;

    // request-line: METHOD SP request-target SP HTTP-version
    var tokens = std.mem.splitScalar(u8, request_line, ' ');
    const method = tokens.next() orelse return error.Malformed;
    const target = tokens.next() orelse return error.Malformed;
    const version = tokens.next() orelse return error.Malformed;
    if (tokens.next() != null) return error.Malformed; // spurious extra token
    if (method.len == 0 or target.len == 0) return error.Malformed;
    if (!std.mem.startsWith(u8, version, "HTTP/")) return error.Malformed;

    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue; // tolerate a stray empty fold
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.Malformed;
        if (colon == 0) return error.Malformed; // empty field name
        if (count == storage.len) return error.TooManyHeaders;
        storage[count] = .{
            .name = line[0..colon],
            // Trim optional whitespace around the field value (RFC 9110 OWS).
            .value = std.mem.trim(u8, line[colon + 1 ..], " \t"),
        };
        count += 1;
    }

    return .{
        .method = method,
        .target = target,
        .version = version,
        .headers = storage[0..count],
        .head_len = head_len,
    };
}

// ---- tests --------------------------------------------------------------

test "parses a well-formed request head" {
    var storage: [16]Header = undefined;
    const input =
        "GET /path?q=1 HTTP/1.1\r\n" ++
        "Host: example.com\r\n" ++
        "User-Agent:  curl/8  \r\n" ++
        "\r\n" ++
        "body-bytes";
    const head = (try parse(input, &storage)).?;
    try std.testing.expectEqualStrings("GET", head.method);
    try std.testing.expectEqualStrings("/path?q=1", head.target);
    try std.testing.expectEqualStrings("HTTP/1.1", head.version);
    try std.testing.expectEqual(@as(usize, 2), head.headers.len);
    try std.testing.expectEqualStrings("example.com", head.header("host").?);
    // Field value OWS is trimmed on both sides.
    try std.testing.expectEqualStrings("curl/8", head.header("User-Agent").?);
    // head_len points just past the blank line; the body follows.
    try std.testing.expectEqualStrings("body-bytes", input[head.head_len..]);
}

test "an incomplete head returns null" {
    var storage: [8]Header = undefined;
    try std.testing.expect((try parse("GET / HTTP/1.1\r\nHost: x\r\n", &storage)) == null);
    try std.testing.expect((try parse("GET / HTTP/1.1\r\n", &storage)) == null);
    try std.testing.expect((try parse("", &storage)) == null);
}

test "malformed request lines are rejected" {
    var storage: [8]Header = undefined;
    try std.testing.expectError(error.Malformed, parse("GET /only-two-parts\r\n\r\n", &storage));
    try std.testing.expectError(error.Malformed, parse("GET / FTP/1.1\r\n\r\n", &storage));
    try std.testing.expectError(error.Malformed, parse("GET / HTTP/1.1\r\nbad-header-no-colon\r\n\r\n", &storage));
    try std.testing.expectError(error.Malformed, parse("GET / HTTP/1.1\r\n: empty-name\r\n\r\n", &storage));
}

test "too many headers overflow the storage" {
    var storage: [1]Header = undefined;
    try std.testing.expectError(error.TooManyHeaders, parse("GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\n\r\n", &storage));
}

test "a request with no headers parses" {
    var storage: [4]Header = undefined;
    const head = (try parse("DELETE /x HTTP/1.0\r\n\r\n", &storage)).?;
    try std.testing.expectEqualStrings("DELETE", head.method);
    try std.testing.expectEqual(@as(usize, 0), head.headers.len);
}
