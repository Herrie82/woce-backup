/* Minimal Future, used only when the Doctor extract is unavailable.
 *
 * This is a model of Palm Foundations' Future, not the real thing, and it has
 * already been shown to diverge in ways that hide real bugs — nest() on a
 * not-yet-complete future in particular. Prefer the real implementation; see
 * future.js. Kept so the suite still runs without the extract.
 */

function Future(value) {
    this._callbacks = [];
    this._hasResult = false;
    this._resultValue = undefined;
    this._exception = undefined;
    this._running = false;

    if (arguments.length > 0) {
        this.result = value;
    }
}

Object.defineProperty(Future.prototype, "result", {
    get: function () {
        if (this._exception !== undefined) {
            var err = this._exception;
            this._exception = undefined;
            throw err;
        }
        return this._resultValue;
    },
    set: function (value) {
        this._resultValue = value;
        this._exception = undefined;
        this._hasResult = true;
        this._advance();
    }
});

Object.defineProperty(Future.prototype, "exception", {
    get: function () { return this._exception; },
    set: function (err) {
        this._exception = err;
        this._hasResult = true;
        this._advance();
    }
});

Future.prototype.then = function (scope, fn) {
    if (typeof scope === "function") { fn = scope; scope = this; }
    this._callbacks.push({ scope: scope, fn: fn });
    if (this._hasResult) { this._advance(); }
    return this;
};

Future.prototype.now = function (scope, fn) {
    if (typeof scope === "function") { fn = scope; scope = this; }
    var returned;
    try {
        returned = fn.call(scope, this);
    } catch (err) {
        this.exception = err;
        return this;
    }
    if (returned instanceof Future) { this.nest(returned); }
    return this;
};

Future.prototype.nest = function (other) {
    var self = this;
    if (!(other instanceof Future)) { this.result = other; return this; }

    this._hasResult = false;
    other.then(other, function (f) {
        if (f._exception !== undefined) {
            var err = f._exception;
            f._exception = undefined;
            self.exception = err;
        } else {
            self.result = f._resultValue;
        }
    });
    return this;
};

Future.prototype._advance = function () {
    if (this._running) { return; }
    this._running = true;

    try {
        while (this._hasResult && this._callbacks.length > 0) {
            var entry = this._callbacks.shift();
            this._hasResult = false;

            var returned;
            try {
                returned = entry.fn.call(entry.scope, this);
            } catch (err) {
                this._exception = err;
                this._hasResult = true;
                continue;
            }

            if (returned !== undefined && !this._hasResult) {
                if (returned instanceof Future) {
                    this._running = false;
                    this.nest(returned);
                    this._running = true;
                } else {
                    this._resultValue = returned;
                    this._exception = undefined;
                    this._hasResult = true;
                }
            }
        }
    } finally {
        this._running = false;
    }
};

module.exports = Future;
