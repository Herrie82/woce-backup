/* Restore options the user sets in the app.
 *
 * Today that is one switch, restoreUserApps: whether a restore reinstalls the
 * applications listed in the backup's package list. It is off by default,
 * because reinstalling an app runs its opkg maintainer scripts (or unpacks its
 * tree) as root from a backup that nothing authenticates. restore.js reads
 * the stored value through prefs.get(); this is the only way the UI changes it.
 */
/*global logger, prefs */

var restoreOptions = (function () {
    var that = {};

    // Only these keys are accepted, and each must be a real boolean. Anything
    // else is refused rather than coerced, so a typo in a caller cannot turn
    // app reinstall on (the string "false" is truthy).
    var KEYS = { restoreUserApps: true };

    that.fromPrefs = function (preferences) {
        return { restoreUserApps: !!(preferences && preferences.restoreUserApps === true) };
    };

    /**
     * Returns the props to store for the given call arguments, or throws.
     */
    that.validate = function (args) {
        var props = {};
        var count = 0;
        var key;

        if (!args || typeof args !== "object") {
            throw new Error("arguments are required");
        }
        for (key in args) {
            if (args.hasOwnProperty(key) && key !== "$activity" && key !== "subscribe") {
                if (!KEYS.hasOwnProperty(key)) {
                    throw new Error("Unknown restore option: " + key);
                }
                if (typeof args[key] !== "boolean") {
                    throw new Error(key + " must be true or false");
                }
                props[key] = args[key];
                count += 1;
            }
        }
        if (count === 0) {
            throw new Error("restoreUserApps is required");
        }
        return props;
    };

    return that;
}());

function GetRestoreOptionsAssistant() {
    this.run = function (future) {
        var chain = prefs.get();
        chain.then(this, function (f) {
            var options = restoreOptions.fromPrefs(f.result);
            options.returnValue = true;
            f.result = options;
        });
        future.nest(chain);
    };
}

function SetRestoreOptionsAssistant() {
    this.run = function (future) {
        var props = restoreOptions.validate(this.controller.args);
        logger.log("Restore options set to", props);
        var chain = prefs.set(props);
        chain.then(this, function (f) {
            var options = restoreOptions.fromPrefs(f.result);
            options.returnValue = true;
            f.result = options;
        });
        future.nest(chain);
    };
}
