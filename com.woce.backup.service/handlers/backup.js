/* The backup engine.
 *
 * Ported from com.palm.service.backup/handlers/backup.js. The shape of the run
 * is unchanged, because the shape is the protocol:
 *
 *     for each registered service
 *         preBackup(tempDir)  -> a list of files
 *         for each file: checksum, compress, store under its checksum
 *         postBackup()
 *     write the manifest
 *     purge old manifests and any file nothing references
 *
 * What changed:
 *
 *   - Files go to a target (targets/), not Palm's storage server.
 *   - No encryption pass.
 *   - Files the jail cannot read are staged through the root helper, and
 *     recorded as skipped when the helper is absent. The stock service never
 *     needed this because it ran unjailed.
 *   - The metadata-server round trips at the start and end of a backup are
 *     gone; they were pure cloud bookkeeping.
 */
/*global Future, FILES_PATH, MANIFESTS_PATH, MANIFEST_ROOT, PalmCall, STAGE_ROOT,
  serviceCallTimeout, backup, dateUtil, eliminateDuplicates, fileUtil, isEmpty,
  isEmptyObject, logger, mapFuture, objectEquals, prefs, privileged, require,
  system, targets, tolerate, userData, withDeadline, withTimeout, zeroPad */

function BackupAssistant() {

    var fs = require("fs");

    var COMPRESSIBLE_EXTENSIONS = [".json", ".sql", ".db", ".txt", ".xml", ".vcf", ".ics"];

    var target;
    var storedFileMap;      // filename -> entry, for incremental dedup
    var startedBy;
    var isPrivileged;
    var skipped;            // [{ service, path, reason }]
    var stageDir;

    /* ------------------------------------------------------------- utilities */

    // Compressing a JPEG wastes CPU and grows the file. Only try where the
    // extension suggests text-ish content.
    var isCompressible = function (path) {
        for (var i = 0; i < COMPRESSIBLE_EXTENSIONS.length; i++) {
            if (path.endsWith(COMPRESSIBLE_EXTENSIONS[i])) {
                return true;
            }
        }
        return false;
    };

    // The path we actually read a file from: its staged copy if the jail could
    // not see the original, otherwise the original itself.
    var sourcePathOf = function (file, baseDir) {
        return file._source || fileUtil.getAbsolutePath(file.path, baseDir);
    };

    // Actually open the file. statSync only proves the entry exists, and the
    // two permissions are not the same: com.palm.appDataBackup returned paths
    // under /var/luna/preferences that stat cleanly and then fail the read with
    // EACCES, which took the whole service down with it.
    var isReadable = function (path) {
        var fd;
        try {
            fd = fs.openSync(path, "r");
            return true;
        } catch (err) {
            return false;
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch (ignored) {}
            }
        }
    };

    /**
     * Manifest entries must not carry our internal bookkeeping, so strip the
     * underscore-prefixed keys before the manifest is written.
     */
    var cleanFileDescriptor = function (file) {
        var ret = {};
        for (var key in file) {
            if (file.hasOwnProperty(key) && key.charAt(0) !== "_") {
                ret[key] = file[key];
            }
        }
        return ret;
    };

    /* -------------------------------------------------------- file transfers */

    var scanFile = function (file, baseDir, isFinal) {
        var path = isFinal ? backup.getFinalPath(file, baseDir) : sourcePathOf(file, baseDir);
        var size = fileUtil.getSize(path);

        var future = fileUtil.getChecksum(path);
        future.then(this, function (f) {
            var checksum = f.result;
            if (isFinal) {
                file.finalSize = size;
                file.finalChecksum = checksum;
            } else {
                file.origSize = size;
                file.origChecksum = checksum;
            }
            f.result = {};
        });
        return future;
    };

    var scanFiles = function (files, baseDir, isFinal) {
        return mapFuture(files, function (file) {
            return scanFile(file, baseDir, isFinal);
        });
    };

    var compressFile = function (file, baseDir) {
        var future = fileUtil.gzip(sourcePathOf(file, baseDir), backup.WORKING_COMPRESSED_FILENAME);
        future.then(this, function (f) {
            var result = f.result;
            file.compressed = true;
            f.result = {};
        });
        return future;
    };

    var storeFile = function (file, baseDir, progressIncrement) {
        var storedName = backup.getServerFilename(file);
        backup.setProgressIncrementPerByte(progressIncrement / Math.max(1, file.finalSize));

        var future = target.putFile(FILES_PATH + storedName,
            backup.getFinalPath(file, baseDir), file.finalChecksum);
        future.then(this, function (f) {
            try {
                var result = f.result;
                storedFileMap[storedName] = {
                    "Content-Length": file.finalSize,
                    Etag: file.finalChecksum
                };
                f.result = result;
            } finally {
                backup.setProgressIncrementPerByte(0);
            }
        });
        return future;
    };

    /**
     * Compresses and stores one file, unless the target already holds it.
     *
     * The early return is the whole of incremental backup: an unchanged file
     * hashes to a name that is already present, so it is referenced by the new
     * manifest without being copied.
     */
    var backupFile = function (file, baseDir, progressIncrement) {
        var compress = isCompressible(file.path);
        var storedName = backup.getServerFilename(file, compress);
        var existing = storedFileMap[storedName];

        if (existing) {
            backup.incrementProgress(progressIncrement);
            file.compressed = compress;
            file.finalSize = existing["Content-Length"];
            file.finalChecksum = existing.Etag;
            file["new"] = false;
            return new Future({});
        }

        var future = new Future();
        if (compress) {
            future.nest(compressFile(file, baseDir));
        } else {
            future.result = {};
        }
        future.then(this, function (f) {
            var result = f.result;
            backup.incrementProgress(progressIncrement * 0.2);
            f.nest(scanFile(file, baseDir, true));
        });
        future.then(this, function (f) {
            var result = f.result;
            backup.incrementProgress(progressIncrement * 0.1);
            file["new"] = true;
            f.nest(storeFile(file, baseDir, progressIncrement * 0.7));
        });
        return future;
    };

    var backupFiles = function (files, baseDir, progressIncrement) {
        var totalOrigSize = 0;
        files.forEach(function (file) {
            totalOrigSize += (file.origSize || 0);
        });

        var future;
        if (files.length === 0) {
            future = new Future({});
            future.then(this, function (f) {
                var result = f.result;
                backup.incrementProgress(progressIncrement);
                f.result = true;
            });
        } else {
            future = mapFuture(files, function (file) {
                // Weight by size so the bar tracks work done, not file count.
                var share = totalOrigSize > 0
                    ? progressIncrement * (file.origSize || 0) / totalOrigSize
                    : progressIncrement / files.length;
                return backupFile(file, baseDir, share);
            });
        }

        future.then(this, function (f) {
            var result = f.result;
            f.nest(fileUtil.rmIfExists(backup.WORKING_COMPRESSED_FILENAME));
        });
        return future;
    };

    /* ------------------------------------------------------ service dispatch */

    /**
     * Invokes a registration callback, in-process for our user-data provider
     * and over the bus for everything else.
     */
    var callCallback = function (serviceName, method, params, descriptor) {
        if (descriptor && descriptor.inProcess) {
            if (serviceName === userData.SERVICE_ID) {
                return userData[method](params);
            }
            throw new Error("No in-process provider for " + serviceName);
        }
        // Bounded. com.palm.browserServer accepted preBackup and never
        // answered, which parked the whole run — a service that will not talk
        // has to become a skipped service, not a stuck backup.
        return withDeadline(system.palmcall(serviceName, method, params),
            serviceCallTimeout(serviceName), serviceName + "/" + method);
    };

    /**
     * Turns the paths a service returned into file descriptors, staging any
     * that the jail cannot read.
     */
    var resolveFiles = function (serviceName, paths, tempDir, ignoreMissing) {
        var direct = [];      // readable as-is
        // Each entry is { stagePath, manifestPath }: stagePath is the real
        // filesystem location the helper reads bytes from, manifestPath is
        // what gets recorded on the descriptor (and, for absolute paths, is
        // where restore puts the file back — for a relative name inside
        // tempDir there is no real "back", so it stays the name the service
        // gave us, same as the direct-read case below).
        var needsStaging = [];

        paths.forEach(function (filename) {
            if (isEmpty(filename)) {
                logger.warn(serviceName, "returned an empty filename");
                return;
            }
            if (system.isReadOnlyPartition(filename)) {
                // Shipped with the OS; restoring it would fail anyway.
                return;
            }

            var absolute = fileUtil.getAbsolutePath(filename, tempDir);
            if (isReadable(absolute)) {
                direct.push({ path: filename });
                return;
            }

            if (filename.charAt(0) === "/") {
                // Absolute and invisible to us: outside the jail, so only the
                // root helper can reach it.
                needsStaging.push({ stagePath: filename, manifestPath: filename });
            } else if (isPrivileged) {
                // Relative, inside tempDir, and still unreadable: a call
                // routed through the root helper (anything gated on db8's
                // admin role) runs as root, outside the jail, and a file it
                // writes there can come out with permissions our jailed
                // process cannot open even though the directory itself is
                // jail-visible. Not necessarily missing — try staging before
                // giving up on it.
                needsStaging.push({ stagePath: absolute, manifestPath: filename });
            } else if (!ignoreMissing) {
                var err = new Error(serviceName + " asked to back up a missing file: " + filename);
                err.serviceId = serviceName;
                throw err;
            } else {
                logger.log("Ignoring missing file:", filename);
            }
        });

        if (needsStaging.length === 0) {
            return new Future(direct);
        }

        if (!isPrivileged) {
            logger.warn("Skipping", needsStaging.length, "file(s) for", serviceName,
                "- outside the jail and no root helper installed");
            needsStaging.forEach(function (entry) {
                skipped.push({ service: serviceName, path: entry.manifestPath, reason: "not-privileged" });
            });
            return new Future(direct);
        }

        var future = privileged.stage(
            needsStaging.map(function (entry) { return entry.stagePath; }),
            stageDir);
        future.then(this, function (f) {
            if (f.exception) {
                logger.warn("Staging failed for", serviceName + ":", f.exception.message);
                needsStaging.forEach(function (entry) {
                    skipped.push({ service: serviceName, path: entry.manifestPath, reason: "stage-failed" });
                });
                f.result = direct;
                return;
            }

            var result = f.result;
            needsStaging.forEach(function (entry) {
                var stagedName = result.staged[entry.stagePath];
                if (stagedName) {
                    // _source is where we read the bytes from now;
                    // manifestPath is what the descriptor records.
                    direct.push({ path: entry.manifestPath, _source: stageDir + stagedName });
                } else {
                    skipped.push({ service: serviceName, path: entry.manifestPath, reason: "unreadable" });
                }
            });
            f.result = direct;
        });
        return future;
    };

    /**
     * Calls preBackup and stores everything it hands back. Recurses while the
     * service reports hasMore, which is how a service larger than the temp
     * window pages its data out to us.
     */
    var callPreBackup = function (serviceName, descriptor, serviceManifest, tempDir, progressIncrement) {
        var hasMore;
        var newFiles;
        var alreadyDone = serviceManifest.files.length;

        var future = new Future();
        future.nest(callCallback(serviceName, descriptor.preBackup, {
            incrementalKey: serviceManifest.incrementalKey,
            maxTempBytes:   backup.TEMP_DIR_SIZE,
            tempDir:        tempDir
        }, descriptor));

        future.then(this, function (f) {
            var result = f.result;
            serviceManifest.version = result.version;
            serviceManifest.description = result.description;

            hasMore = result.hasMore === true;
            if (hasMore) {
                progressIncrement /= 2.0;
                if (!result.files || result.files.length === 0) {
                    throw new Error(serviceName + " cannot create a backup within " +
                        backup.TEMP_DIR_SIZE + " bytes");
                }
                if (objectEquals(result.incrementalKey, serviceManifest.incrementalKey)) {
                    throw new Error(serviceName + " reported hasMore without advancing incrementalKey");
                }
            }
            serviceManifest.incrementalKey = result.incrementalKey;
            backup.incrementProgress(progressIncrement * 0.1);

            f.nest(resolveFiles(serviceName,
                eliminateDuplicates(result.files || []),
                tempDir,
                result.ignoreMissingFiles === true));
        });
        future.then(this, function (f) {
            var resolved = f.result;
            resolved.forEach(function (file) {
                serviceManifest.files.push(file);
            });
            newFiles = serviceManifest.files.slice(alreadyDone);
            f.nest(scanFiles(newFiles, tempDir, false));
        });
        future.then(this, function (f) {
            var result = f.result;
            backup.incrementProgress(progressIncrement * 0.1);
            f.nest(backupFiles(newFiles, tempDir, progressIncrement * 0.8));
        });
        future.then(this, function (f) {
            var result = f.result;
            for (var i = 0; i < newFiles.length; i++) {
                serviceManifest.size += (newFiles[i].finalSize || 0);
            }
            // Clear the shared temp window before the service refills it.
            f.nest(fileUtil.rmFiles(tempDir));
        });
        future.then(this, function (f) {
            var result = f.result;
            if (hasMore) {
                f.nest(callPreBackup(serviceName, descriptor, serviceManifest, tempDir, progressIncrement));
            } else {
                f.result = {};
            }
        });
        return future;
    };

    /**
     * Backs up one service and appends its section to the manifest.
     */
    var backupService = function (serviceName, services, manifest, tempDir, progressIncrement) {
        var descriptor = services[serviceName];
        var serviceManifest = { service: serviceName, size: 0, files: [] };

        logger.log("Backing up", serviceName);

        var future = new Future();
        if (descriptor.preBackup) {
            future.nest(callPreBackup(serviceName, descriptor, serviceManifest, tempDir,
                progressIncrement * 0.9));
        } else {
            backup.incrementProgress(progressIncrement * 0.9);
            future.result = {};
        }
        future.then(this, function (f) {
            var result = f.result;
            if (descriptor.postBackup) {
                f.nest(callCallback(serviceName, descriptor.postBackup, {}, descriptor));
            } else {
                f.result = {};
            }
        });
        future.then(this, function (f) {
            var result = f.result;
            backup.incrementProgress(progressIncrement * 0.1);
            if (descriptor.preBackup) {
                serviceManifest.files = serviceManifest.files.map(cleanFileDescriptor);
                manifest.services.push(serviceManifest);
            }
            f.result = {};
        });
        future.then(this, function (f) {
            if (!f.exception) {
                var result = f.result;
                f.result = result;
                return;
            }

            var err = f.exception;
            // A cancel must unwind the whole run, never be absorbed as one
            // service failing.
            if (backup.isCanceled()) {
                f.exception = err;
                return;
            }
            if (backup.TOLERANT_MODE && backup.REQUIRED_SERVICES.indexOf(serviceName) === -1) {
                logger.error("Skipping", serviceName + ":", err.message);
                skipped.push({ service: serviceName, reason: "failed", error: err.message });
                f.result = {};
            } else {
                logger.error("BLAME:", serviceName);
                f.exception = err;
            }
        });
        return future;
    };

    var getBackupServiceList = function (services) {
        var ret = [];
        for (var serviceName in services) {
            if (services.hasOwnProperty(serviceName)) {
                var descriptor = services[serviceName];
                if (descriptor.preBackup || descriptor.postBackup) {
                    ret.push(serviceName);
                }
            }
        }
        return ret;
    };

    /* ------------------------------------------------------------- manifests */

    var getManifestNameSuffix = function (manifest) {
        return manifest.deviceInfo.nduId ? "-" + manifest.deviceInfo.nduId : "";
    };

    var getNextManifestName = function (previousName, manifest) {
        var next = 1;
        if (previousName) {
            next = parseInt(previousName, 10) + 1;
        }
        return zeroPad(next, 6) + getManifestNameSuffix(manifest);
    };

    /* ------------------------------------------------------------ the backup */

    /**
     * Runs a backup, returning its own future.
     *
     * Building a separate chain rather than appending to the caller's matters:
     * `then` callbacks are a FIFO queue, so a handler the caller registered
     * before calling in here would run in the middle of this chain rather than
     * after it — and the error handler that sets status to Failed would have
     * already passed by the time anything could fail.
     */
    var doBackup = function (full) {
        var future = new Future();

        backup.setStatusPreparing();
        skipped = [];

        var manifest = {
            version:    1,
            osVersion:  {},
            dbVersion:  backup.DB_VERSION,
            started:    dateUtil.formatDateRfc1123(new Date()),
            finished:   null,
            type:       full ? "full" : "incremental",
            deviceId:   null,
            size:       null,
            deviceInfo: {},
            deviceStatus: { start: null, finish: null },
            // woce-backup additions: what could not be captured, and what was
            // installed at the time. Neither exists in a stock manifest.
            skipped:    [],
            packages:   [],
            services:   []
        };

        var manifestName;
        var tempDir;
        var tempDirFuture;
        var preferences;
        var packageFiles;   // [{path}], the .ipks archivePackages actually found

        future.nest(prefs.get());
        future.then(this, function (f) {
            preferences = f.result;
            f.nest(tolerate(privileged.isAvailable(), false));
        });
        future.then(this, function (f) {
            isPrivileged = f.result === true;
            logger.log("Privileged mode:", isPrivileged);
            f.nest(targets.getCurrent());
        });
        future.then(this, function (f) {
            target = f.result;
            f.nest(target.isAvailable());
        });
        future.then(this, function (f) {
            var available = f.result;
            if (!available) {
                var err = new Error("Backup destination is not writable: " + target.getDescription());
                err.type = "TARGET";
                throw err;
            }
            // Per-run staging area, so a crashed run cannot leave files that a
            // later run mistakes for its own.
            stageDir = STAGE_ROOT + new Date().getTime() + "/";
            f.nest(fileUtil.mkdirs(stageDir));
        });
        future.then(this, function (f) {
            var result = f.result;
            tempDirFuture = system.getTempDir(backup.TEMP_DIR_SIZE);
            f.nest(tempDirFuture);
        });
        future.then(this, function (f) {
            tempDir = f.result;
            logger.log("Temp dir:", tempDir);
            // Device metadata is recorded for troubleshooting; none of it is
            // worth failing a backup over, so each call absorbs its own error.
            logger.log("Stage: device name");
            f.nest(tolerate(system.getDeviceName(), ""));
        });
        future.then(this, function (f) {
            manifest.deviceInfo.deviceName = f.result;
            logger.log("Stage: device status");
            // Short budget: this is troubleshooting metadata only, and on a
            // TouchPad one of its two calls never answers. Waiting the full
            // tolerate window would add 20s of dead time to every backup.
            f.nest(withTimeout(system.getDeviceStatus(), 4000, null));
        });
        future.then(this, function (f) {
            manifest.deviceStatus.start = f.result;
            backup.setStatusPreparing();
            // getNduId reads /dev/nduid, which works from inside the jail.
            // The richer device profile needs com.palm.deviceprofile, which is
            // private-bus only — tolerated, since everything it adds
            // (hardwareType, model, OS version) is descriptive. The nduId is
            // the part that matters: manifests are named after it.
            logger.log("Stage: nduId");
            f.nest(tolerate(system.getNduId(), null));
        });
        future.then(this, function (f) {
            manifest.deviceInfo.nduId = f.result || backup.UNKNOWN_NDUID;
            logger.log("Stage: device profile, nduId =", manifest.deviceInfo.nduId);
            f.nest(tolerate(system.getDeviceProfile(), {}));
        });
        future.then(this, function (f) {
            var deviceInfo = f.result || {};

            manifest.deviceId = isEmpty(deviceInfo.deviceId)
                ? manifest.deviceInfo.nduId : deviceInfo.deviceId;
            manifest.osVersion.softwareVersion = deviceInfo.softwareVersion;
            manifest.deviceInfo.hardwareType   = deviceInfo.hardwareType;
            manifest.deviceInfo.deviceModel    = deviceInfo.deviceModel;

            // tolerate() only logs on failure, so a silent success and a
            // silent "the private bus swallowed it" look identical in the
            // log. Say which one happened.
            logger.log("Device profile:", isEmptyObject(deviceInfo)
                ? "unavailable, using nduId only"
                : "hardwareType=" + deviceInfo.hardwareType +
                    " deviceModel=" + deviceInfo.deviceModel);

            logger.log("Stage: syncing manifests");
            f.nest(backup.syncManifests(target));
        });
        future.then(this, function (f) {
            var lastManifestName = f.result;
            manifestName = getNextManifestName(lastManifestName, manifest);
            logger.log("Writing backup as", manifestName);
            backup.setStatusPreparing();

            // A full backup ignores what is already stored and re-copies
            // everything; an incremental one reuses it.
            if (full) {
                f.result = {};
            } else {
                f.nest(backup.getStoredFileMap(target));
            }
        });
        future.then(this, function (f) {
            storedFileMap = full ? {} : (f.result || {});
            if (!full && isEmptyObject(storedFileMap)) {
                // Nothing stored to build on, so this is a full backup whatever
                // the caller asked for.
                manifest.type = "full";
            }
            logger.log("Stage: loading registered services");
            f.nest(backup.loadRegisteredServices());
        });
        future.then(this, function (f) {
            var services = f.result;
            backup.setStatusInProgress();

            var serviceList = getBackupServiceList(services);
            if (serviceList.length === 0) {
                throw new Error("No services are registered for backup");
            }
            var progressIncrement = 80.0 / serviceList.length;
            logger.log("Backing up", serviceList.length, "service(s)");

            f.nest(mapFuture(serviceList, function (serviceName) {
                return backupService(serviceName, services, manifest, tempDir, progressIncrement);
            }));
        });
        future.then(this, function (f) {
            var result = f.result;
            var size = 0;
            manifest.services.forEach(function (service) {
                size += service.size;
            });
            manifest.size = size;
            manifest.skipped = skipped;
            f.nest(tolerate(system.getDeviceStatus(), null));
        });
        future.then(this, function (f) {
            manifest.deviceStatus.finish = f.result;
            backup.incrementProgress(5);

            // Record what was installed. The App Catalog is gone, so a restore
            // cannot re-download anything on its own — but the actual installer
            // for each app is archived below when it can be found, so most
            // restores need nothing from the App Catalog at all.
            if (preferences.includePackages && isPrivileged) {
                // Not tolerate()'s generic 20s: enumerating installed packages
                // is genuinely slow on this hardware, and privileged.js already
                // gives the helper's own job a 60s budget for it - the blanket
                // 20s cap was silently cutting that off before it could ever be
                // used, every single run.
                f.nest(withTimeout(privileged.listInstalledApps(), 60000, { packages: [] }));
            } else {
                f.result = { packages: [] };
            }
        });
        future.then(this, function (f) {
            var result = f.result;
            manifest.packages = (result && result.packages) || [];
            backup.incrementProgress(5);

            if (manifest.packages.length === 0 || !isPrivileged) {
                f.result = { archived: [], archivedDirs: [] };
                return;
            }
            // Best-effort: only finds an .ipk if Preware/WOSQI's download cache
            // still has it. Whatever that misses, the helper falls back to
            // archiving the installed app directory itself (archivedDirs) -
            // whatever even that misses stays list-only, same as before
            // either of these existed.
            f.nest(withTimeout(
                privileged.archivePackages(manifest.packages, stageDir + "packages/"),
                60000, { archived: [], archivedDirs: [] }));
        });
        future.then(this, function (f) {
            var result = f.result;
            var archivedIds = (result && result.archived) || [];
            var archivedDirIds = (result && result.archivedDirs) || [];
            var archivedSet = {};
            archivedIds.forEach(function (id) { archivedSet[id] = true; });
            var archivedDirSet = {};
            archivedDirIds.forEach(function (id) { archivedDirSet[id] = true; });
            manifest.packages.forEach(function (pkg) {
                pkg.archived = archivedSet[pkg.id] === true;
                pkg.dirBackedUp = archivedDirSet[pkg.id] === true;
            });
            backup.incrementProgress(5);

            if (archivedIds.length === 0 && archivedDirIds.length === 0) {
                packageFiles = [];
                f.result = {};
                return;
            }
            packageFiles = archivedIds.map(function (id) { return { path: id + ".ipk" }; })
                .concat(archivedDirIds.map(function (id) { return { path: id + "-app.tar.gz" }; }));
            f.nest(scanFiles(packageFiles, stageDir + "packages/", false));
        });
        future.then(this, function (f) {
            var result = f.result;
            if (packageFiles.length === 0) {
                f.result = {};
                return;
            }
            f.nest(backupFiles(packageFiles, stageDir + "packages/", 5));
        });
        future.then(this, function (f) {
            var result = f.result;
            var byPath = {};
            packageFiles.forEach(function (file) {
                byPath[file.path] = file;
                manifest.size += (file.finalSize || 0);
            });
            manifest.packages.forEach(function (pkg) {
                if (pkg.archived) {
                    pkg.file = cleanFileDescriptor(byPath[pkg.id + ".ipk"]);
                }
                if (pkg.dirBackedUp) {
                    pkg.dirFile = cleanFileDescriptor(byPath[pkg.id + "-app.tar.gz"]);
                }
            });
            backup.incrementProgress(5);
            manifest.finished = dateUtil.formatDateRfc1123(new Date());
            // Past here the backup exists; everything below is tidy-up, so it
            // is tolerated rather than allowed to fail the run.
            f.nest(backup.storeManifest(target, manifest, manifestName));
        });
        future.then(this, function (f) {
            var result = f.result;
            backup.incrementProgress(5);
            f.nest(tolerate(backup.purge(target, preferences.manifestsToKeep), null));
        });
        future.then(this, function (f) {
            var result = f.result;
            f.nest(tolerate(fileUtil.rmFiles(stageDir, true), null));
        });
        future.then(this, function (f) {
            var result = f.result;
            try {
                logger.log("Backup complete:", manifestName, manifest.size, "bytes,",
                    skipped.length, "skipped");
                backup.setStatusComplete({
                    manifestName: manifestName,
                    size:         manifest.size,
                    skipped:      skipped.length
                });
                f.result = {
                    returnValue:  true,
                    STATUS:       "Complete",
                    manifestName: manifestName,
                    size:         manifest.size,
                    skipped:      skipped
                };
            } finally {
                if (tempDirFuture) {
                    PalmCall.cancel(tempDirFuture);
                }
            }
        });

        return future;
    };

    /* ---------------------------------------------------------------- entry */

    var handleError = function (err) {
        var future = new Future();
        logger.error("Backup failed:", err.message);

        // Best-effort cleanup; the failure we report is the original one.
        var cleanup = stageDir ? fileUtil.rmFiles(stageDir, true) : new Future({});
        cleanup.then(this, function (f) {
            var result = f.result;

            if (!backup.isCanceled()) {
                backup.setStatusFailed(err.type, err.message);
            }
            f.exception = err;
        });
        future.nest(cleanup);
        return future;
    };

    this.run = function (future) {
        var args = this.controller.args;
        var full = args.full === true;

        logger.log("startBackup, type=" + (full ? "full" : "incremental"));

        if (backup.isRunning()) {
            logger.log("A backup is already running");
            future.result = { returnValue: true, STATUS: backup.getStatus().STATUS };
            return;
        }

        startedBy = system.getStartedBy(this.controller.message);
        logger.log("Started by", startedBy);

        var chain = prefs.isEnabled();
        chain.then(this, function (f) {
            var enabled = f.result;
            // A manual "Back Up Now" is an explicit instruction, so it runs
            // even when scheduled backups are off. Only the scheduled path
            // honours the toggle.
            if (!enabled && args.scheduled === true) {
                logger.log("Skipping scheduled backup, backup is turned off");
                f.result = { returnValue: true, skipped: true };
            } else {
                f.nest(doBackup(full));
            }
        });
        chain.then(this, function (f) {
            if (f.exception) {
                var err = f.exception;
                f.nest(handleError(err));
            } else {
                var result = f.result;
                f.result = result;
            }
        });
        future.nest(chain);
    };
}

/**
 * Activity Manager callback for the daily backup.
 *
 * Completing the activity with restart=true is what re-arms the schedule; drop
 * that and the daily backup runs exactly once.
 */
function ScheduledBackupAssistant() {
    this.run = function (future) {
        logger.log("Scheduled backup firing");
        var assistant = new BackupAssistant();
        assistant.controller = this.controller;
        this.controller.args.scheduled = true;
        assistant.run(future);
    };

    this.complete = function (activity) {
        if (activity._owner) {
            return activity.complete(true);
        }
        return new Future({});
    };
}
