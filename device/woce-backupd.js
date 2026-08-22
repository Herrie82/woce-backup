/*
 * woce-backupd — the privileged half of woce-backup.
 *
 * Runs as root, outside the triton jail, started by upstart. Exists for one
 * reason: the backup service runs jailed, and the jail cannot see
 * /var/preferences, /var/palm/data or /media/cryptofs. Registered services
 * legitimately hand back absolute paths into those trees, so without a helper
 * outside the jail those files simply cannot be backed up or restored.
 *
 * The service talks to it through job files in /media/internal/.woce-backup/jobs
 * because that directory is the one piece of ground both sides can reach. One
 * job covers a whole service's file list, so the poll interval never dominates.
 *
 * SECURITY
 * --------
 * The job directory is on user-writable storage that is also exposed over USB.
 * Anything that can write there can ask this daemon to act. That is bounded
 * deliberately:
 *
 *   - There is no general "run a command" operation. Every op is specific and
 *     validates its own arguments.
 *   - `unstage` is the only op that writes outside the working area, and it is
 *     the escalation risk. Destinations are checked against ALLOWED_WRITE_ROOTS
 *     and DENIED_WRITE_PREFIXES, after normalisation, and symlinked parents are
 *     resolved before the check so a planted link cannot redirect a write.
 *   - `stage` only reads. It can copy a root-readable file into user storage,
 *     which is inherent to what backup does — the stock service had exactly the
 *     same reach.
 *   - `installPackages` is the one op that runs arbitrary code: `ipkg install`
 *     executes a package's postinst script as root, unconditionally, the same
 *     as any sideloaded install on this device. It is scoped as tightly as
 *     that inherent risk allows: only `.ipk` files already inside WORK_ROOT are
 *     eligible (i.e. ones this same daemon fetched from a backup target during
 *     a restore this same daemon is running — never an arbitrary job-supplied
 *     path), and only during a restore the user explicitly started. The actual
 *     trust boundary this depends on is the one every restore already depends
 *     on: the backup target's contents. A backup made by this device is
 *     exactly as trusted as the device's own db8 data or preferences, which
 *     restore already writes back verbatim; this extends that same boundary to
 *     the .ipks that were sitting in it, rather than opening a new one.
 *   - `reboot` takes no job-supplied argument at all, so there is nothing to
 *     validate. Anyone who can write a job file already has physical/USB
 *     access to the device's mass storage, at which point a forced reboot is
 *     not a meaningful escalation over what that access already grants (they
 *     could just as well pull power).
 *   - `restoreAppDirectories` is `installPackages`'s sibling for the case an
 *     app's original .ipk is nowhere to be found: it un-tars a whole app
 *     bundle over INSTALLED_APPS_DIR/<id> instead of running an installer.
 *     Same WORK_ROOT bound on the source tarball as installPackages, and the
 *     destination is never job-supplied at all - always
 *     INSTALLED_APPS_DIR + the already-validated id, so this can only ever
 *     touch that one app's own directory. Lower risk than installPackages in
 *     one sense (no postinst script runs), but it does `rm -rf` the
 *     destination first, so an id that collided with something unexpected
 *     under INSTALLED_APPS_DIR would be destructive - the `id.indexOf("/")`
 *     check is what keeps it from ever being anything other than one
 *     immediate child of that directory.
 *
 * Node on webOS 3.0.5 is 0.2.x: ES5 only, no fs.existsSync, no Promises.
 */

var fs   = require('fs');
var path = require('path');
var exec = require('child_process').exec;

// Rewritten by build.sh. Reported in the ping reply and logged by the
// service, so "Root helper available, version X" says which daemon code is
// actually live — upstart will not restart a running job on its own.
var VERSION = "1.1.0+20260822-090554";

var SERVICE_ID = "com.palm.app.backup.service";

var WORK_ROOT = "/media/internal/.woce-backup/";
var JOB_ROOT  = WORK_ROOT + "jobs/";
var LOG_FILE  = "/var/log/woce-backupd.log";

var POLL_INTERVAL = 250;

// Restore may write under these roots and nowhere else.
var ALLOWED_WRITE_ROOTS = [
    "/media/internal/",
    "/var/luna/",
    "/var/palm/",
    "/var/preferences/",
    "/var/file-cache/",
    "/tmp/"
];

// Carved out of the above. Writing an ls2 role file would let any caller
// register as any service on the bus, which is a full privilege escalation;
// upstart jobs and the preferences DB are similar.
var DENIED_WRITE_PREFIXES = [
    "/var/palm/ls2/",
    "/var/palm/jail/",
    "/etc/",
    "/usr/",
    "/bin/",
    "/sbin/",
    "/lib/"
];

/* ------------------------------------------------------------------ logging */

function log(message) {
    var line = new Date().toUTCString() + " woce-backupd: " + message + "\n";
    // fs.appendFileSync arrived in node 0.6; this device has 0.2.
    var fd;
    try {
        fd = fs.openSync(LOG_FILE, "a");
        fs.writeSync(fd, line, null);
    } catch (err) {
        // Logging must never take the daemon down.
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (ignored) {}
        }
    }
}

/* ------------------------------------------------------------- filesystem */

