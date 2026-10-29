/* Restore hardening: crafted manifests, argv execution, log redaction.
 *
 * A backup sits on /media/internal, which a PC can write over USB, and nothing
 * authenticates it. On LuneOS the service that restores it runs as root. These
 * tests feed it the manifests an attacker would write and check that nothing
 * they name is written, executed or logged:
 *
 *   - file paths that climb out ("../", "/media/internal/../../"), absolute
 *     paths outside the permitted roots, paths through a symlink, NUL bytes;
 *   - stored-file names and package ids that are not plain names, including
 *     shell metacharacters (';', '$()', backquotes);
 *   - app tarballs whose members leave the app's own directory;
 *   - the restoreUserApps setting, which used to be ignored.
 *
 * Called from run-tests.js, which owns the counters and the sandbox.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');
var childProcess = require('child_process');

module.exports = async function (t) {
    var harness = t.harness;
    var check = t.check;
    var ROOT = t.ROOT;
    var Future = harness.Future;

    var newCtx = function (extra) {
        var options = {
            root: ROOT,
            services: (extra && extra.services) || t.buildServices(),
            quiet: !process.env.VERBOSE
        };
        if (extra && extra.require) {
            options.require = extra.require;
        }
        if (extra && extra.console) {
            options.console = extra.console;
        }
        var ctx = harness.loadService(options);
        vm.runInContext("privileged.setAvailableForTesting(false);", ctx);
        vm.runInContext("prefs.set({ userEnabled: true });", ctx);
        return ctx;
    };

    var call = function (ctx, expr, args) {
        ctx.__args = args;
        vm.runInContext("__out = (" + expr + ");", ctx);
        return ctx.__out;
    };

    var settle = function (future) {
        return new Promise(function (resolve) {
            future.settle(function (err, result) { resolve({ error: err, result: result }); });
        });
    };

    /* ------------------------------------------------ the path policy */
    t.section("Restore path policy (crafted manifest paths)");

    var ctx = newCtx();
    var TEMP = path.join(ROOT, "tempdir").replace(/\\/g, "/") + "/";
    var rel = function (name) {
        return call(ctx, "restorePolicy.checkRelative(__args[0], __args[1])", [name, TEMP]);
    };
    var abs = function (name) {
        return call(ctx, "restorePolicy.checkAbsolute(__args[0])", [name]);
    };

    check("a plain relative name is accepted under the temp dir",
        rel("settings.json").path === TEMP + "settings.json", JSON.stringify(rel("settings.json")));
    check("a relative name in a subdirectory is accepted",
        rel("sub/dir/file.db").path === TEMP + "sub/dir/file.db");
    check("'../etc/shadow' is refused", !rel("../etc/shadow").path, JSON.stringify(rel("../etc/shadow")));
    check("'../../../../etc/shadow' is refused", !rel("../../../../etc/shadow").path);
    check("a '..' in the middle is refused", !rel("a/../../etc/shadow").path);
    check("an absolute path is refused where a relative one was expected",
        !rel("/etc/shadow").path);
    check("a NUL byte is refused", !rel("settings.json\u0000.evil").path);
    check("an empty or non-string name is refused",
        !rel("").path && !call(ctx, "restorePolicy.checkRelative(null, __args)", TEMP).path &&
            !call(ctx, "restorePolicy.checkRelative({}, __args)", TEMP).path);

    check("'/etc/shadow' is refused", !abs("/etc/shadow").path, JSON.stringify(abs("/etc/shadow")));
    check("'/media/internal/../../etc/shadow' is refused",
        !abs("/media/internal/../../etc/shadow").path,
        JSON.stringify(abs("/media/internal/../../etc/shadow")));
    check("'/var/preferences/../../etc/shadow' is refused",
        !abs("/var/preferences/../../etc/shadow").path);
    check("a NUL byte in an absolute path is refused",
        !abs("/media/internal/a\u0000/../../etc/shadow").path);
    check("a relative path is refused where an absolute one was expected",
        !abs("etc/shadow").path);
    check("the developer-mode switch is refused even inside an allowed root",
        !abs("/var/luna/dev-mode-enabled").path &&
            !abs("/var/luna/preferences/devmode_enabled").path);
    check("our own work area (job files the 3.0.5 helper executes) is refused",
        !call(ctx, "restorePolicy.checkAbsolute(WORK_ROOT + 'jobs/evil.job')").path);
    check("the backup store itself is refused",
        !call(ctx, "restorePolicy.checkAbsolute(LOCAL_TARGET_ROOT + 'manifests/x')").path);
    check("a legitimate preferences destination is accepted",
        abs("/var/preferences/com.palm.display/prefsDB.sl").path ===
            "/var/preferences/com.palm.display/prefsDB.sl");

    // Symlinks, in a root of our own so the host's real /media is irrelevant.
    var SYMROOT = path.join(ROOT, "symroot").replace(/\\/g, "/");
    var OUTSIDE = path.join(ROOT, "outside").replace(/\\/g, "/");
    t.mkdirs(path.join(SYMROOT, "real"));
    t.mkdirs(OUTSIDE);
    var symlinksWork = true;
    try {
        fs.symlinkSync(OUTSIDE, path.join(SYMROOT, "link"));
        fs.symlinkSync(path.join(OUTSIDE, "target.txt"), path.join(SYMROOT, "real", "final"));
        fs.symlinkSync(OUTSIDE, path.join(TEMP, "evil"));
    } catch (err) {
        symlinksWork = false;
    }
    if (symlinksWork) {
        call(ctx, "restorePolicy.setRootsForTesting(__args)", [SYMROOT + "/"]);
        check("a file under the test root is accepted",
            abs(SYMROOT + "/real/new.txt").path === SYMROOT + "/real/new.txt",
            JSON.stringify(abs(SYMROOT + "/real/new.txt")));
        check("a symlinked parent directory is refused",
            !abs(SYMROOT + "/link/shadow").path, JSON.stringify(abs(SYMROOT + "/link/shadow")));
        check("a deeper path through a symlinked parent is refused",
            !abs(SYMROOT + "/link/a/b/c").path);
        check("a symlink at the destination itself is refused",
            !abs(SYMROOT + "/real/final").path);
        check("a relative name through a symlink in the temp dir is refused",
            !rel("evil/shadow").path, JSON.stringify(rel("evil/shadow")));
        call(ctx, "restorePolicy.setRootsForTesting(null)");
    } else {
        check("symlink tests skipped: this host cannot create symlinks", true);
    }

    // LuneOS: only the roots a provider there actually backs up into.
    vm.runInContext("__realModern = platform.isModernBus;" +
        "platform.isModernBus = function () { return true; };", ctx);
    check("on LuneOS a luna-backupagent destination is accepted",
        abs("/var/preferences/com.webos.service.wifi/prefsDB.sl").path &&
            abs("/var/luna/preferences/localeInfo").path);
    check("on LuneOS /var/palm is refused (no provider writes there)",
        !abs("/var/palm/data/com.palm.foo/x").path);
    check("on LuneOS /tmp is refused", !abs("/tmp/x").path);
    check("on LuneOS the rest of /var/luna is refused", !abs("/var/luna/data/x").path);
    vm.runInContext("platform.isModernBus = __realModern;", ctx);

    /* ------------------------------------------------ names and ids */
    t.section("Restore names and package ids (crafted manifest ids)");

    var id = function (value) {
        return call(ctx, "restorePolicy.isValidPackageId(__args)", value);
    };
    ["com.example.app", "Waydroid", "org.mer.app.sdl2_opengles1_test", "org.webosports.app.x-y",
        "com.example.app+1"].forEach(function (good) {
        check("real id '" + good + "' is accepted", id(good) === true);
    });
    ["com.x;reboot", "$(reboot)", "a`reboot`", "x' && reboot '", "a b", "../x", "x/y",
        ".hidden", "-rf", "", "a\u0000b", "a\nb"].forEach(function (bad) {
        check("id " + JSON.stringify(bad) + " is refused", id(bad) === false);
    });
    check("a non-string id is refused",
        call(ctx, "restorePolicy.isValidPackageId(42) || restorePolicy.isValidPackageId(null)") === false);

    var stored = function (value) {
        return call(ctx, "restorePolicy.isValidStoredName(__args)", value);
    };
    check("an md5 stored name is accepted",
        stored("8adbda808dcd4227033d7efdcc7a737b") && stored("8adbda808dcd4227033d7efdcc7a737b.gz"));
    check("a stored name that climbs out is refused",
        !stored("../../../etc/shadow") && !stored("../manifests/000001-abc123"));
    check("a stored name with a separator or suffix is refused",
        !stored("8adbda808dcd4227/033d7efdcc7a737b") && !stored("8adbda808dcd4227.sh"));

    /* ------------------------------------------------ end to end */
    t.section("Restore of a crafted manifest");

    // Start from a real manifest the suite produced, and add what an attacker
    // would: names that climb out of the temp dir, and a stored-file name
    // that climbs out of the backup store.
    var manifests = fs.readdirSync(t.manifestDir()).filter(function (n) {
        return /^\d{6}-abc123$/.test(n);
    }).sort();
    var base = JSON.parse(fs.readFileSync(path.join(t.manifestDir(), manifests[0]), "utf8"));
    var settings = base.services.filter(function (s) {
        return s.service === "com.example.settings";
    })[0];
    var goodFile = settings.files[0];
    var clone = function (overrides) {
        var copy = JSON.parse(JSON.stringify(goodFile));
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) {
                copy[k] = overrides[k];
            }
        }
        return copy;
    };
    var ESCAPE = path.join(ROOT, "escaped-by-restore.txt");
    var ESCAPE_DEEP = path.join(ROOT, "escaped-deep.txt");
    try { fs.unlinkSync(ESCAPE); } catch (e) {}
    try { fs.unlinkSync(ESCAPE_DEEP); } catch (e) {}
    settings.files = [
        goodFile,
        clone({ path: "../escaped-by-restore.txt" }),
        clone({ path: "sub/../../escaped-deep.txt" }),
        clone({ path: "/etc/shadow" }),
        clone({ path: "harmless.txt", checksum: "../../../../etc/passwd", origChecksum: undefined })
    ];
    var CRAFTED = "000090-abc123";
    fs.writeFileSync(path.join(t.manifestDir(), CRAFTED), JSON.stringify(base));

    var e2e = newCtx();
    var crafted = await t.run(e2e, "RestoreAssistant", { manifestName: CRAFTED }, []);
    var refusedPaths = ((crafted.result && crafted.result.skipped) || []).filter(function (s) {
        return /^refused/.test(s.reason || "");
    }).map(function (s) { return s.path; });
    check("a restore of the crafted manifest still completes",
        !crafted.error && crafted.result && crafted.result.STATUS === "Complete",
        crafted.error ? crafted.error.message : JSON.stringify(crafted.result));
    check("nothing was written outside the temp dir by '../'",
        !fs.existsSync(ESCAPE) && !fs.existsSync(ESCAPE_DEEP));
    check("every crafted entry is reported as refused",
        refusedPaths.length === 4 &&
            refusedPaths.indexOf("../escaped-by-restore.txt") !== -1 &&
            refusedPaths.indexOf("/etc/shadow") !== -1 &&
            refusedPaths.indexOf("harmless.txt") !== -1,
        JSON.stringify(refusedPaths));
    var postRestoreArgs = e2e.__busLog.filter(function (c) {
        return c.service === "com.example.settings" && c.method === "postRestore";
    }).map(function (c) { return c.args.files; });
    check("the service's postRestore is only handed the legitimate file",
        postRestoreArgs.length === 1 && JSON.stringify(postRestoreArgs[0]) ===
            JSON.stringify([goodFile.path]),
        JSON.stringify(postRestoreArgs));

    /* ------------------------------------------------ packages */
    t.section("Restore of crafted package ids");

    var pkgManifest = JSON.parse(JSON.stringify(base));
    pkgManifest.packages = [
        { id: "com.evil;touch " + ROOT + "/pwned", version: "1.0", archived: true,
          file: clone({ path: "x.ipk" }) },
        { id: "$(touch " + ROOT + "/pwned2)", version: "1.0", dirBackedUp: true,
          dirFile: clone({ path: "x-app.tar.gz" }) },
        { id: "../../../etc/cron", version: "1.0", archived: true, file: clone({ path: "y.ipk" }) },
        { id: "com.example.fine", version: "1.0", archived: true,
          file: clone({ path: "com.example.fine.ipk" }) }
    ];
    var PKG_CRAFTED = "000091-abc123";
    fs.writeFileSync(path.join(t.manifestDir(), PKG_CRAFTED), JSON.stringify(pkgManifest));

    var pkgCtx = newCtx();
    vm.runInContext("privileged.setAvailableForTesting(true);", pkgCtx);
    vm.runInContext("privileged.listInstalledApps = function () {" +
        "  return new Future({ returnValue: true, packages: [], romApps: [] }); };", pkgCtx);
    pkgCtx.__installIds = [];
    pkgCtx.__dirIds = [];
    vm.runInContext("privileged.installPackages = function (files) {" +
        "  files.forEach(function (f) { __installIds.push(f.id); });" +
        "  return new Future({ installed: files.map(function (f) { return f.id; }), failed: [] }); };" +
        "privileged.restoreAppDirectories = function (files) {" +
        "  files.forEach(function (f) { __dirIds.push(f.id); });" +
        "  return new Future({ restored: [], failed: [] }); };" +
        "privileged.setUnstageForTesting(function (files) {" +
        "  return new Future({ restored: [], skipped: [] }); });", pkgCtx);

    var offRun = await t.run(pkgCtx, "RestoreAssistant", { manifestName: PKG_CRAFTED }, []);
    check("restoreUserApps off (the default): no package is touched",
        !offRun.error && offRun.result.appsRestored === false &&
            pkgCtx.__installIds.length === 0 && pkgCtx.__dirIds.length === 0,
        JSON.stringify([offRun.error && offRun.error.message, pkgCtx.__installIds]));

    var onRun = await t.run(pkgCtx, "RestoreAssistant",
        { manifestName: PKG_CRAFTED, restoreUserApps: true }, []);
    check("a per-call restoreUserApps:true turns app restore on",
        !onRun.error && onRun.result.appsRestored === true,
        onRun.error ? onRun.error.message : JSON.stringify(onRun.result.appsRestored));
    check("only the package with a plain id reaches the installer",
        JSON.stringify(pkgCtx.__installIds) === JSON.stringify(["com.example.fine"]) &&
            pkgCtx.__dirIds.length === 0,
        JSON.stringify([pkgCtx.__installIds, pkgCtx.__dirIds]));
    var refusedIds = ((onRun.result && onRun.result.skipped) || []).filter(function (s) {
        return s.reason === "refused: bad package id";
    });
    check("the three crafted ids are reported as refused", refusedIds.length === 3,
        JSON.stringify(refusedIds));
    check("no injected command ran",
        !fs.existsSync(path.join(ROOT, "pwned")) && !fs.existsSync(path.join(ROOT, "pwned2")));

    /* ------------------------------------------------ argv execution */
    t.section("Privileged commands run as argv, never through a shell");

    var execCalls = [];
    var fakeChild = {
        execFile: function (file, args, opts, cb) {
            execCalls.push({ file: file, args: args });
            var done = cb || opts;
            setTimeout(function () { done(null, execOutputs.shift() || "", ""); }, 1);
        }
    };
    var execOutputs = [];
    var argvCtx = newCtx({
        require: function (name) {
            return name === "child_process" ? fakeChild : require(name);
        }
    });
    vm.runInContext("privileged.setDirectModeForTesting(true);", argvCtx);

    var stageDir = call(argvCtx, "WORK_ROOT") + "stage/restore-test/packages/";
    t.mkdirs(stageDir);
    fs.writeFileSync(stageDir + "com.example.fine.ipk", "ipk");
    var weirdId = "com.x;touch " + ROOT + "/pwned3";
    fs.writeFileSync(stageDir + "com.example.dollar.ipk", "ipk");

    execCalls = [];
    argvCtx.__files = [
        { id: "com.example.fine", path: stageDir + "com.example.fine.ipk" },
        { id: weirdId, path: stageDir + weirdId + ".ipk" },
        { id: "com.example.dollar", path: stageDir + "../../../../etc/x.ipk" },
        { id: "com.example.other", path: stageDir + "com.example.fine.ipk" }
    ];
    var inst = await settle(call(argvCtx, "privileged.installPackages(__files)"));
    check("opkg is run with the path as one argv element",
        execCalls.length === 1 && execCalls[0].file === "opkg" &&
            JSON.stringify(execCalls[0].args) === JSON.stringify(
                ["-o", "/media/cryptofs/apps", "--force-reinstall", "install",
                 stageDir + "com.example.fine.ipk"]),
        JSON.stringify(execCalls));
    check("an id with ';', a path that climbs out, and a mismatched name are refused",
        inst.result && JSON.stringify(inst.result.installed) === JSON.stringify(["com.example.fine"]) &&
            inst.result.failed.length === 3,
        JSON.stringify(inst.result || inst.error));

    // App tarball listings, as GNU tar prints them.
    var listing = function (lines, pkgId) {
        return call(argvCtx, "privileged.checkTarListingForTesting(__args[0], __args[1])",
            [lines.join("\n") + "\n", pkgId || "com.example.app"]);
    };
    var L = function (type, name) {
        return type + "rw-r--r-- root/root      12 2026-01-01 12:00 " + name;
    };
    var good = [
        L("d", "usr/palm/applications/com.example.app/"),
        L("-", "usr/palm/applications/com.example.app/appinfo.json"),
        "lrwxrwxrwx root/root 0 2026-01-01 12:00 usr/palm/applications/com.example.app/lib.so -> lib.so.1",
        L("-", "var/lib/opkg/info/com.example.app.control"),
        L("-", ".woce-opkg-status")
    ];
    check("a tarball that only holds its own app is accepted", listing(good) === null,
        String(listing(good)));
    check("a member for another app's directory is refused",
        listing(good.concat([L("-", "usr/palm/applications/com.other/appinfo.json")])) !== null);
    check("a member that climbs out is refused",
        listing(good.concat([L("-", "usr/palm/applications/com.example.app/../../../../etc/shadow")])) !== null);
    check("an absolute member is refused", listing(good.concat([L("-", "/etc/shadow")])) !== null);
    check("a symlink out of the app is refused",
        listing(good.concat(["lrwxrwxrwx root/root 0 2026-01-01 12:00 usr/palm/applications/com.example.app/x -> /etc"])) !== null &&
        listing(good.concat(["lrwxrwxrwx root/root 0 2026-01-01 12:00 usr/palm/applications/com.example.app/x -> ../../../../etc"])) !== null);
    check("a hard link to a file outside is refused",
        listing(good.concat(["hrw-r--r-- root/root 0 2026-01-01 12:00 usr/palm/applications/com.example.app/x link to etc/shadow"])) !== null);
    check("a device node is refused",
        listing(good.concat(["crw-r--r-- root/root 1,3 2026-01-01 12:00 usr/palm/applications/com.example.app/null"])) !== null);
    check("an opkg info file for another package is refused",
        listing(good.concat([L("-", "var/lib/opkg/info/busybox.postinst")])) !== null);

    // Against real GNU tar output, so the parser is not only right about the
    // format this file imagines. Skipped where there is no GNU tar.
    var tarDir = path.join(ROOT, "tarcase");
    var appDir = path.join(tarDir, "usr/palm/applications/com.example.app");
    t.mkdirs(appDir);
    fs.writeFileSync(path.join(appDir, "appinfo.json"), "{}");
    var tarball = path.join(ROOT, "evil-app.tar.gz");
    var realList = null;
    try {
        fs.symlinkSync("/etc", path.join(appDir, "escape"));
        childProcess.execFileSync("tar", ["czf", tarball, "-C", tarDir, "usr"]);
        realList = String(childProcess.execFileSync("tar",
            ["-tvzf", tarball, "--quoting-style=escape"]));
    } catch (err) {
        realList = null;
    }
    if (realList !== null) {
        check("real GNU tar output: the symlink to /etc is caught",
            /symlink leaving the app/.test(String(listing([realList.replace(/\n$/, "")]))),
            String(listing([realList.replace(/\n$/, "")])));
        fs.unlinkSync(path.join(appDir, "escape"));
        childProcess.execFileSync("tar", ["czf", tarball, "-C", tarDir, "usr"]);
        realList = String(childProcess.execFileSync("tar",
            ["-tvzf", tarball, "--quoting-style=escape"]));
        check("real GNU tar output: a clean app tarball is accepted",
            listing([realList.replace(/\n$/, "")]) === null,
            String(listing([realList.replace(/\n$/, "")])));
    } else {
        check("real-tar listing tests skipped: no usable tar/symlinks on this host", true);
    }
};
