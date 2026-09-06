/* Top-level service assistant.
 *
 * Lives for the whole service process, so anything that must survive between
 * commands within one activation belongs here. Backup state itself lives in
 * util/backup-service.js because an in-flight backup outlives the command
 * assistant that started it.
 */
/*global backup, logger, fileUtil, platform, WORK_ROOT, MANIFEST_ROOT, JOB_ROOT, STAGE_ROOT */

// Rewritten by build.sh on every build. Logged at startup so the device
// log says which code is actually running — a reinstall does not restart a
// live node service, so it is easy to spend an evening debugging the
// previous build.
var SERVICE_BUILD = "3.1.1+20260829-161700";

function ServiceAssistant() {
}

ServiceAssistant.prototype.setup = function () {
    logger.log("woce-backup service starting, build", SERVICE_BUILD);
    // Worth one line at startup: it decides every platform service name
    // used below, so a manifest with an empty battery or connection list
    // can be read against what this device actually resolved to.
    logger.log("Platform:", platform.describe());

    // Create the working tree up front. Every later path assumes it exists, and
    // doing it once here keeps the mkdirs out of the hot paths.
    var future = fileUtil.mkdirs(MANIFEST_ROOT);
    future.then(this, function (f) {
        var result = f.result;
        f.nest(fileUtil.mkdirs(JOB_ROOT));
    });
    future.then(this, function (f) {
        var result = f.result;
        f.nest(fileUtil.mkdirs(STAGE_ROOT));
    });
    future.then(this, function (f) {
        if (f.exception) {
            logger.error("Unable to create the working tree:", f.exception.message);
        }
        // Create the dynamic-service kind now rather than on first register().
        // Nothing on this platform registers dynamically today, so without it
        // every backup and restore logged "kind not registered" - a permanent
        // error line for a condition that is entirely normal.
        f.nest(backup.ensureDynamicServiceKind());
    });
    future.then(this, function (f) {
        if (f.exception) {
            logger.warn("Could not ensure the dynamic service kind:", f.exception.message);
        }
        f.result = true;
    });
    return future;
};

ServiceAssistant.prototype.cleanup = function () {
    logger.log("woce-backup service shutting down");
};
