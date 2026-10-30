/* Saved passwords, presented as a backup provider.
 *
 * Account passwords do not live in db8 and are not files on disk: they are in
 * com.palm.keymanager's store, encrypted with a master key at
 * /var/palm/keystore/key that is generated per device. Backing up that store
 * verbatim restores to nothing usable on a wiped or replacement handset, which
 * is why a restore has historically brought accounts back and then asked for
 * every password again.
 *
 * keymanager therefore exports its store re-encrypted under a passphrase the
 * user supplies - the one thing that can cross a device boundary because they
 * carry it themselves:
 *
 *     com.palm.keymanager/exportKeystore {passphrase}
 *       -> {count, unreadable, keystore}
 *     com.palm.keymanager/importKeystore {passphrase, keystore, overwrite}
 *       -> {imported, skipped, failed}
 *
 * Plaintext never leaves keymanager: what this module handles is already
 * ciphertext. That matters, because a woce backup is deliberately unencrypted
 * so it survives a Doctor and moves between devices, and it sits on
 * /media/internal where USB mass storage can read it.
 *
 * Presented through the same preBackup/postRestore contract a registered
 * service uses, so the engine needs no special case: preBackup stages one JSON
 * file into tempDir and names it, postRestore hands it back.
 *
 * Off by default, and it does nothing at all without a passphrase - see
 * setPassphrase. Forgetting the passphrase costs nothing that was not already
 * lost: the credentials do not restore and the user re-enters passwords, which
 * is exactly what happened before this existed.
 */
/*global Future, logger, fileUtil, platform, prefs, require, system, tolerate */