function statOrNull(target) {
    try {
        return fs.statSync(target);
    } catch (err) {
        return null;
    }
}

function existsSync(target) {
    return statOrNull(target) !== null;
}

function mkdirsSync(dir) {
    dir = path.normalize(dir);
    if (existsSync(dir)) {
        return;
    }
    var parent = path.dirname(dir);
    if (parent !== dir) {
        mkdirsSync(parent);
    }
    try {
        fs.mkdirSync(dir, parseInt("0755", 8));
    } catch (err) {
        if (!existsSync(dir)) {
            throw err;
        }
    }
}

function copyFileSync(from, to) {
    // Chunked rather than one readFileSync: a media file can be far larger than
    // the memory this device is willing to give us.
    var CHUNK = 65536;
    var buffer = new Buffer(CHUNK);
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
}

/**
 * True if dest is somewhere restore is permitted to write.
 *
 * Resolves the nearest existing ancestor with realpath first, so a symlink
 * planted at any level cannot point the write somewhere else.
 */
function isWriteAllowed(dest) {
    var normalized = path.normalize(dest);
    if (normalized.indexOf("..") !== -1 || normalized.charAt(0) !== "/") {
        return false;
    }

    var resolved = normalized;
    var probe = path.dirname(normalized);
    while (probe.length > 1 && !existsSync(probe)) {
        probe = path.dirname(probe);
    }
    try {
        resolved = path.join(fs.realpathSync(probe), normalized.substring(probe.length));
        resolved = path.normalize(resolved);
    } catch (err) {
        return false;
    }

    var i;
    for (i = 0; i < DENIED_WRITE_PREFIXES.length; i++) {
        if (resolved.indexOf(DENIED_WRITE_PREFIXES[i]) === 0) {
            return false;
        }
    }
    for (i = 0; i < ALLOWED_WRITE_ROOTS.length; i++) {
        if (resolved.indexOf(ALLOWED_WRITE_ROOTS[i]) === 0) {
            return true;
        }
    }
    return false;
}

/*
 * Installs our own copy of luna-send under its own identity, distinct from
 * com.palm.app.backup.service.
 *
 * It has to be a DIFFERENT name. The obvious design — have this tool present
 * itself AS com.palm.app.backup.service, so it rides on that name's existing
 * grants — does not work, and not for a permissions reason: ls-hubd treats an
 * allowedName as permanently owned by whichever role first claims it. Once
 * the role claiming com.palm.app.backup.service lists that name,
 * NO other executable can ever request it, regardless of whether the main
 * service is even running — confirmed on-device with the app fully closed:
 * every attempt still fails "Attempted to register for a service name that
 * already exists". A second role file for the same name is not a
 * looser-vs-stricter conflict to resolve; the name is just gone.
 *
 * So this tool is com.palm.backup.privileged instead — a name nothing else
 * claims, with its own self-contained role (unlike the old design, this one
 * legitimately needs its own permissions block; there is no other file to
 * collide with).
 *
 * com.palm.db/internal/preBackup is still gated on db8's "admin" role, which
 * mojodb.conf grants by hardcoded name with no API to extend it (unlike
 * per-kind permissions, which putPermissions can push at install). So
 * ensureDbAdminGrant(), below, adds this same name directly to that file.
 */
var LUNACALL_BIN      = "/usr/bin/woce-lunacall";
var LUNACALL_ROLE     = "/var/palm/ls2/roles/prv/woce-lunacall.json";
var LUNACALL_IDENTITY = "com.palm.backup.privileged";

function ensureLunacallBinary() {
    var stock = "/usr/bin/luna-send";
    var stockStat = statOrNull(stock);
    var ourStat = statOrNull(LUNACALL_BIN);

    if (!stockStat) {
        log("no " + stock + " on this device; private-bus calls stay unavailable");
        return false;
    }
    if (ourStat && ourStat.size === stockStat.size) {
        return true;
    }
    try {
        copyFileSync(stock, LUNACALL_BIN);
        fs.chmodSync(LUNACALL_BIN, parseInt("0755", 8));
        log("installed " + LUNACALL_BIN);
        return true;
    } catch (err) {
        log("could not install " + LUNACALL_BIN + ": " + err.message);
        return false;
    }
}

function ensureLunacallRole() {
    var wanted = JSON.stringify({
        role: {
            exeName: LUNACALL_BIN,
            type: "privileged",
            allowedNames: [LUNACALL_IDENTITY]
        },
        permissions: [{
            service: LUNACALL_IDENTITY,
            inbound: ["*"],
            outbound: ["*"]
        }]
    }, null, 4) + "\n";

    var current = null;
    try {
        current = fs.readFileSync(LUNACALL_ROLE, "utf8");
    } catch (err) {
        current = null;
    }
    if (current === wanted) {
        log("lunacall role already in place");
        return;
    }
    try {
        mkdirsSync(path.dirname(LUNACALL_ROLE));
        fs.writeFileSync(LUNACALL_ROLE, wanted);
        log("wrote " + LUNACALL_ROLE + "; takes effect on next boot");
    } catch (err) {
        log("could not write " + LUNACALL_ROLE + ": " + err.message);
    }
}

