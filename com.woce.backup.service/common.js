/* woce-backup service — shared constants and helpers.
 *
 * Ported from com.palm.service.backup/common.js. Two things from the stock
 * version are deliberately not carried over:
 *
 *   - Object.prototype.isEmpty — an enumerable property on Object.prototype
 *     leaks into every for..in loop in the service. Replaced by isEmptyObject().
 *   - String.prototype.startsWith/endsWith built on match() — treats its
 *     argument as a regex, so any path containing '.' or '(' matches wrongly.
 *     Replaced with indexOf/slice versions.
 */
/*global Future, logger, setTimeout */

// Service working area. Inside the triton jail /media/internal is mounted rw,
// which is why every path we own lives under it.
var WORK_ROOT       = "/media/internal/.woce-backup/";
var MANIFEST_ROOT   = WORK_ROOT + "manifests/";   // local manifest cache
var JOB_ROOT        = WORK_ROOT + "jobs/";        // IPC with the root helper
var STAGE_ROOT      = WORK_ROOT + "stage/";       // helper stages out-of-jail files here

// Default local target root. Plain enough that a user can find it over USB.
var LOCAL_TARGET_ROOT = "/media/internal/webos-backups/";

// Layout inside a target. Same names the stock service used on the storage
// server, so a manifest is byte-comparable with a legacy one.
var MANIFESTS_PATH = "manifests/";
var FILES_PATH     = "files/";

// Where services declare their backup callbacks. This is the stock directory,
// read as-is: a registration file names a service and its methods and says
// nothing about which backup service is asking, so every system service that
// participated in Palm backup participates here too, unmodified.
var STATIC_SERVICES_ROOT = "/etc/palm/backup/";

// Runs fun over arr sequentially, collecting the results. Sequential rather
// than parallel is intentional: preBackup calls mutate shared temp space.
function mapFuture(arr, fun) {
    var future = new Future();
    var result = [];
    if (arr === undefined) {
        future.result = undefined;
    } else if (arr.length === 0) {
        future.result = result;
    } else {
        future.nest(fun(arr[0]));
        for (var i = 1; i < arr.length; i++) {
            mapFutureHelper(i, arr, fun, future, result);
        }
        future.then(this, function () {
            result.push(future.result);
            future.result = result;
        });
    }
    return future;
}

function mapFutureHelper(i, arr, fun, future, result) {
    future.then(this, function () {
        result.push(future.result);
        future.nest(fun(arr[i]));
    });
}

String.prototype.startsWith = function (str) {
    return this.slice(0, str.length) === str;
};

String.prototype.endsWith = function (str) {
    return str.length === 0 || this.slice(-str.length) === str;
};

/**
 * Quotes this string for use as a single shell argument.
 */
String.prototype.shellQuote = function () {
    var ret = '"';
    for (var i = 0; i < this.length; i++) {
        var c = this.charAt(i);
        switch (c) {
        case '"':  ret += '\\"';  break;
        case '\\': ret += '\\\\'; break;
        case '$':  ret += '\\$';  break;
        case '`':  ret += '\\`';  break;
        default:   ret += c;
        }
    }
    return ret + '"';
};

/**
 * Returns true if obj has no own enumerable properties.
 */
function isEmptyObject(obj) {
    if (!obj) {
        return true;
    }
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            return false;
        }
    }
    return true;
}

/**
 * Returns true if str is undefined, null, or the empty string.
 */
function isEmpty(str) {
    return str === undefined ||
        str === null ||
        (typeof str === "string" && str.length === 0);
}

// Returns the given number left-padded with zeros to the given length.
function zeroPad(num, length) {
    var numString = num.toString();
    while (numString.length < length) {
        numString = "0" + numString;
    }
    return numString;
}

// Returns the parent directory of the given path.
function getParent(path) {
    if (path.length > 1 && path.charAt(path.length - 1) === '/') {
        path = path.substring(0, path.length - 1);
    }
    var i = path.lastIndexOf("/");
    if (i < 0) {
        return "";
    } else if (i === 0) {
        return "/";
    }
    return path.substring(0, i);
}

// Returns the keys of the given object as an array.
function getServiceList(services) {
    var ret = [];
    for (var service in services) {
        if (services.hasOwnProperty(service)) {
            ret.push(service);
        }
    }
    return ret;
}

// Removes duplicates, keeping the last occurrence of each element.
function eliminateDuplicates(arr) {
    var seen = {};
    var ret = [];
    for (var i = arr.length - 1; i >= 0; i--) {
        var elem = arr[i];
        if (!seen[elem]) {
            seen[elem] = true;
            ret.push(elem);
        }
    }
    return ret.reverse();
}

// Returns a new array of the elements in fromArray not present in removeArray.
function removeAll(fromArray, removeArray) {
    if (fromArray === undefined) {
        return undefined;
    } else if (fromArray.length === 0) {
        return [];
    } else if (removeArray === undefined || removeArray.length === 0) {
        return fromArray;
    }

    var removeMap = {};
    var returnArray = [];

    removeArray.forEach(function (entry) { removeMap[entry] = true; });
    fromArray.forEach(function (entry) {
        if (!removeMap[entry]) {
            returnArray.push(entry);
        }
    });
    return returnArray;
}

