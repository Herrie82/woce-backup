/* User file categories, presented as a backup provider.
 *
 * The stock backup service never backed up media — it only ever moved what
 * registered services handed it. Rather than bolt a second code path onto the
 * engine, this exposes user files through the same contract a registered
 * service uses (preBackup returns a file list, postRestore takes one back), and
 * the engine dispatches it in-process instead of over the bus.
 *
 * No root helper is needed here: /media/internal is mounted rw inside the
 * triton jail, so these paths are directly readable and writable.
 *
 * Every category defaults to off. Media is large, and a backup written to
 * /media/internal doubles usage on the very volume it is copying from, so
 * including it has to be the user's explicit choice. getEstimate() exists so
 * the UI can show the cost before they make it.
 */
/*global Future, logger, mapFuture, fileUtil, prefs, require, getParent */

var userData = (function () {
    var that = {};
    var fs   = require('fs');
    var path = require('path');

    var MEDIA_ROOT = "/media/internal/";

    that.SERVICE_ID = "com.woce.backup.userdata";

    // Candidate directories per category. Only those that exist are used, so
    // the same list works across TouchPad, Pre 3 and Veer.
    var CATEGORIES = {
        photos:    { label: "Photos",    dirs: ["DCIM", "photos", "screencaptures", "wallpapers"] },
        videos:    { label: "Videos",    dirs: ["videos"] },
        music:     { label: "Music",     dirs: ["music"] },
        documents: { label: "Documents", dirs: ["documents"] },
        downloads: { label: "Downloads", dirs: ["downloads"] },
        ringtones: { label: "Ringtones", dirs: ["ringtones"] }
    };

    // Never worth copying: our own backup store (which would recurse), and the
    // scratch areas the platform leaves lying around.
    var EXCLUDED = [
        ".woce-backup",
        "webos-backups",
        "lost+found",
        ".Trash"
    ];

    var isExcluded = function (name) {
        for (var i = 0; i < EXCLUDED.length; i++) {
            if (name === EXCLUDED[i]) {
                return true;
            }
        }
        return false;
    };

    /**
     * Recursively collects file paths under dir. Returns absolute paths.
     *
     * Synchronous on purpose: node 0.2 has no readdir concurrency limit, and a
     * media tree can hold thousands of entries. Doing this async would open
     * every directory at once and exhaust file descriptors.
     */
    var walk = function (dir, out) {
        var entries;
        try {
            entries = fs.readdirSync(dir);
        } catch (err) {
            logger.warn("Unable to read", dir + ":", err.message);
            return out;
        }

        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            if (isExcluded(name)) {
                continue;
            }
            var full = path.join(dir, name);
            var stat;
            try {
                stat = fs.statSync(full);
            } catch (err) {
                continue;   // vanished between readdir and stat
            }
            if (stat.isDirectory()) {
                walk(full, out);
            } else if (stat.isFile()) {
                out.push(full);
            }
        }
        return out;
    };

    /**
     * Absolute paths of every file in the given category that exists on device.
     */
    that.getCategoryFiles = function (categoryId) {
        var category = CATEGORIES[categoryId];
        if (!category) {
            return [];
        }

        var files = [];
        category.dirs.forEach(function (dirName) {
            var dir = MEDIA_ROOT + dirName;
            try {
                if (fs.statSync(dir).isDirectory()) {
                    walk(dir, files);
                }
            } catch (err) {
                // category directory absent on this device, which is normal
            }
        });
        return files;
    };

    /**
     * Per-category file count and total bytes, for the "what to back up" UI.
     */
    that.getEstimate = function () {
        var future = prefs.getUserData();
        future.then(this, function (f) {
            var enabled = f.result;
            var categories = [];

            for (var id in CATEGORIES) {
                if (CATEGORIES.hasOwnProperty(id)) {
                    var files = that.getCategoryFiles(id);
                    var bytes = 0;
                    files.forEach(function (filePath) {
                        bytes += fileUtil.getSize(filePath);
                    });
                    categories.push({
                        id:      id,
                        label:   CATEGORIES[id].label,
                        enabled: enabled[id] === true,
                        count:   files.length,
                        bytes:   bytes
                    });
                }
            }
            f.result = { categories: categories };
        });
        return future;
    };

    /**
     * The preBackup half of the contract: the file list for every enabled
     * category. Absolute paths, so the engine copies them straight from
     * /media/internal without staging.
     */
    that.preBackup = function () {
        var future = prefs.getUserData();
        future.then(this, function (f) {
            var enabled = f.result;
            var files = [];
            var included = [];

            for (var id in CATEGORIES) {
                if (CATEGORIES.hasOwnProperty(id) && enabled[id] === true) {
                    var categoryFiles = that.getCategoryFiles(id);
                    logger.log("User data category", id, "contributes", categoryFiles.length, "files");
                    files = files.concat(categoryFiles);
                    included.push(id);
                }
            }

            f.result = {
                version:            1,
                description:        "User files (" + (included.join(", ") || "none") + ")",
                files:              files,
                // The category selection is the incremental key: change what is
                // selected and the engine re-evaluates instead of assuming the
                // previous file list still holds.
                incrementalKey:     { categories: included.join(",") },
                ignoreMissingFiles: true
            };
        });
        return future;
    };

    /**
     * The postRestore half. Files were backed up under their absolute paths, so
     * the engine has already written them back to /media/internal; all that is
     * left is to make sure the parent directories exist for any that did not.
     */
    that.postRestore = function (params) {
        var files = (params && params.files) || [];
        var dirs = {};
        files.forEach(function (filePath) {
            if (filePath.charAt(0) === '/') {
                dirs[getParent(filePath)] = true;
            }
        });

        var dirList = [];
        for (var dir in dirs) {
            if (dirs.hasOwnProperty(dir)) {
                dirList.push(dir);
            }
        }

        var future = mapFuture(dirList, function (dir) {
            return fileUtil.mkdirs(dir);
        });
        future.then(this, function (f) {
            var result = f.result;
            logger.log("Restored", files.length, "user files");
            f.result = {};
        });
        return future;
    };

    /**
     * True if any category is enabled, so the engine can skip the provider
     * entirely when there is nothing selected.
     */
    that.isEnabled = function () {
        var future = prefs.getUserData();
        future.then(this, function (f) {
            var enabled = f.result;
            var any = false;
            for (var id in CATEGORIES) {
                if (CATEGORIES.hasOwnProperty(id) && enabled[id] === true) {
                    any = true;
                }
            }
            f.result = any;
        });
        return future;
    };

    that.CATEGORIES = CATEGORIES;

    return that;
}());