/*
 * Grants com.palm.backup.privileged the db8 "admin" role by editing
 * mojodb.conf directly — the only way in, since this trust has no putPermissions
 * equivalent. The file is JSON5-ish (comments, a trailing comma) so it is
 * edited as text, anchored on the last stock caller; a device whose file
 * doesn't match that exactly is left untouched rather than guessed at.
 *
 * The pre-edit content is preserved once, so prerm can restore the file
 * byte-for-byte instead of trying to pattern-match our own insertion back out.
 */
var MOJODB_CONF        = "/etc/palm/mojodb.conf";
var MOJODB_CONF_BACKUP = "/etc/palm/mojodb.conf.woce-backup-orig";

function ensureDbAdminGrant() {
    var content;
    try {
        content = fs.readFileSync(MOJODB_CONF, "utf8");
    } catch (err) {
        log("could not read " + MOJODB_CONF + ": " + err.message);
        return;
    }
    if (content.indexOf('"caller":"' + LUNACALL_IDENTITY + '"') !== -1) {
        log("db8 admin grant already in place");
        return;
    }

    if (!existsSync(MOJODB_CONF_BACKUP)) {
        try {
            fs.writeFileSync(MOJODB_CONF_BACKUP, content);
        } catch (err) {
            log("could not back up " + MOJODB_CONF + ": " + err.message);
            return; // do not edit without a way back
        }
    }

    var anchor = '{"type":"db.role","object":"admin","caller":"com.palm.spacecadet","operations":{"*":"allow"}}';
    if (content.indexOf(anchor) === -1) {
        log("mojodb.conf does not match the expected layout; leaving db8 admin list untouched");
        return;
    }
    var addition = anchor + ',\n\t\t\t{"type":"db.role","object":"admin","caller":"' +
        LUNACALL_IDENTITY + '","operations":{"*":"allow"}}';

    try {
        fs.writeFileSync(MOJODB_CONF, content.replace(anchor, addition));
        log("added " + LUNACALL_IDENTITY + " to db8 admin callers in " + MOJODB_CONF +
            "; mojodb-luna must restart (reboot) to pick it up");
    } catch (err) {
        log("could not write " + MOJODB_CONF + ": " + err.message);
    }
}

/* ---------------------------------------------------------------- the ops */

var ops = {};

ops.ping = function (job, done) {
    done({ returnValue: true, version: VERSION });
};

/**
 * Copies files the jail cannot read into the staging directory.
 *
 * Staged names are flat and index-based, so a path of any depth or character
 * set lands somewhere predictable; the caller keeps the mapping.
 */
ops.stage = function (job, done) {
    var paths = job.paths || [];
    var stageDir = job.stageDir;

    if (!stageDir || stageDir.indexOf(WORK_ROOT) !== 0) {
        return done({ returnValue: false, errorText: "stageDir must be inside " + WORK_ROOT });
    }

    try {
        mkdirsSync(stageDir);
    } catch (err) {
        return done({ returnValue: false, errorText: "Cannot create stage dir: " + err.message });
    }

    var staged = {};
    var missing = [];

    for (var i = 0; i < paths.length; i++) {
        var source = paths[i];
        var stat = statOrNull(source);
        if (!stat || !stat.isFile()) {
            missing.push(source);
            continue;
        }
        var name = "s" + i;
        try {
            copyFileSync(source, path.join(stageDir, name));
            staged[source] = name;
        } catch (err) {
            log("stage failed for " + source + ": " + err.message);
            missing.push(source);
        }
    }

    var count = 0;
    for (var key in staged) {
        if (staged.hasOwnProperty(key)) {
            count++;
        }
    }
    log("staged " + count + " file(s), " + missing.length + " missing");
    done({ returnValue: true, staged: staged, missing: missing });
};

/**
 * Writes staged files back to their absolute destinations.
 */
ops.unstage = function (job, done) {
    var files = job.files || [];
    var stageDir = job.stageDir;

    if (!stageDir || stageDir.indexOf(WORK_ROOT) !== 0) {
        return done({ returnValue: false, errorText: "stageDir must be inside " + WORK_ROOT });
    }

    var restored = [];
    var skipped = [];

    for (var i = 0; i < files.length; i++) {
        var entry = files[i];
        var source = path.join(stageDir, entry.staged);
        var dest = entry.path;

        if (!isWriteAllowed(dest)) {
            log("refused write to " + dest);
            skipped.push(dest);
            continue;
        }
        if (!existsSync(source)) {
            skipped.push(dest);
            continue;
        }

        try {
            mkdirsSync(path.dirname(dest));
            copyFileSync(source, dest);
            restored.push(dest);
        } catch (err) {
            log("unstage failed for " + dest + ": " + err.message);
            skipped.push(dest);
        }
    }

    log("restored " + restored.length + " file(s), " + skipped.length + " skipped");
    done({ returnValue: true, restored: restored, skipped: skipped });
};

/**
 * The installed third-party package list. Recorded in the manifest so a restore
 * can tell the user what they had — the App Catalog is gone, so nothing can be
 * re-downloaded automatically.
 */
