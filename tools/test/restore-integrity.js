/* Restore integrity and scratch names.
 *
 * Two things a restore has to get right about the bytes it fetches, beyond
 * where they go (restore-hardening.js covers that):
 *
 *   - What lands must be what was backed up. The store is content-addressed by
 *     the md5 of each original file and the manifest records that md5 as
 *     origChecksum, so a store entry that was copied incompletely off USB, or
 *     has rotted on the card, can be caught before it is handed to a service.
 *     An uncompressed file has no gzip trailer to fail on: without this check a
 *     truncated db8 dump is restored as if it were whole.
 *
 *   - The scratch names used on the way must not be guessable. Fetching a
 *     compressed file to "<destination>.gz" lets anyone who can write the temp
 *     dir plant a symlink there first, and the fetch - which runs as root on
 *     LuneOS - writes the stored bytes through it.
 *
 * This is integrity, not authenticity: whoever can rewrite the store can also
 * rewrite the manifest. Called from run-tests.js, which owns the sandbox.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');
var zlib = require('zlib');

module.exports = async function (t) {
    var harness = t.harness;
    var check = t.check;
    var ROOT = t.ROOT;

    var newCtx = function () {
        var ctx = harness.loadService({
            root: ROOT,
            services: t.buildServices(),
            quiet: !process.env.VERBOSE
        });
        vm.runInContext("privileged.setAvailableForTesting(false);", ctx);
        vm.runInContext("prefs.set({ userEnabled: true });", ctx);
        return ctx;
    };

    var FILES = path.join(ROOT, "backups", "files");
    var storedNameOf = function (file) {
        return (file.checksum || file.origChecksum) + (file.compressed ? ".gz" : "");
    };

    var manifests = fs.readdirSync(t.manifestDir()).filter(function (n) {
        return /^\d{6}-abc123$/.test(n);
    }).sort();
    var base = JSON.parse(fs.readFileSync(path.join(t.manifestDir(), manifests[0]), "utf8"));

    // A relative file the suite really backed up, in each storage form.
    var pick = function (compressed) {
        var found = null;
        base.services.forEach(function (section) {
            (section.files || []).forEach(function (file) {
                if (!found && !!file.compressed === compressed && file.origChecksum &&
                        String(file.path).charAt(0) !== "/" &&
                        fs.existsSync(path.join(FILES, storedNameOf(file)))) {
                    found = { service: section.service, file: file };
                }
            });
        });
        return found;
    };

    // A manifest holding just this one file for its service, written under a
    // fresh sequence number.
    var oneFileManifest = function (choice, name) {
        var m = JSON.parse(JSON.stringify(base));
        m.services = m.services.filter(function (s) { return s.service === choice.service; });
        m.services[0].files = [choice.file];
        fs.writeFileSync(path.join(t.manifestDir(), name), JSON.stringify(m));
        return name;
    };

    var postRestoreFiles = function (ctx, service) {
        return ctx.__busLog.filter(function (c) {
            return c.service === service && c.method === "postRestore";
        }).map(function (c) { return c.args.files; });
    };

    /* ------------------------------------------------ integrity */
    t.section("Restore integrity (a store entry that is not what was backed up)");

    // Everything the suite backs up compresses, so make the uncompressed form
    // from a compressed one: the original bytes stored under their bare md5,
    // which is how backup stores a file gzip would not shrink.
    var asUncompressed = function () {
        var src = pick(true);
        if (!src) {
            return null;
        }
        var bytes = zlib.gunzipSync(fs.readFileSync(path.join(FILES, storedNameOf(src.file))));
        var file = JSON.parse(JSON.stringify(src.file));
        file.compressed = false;
        file.finalChecksum = file.origChecksum;
        file.finalSize = bytes.length;
        fs.writeFileSync(path.join(FILES, file.origChecksum), bytes);
        return { service: src.service, file: file };
    };

    var cases = [
        { label: "uncompressed", choice: pick(false) || asUncompressed(), seq: "000093-abc123" },
        { label: "compressed", choice: pick(true), seq: "000094-abc123" }
    ];
    for (var i = 0; i < cases.length; i++) {
        var c = cases[i];
        check("the suite produced a " + c.label + " relative file to test with", !!c.choice);
        if (!c.choice) {
            continue;
        }
        var storePath = path.join(FILES, storedNameOf(c.choice.file));
        var original = fs.readFileSync(storePath);
        // Same storage form, wrong bytes: what an interrupted copy or a rotted
        // card leaves behind, minus the gzip error a truncated .gz would raise.
        var wrong = Buffer.from("not what was backed up\n");
        fs.writeFileSync(storePath, c.choice.file.compressed ? zlib.gzipSync(wrong) : wrong);
        try {
            var ctx = newCtx();
            var run = await t.run(ctx, "RestoreAssistant",
                { manifestName: oneFileManifest(c.choice, c.seq) }, []);
            var skipped = (run.result && run.result.skipped) || [];
            check("a " + c.label + " entry with the wrong bytes still lets the restore complete",
                !run.error && run.result && run.result.STATUS === "Complete",
                run.error ? run.error.message : JSON.stringify(run.result));
            check("...and is reported as a checksum mismatch",
                skipped.some(function (s) {
                    return s.path === c.choice.file.path && s.reason === "checksum-mismatch";
                }), JSON.stringify(skipped));
            var handed = postRestoreFiles(ctx, c.choice.service);
            check("...and is not handed to the service's postRestore",
                handed.every(function (files) {
                    return (files || []).indexOf(c.choice.file.path) === -1;
                }), JSON.stringify(handed));
        } finally {
            fs.writeFileSync(storePath, original);
        }
    }

    // The same restore over the untouched store still goes through: the check
    // must not refuse good data.
    var good = pick(true) || pick(false);
    if (good) {
        var okCtx = newCtx();
        var okRun = await t.run(okCtx, "RestoreAssistant",
            { manifestName: oneFileManifest(good, "000095-abc123") }, []);
        check("an intact entry passes the check and reaches postRestore",
            !okRun.error && postRestoreFiles(okCtx, good.service).some(function (files) {
                return (files || []).indexOf(good.file.path) !== -1;
            }), okRun.error ? okRun.error.message : JSON.stringify(okRun.result));
        check("...with nothing reported skipped",
            ((okRun.result && okRun.result.skipped) || []).length === 0,
            JSON.stringify(okRun.result && okRun.result.skipped));
    }

    /* ------------------------------------------------ scratch names */
    t.section("Restore scratch names (a symlink planted where the fetch would write)");

    var compressed = pick(true);
    var symlinksWork = true;
    var OUTSIDE = path.join(ROOT, "integrity-outside");
    var VICTIM = path.join(OUTSIDE, "victim.txt");
    try {
        fs.mkdirSync(OUTSIDE);
        fs.writeFileSync(VICTIM, "victim original\n");
        fs.symlinkSync(VICTIM, path.join(OUTSIDE, "probe"));
        fs.unlinkSync(path.join(OUTSIDE, "probe"));
    } catch (err) {
        symlinksWork = false;
    }
    if (!symlinksWork || !compressed) {
        check("scratch-name tests skipped: " + (!compressed ? "no compressed file" : "no symlinks here"), true);
        return;
    }

    // restoreService clears the temp dir before each service, which removes
    // anything planted in advance. What is left is the window between that
    // clear (plus the service's preRestore round trip) and the fetch, so plant
    // the symlink inside it: at the name the fetch is predicted to use, just
    // before the fetch runs. A racing writer of the temp dir can do the same.
    var plantCtx = newCtx();
    plantCtx.__tempDir = null;
    plantCtx.__plant = function (remotePath) {
        if (plantCtx.__planted || !plantCtx.__tempDir || remotePath.indexOf("files/") !== 0) {
            return;
        }
        var at = path.join(plantCtx.__tempDir, compressed.file.path + ".gz");
        try { fs.unlinkSync(at); } catch (e) {}
        fs.symlinkSync(VICTIM, at);
        plantCtx.__planted = at;
    };
    vm.runInContext("(function () {" +
        "var realTemp = system.getTempDir;" +
        "system.getTempDir = function (size) { var fut = realTemp(size);" +
        "  fut.then(this, function (f) { var dir = f.result; __tempDir = dir; f.result = dir; });" +
        "  return fut; };" +
        "var realGet = LocalTarget.prototype.get;" +
        "LocalTarget.prototype.get = function (remotePath) { __plant(String(remotePath));" +
        "  return realGet.apply(this, arguments); }; }());", plantCtx);
    var planted = await t.run(plantCtx, "RestoreAssistant",
        { manifestName: oneFileManifest(compressed, "000096-abc123") }, []);
    check("the symlink was planted at the predictable name", !!plantCtx.__planted);
    check("a restore with a symlink at <destination>.gz still completes",
        !planted.error && planted.result && planted.result.STATUS === "Complete",
        planted.error ? planted.error.message : JSON.stringify(planted.result));
    check("...and nothing was written through it",
        fs.readFileSync(VICTIM, "utf8") === "victim original\n",
        JSON.stringify(fs.readFileSync(VICTIM).slice(0, 16)));
    check("...and the file itself was still restored",
        postRestoreFiles(plantCtx, compressed.service).some(function (files) {
            return (files || []).indexOf(compressed.file.path) !== -1;
        }));

    // No scratch file is left behind next to a restored file.
    var leftovers = [];
    (function walk(dir) {
        var names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        names.forEach(function (n) {
            var p = path.join(dir, n);
            var st = fs.lstatSync(p);
            if (st.isDirectory()) {
                walk(p);
            } else if (/\.woce-[0-9a-z-]+(\.gz)?$/.test(n)) {
                leftovers.push(p);
            }
        });
    }(path.join(ROOT, "work")));
    check("no .woce-* scratch file is left in the work area", leftovers.length === 0,
        JSON.stringify(leftovers));
};
