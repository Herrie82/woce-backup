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
  setTimeout, fileUtil, isEmpty */

var privileged = (function () {
    var that = {};
    var fs   = require('fs');
    var path = require('path');
    var exec = require('child_process').exec;

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
    var copyFileSync = function (from, to) {
        var CHUNK  = 65536;
        var buffer = allocBuffer(CHUNK);
        var input  = fs.openSync(from, "r");
        var output;

        try {
            output = fs.openSync(to, "w");
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
     * These are woce-backupd's ALLOWED_WRITE_ROOTS and DENIED_WRITE_PREFIXES,
     * deliberately unchanged. Direct mode does the same job the daemon does on
     * webOS 3.0.5, against the same untrusted input, so the two must agree -
     * a destination the daemon refuses and this accepts would be a hole that
     * only opens on LuneOS, which is precisely where nobody would look for it.
     */
    var ALLOWED_WRITE_ROOTS = [
        "/media/internal/",
        "/var/luna/",
        "/var/palm/",
        "/var/preferences/",
        "/var/file-cache/",
        "/tmp/"
    ];

    // Carved out of the above: an ls2 role file would let any caller register
    // as any service on the bus.
    var DENIED_WRITE_PREFIXES = [
        "/var/palm/ls2/",
        "/var/palm/jail/",
        "/etc/",
        "/usr/",
        "/bin/",
        "/sbin/",
        "/lib/"
    ];

    var isRestorableDest = function (dest) {
        var raw = String(dest === undefined || dest === null ? "" : dest);
        var normalized = path.normalize(raw);
        var i;

        // Absolute, and no traversal left after normalising. Checked before
        // anything resolves it: path.resolve() interprets a relative path
        // against the process's cwd, so "" becomes the cwd itself and could
        // land inside an allowed root purely by where the service was started.
        if (normalized.indexOf("..") !== -1 || normalized.charAt(0) !== "/") {
            return null;
        }

        // Nearest existing ancestor through realpath, so a symlink planted at
        // any level inside an allowed root cannot redirect the write out of it.
        var resolved = normalized;
        var probe = path.dirname(normalized);
        while (probe.length > 1 && !statOrNull(probe)) {
            probe = path.dirname(probe);
        }
        try {
            resolved = path.normalize(path.join(fs.realpathSync(probe),
                normalized.substring(probe.length)));
        } catch (err) {
            return null;
        }

        for (i = 0; i < DENIED_WRITE_PREFIXES.length; i++) {
            if (resolved.indexOf(DENIED_WRITE_PREFIXES[i]) === 0) {
                return null;
            }
        }
        for (i = 0; i < ALLOWED_WRITE_ROOTS.length; i++) {
            if (resolved.indexOf(ALLOWED_WRITE_ROOTS[i]) === 0) {
                return resolved;
            }
        }
        return null;
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
                copyFileSync(source, dest);
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

        var command = "luna-send -n 1 " +
            ("luna://" + service + "/" + method).shellQuote() + " " + payload.shellQuote();

        exec(command, { maxBuffer: 8 * 1024 * 1024 }, function (error, stdout) {
            if (error) {
                future.exception = new Error("luna-send failed: " + error.message);
                return;
            }
            var reply;
            try {
                reply = JSON.parse(String(stdout));
            } catch (err2) {
                future.exception = new Error(
                    "Un-parseable reply from " + service + "/" + method + ": " + String(stdout));
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
            exec("reboot", function (error) {
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

    /**
     * The installed third-party package list, from ipkg. Recorded in the
     * manifest so a restore can report (or reinstall) what was on the device.
     */
    that.listInstalledApps = function () {
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

    /* Exported so the policy above can be asserted directly.
     *
     * Deliberately not a ForTesting seam: this is a security boundary, and one
     * worth being able to check without having to be root with a staged file
     * on disk to do it.
     */
    that.isRestorableDest = isRestorableDest;

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
