/* End-to-end exercise of the woce-backup engine, off device.
 *
 * Runs the real handlers — backup, restore, listBackups, deleteBackup, optOut —
 * against a temp filesystem with fake registered services standing in for
 * com.palm.db and friends. The point is to prove the protocol sequencing,
 * content addressing, incremental dedup, manifest bookkeeping and purge behave,
 * none of which can be checked by reading the code.
 *
 * Run: node tools/test/run-tests.js
 */

var fs   = require('fs');
var os   = require('os');
var path = require('path');
var vm   = require('vm');

var harness = require('./harness');
var Future  = harness.Future;

// Each loaded service context installs prologue.js's uncaughtException handler,
// and the suite loads a fresh one per scenario. That is correct on device (one
// process, one handler) and only looks like a leak here.
process.setMaxListeners(0);

var passed = 0;
var failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log("  PASS  " + label);
    } else {
        failed++;
        console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : ""));
    }
}

function section(name) {
    console.log("\n" + name);
}

function rmrf(target) {
    var stat;
    try {
        // lstat: never follow a symlink out of the sandbox (the restore
        // hardening tests plant some), and remove a dangling one too.
        stat = fs.lstatSync(target);
    } catch (err) {
        return;
    }
    if (stat.isDirectory()) {
        fs.readdirSync(target).forEach(function (entry) {
            rmrf(path.join(target, entry));
        });
        fs.rmdirSync(target);
    } else {
        fs.unlinkSync(target);
    }
}

function mkdirs(dir) {
    if (fs.existsSync(dir)) {
        return;
    }
    mkdirs(path.dirname(dir));
    fs.mkdirSync(dir);
}

function listFilesIn(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (err) {
        return [];
    }
}

/* ------------------------------------------------------------ the sandbox */

var ROOT = path.join(os.tmpdir(), "woce-backup-test-" + process.pid);

/**
 * Two fake registered services:
 *
 *   com.example.settings  writes a small JSON blob into the temp dir, the way
 *                         com.palm.db's internal/preBackup does
 *   com.example.notes     writes a second file, and declares restoreFinished
 *                         only, like com.palm.service.accounts
 */
function buildSandbox() {
    rmrf(ROOT);
    mkdirs(path.join(ROOT, "etc"));
    mkdirs(path.join(ROOT, "tempdir"));
    mkdirs(path.join(ROOT, "work"));
    mkdirs(path.join(ROOT, "backups"));

    fs.writeFileSync(path.join(ROOT, "etc", "com.example.settings"), JSON.stringify({
        id: "com.example.settings",
        preBackup: "preBackup",
        postBackup: "postBackup",
        preRestore: "preRestore",
        postRestore: "postRestore"
    }));

    fs.writeFileSync(path.join(ROOT, "etc", "com.example.notes"), JSON.stringify({
        id: "com.example.notes",
        preBackup: "preBackup",
        postRestore: "postRestore",
        restoreFinished: "restoreFinished"
    }));

    fs.writeFileSync(path.join(ROOT, "etc", "com.example.watcher"), JSON.stringify({
        id: "com.example.watcher",
        restoreFinished: "restoreFinished"
    }));
}

var state = {
    settingsPayload: '{"theme":"dark","volume":7}',
    notesPayload:    "first note\nsecond note\n",
    restored:        {},
    restoreFinishedCalls: [],
    postBackupCalls: 0,
    // "legacy" accepts the stock battery requirement; "luneos" refuses it as
    // LuneOS's Activity Manager does.
    activityManager: "legacy",
    // undefined = the query fails; otherwise the percent reported.
    battery: 88,
    // undefined = the query fails; otherwise whether a charger is connected.
    charger: false
};

var TEMP_DIR = path.join(ROOT, "tempdir").replace(/\\/g, "/") + "/";

function buildServices() {
    return {
        "com.palm.filecache": {
            InsertCacheObject: function () {
                return { returnValue: true, pathName: path.join(ROOT, "tempdir").replace(/\\/g, "/") };
            },
            DefineType: function () { return { returnValue: true }; }
        },

        "com.palm.deviceprofile": {
            getDeviceProfile: function () {
                return {
                    returnValue: true,
                    deviceInfo: {
                        nduId: "abc123",
                        deviceId: "device-1",
                        softwareVersion: "3.0.5",
                        hardwareType: "topaz",
                        deviceModel: "TouchPad"
                    }
                };
            }
        },

        "com.palm.systemservice": {
            getPreferences: function () {
                return { returnValue: true, deviceName: "Test TouchPad" };
            }
        },

        "com.palm.power": {
            "com/palm/power/batteryStatusQuery": function () {
                if (state.battery === undefined) {
                    throw new Error("battery service gone");
                }
                return { returnValue: true, percent: state.battery };
            },
            "com/palm/power/chargerStatusQuery": function () {
                if (state.charger === undefined) {
                    throw new Error("charger service gone");
                }
                return { returnValue: true, connected: state.charger };
            }
        },

        "com.palm.connectionmanager": {
            getstatus: function () {
                return { returnValue: true, wifi: { state: "connected", ipAddress: "10.0.0.5" } };
            }
        },

        "com.palm.activitymanager": {
            create: function (args) {
                var requirements = args.activity.requirements;
                if (state.activityManager === "luneos" && requirements &&
                        requirements.battery !== undefined) {
                    throw new Error("If 'battery' requirement is specified, the only legal value is 'true'");
                }
                return { returnValue: true, activityId: 1 };
            },
            cancel: function () { return { returnValue: true }; }
        },

        "com.example.settings": {
            preBackup: function (args) {
                fs.writeFileSync(path.join(args.tempDir, "settings.json"), state.settingsPayload);
                return {
                    returnValue: true,
                    version: 1,
                    description: "Example settings",
                    files: ["settings.json"]
                };
            },
            postBackup: function () {
                state.postBackupCalls++;
                return { returnValue: true };
            },
            preRestore: function () {
                return { returnValue: true, proceed: true };
            },
            postRestore: function (args) {
                state.restored["com.example.settings"] =
                    fs.readFileSync(path.join(args.tempDir, "settings.json"), "utf8");
                return { returnValue: true };
            }
        },

        "com.example.notes": {
            preBackup: function (args) {
                fs.writeFileSync(path.join(args.tempDir, "notes.txt"), state.notesPayload);
                return {
                    returnValue: true,
                    version: 2,
                    description: "Example notes",
                    files: ["notes.txt"]
                };
            },
            postRestore: function (args) {
                state.restored["com.example.notes"] =
                    fs.readFileSync(path.join(args.tempDir, "notes.txt"), "utf8");
                return { returnValue: true };
            },
            restoreFinished: function () {
                state.restoreFinishedCalls.push("com.example.notes");
                return { returnValue: true };
            }
        },

        "com.example.watcher": {
            restoreFinished: function () {
                state.restoreFinishedCalls.push("com.example.watcher");
                return { returnValue: true };
            }
        }
    };
}

/* ---------------------------------------------------------------- driver */

function newContext() {
    var context = harness.loadService({
        root: ROOT,
        services: buildServices(),
        // VERBOSE=1 surfaces the service's own logging, which is the fastest
        // way to see where a run stopped.
        quiet: !process.env.VERBOSE
    });
    // The root helper is a device-only component; force the answer instead of
    // waiting out its 3s probe on every call.
    vm.runInContext("privileged.setAvailableForTesting(false);", context);
    // Enable backup so the scheduled path is not short-circuited.
    vm.runInContext("prefs.set({ userEnabled: true });", context);
    return context;
}

/**
 * Runs an assistant and resolves the callback with (error, result).
 */
function run(context, assistant, args, sink) {
    return new Promise(function (resolve) {
        var future = harness.runAssistant(context, assistant, args, sink);
        future.settle(function (err, result) {
            resolve({ error: err, result: result });
        });
    });
}

/**
 * The names a manifest's file descriptors resolve to in the content-addressed
 * store — the same rule as backup.getServerFilename.
 */
function storedNamesOf(manifest) {
    var names = [];
    (manifest.services || []).forEach(function (service) {
        (service.files || []).forEach(function (file) {
            names.push((file.checksum || file.origChecksum) + (file.compressed ? ".gz" : ""));
        });
    });
    return names;
}

function manifestDir() { return path.join(ROOT, "backups", "manifests"); }
function fileStoreDir() { return path.join(ROOT, "backups", "files"); }

/* ----------------------------------------------------------------- tests */

