/* Bridge to the root helper (woce-backupd).
 *
 * Why this exists: the triton jail this service runs in mounts /etc/palm ro,
 * /media/internal rw and /var/file-cache rw — but not /var/preferences,
 * /var/palm/data or /media/cryptofs. Registered services legitimately return
 * absolute paths into those trees (com.palm.service.contacts returns contact
 * photo paths; com.palm.systemservice returns preference files), and
 * fileUtil.getAbsolutePath passes absolute paths through untouched. Without a
 * helper outside the jail those files are simply unreadable.
 *
 * The helper is optional. When it is absent every call here reports
 * unavailable and the backup engine records the affected paths as skipped
 * rather than failing — that is the "limited mode" the UI surfaces.
 *
 * IPC is a job file per request, not a command per file: one round trip covers
 * a whole service's file list, so the poll interval does not dominate runtime.
 */
/*global allocBuffer, Future, JOB_ROOT, WORK_ROOT, logger, packageOpBudget, pathExists, require,
  setTimeout, fileUtil, isEmpty, restorePolicy */

var privileged = (function () {
    var that = {};
    var fs   = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    /* Every command this file runs, run as argv - never through a shell.
     *
     * Package ids and paths reach these commands from a backup manifest,
     * which is attacker-controlled (it sits on USB-exported storage), and in
     * direct mode we are uid 0. Single-quoting them into a shell string was
     * one stray quote away from root command execution. execFile passes each
     * argument to execve unchanged, so there is nothing to escape.
     *
     * Direct mode is LuneOS-only (an unjailed root process; see
     * canActDirectly), where node is modern and execFile exists. The 3.0.5
     * daemon path never comes through here.
     */
    var runArgv = function (file, args, options, callback) {
        if (typeof childProcess.execFile !== "function") {
            setTimeout(function () {
                callback(new Error("child_process.execFile is not available"), "", "");
            }, 0);
            return;
        }
        childProcess.execFile(file, args, options, callback);
    };

    /* The services a lunacall may target, on either bus. Same list the daemon
     * enforces, plus the OSE names for the ones that were renamed: this is a
     * bridge for the backup protocol, not a general-purpose bus shell.
     */
    var LUNACALL_ALLOWED_SERVICES = [
        "com.palm.appDataBackup",
        "com.palm.browserServer",
        "com.palm.db",
        "com.palm.deviceprofile",
        "com.palm.eas",
        "com.palm.keymanager",
        "com.palm.messaging.chatthreader",
        "com.palm.service.accounts",
        "com.palm.service.contacts",
        "com.palm.service.migration",
        "com.palm.sysMgrDataBackup",
        "com.palm.systemservice",
        "com.webos.service.systemservice"
    ];

    var METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/;

    /* ---- direct mode --------------------------------------------------
     *
     * The helper exists for exactly one reason: the triton jail on webOS 3.0.5
     * hides /var/preferences, /var/palm/data and /media/cryptofs from this
     * service, so files that registered services legitimately hand back as
     * absolute paths cannot be read from in here.
     *
     * Where there is no jail and we are already root, that round trip buys
     * nothing. LuneOS runs JS services exactly that way - run-js-service sets
     * user=root, jail=off, palm_jail=off - and ships no daemon, so insisting on
     * one would put a fully capable system into limited mode and tell the user
     * to install it with Preware, which on that platform is simply false.
     *
     * So probe for the reach the helper would have granted. If we already have
     * it, do the work here; otherwise fall back to the job files exactly as
     * before. Nothing above this line changes for webOS 3.0.5.
     */

    var directMode;             // undefined until probed

    var canActDirectly = function () {
        if (typeof process === "undefined" ||
                typeof process.getuid !== "function" || process.getuid() !== 0) {
            return false;
        }
        // These are the trees the jail withholds, which is the whole point of
        // the helper - so being able to read them IS the capability test. A uid
        // check alone is not enough: inside the jail we may still be uid 0 and
        // still unable to see them.
        var probes = ["/var/preferences", "/media/cryptofs"];
        for (var i = 0; i < probes.length; i++) {
            try {
                fs.readdirSync(probes[i]);
            } catch (err) {
                return false;
            }
        }
        return true;
    };

    var statOrNull = function (target) {
        try {
            return fs.statSync(target);
        } catch (err) {
            return null;
        }
    };

    var mkdirsSync = function (dir) {
        dir = path.normalize(dir);
        if (statOrNull(dir)) {
            return;
        }
        var parent = path.dirname(dir);
        if (parent !== dir) {
            mkdirsSync(parent);
        }
        try {
            fs.mkdirSync(dir, parseInt("0755", 8));
        } catch (err) {
            if (!statOrNull(dir)) {
                throw err;
            }
        }
    };

    // Chunked rather than one readFileSync: a media file can be far larger than
    // the memory this device is willing to give us.
    var copyFileSync = function (from, to, noFollow) {
        var CHUNK  = 65536;
        var buffer = allocBuffer(CHUNK);
        var input  = fs.openSync(from, "r");
        var output;

        try {
            output = noFollow ? openNoFollow(to) : fs.openSync(to, "w");
            try {
                var position = 0;
                while (true) {
                    var read = fs.readSync(input, buffer, 0, CHUNK, position);
                    if (read <= 0) {
                        break;
                    }
                    fs.writeSync(output, buffer, 0, read, position);
                    position += read;
                }
            } finally {
                fs.closeSync(output);
            }
        } finally {
            fs.closeSync(input);
        }
    };

    /* The inline counterparts of the daemon's ops. Same arguments, same
     * resolved shape, so every caller is unchanged.
     *
     * The four package operations are deliberately NOT here: they are ipkg and
     * /media/cryptofs/apps specific, and LuneOS is opkg with a different offset
     * root. Leaving them to fall through to the (absent) daemon reports them
     * unavailable, which is honest - archiving apps stays off until that is
     * ported, and the manifest already records that it was not done.
     */
    var direct = {};

    direct.stage = function (paths, stageDir) {
        var future = new Future();
        var staged = {};
        var missing = [];

        try {
            mkdirsSync(stageDir);
        } catch (err) {
            future.exception = new Error("Cannot create stage dir: " + err.message);
            return future;
        }

        for (var i = 0; i < paths.length; i++) {
            var source = paths[i];
            var stat = statOrNull(source);
            if (!stat || !stat.isFile()) {
                missing.push(source);
                continue;
            }
            // Same flat, index-based names the daemon uses; the caller keeps
            // the mapping either way.
            var name = "s" + i;
            try {
                copyFileSync(source, path.join(stageDir, name));
                staged[source] = name;
            } catch (err2) {
                logger.warn("stage failed for", source + ":", err2.message);
                missing.push(source);
            }
        }

        future.result = { staged: staged, missing: missing };
        return future;
    };

    /* Where a restore is allowed to put a file back.
     *
     * A backup lives on /media/internal, which is handed to a PC as USB mass
     * storage, so its manifest is not trustworthy input: it names both the
     * staged file and the absolute path to write it to, and in direct mode we
     * are uid 0. Without this, anything that could drop a folder on that
     * partition could have a later restore write /usr, /lib or an ls2 role file
     * as root - turning "can write to the USB volume" into "owns the device".
     *
     * The policy itself lives in util/restore-policy.js, so that the engine's
     * own direct writes (handlers/restore.js) and this unstage path apply the
     * same one. Returns the normalised destination, or null.
     */
    var isRestorableDest = function (dest) {
        var checked = restorePolicy.checkAbsolute(dest);
        return checked.path || null;
    };

    /* Opens a restore destination for writing without following a symlink
     * at the final component, closing the gap between isRestorableDest's
     * check and the write. fs.constants is modern node only; direct mode
     * only runs there.
     */
    var openNoFollow = function (target) {
        var c = fs.constants;
        if (c && c.O_NOFOLLOW !== undefined) {
            return fs.openSync(target,
                c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_NOFOLLOW, parseInt("0644", 8));
        }
        return fs.openSync(target, "w");
    };

    direct.unstage = function (files, stageDir) {
        var future = new Future();
        var restored = [];
        var skipped = [];

        for (var i = 0; i < files.length; i++) {
            var entry = files[i];
            var source = path.join(stageDir, entry.staged);
            var dest = isRestorableDest(entry.path);

            if (!dest) {
                // Loud, not quiet. No ordinary backup produces this, so if it
                // ever appears in a log it is either a service writing
                // somewhere new - worth knowing about - or a crafted archive.
                logger.warn("refusing to restore outside the permitted roots:",
                    entry.path);
                skipped.push(entry.path);
                continue;
            }
            if (!statOrNull(source)) {
                skipped.push(dest);
                continue;
            }
            try {
                mkdirsSync(path.dirname(dest));
                // Re-checked after mkdirs, which may have created parents,
                // and opened O_NOFOLLOW: a symlink planted in between must
                // not redirect a root write.
                if (!isRestorableDest(dest)) {
                    throw new Error("destination changed under us");
                }
                copyFileSync(source, dest, true);
                restored.push(dest);
            } catch (err) {
                logger.warn("unstage failed for", dest + ":", err.message);
                skipped.push(dest);
            }
        }

        future.result = { restored: restored, skipped: skipped };
        return future;
    };

    direct.readRegistrations = function () {
        var future = new Future();
        var DIR = "/etc/palm/backup/";
        var names;

        try {
            names = fs.readdirSync(DIR);
        } catch (err) {
            future.exception = new Error("Cannot list " + DIR + ": " + err.message);
            return future;
        }

        var files = {};
        var failed = [];
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (name.indexOf("/") !== -1 || name.charAt(0) === ".") {
                continue;
            }
            try {
                files[name] = fs.readFileSync(DIR + name, "utf8");
            } catch (err2) {
                failed.push(name);
            }
        }

        future.result = { files: files, failed: failed };
        return future;
    };

    /* luna-send, run as root, for the same reason the daemon offered this: a
     * service that the ordinary PalmCall path cannot reach. On LuneOS that is
     * rarer than on 3.0.5 - there is one bus and our ACG grants cover the
     * services we need - but the fallback is what system.js reaches for when a
     * call comes back unreachable, so it has to lead somewhere.
     */
    direct.lunacall = function (service, method, params) {
        var future = new Future();

        if (LUNACALL_ALLOWED_SERVICES.indexOf(service) === -1) {
            future.exception = new Error("Service not permitted: " + service);
            return future;
        }
        if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
            future.exception = new Error("Bad method: " + method);
            return future;
        }

        var payload;
        try {
            payload = JSON.stringify(params === undefined ? {} : params);
        } catch (err) {
            future.exception = new Error("Un-encodable params: " + err.message);
            return future;
        }

        // argv, not a shell string. The payload can carry a backup
        // passphrase (keymanager export/import), which is why the error below
        // never repeats the command line: execFile's error.message does.
        runArgv("luna-send", ["-n", "1", "luna://" + service + "/" + method, payload],
            { maxBuffer: 8 * 1024 * 1024 }, function (error, stdout) {
            if (error) {
                future.exception = new Error("luna-send failed for " + service + "/" +
                    method + " (exit " + (error.code === undefined ? "?" : error.code) + ")");
                return;
            }
            var reply;
            try {
                reply = JSON.parse(String(stdout));
            } catch (err2) {
                future.exception = new Error(
                    "Un-parseable reply from " + service + "/" + method);
                return;
            }
            future.result = { reply: reply };
        });

        return future;
    };

    direct.reboot = function () {
        var future = new Future(true);
        // Reply first, go down after: the app is waiting on this call, and on
        // LuneOS the app is a card inside WebAppMgr that the reboot will take
        // with it.
        setTimeout(function () {
            runArgv("reboot", [], {}, function (error) {
                if (error) {
                    logger.error("reboot failed:", error.message);
                }
            });
        }, 2000);
        return future;
    };

    var POLL_INTERVAL = 250;    // ms between checks for a result file
    var PING_TIMEOUT  = 3000;   // ms to wait for the helper to answer a ping
    var JOB_TIMEOUT   = 600000; // ms to wait for a real job (10 min)

    var available;              // undefined until probed, then true/false
    var jobCounter = 0;

    var nextJobId = function () {
        jobCounter += 1;
        return String(new Date().getTime()) + "-" + jobCounter;
    };

    /**
     * Waits for resultPath to appear, then reads and removes it.
     */
    var awaitResult = function (future, resultPath, timeout, elapsed) {
        elapsed = elapsed || 0;

        pathExists(resultPath, function (exists) {
            if (exists) {
                fs.readFile(resultPath, "utf8", function (err, data) {
                    // The result file has served its purpose either way.
                    try { fs.unlinkSync(resultPath); } catch (ignored) {}

                    if (err) {
                        future.exception = err;
                        return;
                    }
                    var parsed;
                    try {
                        parsed = JSON.parse(data);
                    } catch (parseErr) {
                        future.exception = new Error("Malformed helper result: " + data);
                        return;
                    }
                    if (parsed.returnValue === false) {
                        future.exception = new Error(parsed.errorText || "Helper job failed");
                    } else {
                        future.result = parsed;
                    }
                });
            } else if (elapsed >= timeout) {
                future.exception = new Error("Timed out waiting for the root helper");
            } else {
                setTimeout(function () {
                    awaitResult(future, resultPath, timeout, elapsed + POLL_INTERVAL);
                }, POLL_INTERVAL);
            }
        });
    };

    /**
     * Writes a job for the helper and waits for its result.
     */
    var submit = function (job, timeout) {
        var jobId      = nextJobId();
        var jobPath    = JOB_ROOT + jobId + ".job";
        var resultPath = JOB_ROOT + jobId + ".done";
        // Write to .tmp then rename, so the helper never sees a half-written job.
        var tempPath   = JOB_ROOT + jobId + ".tmp";

        var future = fileUtil.mkdirs(JOB_ROOT);
        future.then(this, function (f) {
            var result = f.result;
            job.id = jobId;
            fs.writeFile(tempPath, JSON.stringify(job), "utf8", function (err) {
                if (err) {
                    f.exception = err;
                } else {
                    fs.rename(tempPath, jobPath, function (renameErr) {
                        if (renameErr) {
                            f.exception = renameErr;
                        } else {
                            f.result = {};
                        }
                    });
                }
            });
        });
        future.then(this, function (f) {
            var result = f.result;
            awaitResult(f, resultPath, timeout || JOB_TIMEOUT);
        });
        return future;
    };

    /**
     * True if the root helper is installed and responding. Probed once per
     * service lifetime; the answer cannot change while we are running.
     */
    that.isAvailable = function () {
        if (available !== undefined) {
            return new Future(available);
        }

        if (directMode === undefined) {
            directMode = canActDirectly();
        }
        if (directMode) {
            // No daemon needed, and none is going to appear: say so once and
            // stop pinging. This is also what keeps the app from showing the
            // limited-mode notice, which on such a device is simply untrue.
            logger.info("Running unjailed as root; privileged operations run inline, no helper needed");
            available = true;
            return new Future(true);
        }

        var future = submit({ op: "ping" }, PING_TIMEOUT);
        future.then(this, function (f) {
            if (f.exception) {
                logger.info("Root helper unavailable, running in limited mode:",
                    f.exception.message);
                available = false;
            } else {
                var result = f.result;
                logger.info("Root helper available, version", result.version);
                available = true;
            }
            f.result = available;
        });
        return future;
    };

    /**
     * Copies files the jail cannot read into stageDir, flattened to
     * checksum-free staged names. Returns { staged: {origPath: stagedName},
     * missing: [paths] }.
     *
     * Unreadable or missing paths come back in `missing` rather than throwing:
     * a single stale path in one service's file list should not abort a backup.
     */
    that.stage = function (paths, stageDir) {
        if (!paths || paths.length === 0) {
            return new Future({ staged: {}, missing: [] });
        }
        if (directMode) {
            return direct.stage(paths, stageDir);
        }
        return submit({ op: "stage", paths: paths, stageDir: stageDir });
    };

    /**
     * Writes staged files back to their absolute destinations, creating parent
     * directories as needed. `files` is [{ staged: name, path: absDest }].
     *
     * The helper enforces a destination allowlist — see woce-backupd.js. This
     * is the direction that could escalate privilege, so it is the constrained
     * one.
     */
    that.unstage = function (files, stageDir) {
        if (!files || files.length === 0) {
            return new Future({ restored: [], skipped: [] });
        }
        if (directMode) {
            return direct.unstage(files, stageDir);
        }
        return submit({ op: "unstage", files: files, stageDir: stageDir });
    };

    /**
     * Makes a Luna call through the helper, which reaches the private bus.
     *
     * Resolves with the service's reply, or fails if the helper is absent or
     * the call did. See the lunacall op in device/woce-backupd.js for why this
     * is needed and what it will and will not call.
     */
    that.lunacall = function (service, method, params) {
        var future = directMode
            ? direct.lunacall(service, method, params)
            : submit({
                op: "lunacall",
                service: service,
                method: method,
                params: params || {}
            }, 120000);

        future.then(this, function (f) {
            var result = f.result;
            var reply = result.reply || {};
            // A Luna reply can carry returnValue:false, which is a failure even
            // though the transport succeeded.
            if (reply.returnValue === false) {
                var err = new Error(reply.errorText ||
                    ("Call to " + service + "/" + method + " failed"));
                err.serviceId = service;
                throw err;
            }
            f.result = reply;
        });
        return future;
    };

    /**
     * The raw contents of /etc/palm/backup, read as root.
     *
     * Needed because com.palm.keymanager's registration file is mode 0640
     * root-only. The jail can see the directory but not that file, so without
     * the helper the keymanager — and every credential it holds — is silently
     * dropped from the backup.
     */
    that.readRegistrations = function () {
        if (directMode) {
            return direct.readRegistrations();
        }
        return submit({ op: "readRegistrations" }, 30000);
    };

    /* ------------------------------------------------- packages, direct mode
     *
     * These four were left to the daemon when the rest moved inline, on the
     * reasoning that package work is the risky part. On LuneOS that was simply
     * wrong: there is no daemon, so every one of them wrote a job file nobody
     * would ever read and then waited out its timeout. A backup spent 60
     * seconds doing nothing and recorded an empty app list, and said Complete.
     *
     * The layout differs from webOS 3.0.5 in three ways that matter:
     *
     *   - the tool is opkg, not ipkg, and the subcommand is `list-installed`
     *     rather than `list_installed`;
     *   - third-party apps still live under /media/cryptofs/apps, but the
     *     package database is opkg's (var/lib/opkg) rather than ipkg's
     *     (usr/lib/ipkg/info), which exists but is vestigial;
     *   - nothing caches .ipk files. Neither of the daemon's two search
     *     directories held a single one on a real device, so the archive path
     *     that matters here is the directory fallback, not the .ipk copy.
     *
     * That last point is what the opkg metadata below is for. The daemon's own
     * comment concedes that a directory restore leaves the package manager
     * unaware of the app - runnable, but not manageable or cleanly removable.
     * We can do better, because opkg keeps its whole record of an app in three
     * small files, so they travel in the same tarball and the app comes back
     * properly installed rather than merely present.
     */
    var APPS_ROOT   = "/media/cryptofs/apps";
    var APPS_DIR    = APPS_ROOT + "/usr/palm/applications/";
    var OPKG_DIR    = APPS_ROOT + "/var/lib/opkg";
    var OPKG_STATUS = OPKG_DIR + "/status";
    var OPKG_INFO   = OPKG_DIR + "/info/";
    var ROM_APPS_DIR = "/usr/palm/applications/";

    // The stanza for one package, carried inside its own archive so a
    // directory restore can put opkg's record back too. Named with a leading
    // dot so it cannot collide with anything opkg itself owns.
    var STATUS_MEMBER = ".woce-opkg-status";

    /* Waydroid publishes an appinfo.json shortcut for every Android app it
     * runs. They are generated, not installed: no opkg record, and the
     * Waydroid integration recreates them from the Android side. Backing them
     * up would archive eleven stubs on a device I checked, and restoring them
     * would plant launcher icons for Android apps that may not be there any
     * more. Matched on the id prefix, which is what generates them.
     */
    var isGeneratedStub = function (appId) {
        return String(appId).indexOf("waydroid.") === 0;
    };

    var readAppInfo = function (appId) {
        try {
            return JSON.parse(fs.readFileSync(APPS_DIR + appId + "/appinfo.json", "utf8"));
        } catch (err) {
            return null;
        }
    };

    direct.listInstalledApps = function () {
        var future = new Future();
        var romApps = [];

        try {
            romApps = fs.readdirSync(ROM_APPS_DIR);
        } catch (err) {
            logger.warn("Could not read", ROM_APPS_DIR + ":", err.message);
        }

        runArgv("opkg", ["-o", APPS_ROOT, "list-installed"], { timeout: 45000 },
            function (error, stdout) {
                var packages = [];
                var known = {};

                if (error) {
                    // Not fatal: the directory scan below still finds apps.
                    logger.warn("opkg list-installed failed:", error.message);
                }

                String(stdout || "").split("\n").forEach(function (raw) {
                    var line = raw.replace(/^\s+|\s+$/g, "");
                    if (line.length === 0) {
                        return;
                    }
                    // "com.example.app - 1.0.0", optionally " - description".
                    var parts = line.split(" - ");
                    if (parts.length < 2) {
                        return;
                    }
                    var id = parts[0].replace(/^\s+|\s+$/g, "");
                    if (isGeneratedStub(id) || !restorePolicy.isValidPackageId(id)) {
                        return;
                    }
                    var info = readAppInfo(id);
                    packages.push({
                        id:      id,
                        version: parts[1].replace(/^\s+|\s+$/g, ""),
                        title:   (info && info.title) || id
                    });
                    known[id] = true;
                });

                /* An app put back by the directory fallback is real and
                 * launchable but, before the opkg metadata went into the
                 * archive, was invisible to list-installed - and would then
                 * drop out of every later backup. Anything with an appinfo.json
                 * counts as installed whatever opkg thinks.
                 */
                var appDirs = [];
                try {
                    appDirs = fs.readdirSync(APPS_DIR);
                } catch (err2) {
                    appDirs = [];
                }
                appDirs.forEach(function (appId) {
                    if (known[appId] || isGeneratedStub(appId) ||
                            !restorePolicy.isValidPackageId(appId)) {
                        return;
                    }
                    var info = readAppInfo(appId);
                    if (!info) {
                        return;
                    }
                    packages.push({
                        id:        appId,
                        version:   info.version || "0.0.0",
                        title:     info.title || appId,
                        unmanaged: true
                    });
                    known[appId] = true;
                });

                logger.log("Found", packages.length, "installed app(s),",
                    romApps.length, "from the system image");
                future.result = {
                    returnValue: true,
                    packages: packages,
                    romApps: romApps
                };
            });

        return future;
    };

    /* One tarball per app, rooted at /media/cryptofs/apps so it unpacks back
     * over the same paths, carrying the app directory and opkg's record of it.
     */
    /* Where an installer may still be sitting after an install.
     *
     * Reinstalling from the .ipk is better than unpacking the app directory:
     * opkg runs the install itself, so its bookkeeping is rebuilt rather than
     * reconstructed, and any maintainer script in the package runs as it did
     * the first time. The directory tarball stays as the fallback, because a
     * download is not guaranteed to still be there - and usually is not.
     */
    var IPK_SEARCH_DIRS = ["/media/internal/downloads/", APPS_ROOT + "/usr/palm/packages/"];

    var escapeForRegExp = function (text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    /**
     * A cached installer for exactly this package at exactly this version, or
     * null.
     *
     * Two spellings. woce-backupd looks for "<id>.ipk", which is what its own
     * archive step writes, so that name is honoured here too. What a download
     * actually leaves behind is opkg's own "<id>_<version>_<arch>.ipk" - the
     * daemon never matches those, so on a device where the user installed from
     * the browser its .ipk path silently never fires.
     *
     * The version has to match. A backup records the version that is installed,
     * and quietly reinstalling a different one from a stale download would be a
     * worse outcome than unpacking the directory we know is correct.
     */
    var cachedIpkFor = function (id, version) {
        var i, exact, names, pattern;

        for (i = 0; i < IPK_SEARCH_DIRS.length; i++) {
            exact = IPK_SEARCH_DIRS[i] + id + ".ipk";
            if (statOrNull(exact)) {
                return exact;
            }
        }
        if (!version) {
            return null;
        }

        pattern = new RegExp("^" + escapeForRegExp(id) + "_" +
            escapeForRegExp(version) + "_[^_]*\\.ipk$");
        for (i = 0; i < IPK_SEARCH_DIRS.length; i++) {
            try {
                names = fs.readdirSync(IPK_SEARCH_DIRS[i]);
            } catch (err) {
                names = [];
            }
            for (var n = 0; n < names.length; n++) {
                if (pattern.test(names[n])) {
                    return IPK_SEARCH_DIRS[i] + names[n];
                }
            }
        }
        return null;
    };

    direct.archivePackages = function (packages, destDir) {
        var future = new Future();
        var archived = [];
        var archivedDirs = [];
        var archiveFailures = [];
        var queue = (packages || []).slice(0);

        var finish = function () {
            future.result = {
                returnValue: true,
                archived: archived,
                archivedDirs: archivedDirs,
                failures: archiveFailures
            };
        };

        var next = function () {
            if (queue.length === 0) {
                return finish();
            }
            var pkg = queue.shift();
            var id = pkg && pkg.id;

            if (!id || isGeneratedStub(id)) {
                return next();
            }
            if (!restorePolicy.isValidPackageId(id)) {
                archiveFailures.push({ id: String(id).substring(0, 128), reason: "bad package id" });
                return next();
            }
            if (!statOrNull(APPS_DIR + id)) {
                archiveFailures.push({ id: id, reason: "no installed directory" });
                return next();
            }

            // Named <id>.ipk in the archive whatever it was called in the
            // cache: restore rebuilds that name from the manifest to find it.
            var cachedIpk = cachedIpkFor(id, pkg.version);
            if (cachedIpk) {
                try {
                    mkdirsSync(destDir);
                    copyFileSync(cachedIpk, path.join(destDir, id + ".ipk"));
                    archived.push(id);
                    return next();
                } catch (copyErr) {
                    // Not fatal - fall through and tar the directory instead.
                    logger.warn("Could not take the cached installer for", id + ":",
                        copyErr.message);
                }
            }

            // opkg's status file is one shared file, so the package's own
            // stanza is extracted into the archive rather than the file itself
            // - restoring the whole thing would wipe out records for apps this
            // backup never knew about.
            var members = ["usr/palm/applications/" + id];
            try {
                var stanza = stanzaFor(id);
                if (stanza) {
                    fs.writeFileSync(APPS_ROOT + "/" + STATUS_MEMBER, stanza, "utf8");
                    members.push(STATUS_MEMBER);
                }
            } catch (err) {
                logger.warn("Could not stage the opkg stanza for", id + ":", err.message);
            }
            ["control", "list"].forEach(function (ext) {
                if (statOrNull(OPKG_INFO + id + "." + ext)) {
                    members.push("var/lib/opkg/info/" + id + "." + ext);
                }
            });

            // "-app.tar.gz", not ".tar.gz": handlers/backup.js rebuilds this
            // name from the id to find the staged file, and restore looks for
            // the same. The daemon's naming is the contract.
            var target = path.join(destDir, id + "-app.tar.gz");
            mkdirsSync(destDir);
            runArgv("tar", ["czf", target, "-C", APPS_ROOT].concat(members),
                { timeout: 300000, maxBuffer: 1024 * 1024 },
                function (error) {
                    try {
                        fs.unlinkSync(APPS_ROOT + "/" + STATUS_MEMBER);
                    } catch (ignored) {}

                    if (error) {
                        logger.warn("Could not archive", id + ":", error.message);
                        archiveFailures.push({ id: id, reason: error.message });
                    } else {
                        // Plain id, like the daemon: the caller builds a set of
                        // these to mark pkg.dirBackedUp, and an object here
                        // stringified into "[object Object]-app.tar.gz".
                        archivedDirs.push(id);
                    }
                    next();
                });
        };

        next();
        return future;
    };

    /** The status stanza for one package, or null. */
    var stanzaFor = function (id) {
        var text;
        try {
            text = fs.readFileSync(OPKG_STATUS, "utf8");
        } catch (err) {
            return null;
        }
        var blocks = text.split(/\n\s*\n/);
        for (var i = 0; i < blocks.length; i++) {
            if (new RegExp("^Package:\\s*" + escapeForRegExp(id) + "\\s*$", "m").test(blocks[i])) {
                return blocks[i].replace(/\s+$/, "") + "\n";
            }
        }
        return null;
    };

    /* Why a package job entry may not be acted on, or null.
     *
     * The id is checked as a plain package id, and the file has to be exactly
     * <WORK_ROOT>...<id><suffix>: normalised, no '..', inside our own work
     * area, a regular file and not a symlink. restore.js builds these paths
     * itself from a validated id, so anything else is not one of ours.
     */
    var refusePackageEntry = function (entry, suffix) {
        if (!entry || !restorePolicy.isValidPackageId(entry.id)) {
            return "bad package id";
        }
        var p = String(entry.path || "");
        if (p.indexOf("\u0000") !== -1 || path.normalize(p) !== p ||
                p.split("/").indexOf("..") !== -1 || p.indexOf(WORK_ROOT) !== 0) {
            return "outside the work area";
        }
        if (path.basename(p) !== entry.id + suffix) {
            return "file name does not match the id";
        }
        var st;
        try {
            st = fs.lstatSync(p);
        } catch (err) {
            return "missing";
        }
        if (!st.isFile()) {
            return "not a regular file";
        }
        return null;
    };

    direct.installPackages = function (files) {
        var future = new Future();
        var installed = [];
        var failed = [];
        var queue = (files || []).slice(0);

        var next = function () {
            if (queue.length === 0) {
                future.result = { returnValue: true, installed: installed, failed: failed };
                return;
            }
            var entry = queue.shift();
            // Same bound the daemon puts on this op: an installer runs
            // arbitrary maintainer scripts as root, so it may only ever come
            // from our own work area, never from a path a manifest names.
            var refused = refusePackageEntry(entry, ".ipk");
            if (refused) {
                logger.warn("Refusing to install", JSON.stringify(String(entry && entry.path)) + ":", refused);
                failed.push(restorePolicy.isValidPackageId(entry && entry.id) ? entry.id : "(invalid)");
                return next();
            }
            runArgv("opkg", ["-o", APPS_ROOT, "--force-reinstall", "install", entry.path],
                { timeout: 300000, maxBuffer: 1024 * 1024 },
                function (error) {
                    if (error) {
                        logger.warn("Could not install", entry.id + ":", error.message);
                        failed.push(entry.id);
                    } else {
                        installed.push(entry.id);
                    }
                    next();
                });
        };

        next();
        return future;
    };

    /* Unpacks an archivePackages tarball back over /media/cryptofs/apps and
     * folds its opkg stanza into the status file, so the app returns installed
     * rather than merely present.
     */
    /* What an app-directory tarball may contain: exactly what archivePackages
     * puts in one, for this id and no other.
     */
    var memberAllowed = function (name, id) {
        var n = String(name).replace(/^\.\//, "").replace(/\/$/, "");
        if (n.length === 0 || n.charAt(0) === "/" || n.indexOf("\\") !== -1 ||
                n.split("/").indexOf("..") !== -1) {
            return false;
        }
        var appDir = "usr/palm/applications/" + id;
        return n === appDir || n.indexOf(appDir + "/") === 0 ||
            n === "usr" || n === "usr/palm" || n === "usr/palm/applications" ||
            n === "var" || n === "var/lib" || n === "var/lib/opkg" || n === "var/lib/opkg/info" ||
            n === "var/lib/opkg/info/" + id + ".control" ||
            n === "var/lib/opkg/info/" + id + ".list" ||
            n === STATUS_MEMBER;
    };

    /* One line of GNU `tar -tvzf --quoting-style=escape`:
     *   -rw-r--r-- user/group  123 2026-01-01 12:00 name
     *   lrwxrwxrwx user/group    0 2026-01-01 12:00 name -> target
     *   hrw-r--r-- user/group    0 2026-01-01 12:00 name link to target
     * Returns { type, name, link } or null for a line it cannot read.
     */
    var parseTarLine = function (line) {
        var m = /^(.)\S*\s+\S+\s+\d+(?:,\s*\d+)?\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s+(.+)$/.exec(line);
        if (!m) {
            return null;
        }
        var rest = m[2];
        var entry = { type: m[1], name: rest, link: null };
        var sep = m[1] === "l" ? " -> " : (m[1] === "h" ? " link to " : null);
        if (sep) {
            var parts = rest.split(sep);
            if (parts.length !== 2) {
                return null;
            }
            entry.name = parts[0];
            entry.link = parts[1];
        }
        return entry;
    };

    /**
     * Why this tarball may not be unpacked over /media/cryptofs/apps as root,
     * or null. Every member must sit inside this app's own directory or be
     * one of its two opkg info files or our status stanza; only files,
     * directories and links are allowed; a symlink must be relative and stay
     * inside the app directory, a hard link must name an allowed member.
     */
    var checkTarListing = function (listing, id) {
        var lines = String(listing || "").split("\n");
        var count = 0;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].length === 0) {
                continue;
            }
            var entry = parseTarLine(lines[i]);
            if (!entry) {
                return "unreadable listing line";
            }
            count++;
            if (!memberAllowed(entry.name, id)) {
                return "member outside the app: " + entry.name.substring(0, 200);
            }
            if (entry.type === "l") {
                var target = String(entry.link);
                var base = path.dirname(entry.name.replace(/^\.\//, ""));
                var joined = path.normalize(base + "/" + target);
                if (target.charAt(0) === "/" || target.indexOf("\\") !== -1 ||
                        target.split("/").indexOf("..") !== -1 ||
                        joined.indexOf("usr/palm/applications/" + id + "/") !== 0) {
                    return "symlink leaving the app: " + entry.name.substring(0, 200);
                }
            } else if (entry.type === "h") {
                if (!memberAllowed(entry.link, id)) {
                    return "hard link outside the app: " + entry.name.substring(0, 200);
                }
            } else if (entry.type !== "-" && entry.type !== "d") {
                return "special file: " + entry.name.substring(0, 200);
            }
        }
        return count > 0 ? null : "empty archive";
    };

    direct.restoreAppDirectories = function (files) {
        var future = new Future();
        var restored = [];
        var failed = [];
        var queue = (files || []).slice(0);

        var mergeStanza = function (id) {
            var staged = APPS_ROOT + "/" + STATUS_MEMBER;
            var stanza;
            try {
                stanza = fs.readFileSync(staged, "utf8");
            } catch (err) {
                return;
            }
            try {
                fs.unlinkSync(staged);
            } catch (ignored) {}

            // Replaced, not appended, if opkg already has a record: two stanzas
            // for one package is a corrupt status file.
            if (stanzaFor(id)) {
                return;
            }
            // It came out of the backup, so it must be one stanza and for
            // this package: otherwise a crafted archive could rewrite what
            // opkg believes about any other package.
            var packages = stanza.match(/^Package:.*$/mg) || [];
            if (packages.length !== 1 ||
                    !new RegExp("^Package:\\s*" + escapeForRegExp(id) + "\\s*$").test(packages[0]) ||
                    /\n\s*\n\S/.test(stanza)) {
                logger.warn("Ignoring an opkg stanza that is not for", id);
                return;
            }
            try {
                var current = "";
                try {
                    current = fs.readFileSync(OPKG_STATUS, "utf8");
                } catch (err2) {
                    current = "";
                }
                if (current.length > 0 && !/\n\n$/.test(current)) {
                    current = current.replace(/\s*$/, "\n\n");
                }
                fs.writeFileSync(OPKG_STATUS, current + stanza + "\n", "utf8");
            } catch (err3) {
                logger.warn("Could not record", id, "with opkg:", err3.message);
            }
        };

        var next = function () {
            if (queue.length === 0) {
                future.result = { returnValue: true, restored: restored, failed: failed };
                return;
            }
            var entry = queue.shift();
            var refused = refusePackageEntry(entry, "-app.tar.gz");
            if (refused) {
                logger.warn("Refusing to unpack", JSON.stringify(String(entry && entry.path)) + ":", refused);
                failed.push(restorePolicy.isValidPackageId(entry && entry.id) ? entry.id : "(invalid)");
                return next();
            }
            // List first, unpack only if every member belongs to this app.
            // GNU tar already refuses '..' members, but not a member for
            // another app's directory, a symlink out of the tree followed by
            // a write through it, or a device node.
            runArgv("tar", ["-tvzf", entry.path, "--quoting-style=escape"],
                { timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
                function (listError, listing) {
                    var bad = listError ? "cannot list: exit " + listError.code
                        : checkTarListing(listing, entry.id);
                    if (bad) {
                        logger.warn("Refusing to unpack", entry.id + ":", bad);
                        failed.push(entry.id);
                        return next();
                    }
                    mkdirsSync(APPS_DIR);
                    mkdirsSync(OPKG_INFO);
                    // Ownership and modes from the archive are not ours to
                    // keep: as root, tar would otherwise restore setuid bits
                    // and arbitrary owners.
                    runArgv("tar", ["-xzf", entry.path, "-C", APPS_ROOT,
                            "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"],
                        { timeout: 300000, maxBuffer: 1024 * 1024 },
                        function (error) {
                            if (error) {
                                logger.warn("Could not unpack", entry.id + ": exit", error.code);
                                failed.push(entry.id);
                            } else {
                                mergeStanza(entry.id);
                                restored.push(entry.id);
                            }
                            next();
                        });
                });
        };

        next();
        return future;
    };

    /**
     * The installed third-party package list. Recorded in the manifest so a
     * restore can report (or reinstall) what was on the device.
     */
    that.listInstalledApps = function () {
        if (directMode) {
            return direct.listInstalledApps();
        }
        return submit({ op: "listInstalledApps" }, 60000);
    };

    /**
     * Copies the .ipk files for the given packages into destDir, so a restore
     * can reinstall them without the App Catalog. For a package whose .ipk
     * isn't cached anywhere, the helper falls back to tarring up the app's
     * installed directory instead (archivedDirs) - see the SECURITY note in
     * device/woce-backupd.js for what that trades away.
     */
    that.archivePackages = function (packages, destDir, timeout) {
        if (!packages || packages.length === 0) {
            return new Future({ archived: [], archivedDirs: [] });
        }
        if (directMode) {
            return direct.archivePackages(packages, destDir);
        }
        return submit({ op: "archivePackages", packages: packages, destDir: destDir },
            timeout || packageOpBudget(packages.length));
    };

    /**
     * Installs each { id, path } .ipk via the helper's ipkg. path must be
     * inside WORK_ROOT — see the SECURITY note in device/woce-backupd.js for
     * why that bound is what makes this op safe to expose at all.
     */
    that.installPackages = function (files, timeout) {
        if (!files || files.length === 0) {
            return new Future({ installed: [], failed: [] });
        }
        if (directMode) {
            return direct.installPackages(files);
        }
        return submit({ op: "installPackages", files: files },
            timeout || packageOpBudget(files.length));
    };

    /**
     * Un-tars each { id, path } app-directory archive back over the app's
     * own directory. Same WORK_ROOT bound on path as installPackages; see the
     * SECURITY note in device/woce-backupd.js.
     */
    that.restoreAppDirectories = function (files, timeout) {
        if (!files || files.length === 0) {
            return new Future({ restored: [], failed: [] });
        }
        if (directMode) {
            return direct.restoreAppDirectories(files);
        }
        return submit({ op: "restoreAppDirectories", files: files },
            timeout || packageOpBudget(files.length));
    };

    /**
     * Reboots the device. The helper replies before it actually issues the
     * command (see the SECURITY note in device/woce-backupd.js), so this
     * resolves normally rather than timing out when the system goes down.
     */
    that.reboot = function () {
        if (directMode) {
            return direct.reboot();
        }
        return submit({ op: "reboot" }, 15000);
    };

    /* Exported so the version-matching rule can be asserted directly: which
     * installer is accepted for a package decides whether a restore reinstalls
     * the version that was backed up or a stale one off the disk.
     */
    that.cachedIpkForTesting = cachedIpkFor;

    /* Exported so the policy above can be asserted directly.
     *
     * Deliberately not a ForTesting seam: this is a security boundary, and one
     * worth being able to check without having to be root with a staged file
     * on disk to do it.
     */
    /** True once probed and running the privileged work in-process. */
    that.isDirect = function () {
        return directMode === true;
    };

    that.isRestorableDest = isRestorableDest;
    that.checkTarListingForTesting = checkTarListing;

    /**
     * Test seam: forces direct mode on, so the inline implementations can be
     * exercised off-device. The real probe needs uid 0 and readable
     * /var/preferences and /media/cryptofs, none of which hold on a build
     * machine - and without this the package ops would silently fall through
     * to the job-file path the tests are not about.
     */
    that.setDirectModeForTesting = function (value) {
        directMode = value;
        available = value;
    };

    /**
     * Test seam: lets unit checks force the probe result.
     */
    that.setAvailableForTesting = function (value) {
        // Tests drive the job-file path deliberately; never let the capability
        // probe on the build machine reroute them.
        directMode = false;
        available = value;
    };

    /**
     * Test seam: stands in for the helper's lunacall, so the private-bus
     * fallback can be exercised without a device.
     */
    that.setLunacallForTesting = function (fn) {
        that.lunacall = fn;
    };

    /**
     * Test seam: stands in for the helper's stage op, so a file the jail
     * cannot read (e.g. one a helper-routed call wrote outside it) can be
     * exercised without a device.
     */
    that.setStageForTesting = function (fn) {
        that.stage = fn;
    };

    /**
     * Test seam: stands in for the helper's unstage op, so a restored file
     * bound for a destination the jail cannot write (e.g. /tmp) can be
     * exercised without a device.
     */
    that.setUnstageForTesting = function (fn) {
        that.unstage = fn;
    };

    return that;
}());