/**
 * Makes a Luna call on the private bus and returns the parsed reply.
 *
 * The jailed service registers on the *public* bus, and several services it
 * needs are private-only: they have a role under roles/pub but no service file
 * in /usr/share/dbus-1/services, so a public-bus caller cannot launch them and
 * gets "Service does not exist". com.palm.deviceprofile, com.palm.eas,
 * com.palm.service.contacts, com.palm.service.migration and
 * com.palm.messaging.chatthreader are all in that position.
 *
 * luna-send sends over the private bus by default (-P selects public), and runs
 * here as root under its own privileged role, so it reaches them.
 *
 * Only the services that actually register for backup are callable, and the
 * method has to look like a method — this is a bridge for the backup protocol,
 * not a general-purpose bus shell for anything that can write a job file.
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
    "com.palm.systemservice"
];

var METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/;

ops.lunacall = function (job, done) {
    var service = job.service;
    var method  = job.method;
    var params  = job.params === undefined ? {} : job.params;

    if (LUNACALL_ALLOWED_SERVICES.indexOf(service) === -1) {
        return done({ returnValue: false, errorText: "Service not permitted: " + service });
    }
    if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
        return done({ returnValue: false, errorText: "Bad method: " + method });
    }

    var payload;
    try {
        payload = JSON.stringify(params);
    } catch (err) {
        return done({ returnValue: false, errorText: "Params are not serialisable" });
    }

    // Single-quote the payload for the shell, escaping any embedded quote.
    var quoted = "'" + payload.replace(/'/g, "'\\''") + "'";
    var uri = "palm://" + service + "/" + method;

    // Prefer our own copy under com.palm.backup.privileged: db8 grants its
    // "admin" role by caller name (see ensureDbAdminGrant), and only this
    // binary's role file may claim that identity. The stock luna-send is the
    // fallback for the window between install and the reboot that makes
    // ls-hubd/mojodb-luna read the new role and config — it still reaches the
    // private bus, it just arrives anonymous, so anything gated on admin is
    // denied.
    var useOurs = existsSync(LUNACALL_BIN) && existsSync(LUNACALL_ROLE);

    var run = function (binary, name, onDone) {
        var command = binary + (name ? " -m " + name : "") +
            " -n 1 -f " + uri + " " + quoted;
        exec(command, { timeout: 120000 }, function (error, stdout, stderr) {
            // luna-send writes the payload to stderr and only timing to stdout.
            var text = String(stdout || "") + String(stderr || "");
            var start = text.indexOf("{");
            var end = text.lastIndexOf("}");
            var reply = null;
            if (start >= 0 && end > start) {
                try {
                    reply = JSON.parse(text.substring(start, end + 1));
                } catch (parseErr) {
                    reply = null;
                }
            }
            onDone(reply, text, error);
        });
    };

    var finish = function (reply, text, error) {
        if (reply) {
            return done({ returnValue: true, reply: reply });
        }
        // Carry what the tool actually printed. "No reply" on its own sent us
        // looking for a hung service when the real message was a one-line hub
        // rejection sitting in stderr.
        var detail = String(text || "").replace(/\s+/g, " ");
        if (detail.length > 300) {
            detail = detail.substring(0, 300) + "...";
        }
        done({
            returnValue: false,
            errorText: "No reply from " + uri +
                (error ? ": " + error.message : "") +
                (detail ? " [output: " + detail + "]" : " [no output]")
        });
    };

    if (!useOurs) {
        return run("/usr/bin/luna-send", null, finish);
    }
    run(LUNACALL_BIN, LUNACALL_IDENTITY, function (reply, text, error) {
        // Before the reboot the hub refuses the name outright, which arrives as
        // a startup failure rather than a reply. Fall back rather than reporting
        // the whole backup as broken.
        if (!reply && text.indexOf("Invalid permissions") !== -1) {
            log("lunacall role is not active yet (needs a reboot); using luna-send");
            return run("/usr/bin/luna-send", null, finish);
        }
        finish(reply, text, error);
    });
};

/**
 * Reads the backup registration files in /etc/palm/backup.
 *
 * The jail mounts /etc/palm read-only, so the service reads most of these
 * itself — but com.palm.keymanager is mode 0640 root-only, and the service runs
 * unprivileged. Without this it is dropped, and with it goes every credential
 * the keymanager holds.
 *
 * Returns { name: contents } for whatever could be read; the service parses.
 */
ops.readRegistrations = function (job, done) {
    var DIR = "/etc/palm/backup/";
    var names;

    try {
        names = fs.readdirSync(DIR);
    } catch (err) {
        return done({ returnValue: false, errorText: "Cannot list " + DIR + ": " + err.message });
    }

    var files = {};
    var failed = [];

    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        // Registration filenames are service ids; nothing else belongs here.
        if (name.indexOf("/") !== -1 || name.charAt(0) === ".") {
            continue;
        }
        try {
            files[name] = fs.readFileSync(DIR + name, "utf8");
        } catch (err) {
            failed.push(name);
        }
    }

    log("read " + names.length + " registration file(s), " + failed.length + " unreadable");
    done({ returnValue: true, files: files, failed: failed });
};