// Shallow equality check, sufficient for the incrementalKey comparison.
function objectEquals(obj1, obj2) {
    if (obj1 === undefined) { return obj2 === undefined; }
    if (obj1 === null)      { return obj2 === null; }
    if (obj2 === undefined || obj2 === null) { return false; }

    var i;
    for (i in obj1) {
        if (obj1.hasOwnProperty(i)) {
            if (!obj2.hasOwnProperty(i)) { return false; }
            if (obj1[i] !== obj2[i]) { return false; }
        }
    }
    for (i in obj2) {
        if (obj2.hasOwnProperty(i)) {
            if (!obj1.hasOwnProperty(i)) { return false; }
            if (obj1[i] !== obj2[i]) { return false; }
        }
    }
    return true;
}

/**
 * Wraps a future so it can never fail, yielding `fallback` if it does.
 *
 * This exists because of how the chains in this service are built. Every
 * `.then` in a handler hangs off one future, so clearing `f.exception` inside a
 * callback to tolerate one optional call also discards any error raised
 * earlier in the chain — a failed backup would report success. Absorbing the
 * failure inside the optional call's own future keeps it local.
 *
 * Use for genuinely optional work only: a missing battery reading should not
 * fail a backup, but a failed manifest write must.
 */
function tolerate(future, fallback) {
    return withTimeout(future, TOLERATE_TIMEOUT, fallback);
}

// How long an optional call may take before we stop waiting for it. Generous
// enough for a slow device, far short of the 7200s command timeout.
var TOLERATE_TIMEOUT = 20000;

// How long a registered service gets to answer one backup/restore callback.
// A service that has not replied in a minute is not going to —
// com.palm.browserServer accepts preBackup and never answers, and waiting two
// minutes on it every single run is most of the backup's wall time.
var SERVICE_CALL_TIMEOUT = 60000;

// Except where a service legitimately needs longer. com.palm.db dumps the whole
// database inside preBackup, which on a TouchPad with a full profile is slow
// but real work — cutting that off would lose the backup's entire point.
var SERVICE_CALL_TIMEOUT_OVERRIDES = {
    "com.palm.db": 300000
};

function serviceCallTimeout(serviceName) {
    return SERVICE_CALL_TIMEOUT_OVERRIDES[serviceName] || SERVICE_CALL_TIMEOUT;
}

/**
 * Fails the future if it has not settled within timeout.
 *
 * Unlike withTimeout(), this reports an error rather than substituting a
 * fallback: a service callback that never answers has not produced data, and
 * pretending otherwise would write a manifest claiming a backup that did not
 * happen. The caller decides what to do — for everything except the required
 * services, that means recording it as skipped and moving on.
 */
function withDeadline(future, timeout, label) {
    var wrapper = new Future();
    var settled = false;

    var timer = setTimeout(function () {
        if (!settled) {
            settled = true;
            var err = new Error(label + " did not answer within " + timeout + "ms");
            err.timedOut = true;
            wrapper.exception = err;
        }
    }, timeout);

    future.then(future, function (f) {
        var failure = f.exception;
        var value;
        if (!failure) {
            value = f.result;
        }

        if (settled) {
            return;     // the deadline already answered for us
        }
        settled = true;
        clearTimeout(timer);

        if (failure) {
            wrapper.exception = failure;
        } else {
            wrapper.result = value;
        }
    });
    return wrapper;
}

/**
 * Like tolerate(), but also gives up if the future never settles at all.
 *
 * A failed optional call was always handled; a *hung* one was not, and that is
 * worse. A Luna call that never answers leaves the chain parked with no error,
 * no completion and no timeout for two hours — on device it looked exactly like
 * a backup that had silently stopped caring. An optional call must be able to
 * hang without taking the run with it.
 *
 * The scope passed to then() is the future itself rather than `this`: at module
 * scope `this` is the global object, and Foundations asserts its scope is an
 * object, so a stricter context would throw here.
 */
function withTimeout(future, timeout, fallback) {
    var wrapper = new Future();
    var settled = false;

    var timer = setTimeout(function () {
        if (!settled) {
            settled = true;
            logger.warn("Optional call did not answer within", timeout + "ms, continuing without it");
            wrapper.result = fallback;
        }
    }, timeout);

    future.then(future, function (f) {
        // Read whatever arrived either way: leaving an exception unread makes
        // Foundations re-raise it into a chain that no longer exists.
        var failure = f.exception;
        var value;
        if (!failure) {
            value = f.result;
        }

        if (settled) {
            return;     // the timeout already answered for us
        }
        settled = true;
        clearTimeout(timer);

        if (failure) {
            logger.log("Tolerating optional failure:", failure.message);
            wrapper.result = fallback;
        } else {
            wrapper.result = value;
        }
    });
    return wrapper;
}

// Calls fun up to remainingTries extra times, doubling timeout after each failure.
function retry(fun, remainingTries, timeout) {
    var future = fun();
    future.then(this, function (f) {
        if (f.exception) {
            var err = f.exception;
            logger.warn("Error:", err.message || err);
            if (remainingTries === 0) {
                f.exception = err;
            } else {
                logger.warn("Trying again...");
                setTimeout(function () {
                    f.nest(retry(fun, remainingTries - 1, timeout * 2));
                }, timeout);
            }
        } else {
            var result = f.result;
            f.result = result;
        }
    });
    return future;
}
