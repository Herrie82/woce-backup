/* The Future the tests run against.
 *
 * Prefers the *real* Palm Foundations implementation, read straight out of the
 * webOS Doctor extract. A hand-written stand-in was tried first and was a
 * mistake: it agreed with Foundations closely enough to pass every test while
 * the device failed, because the divergence lived in exactly the corner the
 * bug did (nest() on a not-yet-complete future). Testing a model of the
 * framework only proves things about the model.
 *
 * Falls back to a minimal implementation when the Doctor extract is not
 * present, so the suite still runs on a machine without it — but the fallback
 * prints a warning, because a green run under it means less.
 *
 * The real file needs four globals: Assert (two type checks), Queue (only for
 * whilst(), which this service never calls), console, and an exports object.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var DOCTOR_FUTURE = path.join(
    __dirname, "..", "..", "..",
    "touchpad", "305doctor", "resources", "webOS",
    "nova-cust-image-topaz.rootfs", "usr", "palm", "frameworks", "foundations",
    "submission", "108", "javascript", "control", "future.js");

function loadRealFuture() {
    if (!fs.existsSync(DOCTOR_FUTURE)) {
        return null;
    }

    var sandbox = {
        console: console,
        exports: { Control: {} },
        Assert: {
            requireObject: function (value, message, params) {
                if (value === null || typeof value !== "object") {
                    throw new Error(render(message, params));
                }
            },
            requireFunction: function (value, message, params) {
                if (typeof value !== "function") {
                    throw new Error(render(message, params));
                }
            }
        },
        // Only reached by whilst(), which this service does not use.
        Queue: {
            current: {
                wrap: function (scope, fn) {
                    return function () { return fn.apply(scope, arguments); };
                }
            }
        }
    };

    var render = function (message, params) {
        if (!params) {
            return message;
        }
        return String(message).replace(/#\{(\w+)\}/g, function (all, key) {
            return params[key] !== undefined ? params[key] : all;
        });
    };

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(DOCTOR_FUTURE, "utf8"), sandbox,
        { filename: "foundations/future.js" });

    return sandbox.exports.Control.Future;
}

var Future = loadRealFuture();
var usingReal = !!Future;

if (!Future) {
    console.log("WARNING: Doctor extract not found at\n  " + DOCTOR_FUTURE +
        "\n  Falling back to a simplified Future. Results are less trustworthy.");
    Future = require('./future-fallback');
}

/**
 * Drains the event loop, then reports how the future settled.
 *
 * Test-only. Settled means a result is set *and* nothing is left queued —
 * checking only for a result resolves early whenever a later callback is still
 * pending, which is how a broken chain can look like a passing one.
 */
Future.prototype.settle = function (callback) {
    var self = this;
    var ticks = 0;

    var state = function () {
        // Foundations keeps its state in _result/_then; the fallback mirrors
        // those names so this works either way.
        var hasResult = self._result ? self._result.isset : self._hasResult;
        var pending = self._then ? self._then.length : self._callbacks.length;
        var exception = self._result ? self._result.exception : self._exception;
        var result = self._result ? self._result.result : self._resultValue;
        return { done: hasResult && pending === 0, exception: exception, result: result };
    };

    var check = function () {
        var s = state();
        if (s.done || ticks > 20000) {
            callback(s.exception, s.result);
            return;
        }
        ticks++;
        setTimeout(check, 0);
    };
    check();
};

Future.usingRealFoundations = usingReal;

module.exports = Future;
