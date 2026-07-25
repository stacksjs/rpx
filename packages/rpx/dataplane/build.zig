const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Optional zig-waf integration: point -Dwaf at a built zig-waf checkout
    // (one that has run `zig build`, producing zig-out/lib/libzig-waf.a) to link
    // the WAF engine and inspect each request through its C connector ABI. Left
    // unset the dataplane builds as a plain proxy with no zig-waf dependency.
    const waf_root = b.option([]const u8, "waf", "Path to a built zig-waf checkout to link the WAF engine");
    // Optional TLS termination: point -Dtls at a zig-tls checkout (pure Zig).
    // Left unset the dataplane is plaintext-only.
    const tls_root = b.option([]const u8, "tls", "Path to a zig-tls checkout for TLS termination");

    const options = b.addOptions();
    options.addOption(bool, "has_waf", waf_root != null);
    options.addOption(bool, "has_tls", tls_root != null);

    // http is a shared module so the request-head type is the same in `main` and
    // the WAF hook.
    const http = b.createModule(.{
        .root_source_file = b.path("src/http.zig"),
        .target = target,
        .optimize = optimize,
    });

    // The WAF hook is a module resolved to the real engine (with libc + linked
    // static libraries) or the no-op stand-in, depending on -Dwaf.
    const waf_hook = wafHookModule(b, target, optimize, http, waf_root);
    const tls_hook = tlsHookModule(b, target, optimize, tls_root);

    const exe_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_module.addOptions("build_options", options);
    exe_module.addImport("http", http);
    exe_module.addImport("waf_hook", waf_hook);
    exe_module.addImport("tls_hook", tls_hook);
    if (waf_root != null) exe_module.link_libc = true;

    const exe = b.addExecutable(.{ .name = "rpx-dataplane", .root_module = exe_module });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    const run_step = b.step("run", "Run the rpx dataplane");
    run_step.dependOn(&run_cmd.step);

    // Tests cover the pure logic (main + http) with the no-op WAF, so no zig-waf
    // checkout is needed for `zig build test`.
    const test_options = b.addOptions();
    test_options.addOption(bool, "has_waf", false);
    test_options.addOption(bool, "has_tls", false);
    const test_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_module.addOptions("build_options", test_options);
    test_module.addImport("http", http);
    test_module.addImport("waf_hook", wafHookModule(b, target, optimize, http, null));
    test_module.addImport("tls_hook", tlsHookModule(b, target, optimize, null));
    const tests = b.addTest(.{ .root_module = test_module });
    const run_tests = b.addRunArtifact(tests);

    const http_tests = b.addTest(.{ .root_module = http });
    const run_http_tests = b.addRunArtifact(http_tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
    test_step.dependOn(&run_http_tests.step);
}

/// Build the `waf_hook` module: the real zig-waf engine (linked over the C ABI)
/// when a checkout path is given, else the no-op stand-in.
fn wafHookModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    http: *std.Build.Module,
    waf_root: ?[]const u8,
) *std.Build.Module {
    const root = waf_root orelse {
        const module = b.createModule(.{
            .root_source_file = b.path("src/waf_noop.zig"),
            .target = target,
            .optimize = optimize,
        });
        module.addImport("http", http);
        return module;
    };
    // @cImport is not a language builtin in this Zig; translate the header into
    // a Zig module via the build system (the same pattern zig-waf uses for lmdb).
    const translate = b.addTranslateC(.{
        .root_source_file = .{ .cwd_relative = b.pathJoin(&.{ root, "include", "zig_waf.h" }) },
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const waf_c = translate.createModule();

    const module = b.createModule(.{
        .root_source_file = b.path("src/waf_engine.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    module.addImport("http", http);
    module.addImport("waf_c", waf_c);
    module.addObjectFile(.{ .cwd_relative = b.pathJoin(&.{ root, "zig-out", "lib", "libzig-waf.a" }) });
    module.addObjectFile(.{ .cwd_relative = b.pathJoin(&.{ root, "pantry", "openldap.org", "liblmdb", "v0.9.35", "lib", "liblmdb.a" }) });
    return module;
}

/// Build the `tls_hook` module: the real zig-tls termination engine when a
/// checkout path is given, else the no-op stand-in (plaintext-only).
fn tlsHookModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    tls_root: ?[]const u8,
) *std.Build.Module {
    const root = tls_root orelse {
        return b.createModule(.{
            .root_source_file = b.path("src/tls_noop.zig"),
            .target = target,
            .optimize = optimize,
        });
    };
    // Mirror zig-tls's own module setup (build.zig): build_options, libc, PIC,
    // and the hardware-crypto assembly + include paths for this arch/os.
    const tls_options = b.addOptions();
    tls_options.addOption(bool, "bedrock_c_mul_base", false);
    const tls_module = b.createModule(.{
        .root_source_file = .{ .cwd_relative = b.pathJoin(&.{ root, "src", "root.zig" }) },
        .target = target,
        .optimize = optimize,
    });
    tls_module.link_libc = true;
    tls_module.pic = true;
    tls_module.addOptions("build_options", tls_options);
    addTlsCryptoAsm(b, tls_module, target, root);

    const module = b.createModule(.{
        .root_source_file = b.path("src/tls_engine.zig"),
        .target = target,
        .optimize = optimize,
    });
    module.link_libc = true;
    module.addImport("tls", tls_module);
    return module;
}

/// Add zig-tls's hardware-crypto assembly and include paths (mirrors its
/// `addHwCryptoAsm`), resolving files under the `root` checkout.
fn addTlsCryptoAsm(b: *std.Build, module: *std.Build.Module, target: std.Build.ResolvedTarget, root: []const u8) void {
    const arch = target.result.cpu.arch;
    const os = target.result.os.tag;
    if ((os != .macos and os != .linux)) return;
    const suffix = if (os == .macos) "apple" else "linux";
    if (arch == .aarch64) {
        module.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ root, "src", "crypto", "aarch64", "include" }) });
        inline for (.{ "aesv8-gcm-armv8", "ghashv8-armv8", "aesv8-armv8", "p256-armv8-asm" }) |base| {
            module.addAssemblyFile(.{ .cwd_relative = b.pathJoin(&.{ root, "src", "crypto", "aarch64", b.fmt("{s}-{s}.S", .{ base, suffix }) }) });
        }
    } else if (arch == .x86_64) {
        module.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ root, "src", "crypto", "x86_64", "include" }) });
        inline for (.{ "aes-gcm-avx2-x86_64", "aesni-x86_64", "p256-x86_64-asm" }) |base| {
            module.addAssemblyFile(.{ .cwd_relative = b.pathJoin(&.{ root, "src", "crypto", "x86_64", b.fmt("{s}-{s}.S", .{ base, suffix }) }) });
        }
        inline for (.{ "fiat_p256_adx_mul", "fiat_p256_adx_sqr" }) |base| {
            module.addAssemblyFile(.{ .cwd_relative = b.pathJoin(&.{ root, "src", "crypto", "x86_64", b.fmt("{s}.S", .{base}) }) });
        }
    }
}