/**
 * Reboots the device after a restore, so restored preferences/db8 state that
 * only takes effect on the next boot (the woce-lunacall role and the
 * mojodb.conf admin grant among them - see ensureLunacallRole and
 * ensureDbAdminGrant above) actually apply without the user having to know
 * that and do it themselves. Confirmed on-device that plain "reboot now"
 * brings the system down; replying first and delaying the command a couple of
 * seconds gives the job result - and the Luna response built on it - time to
 * reach the app before the system actually goes.
 */
ops.reboot = function (job, done) {
    done({ returnValue: true });
    setTimeout(function () {
        exec("reboot now", function (error) {
            if (error) {
                log("reboot failed: " + error.message);
            }
        });
    }, 2000);
};

/*
 * Every app the SYSTEM IMAGE provides, by whichever of the two routes an image
 * can use. Neither is the user's to back up, and neither is theirs to restore:
 * both come back by reflashing.
 *
 *   1. BAKED into the read-only rootfs, at the path LunaSysMgr scans.
 *      ipkg knows nothing about these - they were flashed, not installed.
 *   2. STAGED as a preload under /usr/palm/ipkgs, which app-install installs
 *      into cryptofs on first boot. These end up looking exactly like a user
 *      install, ipkg record and all, which is why the directory scan alone
 *      cannot find them.
 *
 * This replaces a "com.palm.*-prefixed means system-owned" name check, which
 * was wrong in both directions on a real device: it skipped
 * com.palm.app.codepoet.simplechat, a community app that merely borrows the
 * prefix, while archiving and restoring 11.7MB of QuickOffice that every image
 * already ships. Asking the image what it provides is the actual question.
 *
 * Restoring one of these does not "put it back", it SHADOWS the image's own
 * copy with an older one: a cryptofs app wins over the rootfs, so a webOS 3.0.5
 * backup restored onto CE 3.1 would silently roll apps back to 2013.
 *
 * Reported separately from `packages` so it only ever informs the "does this
 * device already have it?" question.
 */
var ROM_APPS_DIR = "/usr/palm/applications/";
var PRELOAD_IPK_DIR = "/usr/palm/ipkgs/";

function listImageApps() {
    var ids = {};
    var names;

    try {
        names = fs.readdirSync(ROM_APPS_DIR);
        for (var i = 0; i < names.length; i++) {
            if (existsSync(ROM_APPS_DIR + names[i] + "/appinfo.json")) {
                ids[names[i]] = true;
            }
        }
    } catch (err) {
        // no rootfs app dir is not a failure, just nothing to add
    }

    // Staged preloads sit either flat in /usr/palm/ipkgs or in a per-app
    // subdirectory; stock webOS 3.0.5 uses both shapes at once. The package
    // name is the part of the .ipk filename before the first underscore.
    var addIpks = function (dir, depth) {
        var entries;
        try {
            entries = fs.readdirSync(dir);
        } catch (err) {
            return;
        }
        for (var j = 0; j < entries.length; j++) {
            var name = entries[j];
            var full = dir + name;
            if (name.slice(-4) === ".ipk") {
                ids[name.split("_")[0]] = true;
            } else if (depth > 0) {
                var st = statOrNull(full);
                if (st && st.isDirectory()) {
                    ids[name] = true;      // subdir is named for the app by convention
                    addIpks(full + "/", depth - 1);
                }
            }
        }
    };
    addIpks(PRELOAD_IPK_DIR, 1);

    var out = [];
    for (var id in ids) {
        if (ids.hasOwnProperty(id)) {
            out.push(id);
        }
    }
    return out;
}

ops.listInstalledApps = function (job, done) {
    var romApps = listImageApps();
    exec("/usr/bin/ipkg -o /media/cryptofs/apps list_installed", function (error, stdout) {
        if (error) {
            return done({ returnValue: true, packages: [], romApps: romApps });
        }

        var packages = [];
        var lines = (stdout || "").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\s+|\s+$/g, "");
            if (line.length === 0) {
                continue;
            }
            // "com.example.app - 1.0.0 - Description"
            var parts = line.split(" - ");
            if (parts.length >= 2) {
                packages.push({
                    id:      parts[0].replace(/^\s+|\s+$/g, ""),
                    version: parts[1].replace(/^\s+|\s+$/g, ""),
                    title:   parts.length > 2 ? parts.slice(2).join(" - ") : undefined
                });
            }
        }
        log("listed " + packages.length + " installed package(s), " +
            romApps.length + " provided by the system image");
        done({ returnValue: true, packages: packages, romApps: romApps });
    });
};

// The offset root every cryptofs install lives under, and the app directory
// inside it - regardless of whether Preware/WOSQI's download cache still has
// the .ipk that put it there.
var CRYPTOFS_ROOT = "/media/cryptofs/apps/";
var INSTALLED_APPS_DIR = CRYPTOFS_ROOT + "usr/palm/applications/";
var IPKG_INFO_DIR = CRYPTOFS_ROOT + "usr/lib/ipkg/info/";

