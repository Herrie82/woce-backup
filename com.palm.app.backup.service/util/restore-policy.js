/* What a restore is allowed to touch, decided from the manifest alone.
 *
 * A backup lives on /media/internal, which is handed to a PC over USB, and
 * nothing authenticates it. Every name in its manifest is therefore attacker
 * input, and on LuneOS the service that acts on them runs as uid 0, unjailed.
 * Before this file, a relative name was joined onto the temp dir without
 * normalising ("../../../../etc/x"), an absolute one only had to start with
 * "/media/internal/" to be written directly ("/media/internal/../../etc/x"),
 * the stored-file name and the package id were pasted into paths unchecked,
 * and a symlink anywhere in a destination's parents redirected the write.
 *
 * Every manifest-derived name goes through one of the checks below before it
 * is used, and the restore engine drops whatever fails, so nothing downstream
 * (the fetch, the write, the helper, a service's postRestore) ever sees it.
 *
 * Deliberately conservative: a name is rejected, never repaired. A path that
 * needs normalising to be acceptable is not one any real backup produced.
 *
 * Node 0.2 compatible (webOS 3.0.5 runs this file too): path.normalize,
 * fs.lstatSync and fs.realpathSync only.
 */
/*global LOCAL_TARGET_ROOT, WORK_ROOT, platform, require */

