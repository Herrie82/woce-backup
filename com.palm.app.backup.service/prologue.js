/* woce-backup service — global imports and logging.
 *
 * Mirrors the prologue of com.palm.service.backup, but uses a logger that
 * degrades to console.log: pmloglib is not guaranteed present for a
 * third-party service, and losing logs makes on-device debugging miserable.
 */
/*global IMPORTS, require, console, redactText */

var Foundations = IMPORTS.foundations;
var Io = IMPORTS["foundations.io"];

var DB = Foundations.Data.DB;
var Future = Foundations.Control.Future;
var PalmCall = Foundations.Comms.PalmCall;

// NOV-108635 workaround, carried over from the stock service
if (typeof require === 'undefined') {
    require = IMPORTS.require;
}

/* Log an uncaught exception before the process dies.
 *
 * Foundations catches anything thrown inside a future callback, but a throw
 * from an fs, setTimeout or child_process callback is outside its reach and
 * takes the service down with no output at all — the log simply stops, and the
 * next call reports "com.palm.app.backup.service is not running". That is a
 * miserable thing to debug on a device, so make it say something first.
 *
 * This does not swallow the crash: the process still exits, because a service
 * left running after an unknown fault is worse than one that restarts clean.
 */
if (typeof process !== "undefined" && process.on) {
    process.on("uncaughtException", function (err) {
        try {
            console.error("woce-backup: FATAL uncaught exception: " +
                (err && (err.stack || err.message || err)));
        } catch (ignored) {
            // nothing left to do if even logging fails
        }
        process.exit(1);
    });
}

/* Secrets never reach the log.
 *
 * Calls this service makes carry them as ordinary parameters: the backup
 * passphrase and the encrypted keystore envelope to and from keymanager
 * (util/credentials.js). Those were logged on every backup and restore by
 * system.palmcall's "Calling ... with <args>" line and, on failure, by the
 * error text PalmCall builds by interpolating the call and its arguments.
 * /var/log/messages is persistent, so the passphrase protecting every saved
 * password ended up on disk next to the envelope it opens.
 *
 * Redacted by key name, at any depth, both in objects and inside text that
 * embeds JSON. Matching is by name because the values are by definition not
 * known here.
 */
var SECRET_KEY_PATTERN = /pass(phrase|word|wd)|keystore|token|authori[sz]ation|secret|credential|cookie/i;
var REDACTED = "[redacted]";

var redactSecrets = function (value, depth) {
    depth = depth || 0;
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (depth > 16) {
        return REDACTED;
    }
    var out;
    if (Object.prototype.toString.call(value) === "[object Array]") {
        out = [];
        for (var i = 0; i < value.length; i++) {
            out.push(redactSecrets(value[i], depth + 1));
        }
        return out;
    }
    if (value instanceof Error) {
        return redactText(value.message);
    }
    out = {};
    for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED
                : redactSecrets(value[key], depth + 1);
        }
    }
    return out;
};

/* The JSON-in-text form: "passphrase":"...", "keystore":{...}. The value is
 * skipped by scanning, not by regex, so a nested object or an escaped quote
 * inside a string cannot end it early.
 */
var redactText = function (text) {
    var str = String(text === undefined || text === null ? "" : text);
    var keyRe = /"((?:[^"\\]|\\.){1,128})"\s*:\s*/g;
    var out = "";
    var last = 0;
    var m;
    while ((m = keyRe.exec(str)) !== null) {
        if (!SECRET_KEY_PATTERN.test(m[1])) {
            continue;
        }
        var start = m.index + m[0].length;
        var end = start;
        var c = str.charAt(start);
        if (c === '"') {
            end = start + 1;
            while (end < str.length && str.charAt(end) !== '"') {
                end += str.charAt(end) === "\\" ? 2 : 1;
            }
            end = Math.min(end + 1, str.length);
        } else if (c === "{" || c === "[") {
            var level = 0;
            var inString = false;
            for (end = start; end < str.length; end++) {
                var ch = str.charAt(end);
                if (inString) {
                    if (ch === "\\") {
                        end++;
                    } else if (ch === '"') {
                        inString = false;
                    }
                } else if (ch === '"') {
                    inString = true;
                } else if (ch === "{" || ch === "[") {
                    level++;
                } else if (ch === "}" || ch === "]") {
                    level--;
                    if (level === 0) {
                        end++;
                        break;
                    }
                }
            }
        } else {
            while (end < str.length && ",}] \n".indexOf(str.charAt(end)) === -1) {
                end++;
            }
        }
        out += str.substring(last, start) + '"' + REDACTED + '"';
        last = end;
        keyRe.lastIndex = end;
    }
    return out + str.substring(last);
};

var logger = (function () {
    var LOG_PREFIX = "woce-backup: ";

    var join = function (args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a !== null && typeof a === "object") {
                try {
                    parts.push(JSON.stringify(redactSecrets(a)));
                } catch (err) {
                    parts.push(String(a));
                }
            } else {
                parts.push(String(a));
            }
        }
        // Text too: an error message can carry the payload it failed on.
        return LOG_PREFIX + redactText(parts.join(" "));
    };

    var pmlog;
    try {
        pmlog = require('pmloglib');
    } catch (err) {
        pmlog = null;
    }

    var emit = function (level, args) {
        var line = join(args);
        if (pmlog && typeof pmlog[level] === "function") {
            pmlog[level](line);
        } else {
            console.log(line);
        }
    };

    return {
        log:   function () { emit("log", arguments); },
        info:  function () { emit("info", arguments); },
        warn:  function () { emit("warn", arguments); },
        error: function () { emit("error", arguments); }
    };
}());