var credentials = (function () {
    var that = {};
    var fs   = require('fs');
    var path = require('path');

    that.SERVICE_ID = "com.palm.backup.credentials";
    that.CATEGORY_ID = "passwords";
    that.CATEGORY_LABEL = "Saved passwords";

    // The staged filename, and what restore looks for. Deliberately not a
    // ".json" the user might open and mistake for readable: it is ciphertext.
    var STAGED_NAME = "keystore-export";
    that.STAGED_NAME = STAGED_NAME;

    // Held for the duration of one run only. Never written to prefs, never in
    // the manifest, never logged - a passphrase that outlived the operation it
    // was given for would be a worse leak than the one this feature closes.
    var passphrase = null;

    /**
     * Give the current run its passphrase, or clear it.
     *
     * startBackup and restore pass whatever the app collected; everything else
     * leaves it null, which is what makes the category a no-op unless the user
     * has actually been asked.
     */
    that.setPassphrase = function (value) {
        passphrase = (typeof value === "string" && value.length > 0) ? value : null;
        lastError = null;
    };

    /* Whether this run was given a passphrase. The backup engine asks, so it
     * can tell "skipped: no passphrase" (carry the last export forward) from
     * an export that was tried and failed (do not).
     */
    that.hasPassphrase = function () {
        return passphrase !== null;
    };

    /* The last credentials failure of this run, or null.
     *
     * postRestore's own return value goes nowhere - the engine discards what a
     * service's postRestore replies with - so a wrong passphrase would
     * otherwise be logged and then vanish, leaving the user a "successful"
     * restore with no passwords and no explanation. That is the one restore
     * failure they can actually act on, so it is kept here and folded into the
     * restore's final status by handlers/restore.js.
     */
    var lastError = null;

    that.getLastError = function () {
        return lastError;
    };

    /**
     * Strip the passphrase out of anything on its way to a log or a manifest.
     *
     * system.palmcall builds its error messages by interpolating the call and
     * its arguments, so a failed exportKeystore comes back as
     *
     *     palm://com.palm.keymanager/exportKeystore {"passphrase":"..."}: Denied
     *
     * and that text was going straight into the manifest's service description
     * - which is stored in the backup, in the clear, on USB-readable storage.
     * Caught by a real run on device. Redacting the one secret we hold is
     * exact; sanitising the message generally would be guesswork.
     */
    var redact = function (text) {
        var value = String(text === undefined || text === null ? "" : text);
        if (!passphrase) {
            return value;
        }
        return value.split(passphrase).join("********");
    };

    /**
     * True when the user has switched the category on. Passphrase state is not
     * consulted here: the engine asks this to decide whether to include the
     * provider at all, and a missing passphrase is reported as a skip with a
     * reason rather than by silently pretending the category was off.
     */
    that.isEnabled = function () {
        var future = prefs.getUserData();
        future.then(this, function (f) {
            var enabled = f.result;
            f.result = enabled[that.CATEGORY_ID] === true;
        });
        return future;
    };

    var keymanagerCall = function (method, params) {
        return system.palmcall(platform.service("keymanager"), method, params);
    };

    /**
     * preBackup: ask keymanager for its store, write the envelope into tempDir
     * and name it. One file, a few kilobytes.
     */
    that.preBackup = function (params) {
        var tempDir = (params && params.tempDir) || "";
        var future = new Future();

        if (!passphrase) {
            // Not an error: the category can be on while this particular run
            // was started without a passphrase, e.g. the scheduled daily
            // backup, which has nobody to ask.
            logger.log("Passwords category is on but no passphrase was given; skipping");
            future.result = {
                version: "1.0",
                description: "Saved passwords (skipped: no passphrase)",
                files: []
            };
            return future;
        }

        var call = keymanagerCall("exportKeystore", { passphrase: passphrase });
        call.then(this, function (f) {
            var result;
            try {
                result = f.result;
            } catch (err) {
                // A keymanager that will not export must not sink the whole
                // backup - everything else in the run is still worth having.
                logger.error("Could not export the keystore:", redact(err.message || err));
                lastError = redact(err.message || err);
                f.result = {
                    version: "1.0",
                    description: "Saved passwords (failed)",
                    files: []
                };
                return;
            }

            if (!result || !result.keystore) {
                // returnValue true with nothing in it. Guarded because
                // JSON.stringify(undefined) is undefined, and writeFileSync
                // would throw on that rather than say what went wrong.
                logger.error("keymanager reported success but returned no keystore");
                lastError = "The keystore export came back empty.";
                f.result = {
                    version: "1.0",
                    description: "Saved passwords (failed)",
                    files: []
                };
                return;
            }

            var target = fileUtil.getAbsolutePath(STAGED_NAME, tempDir);
            try {
                fs.writeFileSync(target, JSON.stringify(result.keystore), "utf8");
            } catch (writeErr) {
                logger.error("Could not stage the keystore export:", redact(writeErr.message));
                lastError = "The saved-passwords file could not be written.";
                f.result = {
                    version: "1.0",
                    description: "Saved passwords (failed to stage)",
                    files: []
                };
                return;
            }

            logger.log("Staged", result.count, "credential(s) for backup;",
                (result.unreadable || []).length, "unreadable");

            f.result = {
                version: "1.0",
                description: "Saved passwords, encrypted with your backup passphrase",
                // Relative to tempDir, so the engine stores it as a plain file
                // and hands the same name back at restore.
                files: [STAGED_NAME]
            };
        });

        future.nest(call);
        return future;
    };

    /**
     * postRestore: read the envelope back and let keymanager decrypt it under
     * the passphrase the user just gave.
     *
     * A wrong passphrase fails here and is reported, not swallowed. It is the
     * one failure in a restore the user can actually do something about.
     */
    that.postRestore = function (params) {
        var files = (params && params.files) || [];
        var tempDir = (params && params.tempDir) || "";
        var future = new Future();
        var envelope;

        var staged = null;
        files.forEach(function (name) {
            if (name === STAGED_NAME || path.basename(name) === STAGED_NAME) {
                staged = name;
            }
        });

        if (!staged) {
            future.result = {};
            return future;
        }
        if (!passphrase) {
            logger.warn("A keystore export was restored but no passphrase was given; " +
                "passwords will have to be re-entered");
            lastError = "No passphrase was given, so saved passwords were not restored.";
            future.result = {};
            return future;
        }

        try {
            envelope = JSON.parse(
                fs.readFileSync(fileUtil.getAbsolutePath(staged, tempDir), "utf8")
            );
        } catch (err) {
            logger.error("Could not read the restored keystore export:", err.message);
            lastError = "The saved-passwords file in this backup could not be read.";
            future.result = {};
            return future;
        }

        var call = keymanagerCall("importKeystore", {
            passphrase: passphrase,
            keystore: envelope,
            // Never replace a credential that already works on this device with
            // an older one out of a backup.
            overwrite: false
        });

        call.then(this, function (f) {
            var result;
            try {
                result = f.result;
            } catch (err) {
                logger.error("Could not import the keystore:", redact(err.message || err));
                // Reported to the caller so restore can tell the user the
                // passphrase was wrong, rather than finishing quietly with no
                // passwords restored and no explanation.
                lastError = redact(err.message || err);
                f.result = {};
                return;
            }
            logger.log("Restored", result.imported, "credential(s);",
                result.skipped, "already present,", (result.failed || []).length, "failed");
            f.result = {
                credentialsImported: result.imported,
                credentialsSkipped: result.skipped
            };
        });

        future.nest(call);
        return future;
    };

    return that;
}());
