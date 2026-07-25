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

pub const ResponseHead = struct {
    version: []const u8,
    status: u16,
    /// Reason phrase (may be empty); borrowed from the input.
    reason: []const u8,
    /// Borrowed from the caller's storage; valid as long as the input buffer is.
    headers: []const Header,
    /// Byte length of the head through the terminating CRLF CRLF; the response
    /// body (if any) begins at `input[head_len..]`.
    head_len: usize,

    /// First header value matching `name` case-insensitively, or null.
    pub fn header(self: ResponseHead, name: []const u8) ?[]const u8 {
        for (self.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }
};

/// Parse an HTTP/1.1 response head from `input`, storing headers in `storage`.
/// Returns null if the head is incomplete, or an error if it is malformed. Used
/// to run the origin's response through the WAF's response phases before it is
/// forwarded to the client.
pub fn parseResponse(input: []const u8, storage: []Header) Error!?ResponseHead {
    const marker = std.mem.indexOf(u8, input, "\r\n\r\n") orelse return null;
    const head_len = marker + 4;
    const head = input[0..marker];

    var lines = std.mem.splitSequence(u8, head, "\r\n");
    const status_line = lines.next() orelse return error.Malformed;

    // status-line: HTTP-version SP status-code SP [reason-phrase]
    var tokens = std.mem.splitScalar(u8, status_line, ' ');
    const version = tokens.next() orelse return error.Malformed;
    const code = tokens.next() orelse return error.Malformed;
    const reason = tokens.rest(); // remainder, may be empty or contain spaces
    if (!std.mem.startsWith(u8, version, "HTTP/")) return error.Malformed;
    if (code.len != 3) return error.Malformed;
    const status = std.fmt.parseInt(u16, code, 10) catch return error.Malformed;
    if (status < 100 or status > 599) return error.Malformed;

    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.Malformed;
        if (colon == 0) return error.Malformed;
        if (count == storage.len) return error.TooManyHeaders;
        storage[count] = .{
            .name = line[0..colon],
            .value = std.mem.trim(u8, line[colon + 1 ..], " \t"),
        };
        count += 1;
    }

    return .{
        .version = version,
        .status = status,
        .reason = reason,
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

test "random bytes never crash the parser and yield only borrowed slices" {
    var prng = std.Random.DefaultPrng.init(0x4777_9A55_3F1C);
    const random = prng.random();
    var buffer: [512]u8 = undefined;
    var storage: [64]Header = undefined;
    var iteration: usize = 0;
    while (iteration < 5000) : (iteration += 1) {
        const len = random.uintLessThan(usize, buffer.len + 1);
        for (buffer[0..len]) |*byte| {
            // Bias toward request-line and header-framing bytes.
            byte.* = switch (random.uintLessThan(u8, 10)) {
                0 => ' ',
                1 => ':',
                2 => '\r',
                3 => '\n',
                4 => '/',
                5 => 'G',
                6 => 'H',
                7 => 'T',
                else => random.int(u8),
            };
        }
        // The response parser must be just as crash-proof over the same bytes.
        if (parseResponse(buffer[0..len], &storage) catch null) |response| {
            try std.testing.expect(response.head_len <= len);
            try std.testing.expect(withinBuffer(response.version, buffer[0..len]));
            try std.testing.expect(withinBuffer(response.reason, buffer[0..len]));
            for (response.headers) |field| {
                try std.testing.expect(withinBuffer(field.name, buffer[0..len]));
                try std.testing.expect(withinBuffer(field.value, buffer[0..len]));
            }
        }
        const result = parse(buffer[0..len], &storage) catch continue;
        const head = result orelse continue;
        // Every returned slice must point inside the input buffer, and the head
        // length must be within it.
        try std.testing.expect(head.head_len <= len);
        for (head.headers) |field| {
            try std.testing.expect(withinBuffer(field.name, buffer[0..len]));
            try std.testing.expect(withinBuffer(field.value, buffer[0..len]));
        }
        try std.testing.expect(withinBuffer(head.method, buffer[0..len]));
        try std.testing.expect(withinBuffer(head.target, buffer[0..len]));
    }
}

test "parses a well-formed response head" {
    var storage: [16]Header = undefined;
    const input =
        "HTTP/1.1 200 OK\r\n" ++
        "Content-Type: text/html\r\n" ++
        "Content-Length: 5\r\n" ++
        "\r\n" ++
        "hello";
    const head = (try parseResponse(input, &storage)).?;
    try std.testing.expectEqualStrings("HTTP/1.1", head.version);
    try std.testing.expectEqual(@as(u16, 200), head.status);
    try std.testing.expectEqualStrings("OK", head.reason);
    try std.testing.expectEqual(@as(usize, 2), head.headers.len);
    try std.testing.expectEqualStrings("text/html", head.header("content-type").?);
    try std.testing.expectEqualStrings("hello", input[head.head_len..]);
}

test "response head: incomplete, malformed, and multi-word reason" {
    var storage: [8]Header = undefined;
    try std.testing.expect((try parseResponse("HTTP/1.1 200 OK\r\n", &storage)) == null);
    try std.testing.expectError(error.Malformed, parseResponse("HTTP/1.1 xxx OK\r\n\r\n", &storage)); // non-numeric code
    try std.testing.expectError(error.Malformed, parseResponse("HTTP/1.1 99 OK\r\n\r\n", &storage)); // code not 3 digits
    try std.testing.expectError(error.Malformed, parseResponse("FTP/1.1 200 OK\r\n\r\n", &storage)); // bad version
    // A multi-word reason phrase is preserved verbatim.
    const head = (try parseResponse("HTTP/1.1 404 Not Found\r\n\r\n", &storage)).?;
    try std.testing.expectEqual(@as(u16, 404), head.status);
    try std.testing.expectEqualStrings("Not Found", head.reason);
}

fn withinBuffer(slice: []const u8, buffer: []const u8) bool {
    if (slice.len == 0) return true;
    const start = @intFromPtr(slice.ptr);
    const base = @intFromPtr(buffer.ptr);
    return start >= base and start + slice.len <= base + buffer.len;
}