/*
 * The subtrees a package may own inside the cryptofs root. An app bundle is
 * only part of what an .ipk installs: a service goes to usr/palm/services,
 * packageinfo.json to usr/palm/packages, and a shared library to
 * usr/palm/frameworks. Archiving only the app directory - which is all this
 * used to do - restores an app whose service is simply missing, so it launches
 * and does nothing.
 *
 * This list is also the allowlist restoreAppDirectories validates a tarball's
 * members against, so widening it widens what a restore can write.
 * usr/lib/ipkg is deliberately absent: that is ipkg's own bookkeeping, not the
 * package's runtime, and rewriting it from a backup would desync the package
 * database rather than repair it.
 */
var OWNED_SUBTREES = [
    "usr/palm/applications/",
    "usr/palm/services/",
    "usr/palm/packages/",
    "usr/palm/frameworks/"
];

function ownedSubtreeOf(rel) {
    for (var i = 0; i < OWNED_SUBTREES.length; i++) {
        if (rel.indexOf(OWNED_SUBTREES[i]) === 0) {
            return OWNED_SUBTREES[i];
        }
    }
    return null;
}

/*
 * What ipkg says a package installed, reduced to the directories it owns.
 *
 * The .list file names every individual file, which for a big app is a
 * thousand-odd paths - far past what one command line can carry. Collapsing
 * each to its usr/palm/<kind>/<name> directory gives the same coverage in a
 * handful of arguments, and picks up anything the package created at runtime
 * inside its own directory as a bonus.
 *
 * Returns [] when there is no .list (an app that was itself restored by the
 * directory fallback has none), and the caller falls back to the app dir.
 */
function ownedPathsFor(id) {
    var listFile = IPKG_INFO_DIR + id + ".list";
    var text;
    try {
        text = fs.readFileSync(listFile, "utf8");
    } catch (err) {
        return [];
    }

    var seen = {};
    var out = [];
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var rel = lines[i].replace(/^\s+|\s+$/g, "").replace(/^\/+/, "");
        if (!rel || rel.indexOf("..") !== -1) {
            continue;
        }
        var subtree = ownedSubtreeOf(rel);
        if (!subtree) {
            continue;              // ipkg bookkeeping, or outside the cryptofs tree
        }
        var rest = rel.slice(subtree.length);
        var name = rest.split("/")[0];
        if (!name) {
            continue;
        }
        var owned = subtree + name;
        if (!seen[owned] && existsSync(CRYPTOFS_ROOT + owned)) {
            seen[owned] = true;
            out.push(owned);
        }
    }
    return out;
}

/**
 * Copies the .ipk for each named package into destDir, so a restore can
 * reinstall without a catalog. For a package whose .ipk is gone from both
 * cache locations - the common case for anything installed a while ago -
 * falls back to tarring up the installed app directory itself, so restore
 * still has *something* to put back rather than nothing. LunaSysMgr
 * discovers an app by scanning INSTALLED_APPS_DIR for an appinfo.json at its
 * own next boot, independent of ipkg's package database, so a raw directory
 * put back there becomes a launchable icon the same way a fresh install
 * would - after the reboot restore already asks for, for the unrelated
 * role-file reasons documented elsewhere in this file. What that reboot
 * does *not* do is re-create ipkg's own bookkeeping for the package
 * (.control/.list/.md5sums under .../usr/lib/ipkg/info/), so Software
 * Manager/Preware may not offer to manage or cleanly uninstall an app that
 * came back this way, even though it runs. The cleaner .ipk-reinstall path
 * above is used whenever it's available for exactly that reason; this is
 * the fallback for when it is not.
 */
