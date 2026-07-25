const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Optional zig-waf integration: point -Dwaf at a built zig-waf checkout
    // (one that has run `zig build`, producing zig-out/lib/libzig-waf.a) to link
    // the WAF engine and inspect each request through its C connector ABI. Left
    // unset the dataplane builds as a plain proxy with no zig-waf dependency.
    const waf_root = b.option([]const u8, "waf", "Path to a built zig-waf checkout to link the WAF engine");

    const options = b.addOptions();
    options.addOption(bool, "has_waf", waf_root != null);

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

    const exe_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_module.addOptions("build_options", options);
    exe_module.addImport("http", http);
    exe_module.addImport("waf_hook", waf_hook);
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
    const test_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_module.addOptions("build_options", test_options);
    test_module.addImport("http", http);
    test_module.addImport("waf_hook", wafHookModule(b, target, optimize, http, null));
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