var restorePolicy = (function () {
    var that = {};
    var fs   = require('fs');
    var path = require('path');

    /* Where an absolute manifest path may point.
     *
     * webOS 3.0.5: the root helper's own ALLOWED_WRITE_ROOTS
     * (device/woce-backupd.js), unchanged, because the stock services there
     * hand back paths across all of these (contact photos under /var/palm/data,
     * luna-sysmgr files under /var/luna/preferences, the browser cookie db
     * under /tmp) and narrowing them would need measurements on a TouchPad
     * that have not been made.
     *
     * LuneOS: only what a provider on this platform actually backs up. db8
     * and systemservice return names relative to the temp dir; the in-process
     * media categories return /media/internal paths; luna-backupagent returns
     * a fixed list under /var/luna/preferences and /var/preferences
     * (s_candidateFiles in its BackupAgent.cpp). Nothing returns /tmp, or
     * anything under /var/palm or the rest of /var/luna.
     */
    var LEGACY_ROOTS = [
        "/media/internal/",
        "/var/luna/",
        "/var/palm/",
        "/var/preferences/",
        "/var/file-cache/",
        "/tmp/"
    ];
    var MODERN_ROOTS = [
        "/media/internal/",
        "/var/luna/preferences/",
        "/var/preferences/",
        "/var/file-cache/"
    ];

    /* Carved out of the roots above, on both platforms.
     *
     *  - our own work area: the 3.0.5 root helper executes job files it finds
     *    under JOB_ROOT, and the staging area is where restore assembles what
     *    it is about to hand to root;
     *  - the backup store itself;
     *  - ls2 roles and jail configuration (any service name, any jail);
     *  - developer mode switches, which open sshd, adb and unsigned installs.
     */
    var deniedPrefixes = function () {
        return [
            WORK_ROOT,
            LOCAL_TARGET_ROOT,
            "/var/palm/ls2/",
            "/var/palm/ls2-dev/",
            "/var/palm/jail/",
            "/var/palm/data/com.palm.appInstallService/",
            "/var/luna/dev-mode-enabled",
            "/var/luna/preferences/devmode_enabled",
            "/var/luna/preferences/debug_system_apps"
        ];
    };

    var rootsOverride = null;

    var allowedRoots = function () {
        if (rootsOverride) {
            return rootsOverride;
        }
        var modern = false;
        try {
            modern = platform.isModernBus();
        } catch (err) {
            modern = false;
        }
        return modern ? MODERN_ROOTS : LEGACY_ROOTS;
    };

    var toPosix = function (p) {
        return String(p).replace(/\\/g, "/");
    };

    var withSlash = function (dir) {
        dir = toPosix(dir);
        return dir.charAt(dir.length - 1) === "/" ? dir : dir + "/";
    };

    var lstatOrNull = function (target) {
        try {
            return fs.lstatSync(target);
        } catch (err) {
            return null;
        }
    };

    var realOrNull = function (target) {
        try {
            return toPosix(fs.realpathSync(target));
        } catch (err) {
            return null;
        }
    };

    /** Shared shape checks for any manifest-supplied name. */
    var badName = function (name) {
        if (typeof name !== "string" || name.length === 0) {
            return "empty or not a string";
        }
        if (name.length > 4096) {
            return "too long";
        }
        if (name.indexOf("\u0000") !== -1) {
            return "contains NUL";
        }
        var parts = toPosix(name).split("/");
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === "..") {
                return "contains a '..' component";
            }
        }
        return null;
    };

    /**
     * Walks the components of `full` below `base` (which must be a prefix of
     * it) and fails on the first one that exists and is a symlink. Components
     * that do not exist yet are fine: restore creates them as directories.
     * The last component is checked too, so a write cannot follow a symlink
     * planted at the destination itself.
     */
    var symlinkBelow = function (base, full) {
        var rest = full.substring(base.length).split("/");
        var probe = base.substring(0, base.length - 1);
        for (var i = 0; i < rest.length; i++) {
            if (rest[i] === "") {
                continue;
            }
            probe = probe + "/" + rest[i];
            var st = lstatOrNull(probe);
            if (!st) {
                return null;
            }
            if (st.isSymbolicLink()) {
                return probe;
            }
        }
        return null;
    };

    /**
     * The nearest existing ancestor of target, through realpath, with the
     * missing tail re-appended. null when nothing on the way resolves.
     */
    var resolveExisting = function (target) {
        var probe = target;
        while (probe.length > 1 && !lstatOrNull(probe)) {
            probe = toPosix(path.dirname(probe));
        }
        var real = realOrNull(probe);
        if (real === null) {
            return null;
        }
        return toPosix(path.normalize(real + target.substring(probe.length)));
    };

    var startsWithAny = function (value, prefixes) {
        for (var i = 0; i < prefixes.length; i++) {
            if (prefixes[i] && value.indexOf(prefixes[i]) === 0) {
                return prefixes[i];
            }
        }
        return null;
    };

    /**
     * An absolute manifest path, checked as a write destination.
     *
     * @return { path: <normalised path> } or { reason: <why it was refused> }
     */
    that.checkAbsolute = function (name) {
        var bad = badName(name);
        if (bad) {
            return { reason: bad };
        }
        name = toPosix(name);
        if (name.charAt(0) !== "/") {
            return { reason: "not absolute" };
        }
        var normalized = toPosix(path.normalize(name));

        var roots = allowedRoots();
        var root = startsWithAny(normalized, roots);
        if (!root) {
            return { reason: "outside the permitted roots" };
        }
        var denied = deniedPrefixes();
        if (startsWithAny(normalized, denied)) {
            return { reason: "inside a protected path" };
        }
        var link = symlinkBelow(root, normalized);
        if (link) {
            return { reason: "symlink in the path at " + link };
        }
        // The root itself may legitimately be a link or a mount (a device
        // where /media/internal points elsewhere), so the resolved result is
        // accepted under either the root as named or the root as resolved.
        var resolved = resolveExisting(normalized);
        if (resolved === null) {
            return { reason: "does not resolve" };
        }
        var realRoot = realOrNull(root);
        var underRoot = resolved.indexOf(root) === 0 ||
            (realRoot !== null && resolved.indexOf(withSlash(realRoot)) === 0);
        if (!underRoot || startsWithAny(resolved, denied)) {
            return { reason: "resolves outside the permitted roots" };
        }
        return { path: normalized };
    };

    /**
     * A relative manifest path, resolved under baseDir (the temp dir a
     * service will read it back from).
     *
     * @return { path: <absolute path under baseDir> } or { reason: ... }
     */
    that.checkRelative = function (name, baseDir) {
        var bad = badName(name);
        if (bad) {
            return { reason: bad };
        }
        name = toPosix(name);
        if (name.charAt(0) === "/") {
            return { reason: "absolute where a relative name was expected" };
        }
        if (/^[A-Za-z]:/.test(name)) {
            return { reason: "drive-qualified" };
        }
        if (typeof baseDir !== "string" || baseDir.length === 0) {
            return { reason: "no base directory" };
        }
        var base = withSlash(toPosix(path.normalize(baseDir)));
        var full = toPosix(path.normalize(base + name));
        if (full.indexOf(base) !== 0 || full.length === base.length) {
            return { reason: "escapes the temp directory" };
        }
        var link = symlinkBelow(base, full);
        if (link) {
            return { reason: "symlink in the path at " + link };
        }
        var realBase = realOrNull(base);
        var resolved = resolveExisting(full);
        if (realBase !== null && (resolved === null ||
                resolved.indexOf(withSlash(realBase)) !== 0)) {
            return { reason: "resolves outside the temp directory" };
        }
        return { path: full };
    };

    /** Either kind of manifest file path. */
    that.checkFilePath = function (name, baseDir) {
        if (typeof name === "string" && toPosix(name).charAt(0) === "/") {
            return that.checkAbsolute(name);
        }
        return that.checkRelative(name, baseDir);
    };

    /* The name a file is stored under in the target: its checksum (hex md5
     * today; up to sha512 length allowed), optionally ".gz". It becomes a
     * path component on both the read and the staging side.
     */
    var STORED_NAME = /^[0-9A-Fa-f]{8,128}(\.gz)?$/;

    that.isValidStoredName = function (name) {
        return typeof name === "string" && STORED_NAME.test(name);
    };

    /* A package id from the manifest. It becomes a file name in the staging
     * directory and an argument to opkg and tar.
     *
     * Not the ^[a-z0-9][a-z0-9.-]*$ the audit suggested: real ids are not all
     * lower case. A LuneOS image ships "Waydroid" and
     * "org.mer.app.sdl2_opengles1_test" in /usr/palm/applications. Allowed:
     * letters, digits, '.', '_', '+', '-', starting with a letter or digit, so
     * never '/', never a leading '.' or '-' (no "..", no option injection),
     * and no shell metacharacter at all.
     */
    var PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,254}$/;

    that.isValidPackageId = function (id) {
        return typeof id === "string" && PACKAGE_ID.test(id);
    };

    /** Tests only: restrict or widen the roots (null restores the default). */
    that.setRootsForTesting = function (roots) {
        rootsOverride = roots ? roots.map(withSlash) : null;
    };

    return that;
}());