async function main() {
    console.log("woce-backup engine tests");
    console.log("sandbox: " + ROOT);

    buildSandbox();
    var context = newContext();

    /* ---- backup ---- */
    section("Backup");

    // Progress arrives on the getBackupStatus subscription, not on startBackup's
    // own — which is how the app wires it, and why it opens both.
    var statuses = [];
    await run(context, "GetBackupStatusAssistant", { subscribe: true }, statuses);

    var backup1 = await run(context, "BackupAssistant", { full: true }, []);

    check("startBackup succeeds",
        !backup1.error && backup1.result && backup1.result.STATUS === "Complete",
        backup1.error && backup1.error.message);

    var manifests = listFilesIn(manifestDir());
    check("one manifest written", manifests.length === 1, "found " + manifests.join(","));
    check("manifest is named 000001-<nduId>", manifests[0] === "000001-abc123", manifests[0]);
    if (manifests.length === 0) {
        // Nothing below can say anything useful without a manifest.
        console.log("\n  no manifest was written; stopping here");
        process.exit(1);
    }

    var storedFiles = listFilesIn(fileStoreDir());
    check("both service files stored", storedFiles.length === 2, "found " + storedFiles.length);

    var manifest = JSON.parse(fs.readFileSync(path.join(manifestDir(), manifests[0]), "utf8"));
    check("manifest records both services", manifest.services.length === 2,
        "found " + manifest.services.length);
    check("manifest size is non-zero", manifest.size > 0, String(manifest.size));
    check("manifest type is full", manifest.type === "full", manifest.type);
    check("postBackup was called", state.postBackupCalls === 1, String(state.postBackupCalls));
    check("device info captured", manifest.deviceInfo.deviceName === "Test TouchPad",
        manifest.deviceInfo.deviceName);
    check("progress was reported", statuses.length > 0, String(statuses.length));

    // .json compresses, .txt compresses; both should be gzipped and named by
    // the checksum of the original.
    check("stored names are checksum-addressed",
        storedFiles.every(function (n) { return /^[0-9a-f]{32}(\.gz)?$/.test(n); }),
        storedFiles.join(","));

    /* ---- incremental dedup ---- */
    section("Incremental backup with unchanged data");

    var backup2 = await run(context, "BackupAssistant", {}, []);
    check("second backup succeeds",
        !backup2.error && backup2.result.STATUS === "Complete",
        backup2.error && backup2.error.message);

    check("second manifest written", listFilesIn(manifestDir()).length === 2,
        listFilesIn(manifestDir()).join(","));
    check("no new files stored (deduped)", listFilesIn(fileStoreDir()).length === 2,
        "found " + listFilesIn(fileStoreDir()).length);

    var manifest2 = JSON.parse(fs.readFileSync(path.join(manifestDir(), "000002-abc123"), "utf8"));
    var reusedAll = manifest2.services.every(function (service) {
        return service.files.every(function (file) { return file["new"] === false; });
    });
    check("second manifest marks every file as reused", reusedAll);

    /* ---- incremental with changed data ---- */
    section("Incremental backup after data changes");

    state.notesPayload = "first note\nsecond note\nthird note\n";
    var backup3 = await run(context, "BackupAssistant", {}, []);
    check("third backup succeeds",
        !backup3.error && backup3.result.STATUS === "Complete",
        backup3.error && backup3.error.message);
    check("changed file added to the store", listFilesIn(fileStoreDir()).length === 3,
        "found " + listFilesIn(fileStoreDir()).length);

    /* ---- listing ---- */
    section("Listing");

    var list = await run(context, "ListBackupsAssistant", {});
    check("listBackups returns three backups",
        !list.error && list.result.backups.length === 3,
        list.error ? list.error.message : String(list.result.backups.length));
    check("newest backup listed first",
        list.result.backups[0].manifestName === "000003-abc123",
        list.result.backups[0] && list.result.backups[0].manifestName);

    var devices = await run(context, "GetRestoreDevicesAssistant", {});
    check("getRestoreDevices finds the device",
        !devices.error && devices.result.devices.length === 1,
        devices.error && devices.error.message);
    check("device reports all three backups",
        devices.result.devices[0].backups.length === 3,
        String(devices.result.devices[0].backups.length));
    check("device is marked as current",
        devices.result.devices[0].currentDevice === true);
    check("autoRestore is false with several backups",
        devices.result.autoRestore === false);

    /* ---- restore ---- */
    section("Restore");

    state.restored = {};
    state.restoreFinishedCalls = [];
    var restoreStatuses = [];

    var restore = await run(context, "RestoreAssistant",
        { manifestName: "000003-abc123" }, restoreStatuses);

    check("restore succeeds",
        !restore.error && restore.result && restore.result.STATUS === "Complete",
        restore.error && restore.error.message);
    check("settings content restored",
        state.restored["com.example.settings"] === state.settingsPayload,
        state.restored["com.example.settings"]);
    check("notes content restored (newest version)",
        state.restored["com.example.notes"] === state.notesPayload,
        JSON.stringify(state.restored["com.example.notes"]));
    check("restore reported progress", restoreStatuses.length > 0, String(restoreStatuses.length));

    check("restoreFinished sent to the notes service",
        state.restoreFinishedCalls.indexOf("com.example.notes") !== -1,
        state.restoreFinishedCalls.join(","));
    check("restoreFinished sent to the backup-less watcher service",
        state.restoreFinishedCalls.indexOf("com.example.watcher") !== -1,
        state.restoreFinishedCalls.join(","));

    // Written onto the manifest itself by restore (backup.storeManifest),
    // not tracked separately - so listBackups picks it up for free.
    var listAfterRestore = await run(context, "ListBackupsAssistant", {});
    var restoredEntry = listAfterRestore.result.backups.filter(
        function (b) { return b.manifestName === "000003-abc123"; })[0];
    var untouchedEntry = listAfterRestore.result.backups.filter(
        function (b) { return b.manifestName === "000002-abc123"; })[0];
    check("the restored backup is marked restored",
        restoredEntry && restoredEntry.restoredCount === 1 && !!restoredEntry.lastRestored,
        JSON.stringify(restoredEntry));
    check("a backup never restored reports restoredCount 0",
        untouchedEntry && untouchedEntry.restoredCount === 0 && !untouchedEntry.lastRestored,
        JSON.stringify(untouchedEntry));

    /* ---- restoring an older backup ---- */
    section("Restore of an earlier backup");

    state.restored = {};
    var restoreOld = await run(context, "RestoreAssistant", { manifestName: "000001-abc123" }, []);
    check("older restore succeeds",
        !restoreOld.error && restoreOld.result.STATUS === "Complete",
        restoreOld.error && restoreOld.error.message);
    check("older notes content came back",
        state.restored["com.example.notes"] === "first note\nsecond note\n",
        JSON.stringify(state.restored["com.example.notes"]));

    /* ---- delete and purge ---- */
    section("Delete and purge");

    var filesBefore = listFilesIn(fileStoreDir()).length;
    var del = await run(context, "DeleteBackupAssistant", { manifestName: "000003-abc123" });
    check("deleteBackup succeeds", !del.error, del.error && del.error.message);
    check("manifest removed", listFilesIn(manifestDir()).indexOf("000003-abc123") === -1);
    check("the file only that backup referenced was purged",
        listFilesIn(fileStoreDir()).length === filesBefore - 1,
        "before " + filesBefore + ", after " + listFilesIn(fileStoreDir()).length);

    var listAfter = await run(context, "ListBackupsAssistant", {});
    check("two backups remain", listAfter.result.backups.length === 2,
        String(listAfter.result.backups.length));

    /* ---- opt out erases everything ---- */
    section("Opt out");

    var optOut = await run(context, "OptOutAssistant", {});
    check("optOutOfBackup succeeds", !optOut.error, optOut.error && optOut.error.message);
    check("all manifests erased", listFilesIn(manifestDir()).length === 0,
        listFilesIn(manifestDir()).join(","));
    check("all stored files erased", listFilesIn(fileStoreDir()).length === 0,
        listFilesIn(fileStoreDir()).join(","));

    var afterOptOut = await run(context, "GetLastBackupTimeAssistant", {});
    check("last backup time reports the '.' sentinel",
        afterOptOut.result.lastbackupTime === ".",
        String(afterOptOut.result.lastbackupTime));
    check("optOut flag is reported", afterOptOut.result.optOut === true);

    /* ---- registration ---- */
    section("Dynamic registration");

    var reg = await run(context, "RegisterAssistant", {
        service: "com.example.dynamic",
        preBackup: "myPreBackup",
        postRestore: "myPostRestore"
    });
    check("register succeeds", !reg.error, reg.error && reg.error.message);

    var loaded = await new Promise(function (resolve) {
        vm.runInContext("__loaded = backup.loadRegisteredServices();", context);
        context.__loaded.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    check("dynamic registration is picked up",
        !loaded.error && loaded.result["com.example.dynamic"] !== undefined,
        loaded.error && loaded.error.message);
    check("static registrations still load",
        loaded.result["com.example.settings"] !== undefined);

    /* A restore must be able to hand a backup's saved passwords back even
     * though the Passwords category is off, which is its default - and the
     * default is exactly the state a device is in after the Doctor the backup
     * was taken to survive. Gating the restore on the local toggle skipped the
     * very data the run was for, and did it silently. */
    check("passwords provider stays out of a backup while the category is off",
        loaded.result["com.palm.backup.credentials"] === undefined);

    var forRestore = await new Promise(function (resolve) {
        vm.runInContext("__forRestore = backup.loadRegisteredServices({ allProviders: true });", context);
        context.__forRestore.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    check("restore registers the passwords provider regardless of the toggle",
        !forRestore.error && forRestore.result["com.palm.backup.credentials"] !== undefined,
        forRestore.error && forRestore.error.message);
    check("the provider restore gets is the in-process one",
        forRestore.result["com.palm.backup.credentials"] &&
            forRestore.result["com.palm.backup.credentials"].inProcess === true &&
            forRestore.result["com.palm.backup.credentials"].postRestore === "postRestore");

    var unreg = await run(context, "UnregisterAssistant", { service: "com.example.dynamic" });
    check("unregister succeeds", !unreg.error, unreg.error && unreg.error.message);

    /* ---- preferences ---- */
    section("Preferences");

    // prefs.set must resolve with a usable object. It used to chain a second
    // get() through nest(), which handed some callers undefined — and every
    // caller immediately does result.something.
    var setResult = await new Promise(function (resolve) {
        vm.runInContext('__setResult = prefs.set({ manifestsToKeep: 7 });', context);
        context.__setResult.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    check("prefs.set resolves with an object",
        !setResult.error && setResult.result && typeof setResult.result === "object",
        setResult.error ? setResult.error.message : String(setResult.result));
    check("prefs.set returns the merged value",
        setResult.result && setResult.result.manifestsToKeep === 7,
        JSON.stringify(setResult.result));
    check("prefs.set preserves untouched keys",
        setResult.result && setResult.result.userData !== undefined &&
        setResult.result.targetId === "local",
        JSON.stringify(setResult.result));

    // setUserDataCategories reads .userData off that result, which is exactly
    // where the device failure surfaced.
    var setCats = await run(context, "SetUserDataCategoriesAssistant",
        { categories: { photos: true } });
    check("setUserDataCategories succeeds",
        !setCats.error && setCats.result && setCats.result.returnValue === true,
        setCats.error && setCats.error.message);
    check("setUserDataCategories echoes the selection",
        setCats.result && setCats.result.categories &&
        setCats.result.categories.photos === true,
        JSON.stringify(setCats.result && setCats.result.categories));

    var getCats = await run(context, "GetUserDataCategoriesAssistant", {});
    var photos = null;
    (getCats.result.categories || []).forEach(function (c) {
        if (c.id === "photos") { photos = c; }
    });
    check("the selection persists", photos && photos.enabled === true,
        JSON.stringify(photos));

    /* ---- failure handling ---- */
    section("Failure handling");

    // getNduId reads a character device. It must survive that device being
    // absent (as it is here) without throwing out of an fs callback — a throw
    // there is outside any future's reach and takes the whole service process
    // down, silently.
    var nduFuture = vm.runInContext("system.getNduId();", context);
    var ndu = await new Promise(function (resolve) {
        nduFuture.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    check("getNduId settles when /dev/nduid is missing",
        ndu.error === undefined,
        ndu.error && ndu.error.message);
    check("and falls back to the device profile",
        ndu.result === "abc123", JSON.stringify(ndu.result));

    // /etc/palm/backup/com.palm.keymanager is mode 0640 root-only, so the jailed
    // service cannot read it and the helper has to. Modelled here with a
    // directory in the registration folder: readFileSync throws EISDIR, which is
    // the same "listed but unreadable" shape, and works on any OS.
    //
    // This also guards the chain itself: an earlier version assigned
    // f.exception, which let the service list finish 6ms after asking the helper
    // and dropped the file entirely.
    mkdirs(path.join(ROOT, "etc", "com.example.locked"));
    var lockedCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(true);", lockedCtx);
    lockedCtx.__registrationsAsked = 0;
    // Settles on a later tick, like the real helper's job-file round trip. A
    // synchronous stub would make Future.nest take its "already complete" path
    // and hide exactly the bug this test exists for.
    vm.runInContext(
        "privileged.readRegistrations = function () {" +
        "  __registrationsAsked++;" +
        "  var f = new Future();" +
        "  setTimeout(function () {" +
        "    f.result = { returnValue: true, files: {" +
        "      'com.example.locked': JSON.stringify({" +
        "        id: 'com.example.locked', restoreFinished: 'restoreFinished' }) }," +
        "      failed: [] };" +
        "  }, 20);" +
        "  return f;" +
        "};", lockedCtx);

    var loaded = await new Promise(function (resolve) {
        vm.runInContext("__loaded = backup.loadRegisteredServices();", lockedCtx);
        lockedCtx.__loaded.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    check("an unreadable registration file is fetched through the helper",
        lockedCtx.__registrationsAsked === 1,
        "asked " + lockedCtx.__registrationsAsked + " time(s)");
    check("and the service it declares ends up registered",
        !loaded.error && loaded.result && loaded.result["com.example.locked"] !== undefined,
        loaded.error ? loaded.error.message : Object.keys(loaded.result || {}).join(", "));
    rmrf(path.join(ROOT, "etc", "com.example.locked"));

    // com.palm.db answers on the public bus but exposes internal/preBackup —
    // the call the whole backup depends on — only on the private one, reporting
    // it as an unknown method. That has to route through the root helper, not
    // fail the run: com.palm.db is a required service.
    /* Installed-app discovery in direct mode.
     *
     * Driven with the exact shape two real LuneOS devices produce: a sargo with
     * two genuinely installed apps, and a tissot whose eleven
     * waydroid.* entries are appinfo.json shortcuts the Waydroid integration
     * generates for Android apps. Those carry no opkg record and are recreated
     * from the Android side, so archiving them would back up stubs and a
     * restore would plant launcher icons for apps that may be long gone. */
    section("Installed apps, direct mode");

    var APPS = "/media/cryptofs/apps/usr/palm/applications/";
    var appFixture = {
        // What `opkg -o /media/cryptofs/apps list-installed` prints on sargo.
        opkg: "com.achunt.jukie - 2.0.0\norg.webosarchive.flyingtoasters - 1.1.2\n",
        dirs: ["com.achunt.jukie", "org.webosarchive.flyingtoasters",
               "waydroid.org.lineageos.jelly", "waydroid.com.android.settings",
               "org.webosports.app.restoredbyhand"]
    };

    var realFs = require("fs");
    var appCtx = harness.loadService({
        root: ROOT,
        services: services,
        quiet: !process.env.VERBOSE,
        require: function (name) {
            if (name === "child_process") {
                // execFile: privileged.js runs every command as argv now.
                return { execFile: function (file, args, opts, cb) {
                    var done = cb || opts;
                    if (args.indexOf("list-installed") !== -1) {
                        return setTimeout(function () { done(null, appFixture.opkg, ""); }, 1);
                    }
                    return setTimeout(function () { done(null, "", ""); }, 1);
                } };
            }
            if (name === "fs") {
                var shim = Object.create(realFs);
                shim.readdirSync = function (dir) {
                    if (dir === APPS) { return appFixture.dirs; }
                    if (dir === "/usr/palm/applications/") { return ["com.palm.app.email"]; }
                    return realFs.readdirSync(dir);
                };
                shim.readFileSync = function (file, enc) {
                    var m = String(file).match(/applications\/([^\/]+)\/appinfo\.json$/);
                    if (m) {
                        return JSON.stringify({ id: m[1], title: "T-" + m[1], version: "9.9.9" });
                    }
                    return realFs.readFileSync(file, enc);
                };
                return shim;
            }
            return require(name);
        }
    });
    vm.runInContext("privileged.setDirectModeForTesting(true);", appCtx);

    var apps = await new Promise(function (resolve) {
        vm.runInContext("__apps = privileged.listInstalledApps();", appCtx);
        appCtx.__apps.settle(function (err, result) { resolve({ error: err, result: result }); });
    });
    var ids = ((apps.result && apps.result.packages) || []).map(function (p) { return p.id; }).sort();

    check("the two opkg-installed apps are found",
        ids.indexOf("com.achunt.jukie") !== -1 &&
            ids.indexOf("org.webosarchive.flyingtoasters") !== -1,
        JSON.stringify(ids));
    check("waydroid shortcuts are not treated as installed apps",
        ids.filter(function (id) { return id.indexOf("waydroid.") === 0; }).length === 0,
        JSON.stringify(ids));
    // An app the directory fallback put back has no opkg record, so opkg cannot
    // see it - and before it was picked up here it would drop out of every
    // later backup.
    check("an app with only a directory is still found, and marked unmanaged",
        ids.indexOf("org.webosports.app.restoredbyhand") !== -1 &&
            (apps.result.packages.filter(function (p) {
                return p.id === "org.webosports.app.restoredbyhand";
            })[0] || {}).unmanaged === true,
        JSON.stringify(ids));
    check("the version comes from opkg, not from appinfo",
        (apps.result.packages.filter(function (p) {
            return p.id === "com.achunt.jukie";
        })[0] || {}).version === "2.0.0");
    check("system-image apps are reported separately",
        (apps.result.romApps || []).indexOf("com.palm.app.email") !== -1,
        JSON.stringify(apps.result.romApps));

    /* Archiving prefers a cached installer over the directory tarball.
     *
     * Reinstalling from the .ipk lets opkg rebuild its own bookkeeping instead
     * of us reconstructing it, so it is worth looking for. woce-backupd looks
     * only for "<id>.ipk"; what a browser download actually leaves in
     * /media/internal/downloads is opkg's "<id>_<version>_<arch>.ipk", which
     * that name never matches - so both spellings are accepted here, and the
     * version has to match, since reinstalling a stale different version would
     * be worse than unpacking the directory we know is right. */
    section("Cached installers");

    var DOWNLOADS = "/media/internal/downloads/";
    var ipkFixture = { present: [], dirs: [] };
    var ipkCtx = harness.loadService({
        root: ROOT, services: services, quiet: !process.env.VERBOSE,
        require: function (name) {
            if (name === "child_process") {
                return { execFile: function (file, args, opts, cb) {
                    var done = cb || opts;
                    return setTimeout(function () { done(null, "", ""); }, 1);
                } };
            }
            if (name === "fs") {
                var realFs = require("fs");
                var shim = Object.create(realFs);
                shim.statSync = function (t) {
                    if (ipkFixture.present.indexOf(t) !== -1) { return { isFile: function () { return true; } }; }
                    if (String(t).indexOf(APPS) === 0) { return { isDirectory: function () { return true; } }; }
                    return realFs.statSync(t);
                };
                shim.readdirSync = function (dir) {
                    if (dir === DOWNLOADS) { return ipkFixture.dirs; }
                    if (dir === APPS) { return ["com.example.app"]; }
                    return realFs.readdirSync(dir);
                };
                return shim;
            }
            return require(name);
        }
    });
    vm.runInContext("privileged.setDirectModeForTesting(true);", ipkCtx);

    var findIpk = function (id, version, present, listing) {
        ipkFixture.present = present || [];
        ipkFixture.dirs = listing || [];
        ipkCtx.__ipkArgs = { id: id, version: version };
        vm.runInContext("__ipkFound = privileged.cachedIpkForTesting(__ipkArgs.id, __ipkArgs.version);", ipkCtx);
        return ipkCtx.__ipkFound;
    };

    check("the daemon's <id>.ipk name is honoured",
        findIpk("com.example.app", "1.0.0", [DOWNLOADS + "com.example.app.ipk"]) ===
            DOWNLOADS + "com.example.app.ipk");
    check("a browser download's <id>_<version>_<arch>.ipk is found too",
        findIpk("com.example.app", "1.0.0", [], ["com.example.app_1.0.0_all.ipk"]) ===
            DOWNLOADS + "com.example.app_1.0.0_all.ipk",
        String(findIpk("com.example.app", "1.0.0", [], ["com.example.app_1.0.0_all.ipk"])));
    check("a different version is refused rather than reinstalled",
        findIpk("com.example.app", "1.0.0", [], ["com.example.app_2.5.0_all.ipk"]) === null);
    check("another package with a similar name is not matched",
        findIpk("com.example.app", "1.0.0", [], ["com.example.apples_1.0.0_all.ipk"]) === null);
    check("nothing cached means nothing found, and the tarball path is used",
        findIpk("com.example.app", "1.0.0", [], []) === null);

    /* The restore destination allowlist. A backup sits on /media/internal,
     * which is exported to a PC as USB mass storage, so the paths in its
     * manifest are untrusted input being handed to a process running as root. */
    section("Restore destination policy");

    var destCtx = harness.loadService({ root: ROOT, services: services, quiet: !process.env.VERBOSE });
    var permits = function (p) {
        destCtx.__destProbe = p;
        vm.runInContext("__destResult = privileged.isRestorableDest(__destProbe);", destCtx);
        return destCtx.__destResult;
    };

    check("a real preferences destination is allowed",
        permits("/var/preferences/com.palm.display/prefsDB.sl") ===
            "/var/preferences/com.palm.display/prefsDB.sl");
    check("a real luna destination is allowed",
        permits("/var/luna/preferences/universalsearchprefs.db") !== null);
    check("the media destination is allowed", permits("/media/internal/photo.jpg") !== null);
    check("an executable destination is refused", permits("/usr/bin/luna-next") === null);
    check("an init script destination is refused", permits("/etc/init.d/evil") === null);
    check("a library destination is refused", permits("/lib/ld-linux.so") === null);
    // Denied even though /var/palm/ itself is allowed: an ls2 role file lets
    // any caller register as any service on the bus.
    check("an ls2 role destination is refused inside an allowed root",
        permits("/var/palm/ls2/roles/anything.json") === null);
    check("a jail destination is refused inside an allowed root",
        permits("/var/palm/jail/x") === null);
    check("the policy matches the 3.0.5 daemon's, root for root",
        permits("/home/root/x") === null && permits("/etc/palm/luna.conf") === null);
    check("traversal out of an allowed root is refused",
        permits("/var/preferences/../../usr/bin/luna-next") === null,
        String(permits("/var/preferences/../../usr/bin/luna-next")));
    check("a relative path cannot slip through", permits("../../usr/bin/x") === null);
    check("an empty destination is refused", permits("") === null && permits(null) === null);

    var privCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE,
        privateCategories: { "com.example.settings": "preBackup" }
    });
    vm.runInContext("privileged.setAvailableForTesting(true);", privCtx);
    // includePackages defaults on, and privileged mode makes BackupAssistant
    // call this near the end of every run. Unstubbed it falls through to the
    // real job-file implementation, which never finds a .done file here and
    // eats a real 60s wall-clock wait (privileged.js's own budget for that
    // job) before the run can complete.
    vm.runInContext(
        "privileged.listInstalledApps = function () { return new Future({ packages: [] }); };",
        privCtx);
    privCtx.__helperCalls = [];
    vm.runInContext(
        "privileged.setLunacallForTesting(function (service, method, params) {" +
        "  __helperCalls.push(service + '/' + method);" +
        "  return services__settingsPreBackup(params);" +
        "});", privCtx);
    // Route the helper's call at the same fake service the bus would have hit.
    privCtx.services__settingsPreBackup = function (params) {
        var svc = buildServices()["com.example.settings"];
        return new Future(svc.preBackup(params));
    };
    vm.runInContext("prefs.set({ userEnabled: true });", privCtx);

    var viaHelper = await run(privCtx, "BackupAssistant", { full: true }, []);
    check("a private-only category falls back to the root helper",
        privCtx.__helperCalls.length > 0,
        JSON.stringify(privCtx.__helperCalls));
    check("and the backup completes rather than failing on it",
        !viaHelper.error && viaHelper.result && viaHelper.result.STATUS === "Complete",
        viaHelper.error ? viaHelper.error.message : JSON.stringify(viaHelper.result));

    // A service reached through the root helper (anything gated on db8's
    // admin role) runs as root, outside the jail, so a RELATIVE filename it
    // names in its manifest can be just as unreadable to the jailed side as an
    // absolute one — the exact shape com.palm.db/internal/preBackup hit on
    // device: preBackup ran and named a real file, but the file came out
    // unreadable even though the directory itself is jail-visible. Before this
    // fix, a relative name was assumed genuinely missing the instant
    // isReadable() failed, with no staging attempt at all.
    var dumpServices = buildServices();
    dumpServices["com.example.dbish"] = {
        preBackup: function () {
            // Deliberately does not write into tempDir - stands in for a file
            // a process outside the jail wrote somewhere the jailed reader
            // cannot open.
            return {
                returnValue: true,
                version: 1,
                description: "Example db-like dump",
                files: ["dump.json"]
            };
        }
    };
    fs.writeFileSync(path.join(ROOT, "etc", "com.example.dbish"), JSON.stringify({
        id: "com.example.dbish",
        preBackup: "preBackup"
    }));

    var dumpCtx = harness.loadService({
        root: ROOT,
        services: dumpServices,
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(true);", dumpCtx);
    // See the identical stub and comment on privCtx above.
    vm.runInContext(
        "privileged.listInstalledApps = function () { return new Future({ packages: [] }); };",
        dumpCtx);
    dumpCtx.__staged = [];
    vm.runInContext(
        "privileged.setStageForTesting(function (paths, stageDir) {" +
        "  __staged = paths;" +
        "  var staged = {};" +
        "  var fs2 = require('fs');" +
        "  paths.forEach(function (p) {" +
        "    staged[p] = 'staged-dump';" +
        "    fs2.writeFileSync(stageDir + 'staged-dump', 'dump contents');" +
        "  });" +
        "  return new Future({ staged: staged, missing: [] });" +
        "});", dumpCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", dumpCtx);

    var dumpResult = await run(dumpCtx, "BackupAssistant", { full: true }, []);
    // Checking STATUS alone would not catch a regression here: com.example.dbish
    // is not a required service, so TOLERANT_MODE reports "Complete" whether the
    // file was actually staged or just silently skipped. The skipped list is
    // what actually distinguishes the two.
    var dumpSkipped = ((dumpResult.result && dumpResult.result.skipped) || [])
        .filter(function (s) { return s.service === "com.example.dbish"; });
    check("a relative filename unreadable from the jail is staged, not treated as missing",
        !dumpResult.error && dumpResult.result && dumpResult.result.STATUS === "Complete" &&
            dumpSkipped.length === 0,
        dumpResult.error ? dumpResult.error.message : JSON.stringify(dumpResult.result));
    check("staging was asked for the tempDir-resolved absolute path, not the bare relative name",
        dumpCtx.__staged.length === 1 && dumpCtx.__staged[0] !== "dump.json" &&
            dumpCtx.__staged[0].indexOf("dump.json") !== -1,
        JSON.stringify(dumpCtx.__staged));

    // And a service reached DIRECTLY (no root helper involved) with a relative,
    // genuinely-missing file must still fail loudly - this is the behaviour the
    // fix above must not have loosened.
    var stillMissingServices = buildServices();
    stillMissingServices["com.example.dbish"] = dumpServices["com.example.dbish"];
    fs.writeFileSync(path.join(ROOT, "etc", "com.example.dbish"), JSON.stringify({
        id: "com.example.dbish",
        preBackup: "preBackup"
    }));
    var stillMissingCtx = harness.loadService({
        root: ROOT,
        services: stillMissingServices,
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(false);", stillMissingCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", stillMissingCtx);
    var stillMissing = await run(stillMissingCtx, "BackupAssistant", { full: true }, []);
    // com.example.dbish is not a required service, so TOLERANT_MODE turns its
    // throw into a skip rather than failing the whole run - same as any other
    // optional service's error. (com.palm.db, the one REQUIRED_SERVICES entry,
    // is what turned this exact error into a hard "Backup failed" on device.)
    // What this test needs to prove is narrower: absent the helper, the file is
    // still reported missing rather than silently treated as available.
    var stillMissingSkip = ((stillMissing.result && stillMissing.result.skipped) || [])
        .filter(function (s) { return s.service === "com.example.dbish"; })[0];
    check("without the helper, a relative missing file is still reported missing",
        stillMissingSkip && /asked to back up a missing file/.test(stillMissingSkip.error || ""),
        JSON.stringify(stillMissing.error || stillMissing.result));
    rmrf(path.join(ROOT, "etc", "com.example.dbish"));

    // A file whose manifest path is absolute and outside the jail (e.g. /tmp,
    // like com.palm.appDataBackup's cookies db) must be restored through the
    // root helper's unstage, not written directly - the jail cannot write /tmp
    // any more than it can write /var/palm. Confirmed on device: the jailed
    // process's own gunzip into /tmp failed with EACCES because isWritableHere
    // wrongly treated /tmp/ as jail-writable.
    // Not /tmp/... on purpose: on Windows (where this suite runs), Node
    // resolves a leading "/" against the current drive root, so a short,
    // plausible-looking /tmp path can accidentally already exist on the test
    // machine and take the "direct" branch instead of exercising staging at
    // all - happened while writing this test. A synthetic, pid-suffixed path
    // under a directory production actually uses for this (com.palm.service.
    // contacts returns /var/palm/data/... paths) can't collide either way.
    var OUTSIDE_PATH = "/var/palm/data/woce-backup-test-outside-" + process.pid + ".txt";
    var outsideServices = buildServices();
    outsideServices["com.example.outside"] = {
        preBackup: function () {
            return {
                returnValue: true,
                version: 1,
                description: "Example file outside the jail",
                files: [OUTSIDE_PATH]
            };
        },
        postRestore: function () {
            return { returnValue: true };
        }
    };
    fs.writeFileSync(path.join(ROOT, "etc", "com.example.outside"), JSON.stringify({
        id: "com.example.outside", preBackup: "preBackup", postRestore: "postRestore"
    }));

    var outsideCtx = harness.loadService({
        root: ROOT,
        services: outsideServices,
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(true);", outsideCtx);
    vm.runInContext(
        "privileged.listInstalledApps = function () { return new Future({ packages: [] }); };",
        outsideCtx);
    outsideCtx.__staged = [];
    vm.runInContext(
        "privileged.setStageForTesting(function (paths, stageDir) {" +
        "  __staged = paths;" +
        "  var staged = {};" +
        "  var fs2 = require('fs');" +
        "  paths.forEach(function (p) {" +
        "    staged[p] = 'staged-outside';" +
        "    fs2.writeFileSync(stageDir + 'staged-outside', 'outside jail contents');" +
        "  });" +
        "  return new Future({ staged: staged, missing: [] });" +
        "});", outsideCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", outsideCtx);

    var outsideBackup = await run(outsideCtx, "BackupAssistant", { full: true }, []);
    check("backing up a file outside the jail succeeds (staged via the helper)",
        !outsideBackup.error && outsideBackup.result && outsideBackup.result.STATUS === "Complete",
        outsideBackup.error ? outsideBackup.error.message : JSON.stringify(outsideBackup.result));

    outsideCtx.__unstaged = null;
    vm.runInContext(
        "privileged.setUnstageForTesting(function (files, stageDir) {" +
        "  __unstaged = files;" +
        "  return new Future({ restored: files.map(function (f) { return f.path; }), skipped: [] });" +
        "});", outsideCtx);

    var outsideRestore = await run(outsideCtx, "RestoreAssistant",
        { manifestName: outsideBackup.result.manifestName }, []);
    check("restoring it back completes",
        !outsideRestore.error && outsideRestore.result && outsideRestore.result.STATUS === "Complete",
        outsideRestore.error ? outsideRestore.error.message : JSON.stringify(outsideRestore.result));
    check("and it went through unstage rather than a direct jail write",
        outsideCtx.__unstaged && outsideCtx.__unstaged.length === 1 &&
            outsideCtx.__unstaged[0].path === OUTSIDE_PATH,
        JSON.stringify(outsideCtx.__unstaged));
    rmrf(path.join(ROOT, "etc", "com.example.outside"));

    /* ---- installed packages: archive on backup, reinstall on restore ---- */
    section("Installed applications");

    // archivePackages is best-effort: it only finds an .ipk if Preware/WOSQI's
    // download cache still has it. Modelled here with two listed packages,
    // only one of which the stub "finds" - the other should stay list-only,
    // same as the real daemon leaves anything it cannot locate.
    var pkgCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(true);", pkgCtx);
    vm.runInContext(
        "privileged.listInstalledApps = function () {" +
        "  return new Future({ returnValue: true, packages: [" +
        "    { id: 'com.example.appone', version: '1.0', title: 'App One' }," +
        "    { id: 'com.example.apptwo', version: '2.0', title: 'App Two' }," +
        "    { id: 'com.example.appthree', version: '3.0', title: 'App Three' }," +
        "    { id: 'com.example.appfour', version: '4.0', title: 'App Four' }," +
        "    { id: 'com.example.appfive', version: '5.0', title: 'App Five' }," +
        "    { id: 'com.palm.somesystemapp', version: '1.0', title: 'Some System App' }" +
        "  ] });" +
        "};", pkgCtx);
    pkgCtx.__archiveDestDirs = [];
    pkgCtx.__writeArchivedIpk = function (destDir) {
        mkdirs(destDir);
        fs.writeFileSync(path.join(destDir, "com.example.appone.ipk"), "fake ipk bytes");
    };
    // appfour models the common case: no cached .ipk, so the daemon's
    // fallback tars up the installed app directory instead.
    pkgCtx.__writeArchivedAppDir = function (destDir, id) {
        mkdirs(destDir);
        fs.writeFileSync(path.join(destDir, (id || "com.example.appfour") + "-app.tar.gz"),
                         "fake tarball bytes");
    };
    vm.runInContext(
        // The service now calls this once PER PACKAGE so it can name what it is
        // working on, so the stub answers for whichever one it was handed.
        "privileged.archivePackages = function (packages, destDir) {" +
        "  __archiveDestDirs.push(destDir);" +
        "  var id = packages[0] && packages[0].id;" +
        "  var out = { returnValue: true, archived: [], archivedDirs: [], failures: [] };" +
        "  if (id === 'com.example.appone') { __writeArchivedIpk(destDir); out.archived.push(id); }" +
        "  if (id === 'com.example.appfour') { __writeArchivedAppDir(destDir); out.archivedDirs.push(id); }" +
        "  if (id === 'com.example.appfive') { __writeArchivedAppDir(destDir, 'com.example.appfive'); out.archivedDirs.push(id); }" +
        "  if (id === 'com.example.apptwo') { out.failures.push({ id: id," +
        "      reason: 'timed out after 300s (budget 300s for 412MB)' }); }" +
        "  return new Future(out);" +
        "};", pkgCtx);
    vm.runInContext("prefs.set({ userEnabled: true, includePackages: true });", pkgCtx);

    var pkgBackup = await run(pkgCtx, "BackupAssistant", { full: true }, []);
    check("archiving asks for one package at a time (so it can name each)",
        pkgCtx.__archiveDestDirs.length >= 4,
        "archive calls: " + pkgCtx.__archiveDestDirs.length);

    check("backup with archivable packages completes",
        !pkgBackup.error && pkgBackup.result && pkgBackup.result.STATUS === "Complete",
        pkgBackup.error ? pkgBackup.error.message : JSON.stringify(pkgBackup.result));

    var pkgManifest = JSON.parse(fs.readFileSync(
        path.join(manifestDir(), pkgBackup.result.manifestName), "utf8"));
    var appOne = (pkgManifest.packages || []).filter(function (p) { return p.id === "com.example.appone"; })[0];
    var appTwo = (pkgManifest.packages || []).filter(function (p) { return p.id === "com.example.apptwo"; })[0];
    check("the found package is marked archived with a stored file",
        appOne && appOne.archived === true && appOne.file && appOne.file.path === "com.example.appone.ipk",
        JSON.stringify(appOne));
    check("the not-found package is listed but not archived",
        appTwo && appTwo.archived === false && !appTwo.file,
        JSON.stringify(appTwo));

    var appFour = (pkgManifest.packages || []).filter(function (p) { return p.id === "com.example.appfour"; })[0];
    // The helper reports WHY an archive failed; that reason has to survive into
    // the manifest, or a package that timed out looks identical to one that was
    // never installed.
    var appTwoEntry = (pkgManifest.packages || []).filter(function (p) {
        return p.id === "com.example.apptwo";
    })[0];
    check("a failed archive records the helper's reason in the manifest",
        appTwoEntry && /timed out after 300s/.test(appTwoEntry.archiveError || ""),
        JSON.stringify(appTwoEntry && appTwoEntry.archiveError));

    check("the package with no cached .ipk falls back to a directory backup",
        appFour && appFour.archived === false && !appFour.file &&
            appFour.dirBackedUp === true && appFour.dirFile &&
            appFour.dirFile.path === "com.example.appfour-app.tar.gz",
        JSON.stringify(appFour));

    // Now restore from that manifest: the archived package should be fetched
    // back and handed to installPackages; the other was never archived, so it
    // must not even be attempted. Restore re-queries listInstalledApps against
    // *this* device to skip anything already present - the whole reason the
    // feature exists is restoring onto a wiped or different device, so only
    // appthree (simulating an app the user never uninstalled, or put back
    // manually before running restore) is reported installed here, unlike at
    // backup time above.
    pkgCtx.__installCalls = [];
    vm.runInContext(
        "privileged.installPackages = function (files) {" +
        "  __installCalls.push(files);" +
        "  return new Future({ returnValue: true," +
        "    installed: files.map(function (f) { return f.id; }), failed: [] });" +
        "};", pkgCtx);
    pkgCtx.__restoreDirCalls = [];
    vm.runInContext(
        "privileged.restoreAppDirectories = function (files) {" +
        "  __restoreDirCalls.push(files);" +
        "  var ok = [], bad = [], why = {};" +
        "  files.forEach(function (f) {" +
        "    if (f.id === 'com.example.appfive') {" +
        "      bad.push(f.id);" +
        "      why[f.id] = 'extracting timed out after 642s (budget 642s for a 214MB archive)';" +
        "    } else { ok.push(f.id); }" +
        "  });" +
        "  return new Future({ returnValue: true," +
        "    restored: ok, failed: bad, failureReasons: why," +
        // the helper reports which of them needed their service registering
        "    servicesRegistered: ok });" +
        "};", pkgCtx);
    vm.runInContext(
        "privileged.listInstalledApps = function () {" +
        "  return new Future({ returnValue: true, packages: [" +
        "    { id: 'com.example.appthree', version: '3.0', title: 'App Three' }" +
        "  ], romApps: ['com.palm.somesystemapp'] });" +
        "};", pkgCtx);

    // restoreUserApps defaults off: reinstalling runs opkg maintainer scripts
    // (or unpacks a tree) as root from an unauthenticated backup, so a restore
    // that was not asked to bring apps back must not touch any.
    var noAppsRestore = await run(pkgCtx, "RestoreAssistant",
        { manifestName: pkgBackup.result.manifestName }, []);
    check("with restoreUserApps off, the restore still completes",
        !noAppsRestore.error && noAppsRestore.result &&
            noAppsRestore.result.STATUS === "Complete" &&
            noAppsRestore.result.appsRestored === false,
        noAppsRestore.error ? noAppsRestore.error.message : JSON.stringify(noAppsRestore.result));
    check("and no package is installed or unpacked",
        pkgCtx.__installCalls.length === 0 && pkgCtx.__restoreDirCalls.length === 0,
        JSON.stringify([pkgCtx.__installCalls, pkgCtx.__restoreDirCalls]));

    vm.runInContext("prefs.set({ restoreUserApps: true });", pkgCtx);
    var pkgRestore = await run(pkgCtx, "RestoreAssistant",
        { manifestName: pkgBackup.result.manifestName }, []);
    check("restore completes",
        !pkgRestore.error && pkgRestore.result && pkgRestore.result.STATUS === "Complete",
        pkgRestore.error ? pkgRestore.error.message : JSON.stringify(pkgRestore.result));
    check("installPackages was only asked for the archived package",
        pkgCtx.__installCalls.length === 1 && pkgCtx.__installCalls[0].length === 1 &&
            pkgCtx.__installCalls[0][0].id === "com.example.appone",
        JSON.stringify(pkgCtx.__installCalls));
    check("restoreAppDirectories was only asked for the directory-backed-up packages",
        pkgCtx.__restoreDirCalls.length === 1 && pkgCtx.__restoreDirCalls[0].length === 2 &&
            pkgCtx.__restoreDirCalls[0].map(function (f) { return f.id; }).sort().join(",") ===
                "com.example.appfive,com.example.appfour",
        JSON.stringify(pkgCtx.__restoreDirCalls));

    var resultPackages = (pkgRestore.result && pkgRestore.result.packages) || [];
    var resultAppOne = resultPackages.filter(function (p) { return p.id === "com.example.appone"; })[0];
    var resultAppTwo = resultPackages.filter(function (p) { return p.id === "com.example.apptwo"; })[0];
    var resultAppThree = resultPackages.filter(function (p) { return p.id === "com.example.appthree"; })[0];
    var resultAppFour = resultPackages.filter(function (p) { return p.id === "com.example.appfour"; })[0];
    var resultSystemApp = resultPackages.filter(function (p) { return p.id === "com.palm.somesystemapp"; })[0];
    check("the archived package reports as automatically reinstalled",
        resultAppOne && resultAppOne.installed === true, JSON.stringify(resultAppOne));
    check("the never-archived package reports as still needing a manual reinstall",
        resultAppTwo && resultAppTwo.installed === false, JSON.stringify(resultAppTwo));
    check("the directory-backed-up package also reports as automatically reinstalled",
        resultAppFour && resultAppFour.installed === true, JSON.stringify(resultAppFour));
    check("a package already installed on this device is left out of the result entirely",
        !resultAppThree, JSON.stringify(resultAppThree));
    check("a package the system image provides is left out of the result entirely",
        !resultSystemApp, JSON.stringify(resultSystemApp));
    check("neither excluded package was ever handed to installPackages",
        pkgCtx.__installCalls[0].every(function (f) {
            return f.id !== "com.example.appthree" && f.id !== "com.palm.somesystemapp";
        }),
        JSON.stringify(pkgCtx.__installCalls));
    check("neither excluded package was ever handed to restoreAppDirectories",
        pkgCtx.__restoreDirCalls[0].every(function (f) {
            return f.id !== "com.example.appthree" && f.id !== "com.palm.somesystemapp";
        }),
        JSON.stringify(pkgCtx.__restoreDirCalls));

    // The restore receipt: the only durable record of what a restore did.
    // Every outcome must be represented, and the two skip reasons must stay
    // distinguishable - "you already have it" and "the image provides it" are
    // different answers to "why is my app missing".
    var receiptDir = path.join(ROOT, "backups", "receipts");
    // Several restores run in this suite, each leaving its own receipt, so pick
    // the one for THIS manifest's second restore rather than whatever sorts
    // first. The first is the restoreUserApps-off run above.
    var wantReceipt = pkgBackup.result.manifestName + "-restore-02.json";
    var receipts = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir) : [];
    var offReceiptName = pkgBackup.result.manifestName + "-restore-01.json";
    var offReceipt = receipts.indexOf(offReceiptName) !== -1
        ? JSON.parse(fs.readFileSync(path.join(receiptDir, offReceiptName), "utf8")) : null;
    check("with restoreUserApps off, the receipt says the apps were not requested",
        offReceipt && offReceipt.packages.filter(function (p) {
            return p.id === "com.example.appone";
        })[0].outcome === "not-requested",
        JSON.stringify(offReceipt && offReceipt.summary));
    check("a restore writes a receipt named for the manifest and attempt",
        receipts.indexOf(wantReceipt) !== -1, JSON.stringify(receipts));
    if (receipts.indexOf(wantReceipt) !== -1) {
        var rcpt = JSON.parse(fs.readFileSync(path.join(receiptDir, wantReceipt), "utf8"));
        var byId = {};
        (rcpt.packages || []).forEach(function (p) { byId[p.id] = p.outcome; });
        check("the receipt names the manifest it restored",
            rcpt.manifestName === pkgBackup.result.manifestName, JSON.stringify(rcpt.manifestName));
        check("an app that was put back reads as installed",
            byId["com.example.appone"] === "installed", JSON.stringify(byId));
        check("an app the backup never captured reads as not-captured",
            byId["com.example.apptwo"] === "not-captured", JSON.stringify(byId));
        var twoEntry = (rcpt.packages || []).filter(function (p) {
            return p.id === "com.example.apptwo";
        })[0];
        check("the receipt says WHY it was not captured",
            twoEntry && /timed out after 300s/.test(twoEntry.note || ""),
            JSON.stringify(twoEntry));
        // The bug this guards: a directory restore that ran out of time was
        // recorded as a bare "failed", indistinguishable from a corrupt
        // archive, and two 400MB games were misdiagnosed for a whole release
        // cycle because of it. The helper's reason has to reach the receipt.
        check("a directory restore that failed reads as failed",
            byId["com.example.appfive"] === "failed", JSON.stringify(byId));
        var fiveEntry = (rcpt.packages || []).filter(function (p) {
            return p.id === "com.example.appfive";
        })[0];
        check("the receipt says WHY the directory restore failed",
            fiveEntry && /timed out after 642s/.test(fiveEntry.note || ""),
            JSON.stringify(fiveEntry));
        check("a failed restore is not also claimed as a registered service",
            fiveEntry && !fiveEntry.serviceRegistered, JSON.stringify(fiveEntry));
        check("an app already on the device reads as already-present",
            byId["com.example.appthree"] === "already-present", JSON.stringify(byId));
        check("an app the image provides reads as image-provided",
            byId["com.palm.somesystemapp"] === "image-provided", JSON.stringify(byId));
        var svcEntry = (rcpt.packages || []).filter(function (p) {
            return p.id === "com.example.appfour";
        })[0];
        check("an app whose service we registered says so in the receipt",
            svcEntry && svcEntry.serviceRegistered === true && /reboot/.test(svcEntry.note || ""),
            JSON.stringify(svcEntry));
        check("the receipt counts how many services it had to register",
            rcpt.summary.servicesRegistered >= 1, JSON.stringify(rcpt.summary));
        check("the summary counts add up to the package list",
            (rcpt.summary.installed + rcpt.summary.failed + rcpt.summary.notCaptured +
             rcpt.summary.alreadyPresent + rcpt.summary.imageProvided) === rcpt.packages.length,
            JSON.stringify(rcpt.summary));
    }

    // An app that lives in /usr/palm/applications belongs to the system image.
    // ipkg can still report it as installed - webOS CE seeds cryptofs status
    // stanzas for apps it BAKES, so Preware shows them - so the id turning up
    // in `packages` is not enough to call it the user's. Backup must leave it
    // out of the manifest entirely.
    vm.runInContext(
        "privileged.listInstalledApps = function () {" +
        "  return new Future({ returnValue: true, packages: [" +
        "    { id: 'com.example.appone', version: '1.0', title: 'App One' }," +
        "    { id: 'org.example.bakedapp', version: '0.9', title: 'Baked App' }" +
        "  ], romApps: ['org.example.bakedapp'] });" +
        "};", pkgCtx);
    var romBackup = await run(pkgCtx, "BackupAssistant", { full: true }, []);
    check("a backup with a system app in the ipkg list still completes",
        !romBackup.error && romBackup.result && romBackup.result.STATUS === "Complete",
        romBackup.error ? romBackup.error.message : JSON.stringify(romBackup.result));
    var romManifest = JSON.parse(fs.readFileSync(
        path.join(manifestDir(), romBackup.result.manifestName), "utf8"));
    var romIds = (romManifest.packages || []).map(function (p) { return p.id; });
    check("an app in /usr is left out of the backup manifest",
        romIds.indexOf("org.example.bakedapp") === -1, JSON.stringify(romIds));
    check("the user's own app is still recorded",
        romIds.indexOf("com.example.appone") !== -1, JSON.stringify(romIds));

    // And the restore side of the same rule, which the backup filter cannot
    // cover: a backup taken on webOS 3.0.5, where the app really was a cryptofs
    // install, restored onto CE 3.1, which bakes that app into the rootfs.
    // Putting the backed-up copy back would shadow the newer system one.
    pkgCtx.__installCalls = [];
    pkgCtx.__restoreDirCalls = [];
    vm.runInContext(
        "privileged.listInstalledApps = function () {" +
        "  return new Future({ returnValue: true, packages: []," +
        "    romApps: ['com.example.appone', 'com.example.appfour'] });" +
        "};", pkgCtx);
    var romRestore = await run(pkgCtx, "RestoreAssistant",
        { manifestName: pkgBackup.result.manifestName }, []);
    check("restore completes with every restorable app now baked into the image",
        !romRestore.error && romRestore.result && romRestore.result.STATUS === "Complete",
        romRestore.error ? romRestore.error.message : JSON.stringify(romRestore.result));
    check("an app baked into the system image is never reinstalled over",
        pkgCtx.__installCalls.every(function (call) {
            return call.every(function (f) { return f.id !== "com.example.appone"; });
        }), JSON.stringify(pkgCtx.__installCalls));
    check("nor is one put back as a raw app directory",
        pkgCtx.__restoreDirCalls.every(function (call) {
            return call.every(function (f) { return f.id !== "com.example.appfour"; });
        }), JSON.stringify(pkgCtx.__restoreDirCalls));

    // Confirmed on-device: a second restore call fired while one was already
    // running - well past the point any client-side re-entry guard could
    // still be blocking it - raced the first one's own lunacall fallback and
    // collided ("Attempted to register for a service name that already
    // exists: com.palm.backup.privileged"). Reproduced here as two calls
    // fired back to back, neither awaited before the other starts; both
    // reach RestoreAssistant.run() before either can finish.
    var firstRestore  = run(pkgCtx, "RestoreAssistant",
        { manifestName: pkgBackup.result.manifestName }, []);
    var secondRestore = run(pkgCtx, "RestoreAssistant",
        { manifestName: pkgBackup.result.manifestName }, []);
    var concurrentResults = await Promise.all([firstRestore, secondRestore]);

    var completed = concurrentResults.filter(function (r) {
        return !r.error && r.result && r.result.STATUS === "Complete";
    });
    var busyRejected = concurrentResults.filter(function (r) {
        return !r.error && r.result && r.result.STATUS === "Failed" &&
            /already in progress/i.test(r.result.errorText || "");
    });
    check("exactly one of two concurrent restores actually runs",
        completed.length === 1, JSON.stringify(concurrentResults));
    check("the other is rejected cleanly instead of racing for the privileged bus identity",
        busyRejected.length === 1, JSON.stringify(concurrentResults));

    // A *registered service* that accepts preBackup and never answers must be
    // skipped, not allowed to park the backup. This is what com.palm.browserServer
    // did on device: the run sat in preBackup with no error and no completion.
    var stuckServices = buildServices();
    stuckServices["com.example.notes"] = {
        preBackup: function () { return new Future(); }   // never settles
    };
    var stuckCtx = harness.loadService({
        root: ROOT,
        services: stuckServices,
        quiet: !process.env.VERBOSE
    });
    vm.runInContext("privileged.setAvailableForTesting(false);", stuckCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", stuckCtx);
    vm.runInContext("SERVICE_CALL_TIMEOUT = 300;", stuckCtx);

    var stuck = await run(stuckCtx, "BackupAssistant", { full: true }, []);
    check("a service that never answers preBackup does not park the backup",
        stuck.error !== undefined || stuck.result !== undefined,
        "future never settled");
    check("the backup completes with that service recorded as skipped",
        !stuck.error && stuck.result && stuck.result.STATUS === "Complete" &&
        (stuck.result.skipped || []).length > 0,
        stuck.error ? stuck.error.message : JSON.stringify(stuck.result));

    // A service that accepts a call and never answers must not park the run.
    // startBackup has a 7200s command timeout, so a hung optional call is
    // invisible for two hours — it just looks like the backup stopped.
    var hangCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE,
        palmCallHangsFor: "com.palm.systemservice"
    });
    vm.runInContext("privileged.setAvailableForTesting(false);", hangCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", hangCtx);
    // Shorten the wait so the suite does not sit here for 20s.
    vm.runInContext("TOLERATE_TIMEOUT = 300;", hangCtx);

    var hung = await run(hangCtx, "BackupAssistant", { full: true }, []);
    check("a hung optional call does not park the backup",
        hung.error !== undefined || hung.result !== undefined,
        "future never settled");
    check("the backup completes without the hung call's data",
        !hung.error && hung.result && hung.result.STATUS === "Complete",
        hung.error ? hung.error.message : JSON.stringify(hung.result));

    // A malformed URI makes PalmCall throw *synchronously*, before any future
    // exists. That escapes tolerate(), which takes a future, and on device it
    // stalled the backup at "Preparing" — no error, no completion, just a
    // command timeout minutes later.
    var throwCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE,
        // The battery query is optional, so a throw from it must not be fatal.
        palmCallThrowsFor: "com.palm.power"
    });
    vm.runInContext("privileged.setAvailableForTesting(false);", throwCtx);
    vm.runInContext("prefs.set({ userEnabled: true });", throwCtx);

    var syncThrow = await run(throwCtx, "BackupAssistant", { full: true }, []);
    check("a synchronous PalmCall throw settles the future instead of stalling",
        syncThrow.error !== undefined || syncThrow.result !== undefined,
        "future never settled");
    check("and the backup still completes, since that call is optional",
        !syncThrow.error && syncThrow.result && syncThrow.result.STATUS === "Complete",
        syncThrow.error ? syncThrow.error.message : JSON.stringify(syncThrow.result))

    // A non-required service that blows up should be recorded and stepped over,
    // not take the whole backup with it.
    buildSandbox();
    state.notesPayload = "notes\n";

    var services = buildServices();
    services["com.example.notes"].preBackup = function () {
        throw new Error("notes service is broken");
    };
    var flakyContext = harness.loadService({ root: ROOT, services: services, quiet: !process.env.VERBOSE });
    vm.runInContext("privileged.setAvailableForTesting(false);", flakyContext);
    vm.runInContext("prefs.set({ userEnabled: true });", flakyContext);
    vm.runInContext('backup.REQUIRED_SERVICES = ["com.example.settings"];', flakyContext);

    var tolerated = await run(flakyContext, "BackupAssistant", { full: true }, []);
    check("backup survives a non-required service failing",
        !tolerated.error && tolerated.result && tolerated.result.STATUS === "Complete",
        tolerated.error && tolerated.error.message);
    check("the failure is recorded in skipped",
        tolerated.result && tolerated.result.skipped &&
        tolerated.result.skipped.some(function (s) { return s.service === "com.example.notes"; }),
        JSON.stringify(tolerated.result && tolerated.result.skipped));

    var savedManifest = listFilesIn(manifestDir())[0];
    var partial = JSON.parse(fs.readFileSync(path.join(manifestDir(), savedManifest), "utf8"));
    check("the manifest records what was skipped", partial.skipped.length === 1,
        JSON.stringify(partial.skipped));

    // A REQUIRED service failing must fail the run, and — this is the part that
    // regressed once — the status has to end up Failed rather than silently
    // completing because an error handler ran too early in the chain.
    buildSandbox();
    var brokenServices = buildServices();
    brokenServices["com.example.settings"].preBackup = function () {
        throw new Error("settings service is broken");
    };
    var brokenContext = harness.loadService({ root: ROOT, services: brokenServices, quiet: !process.env.VERBOSE });
    vm.runInContext("privileged.setAvailableForTesting(false);", brokenContext);
    vm.runInContext("prefs.set({ userEnabled: true });", brokenContext);
    vm.runInContext('backup.REQUIRED_SERVICES = ["com.example.settings"];', brokenContext);

    var broken = await run(brokenContext, "BackupAssistant", { full: true }, []);
    check("backup fails when a required service fails", !!broken.error,
        broken.error ? broken.error.message : "no error raised");

    var brokenStatus = vm.runInContext("backup.getStatus()", brokenContext);
    check("status ends up Failed, not Complete",
        brokenStatus && brokenStatus.STATUS === "Failed",
        JSON.stringify(brokenStatus));
    check("no manifest is left behind by a failed backup",
        listFilesIn(manifestDir()).length === 0,
        listFilesIn(manifestDir()).join(","));

    /* ---- free space ---- */
    section("Free space");

    // Both targets have implemented getSpace() from the start and nothing ever
    // called it, so a full volume surfaced as a backup that ran for a while and
    // then failed somewhere in the middle.
    buildSandbox();
    var spaceContext = newContext();
    vm.runInContext(
        "LocalTarget.prototype.getSpace = function () {" +
        "  var f = new Future();" +
        "  setTimeout(function () { f.result = { free: 1024, total: 1024 * 1024 * 1024 }; }, 0);" +
        "  return f;" +
        "};", spaceContext);

    var spaceRun = await run(spaceContext, "BackupAssistant", { full: true }, []);
    check("a backup that cannot possibly fit is refused up front",
        !!spaceRun.error && /Not enough free space/.test(spaceRun.error.message),
        spaceRun.error ? spaceRun.error.message : "no error raised");

    var spaceStatus = vm.runInContext("backup.getStatus()", spaceContext);
    check("and reports type SPACE, so the app can say why",
        spaceStatus && spaceStatus.STATUS === "Failed" && spaceStatus.type === "SPACE",
        JSON.stringify(spaceStatus));
    check("no manifest is written for a backup refused on space",
        listFilesIn(manifestDir()).length === 0,
        listFilesIn(manifestDir()).join(","));

    // A target that cannot measure itself must not block backups — that is the
    // honest answer for a future network target.
    buildSandbox();
    var unknownSpaceContext = newContext();
    vm.runInContext(
        "LocalTarget.prototype.getSpace = function () {" +
        "  var f = new Future();" +
        "  setTimeout(function () { f.result = { free: null, total: null }; }, 0);" +
        "  return f;" +
        "};", unknownSpaceContext);
    var unknownSpaceRun = await run(unknownSpaceContext, "BackupAssistant", { full: true }, []);
    check("a target that cannot report free space still backs up",
        !unknownSpaceRun.error && unknownSpaceRun.result &&
            unknownSpaceRun.result.STATUS === "Complete",
        unknownSpaceRun.error && unknownSpaceRun.error.message);

    /* ---- purge is scoped to this device ---- */
    section("Purge across devices");

    // The README tells people to copy backups off one device and onto another.
    // Trimming to manifestsToKeep used to count every manifest in the target and
    // delete the lexicographically lowest, so importing another device's
    // backups and then running one backup here deleted them.
    buildSandbox();
    var shareContext = newContext();
    vm.runInContext("prefs.set({ manifestsToKeep: 1 });", shareContext);

    var shared1 = await run(shareContext, "BackupAssistant", { full: true }, []);
    check("first backup on the shared target succeeds",
        !shared1.error && shared1.result && shared1.result.STATUS === "Complete",
        shared1.error && shared1.error.message);

    var ours = JSON.parse(fs.readFileSync(path.join(manifestDir(), "000001-abc123"), "utf8"));
    var foreignFiles = storedNamesOf(ours);
    check("the first backup stored files to protect", foreignFiles.length > 0);

    // Another device's backup, dropped into the target the way copying one over
    // USB would. It references the files that exist right now, so after our own
    // older manifest is trimmed those files are referenced by it alone.
    var foreign = JSON.parse(JSON.stringify(ours));
    foreign.deviceInfo.nduId = "otherdev";
    foreign.deviceInfo.deviceName = "Someone else's TouchPad";
    fs.writeFileSync(path.join(manifestDir(), "000009-otherdev"),
        JSON.stringify(foreign, null, 2));

    // Different content, so our second backup does not simply reference the
    // same stored files and make the check vacuous.
    state.settingsPayload = '{"theme":"light","volume":3,"extra":"changed"}';
    state.notesPayload = "a completely different note\n";

    var shared2 = await run(shareContext, "BackupAssistant", { full: true }, []);
    check("second backup on the shared target succeeds",
        !shared2.error && shared2.result && shared2.result.STATUS === "Complete",
        shared2.error && shared2.error.message);

    var afterPurge = listFilesIn(manifestDir());
    check("the other device's backup survives our purge",
        afterPurge.indexOf("000009-otherdev") !== -1, afterPurge.join(","));
    check("our own older backup is still trimmed to manifestsToKeep",
        afterPurge.indexOf("000001-abc123") === -1, afterPurge.join(","));

    var storedAfter = listFilesIn(fileStoreDir());
    var foreignSurvived = foreignFiles.every(function (name) {
        return storedAfter.indexOf(name) !== -1;
    });
    check("and the files only the other device's manifest references are not swept",
        foreignSurvived, "want " + foreignFiles.join(",") + " in " + storedAfter.join(","));

    /* ---- a failed run must not leak what it already stored ---- */
    section("Failure leaves no orphans");

    // A backup stores each file as it goes and writes the manifest LAST, so a
    // run that dies partway has already put files in the store that no manifest
    // will ever reference. Only the success path used to purge, so every
    // failure leaked at full size -- and the leak made the next run likelier to
    // fail the same way. Measured on a daily driver (2026-08-29): two failed
    // runs left two unreferenced copies of a 295MB app archive, /media/internal
    // hit 100%, and every subsequent backup died with ENOSPC.
    //
    // Failing at storeManifest reproduces that shape exactly: all the file
    // transfers have happened, the manifest has not.
    state.notesPayload = "a note that is not yet in the store\n";
    var failCtx = harness.loadService({
        root: ROOT,
        services: buildServices(),
        quiet: !process.env.VERBOSE
    });
    vm.runInContext(
        "backup.storeManifest = function () {" +
        "  var f = new Future();" +
        "  setTimeout(function () { f.exception = new Error('storeManifest boom'); }, 5);" +
        "  return f;" +
        "};", failCtx);

    var storedBefore = listFilesIn(fileStoreDir()).length;
    var manifestsBefore = listFilesIn(manifestDir()).length;
    // NB: not `failed` -- that is the suite's own failure counter.
    var failedRun = await run(failCtx, "BackupAssistant", {}, []);

    check("the run reports failure",
        !!failedRun.error || (failedRun.result && failedRun.result.STATUS === "Failed"),
        JSON.stringify(failedRun.result || failedRun.error && failedRun.error.message));

    // Every file in the store must be referenced by some manifest.
    var referenced = {};
    listFilesIn(manifestDir()).forEach(function (name) {
        var m = JSON.parse(fs.readFileSync(path.join(manifestDir(), name), "utf8"));
        storedNamesOf(m).forEach(function (stored) { referenced[stored] = true; });
    });
    var orphans = listFilesIn(fileStoreDir()).filter(function (name) {
        return !referenced[name];
    });
    check("a failed backup leaves no unreferenced files behind",
        orphans.length === 0, "orphans: " + orphans.join(", "));
    check("and it does not delete the good backups that were already there",
        listFilesIn(manifestDir()).length === manifestsBefore,
        "manifests " + manifestsBefore + " -> " + listFilesIn(manifestDir()).length);

    /* ---- the cache must mirror the target's CONTENT, not just its names ---- */
    section("Manifest cache collision");

    // Manifest names are NNNNNN-<nduId> and are NOT unique: the counter restarts
    // whenever a store is cleared, while /media/internal survives a Doctor
    // flash. So the local cache can hold a DIFFERENT backup under a name the
    // target also has. Reconciling by name alone (fetch what we lack, drop what
    // the target lacks) left such a copy untouched, and restores then read it --
    // once restoring 6 files out of a 115-package backup and reporting success.
    var cacheNames = listFilesIn(manifestDir());
    var victim = cacheNames[cacheNames.length - 1];
    var cachedPath = path.join(ROOT, "work", "manifests", victim);
    var targetPath = path.join(manifestDir(), victim);
    fs.writeFileSync(cachedPath, JSON.stringify({
        note: "a different backup that happens to share this name",
        services: [], packages: []
    }));
    await run(context, "ListBackupsAssistant", {});
    check("a cached manifest whose content differs from the target is refreshed",
        fs.readFileSync(cachedPath, "utf8") === fs.readFileSync(targetPath, "utf8"),
        "cache still holds: " + fs.readFileSync(cachedPath, "utf8").slice(0, 70));

    /* ---- pathExists and allocBuffer across node vintages ---- */
    section("Old-node APIs resolve on every runtime this service runs on");

    // The service has to load on webOS 3.0.5's node 0.2 and on LuneOS's node 22,
    // and the three of them spell "does this path exist" differently. Getting it
    // wrong is not a graceful degradation: on node 22 the missing path.exists
    // took the service down inside ServiceAssistant.setup, before it answered
    // anything at all. Stand in each vintage's fs/path and check the helper both
    // resolves and answers correctly.
    //
    // Only the two properties under test are masked; everything else still comes
    // from the real modules, so the rest of the service loads normally.
    // node 0.2 has no Buffer.alloc, only `new Buffer(size)`. A plain object
    // would not do: the fallback branch constructs it, so the stand-in has to
    // be constructible. Returning an object from a constructor overrides
    // `this`, so `new Legacy(4)` yields a real 4-byte Buffer while the type
    // itself carries no .alloc - which is exactly the shape under test.
    function bufferVintage(shape) {
        if (shape !== "node0.2") {
            return Buffer;
        }
        return function (arg) {
            return Buffer.alloc(typeof arg === "number" ? arg : 0);
        };
    }

    function nodeVintage(shape) {
        var realFs = require("fs");
        var realPath = require("path");
        var fakeFs = Object.create(realFs);
        var fakePath = Object.create(realPath);

        if (shape === "node0.2") {
            // path.exists only - no fs.exists, no fs.access, no fs.existsSync.
            fakeFs.access = undefined;
            fakeFs.exists = undefined;
            fakePath.exists = function (target, callback) {
                realFs.stat(target, function (err) { callback(!err); });
            };
        } else if (shape === "node0.8") {
            // fs.exists, but fs.access is not there yet (it arrived in 0.11).
            fakeFs.access = undefined;
        }
        // "modern" masks nothing: fs.access is present and wins.

        return function (name) {
            if (name === "fs") { return fakeFs; }
            if (name === "path") { return fakePath; }
            return require(name);
        };
    }

    var presentFile = path.join(ROOT, "pathexists-present");
    fs.writeFileSync(presentFile, "x");
    var absentFile = path.join(ROOT, "pathexists-absent");

    var vintages = ["node0.2", "node0.8", "modern"];
    for (var vi = 0; vi < vintages.length; vi++) {
        var shape = vintages[vi];
        var vintageCtx = null;
        try {
            vintageCtx = harness.loadService({
                root: path.join(ROOT, "vintage-" + shape),
                quiet: true,
                require: nodeVintage(shape),
                Buffer: bufferVintage(shape)
            });
        } catch (err) {
            check(shape + ": service loads", false, err.message);
            continue;
        }
        check(shape + ": service loads", true);
        check(shape + ": pathExists is a function",
            vm.runInContext("typeof pathExists", vintageCtx) === "function");

        vm.runInContext("__peHits = [];", vintageCtx);
        vintageCtx.__present = presentFile;
        vintageCtx.__absent = absentFile;
        vm.runInContext(
            "pathExists(__present, function (e) { __peHits.push(['present', e]); });" +
            "pathExists(__absent,  function (e) { __peHits.push(['absent', e]); });",
            vintageCtx);

        await new Promise(function (resolve) { setTimeout(resolve, 50); });

        var hits = vm.runInContext("JSON.stringify(__peHits)", vintageCtx);
        var parsed = JSON.parse(hits);
        var got = {};
        parsed.forEach(function (h) { got[h[0]] = h[1]; });
        check(shape + ": existing path reports true", got.present === true, hits);
        check(shape + ": missing path reports false", got.absent === false, hits);

        // allocBuffer is the same problem in the other direction: Buffer.alloc
        // does not exist on 0.2, and new Buffer() is deprecated and slated to
        // go on 22/24. Both spellings have to keep working.
        check(shape + ": allocBuffer is a function",
            vm.runInContext("typeof allocBuffer", vintageCtx) === "function");
        check(shape + ": allocBuffer returns a buffer of the right size",
            vm.runInContext("(function(){var b = allocBuffer(7);" +
                "return (typeof b.length === 'number' ? b.length : -1);}())", vintageCtx) === 7);
    }

    /* ---- daily schedule, legacy and LuneOS ---- */
    await require("./daily-schedule")({
        check: check, section: section, run: run, state: state,
        newContext: newContext, listFilesIn: listFilesIn, manifestDir: manifestDir
    });

    /* ---- crafted manifests, argv execution, log redaction ---- */
    await require("./restore-hardening")({
        harness: harness, check: check, section: section, run: run,
        buildServices: buildServices, ROOT: ROOT, mkdirs: mkdirs, rmrf: rmrf,
        manifestDir: manifestDir
    });

    /* ---- summary ---- */
    console.log("\n" + passed + " passed, " + failed + " failed");
    rmrf(ROOT);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
    console.error("\nHarness error:", err && err.stack || err);
    rmrf(ROOT);
    process.exit(1);
});