ops.archivePackages = function (job, done) {
    var packages = job.packages || [];
    var destDir = job.destDir;

    if (!destDir || destDir.indexOf(WORK_ROOT) !== 0) {
        return done({ returnValue: false, errorText: "destDir must be inside " + WORK_ROOT });
    }

    try {
        mkdirsSync(destDir);
    } catch (err) {
        return done({ returnValue: false, errorText: err.message });
    }

    // Where Preware and WOSQI leave downloaded packages.
    var SEARCH_DIRS = ["/media/internal/downloads/", "/media/cryptofs/apps/usr/palm/packages/"];
    var archived = [];
    var archivedDirs = [];

    // Node 0.2 has no execSync, and tar can genuinely take a moment on a
    // large app - so this walks packages one at a time with an async
    // continuation, same shape as installPackages/restoreAppDirectories
    // below, rather than the synchronous for-loop the pure-copy .ipk path
    // used to get away with.
    var archiveNext = function (i) {
        if (i >= packages.length) {
            return done({ returnValue: true, archived: archived, archivedDirs: archivedDirs });
        }

        var id = packages[i].id;
        if (!id || id.indexOf("/") !== -1) {
            return archiveNext(i + 1);
        }

        for (var d = 0; d < SEARCH_DIRS.length; d++) {
            var candidate = SEARCH_DIRS[d] + id + ".ipk";
            if (existsSync(candidate)) {
                try {
                    copyFileSync(candidate, path.join(destDir, id + ".ipk"));
                    archived.push(id);
                } catch (err) {
                    log("archive failed for " + id + ": " + err.message);
                }
                return archiveNext(i + 1);
            }
        }

        // Everything ipkg says this package owns - app bundle, service,
        // packageinfo, framework - relative to the cryptofs root, so a restore
        // can put the whole thing back and not just the launchable half.
        var owned = ownedPathsFor(id);
        if (owned.length === 0) {
            // No .list: an app that was itself put back by this fallback has
            // none. The app directory alone is still better than nothing.
            var appStat = statOrNull(INSTALLED_APPS_DIR + id);
            if (!appStat || !appStat.isDirectory()) {
                return archiveNext(i + 1);   // not installed here either
            }
            owned = ["usr/palm/applications/" + id];
        }

        var quote = function (text) { return "'" + text.replace(/'/g, "'\\''") + "'"; };
        var tarball = path.join(destDir, id + "-app.tar.gz");
        var args = owned.map(quote).join(" ");
        exec("/bin/tar czf " + quote(tarball) + " -C " + CRYPTOFS_ROOT + " " + args,
            { timeout: 120000 },
            function (error) {
                if (error) {
                    log("directory archive failed for " + id + ": " + error.message);
                } else {
                    log("archived " + id + " as " + owned.length + " owned path(s): " +
                        owned.join(", "));
                    archivedDirs.push(id);
                }
                archiveNext(i + 1);
            });
    };

    archiveNext(0);
};

/**
 * Restores one package's raw installed files from a tarball this daemon fetched
 * during this same restore - same WORK_ROOT bound as installPackages, for the
 * same reason (see the SECURITY note at the top of this file).
 *
 * The destination is still never job-supplied: it is always CRYPTOFS_ROOT, and
 * every member of the tarball is read out and checked BEFORE anything is
 * extracted or deleted. A member must sit inside one of OWNED_SUBTREES and
 * carry no "..", so the worst a tampered archive can reach is another cryptofs
 * app's directory - not /etc, not /usr, not an ls2 role. One bad member fails
 * the whole entry rather than extracting the rest, because a half-applied
 * package is harder to reason about than one that plainly did not restore.
 *
 * Two tarball layouts exist. Archives written before this daemon captured
 * whole packages contain "<id>/..." and restore into INSTALLED_APPS_DIR; the
 * current ones are relative to the cryptofs root and contain the app bundle
 * plus whatever else ipkg said the package owned - its service above all,
 * without which an app comes back launchable and inert.
 */
ops.restoreAppDirectories = function (job, done) {
    var files = job.files || [];
    var restored = [];
    var failed = [];

    var quote = function (text) { return "'" + text.replace(/'/g, "'\\''") + "'"; };

    var restoreNext = function (i) {
        if (i >= files.length) {
            return done({ returnValue: true, restored: restored, failed: failed });
        }

        var entry = files[i] || {};
        var tarPath = entry.path;
        var id = entry.id;

        var fail = function (why) {
            log("directory restore failed for " + (id || "(unknown)") + ": " + why);
            failed.push(id || "(unknown)");
            restoreNext(i + 1);
        };

        if (!id || id.indexOf("/") !== -1 || !tarPath || tarPath.indexOf(WORK_ROOT) !== 0 ||
                tarPath.slice(-7) !== ".tar.gz" || !existsSync(tarPath)) {
            return fail("bad entry");
        }

        exec("/bin/tar tzf " + quote(tarPath), { timeout: 60000 },
            function (listError, listOut) {
                if (listError) {
                    return fail("could not read the archive: " + listError.message);
                }

                var members = String(listOut || "").split("\n");
                var legacy = true;
                var roots = {};
                var count = 0;

                for (var m = 0; m < members.length; m++) {
                    var name = members[m].replace(/^\s+|\s+$/g, "").replace(/^\.\//, "");
                    if (!name) {
                        continue;
                    }
                    count++;
                    if (name.indexOf("..") !== -1 || name.charAt(0) === "/") {
                        return fail("archive member escapes the destination: " + name);
                    }
                    if (name.indexOf(id + "/") === 0 || name === id) {
                        continue;                       // legacy "<id>/..." member
                    }
                    legacy = false;
                    var subtree = ownedSubtreeOf(name);
                    if (!subtree) {
                        return fail("archive member outside the allowed subtrees: " + name);
                    }
                    var owned = subtree + name.slice(subtree.length).split("/")[0];
                    roots[owned] = true;
                }

                if (count === 0) {
                    return fail("archive is empty");
                }

                var base, clear;
                if (legacy) {
                    base = INSTALLED_APPS_DIR;
                    clear = [INSTALLED_APPS_DIR + id];
                } else {
                    base = CRYPTOFS_ROOT;
                    clear = [];
                    for (var r in roots) {
                        if (roots.hasOwnProperty(r)) {
                            clear.push(CRYPTOFS_ROOT + r);
                        }
                    }
                }

                exec("rm -rf " + clear.map(quote).join(" "), { timeout: 30000 },
                    function (rmError) {
                        if (rmError) {
                            return fail("could not clear " + clear.join(", ") + ": " +
                                        rmError.message);
                        }
                        exec("/bin/tar xzf " + quote(tarPath) + " -C " + base,
                            { timeout: 120000 },
                            function (error) {
                                if (error) {
                                    return fail(error.message);
                                }
                                log("restored " + id + " into " + clear.length +
                                    " path(s): " + clear.join(", "));
                                restored.push(id);
                                restoreNext(i + 1);
                            });
                    });
            });
    };

    restoreNext(0);
};

/**
 * Installs each named .ipk via ipkg, so a restore can put an archived app back
 * exactly the way a sideloaded install does — same command, same root
 * privilege, same postinst execution.
 *
 * The one guard that matters: every path must already be inside WORK_ROOT.
 * That means it can only be a file this daemon itself fetched from the backup
 * target during this same restore — never a path a job file supplies from
 * somewhere else. See the SECURITY note at the top of this file for why that
 * bound, not signature checking (this platform doesn't enforce any), is what
 * this op actually relies on.
 */
ops.installPackages = function (job, done) {
    var files = job.files || [];
    var installed = [];
    var failed = [];

    var installNext = function (i) {
        if (i >= files.length) {
            return done({ returnValue: true, installed: installed, failed: failed });
        }

        var entry = files[i] || {};
        var ipkPath = entry.path;
        var id = entry.id;

        if (!id || !ipkPath || ipkPath.indexOf(WORK_ROOT) !== 0 ||
                ipkPath.slice(-4) !== ".ipk" || !existsSync(ipkPath)) {
            failed.push(id || "(unknown)");
            return installNext(i + 1);
        }

        var quoted = "'" + ipkPath.replace(/'/g, "'\\''") + "'";
        exec("/usr/bin/ipkg -o /media/cryptofs/apps -force-overwrite install " + quoted,
            { timeout: 60000 },
            function (error) {
                if (error) {
                    log("install failed for " + id + ": " + error.message);
                    failed.push(id);
                } else {
                    log("installed " + id);
                    installed.push(id);
                }
                installNext(i + 1);
            });
    };

    installNext(0);
};

/* -------------------------------------------------------------- job loop */

function writeResult(jobId, result) {
    var tempPath = path.join(JOB_ROOT, jobId + ".writing");
    var finalPath = path.join(JOB_ROOT, jobId + ".done");
    try {
        // Rename into place so the service never reads a partial result.
        fs.writeFileSync(tempPath, JSON.stringify(result));
        fs.renameSync(tempPath, finalPath);
    } catch (err) {
        log("unable to write result for " + jobId + ": " + err.message);
    }
}

function handleJobFile(filename) {
    var jobPath = path.join(JOB_ROOT, filename);
    var jobId = filename.substring(0, filename.length - ".job".length);
    var job;

    try {
        job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    } catch (err) {
        log("malformed job " + filename + ": " + err.message);
        try { fs.unlinkSync(jobPath); } catch (ignored) {}
        return;
    }

    // Remove the request before acting, so a crash mid-job cannot make the
    // daemon replay it on every restart.
    try { fs.unlinkSync(jobPath); } catch (ignored) {}

    var handler = ops[job.op];
    if (!handler) {
        log("unknown op: " + job.op);
        writeResult(jobId, { returnValue: false, errorText: "Unknown op: " + job.op });
        return;
    }

    try {
        handler(job, function (result) {
            writeResult(jobId, result);
        });
    } catch (err) {
        log("op " + job.op + " threw: " + err.message);
        writeResult(jobId, { returnValue: false, errorText: err.message });
    }
}

function poll() {
    var entries;
    try {
        entries = fs.readdirSync(JOB_ROOT);
    } catch (err) {
        // The service creates this on first run; until then there is nothing
        // to do.
        entries = [];
    }

    for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        if (name.length > 4 && name.substring(name.length - 4) === ".job") {
            handleJobFile(name);
        }
    }

    setTimeout(poll, POLL_INTERVAL);
}

/*
 * There is deliberately no ensurePrivateBusRole() here any more.
 *
 * It used to write /var/palm/ls2/roles/prv/<service>.json granting our own
 * service outbound: ["*"] on the private bus, because LunaSysMgr generates
 * third-party JS service roles from /usr/palm/ls2/templates/Triton.prv, which
 * hardcodes "outbound": [] — and without outbound, com.palm.db's
 * internal/preBackup (the call the entire backup depends on) comes back as an
 * unknown method.
 *
 * What that role was working around was the *name*. Measured on device:
 * com.palm.service.payment, a third-party service shipping no role of its own,
 * has outbound ["*"] while ours had []; the com.palm. prefix was the only
 * differentiator. This service is now com.palm.app.backup.service, so it is on the
 * permissive side of that rule by construction and the role file has nothing
 * left to add.
 *
 * Writing it anyway would not be merely redundant, it would be a hazard. The
 * hub already has a generated role claiming this name, and a second role file
 * naming the same service in its permissions block throws "Attempting to add
 * duplicate service name to permission map" — which drops *both* grants, so the
 * workaround would take out the thing it was working around. prerm no longer
 * removes that file either, since we no longer create it.
 *
 * The db8 admin grant below is a different question and is still written; see
 * ensureDbAdminGrant.
 */

function main() {
    log("starting, version " + VERSION + ", pid " + process.pid);
    if (ensureLunacallBinary()) {
        ensureLunacallRole();
        ensureDbAdminGrant();
    }
    try {
        mkdirsSync(JOB_ROOT);
    } catch (err) {
        log("unable to create " + JOB_ROOT + ": " + err.message);
    }
    poll();
}

main();
