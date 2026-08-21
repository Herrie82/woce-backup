/* Loads the woce-backup service off-device so its engine can be exercised.
 *
 * The service is written as a set of globals that the webOS JS service
 * framework concatenates and evaluates together. This does the same thing with
 * node's vm module, substituting:
 *
 *   IMPORTS   -> our mini Future plus in-memory DB / PalmCall
 *   fake bus  -> registered services backed by plain JS functions
 *   fake FS    -> every root constant repointed under a temp directory
 *
 * What that buys is a real run of the actual backup and restore handlers over a
 * real filesystem: the protocol sequencing, checksum addressing, incremental
 * dedup, manifest bookkeeping and purge all execute for real. What it does not
 * cover is the Luna bus and the jail, which only a device can tell us about.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var Future = require('./future');

var SERVICE_DIR = path.join(__dirname, "..", "..", "com.palm.app.backup.service");

/* The device runs node 0.2, where existence checks live on `path`. Modern node
 * moved them to `fs` and then deleted them outright. The service is written for
 * the device, so the shim belongs here rather than in the service. */
if (typeof path.exists !== "function") {
    path.exists = function (target, callback) {
        fs.stat(target, function (err) { callback(!err); });
    };
    path.existsSync = function (target) {
        try {
            fs.statSync(target);
            return true;
        } catch (err) {
            return false;
        }
    };
}

/* ------------------------------------------------------------- fake db8 */

/**
 * A future that settles on a later tick, the way a real Luna call does.
 *
 * This matters more than it looks. Resolving immediately means Future.nest()
 * always takes its "inner future already complete" path, and the asynchronous
 * path — the one every call on device actually takes — never runs. A bug that
 * only appears when nesting an incomplete future will pass every test and then
 * fail on the device.
 */
function asyncFuture(valueFn) {
    var future = new Future();
    setTimeout(function () {
        var value;
        try {
            value = valueFn();
        } catch (err) {
            future.exception = err;
            return;
        }
        if (value && value.__exception) {
            future.exception = value.__exception;
        } else {
            future.result = value;
        }
    }, 0);
    return future;
}

function makeDB() {
    var kinds = {};      // kindId -> true
    var rows = {};       // _id -> row
    var nextId = 1;
    var nextRev = 1;

    var matches = function (row, where) {
        if (!where) {
            return true;
        }
        for (var i = 0; i < where.length; i++) {
            var clause = where[i];
            var value = row[clause.prop];
            if (clause.op === "=" && value !== clause.val) {
                return false;
            }
        }
        return true;
    };

    return {
        _rows: rows,
        _kinds: kinds,

        find: function (query) {
            return asyncFuture(function () {
                var from = query.from;
                if (from === "Kind:1") {
                    var found = [];
                    for (var kindId in kinds) {
                        if (kinds.hasOwnProperty(kindId) && matches({ id: kindId }, query.where)) {
                            found.push({ id: kindId });
                        }
                    }
                    return { returnValue: true, results: found };
                }

                if (!kinds[from]) {
                    return { __exception: new Error("db: kind not found: " + from) };
                }

                var results = [];
                for (var id in rows) {
                    if (rows.hasOwnProperty(id) && rows[id]._kind === from &&
                            matches(rows[id], query.where)) {
                        results.push(rows[id]);
                    }
                }
                return { returnValue: true, results: results };
            });
        },

        putKind: function (kindId) {
            return asyncFuture(function () {
                kinds[kindId] = true;
                return { returnValue: true };
            });
        },

        put: function (records) {
            return asyncFuture(function () {
                var ids = [];
                for (var i = 0; i < records.length; i++) {
                    var record = records[i];
                    if (!record._id) {
                        record._id = "row" + (nextId++);
                        record._rev = nextRev++;
                    } else if (rows[record._id]) {
                        // Real mojodb behaviour, and the reason the preference
                        // toggle silently failed on device: a put against an
                        // object that already exists is rejected unless it
                        // carries the current _rev.
                        if (record._rev !== rows[record._id]._rev) {
                            return { __exception: new Error(
                                "db: _rev must be specified for existing objects") };
                        }
                        record._rev = nextRev++;
                    } else {
                        record._rev = nextRev++;
                    }
                    rows[record._id] = record;
                    kinds[record._kind] = true;
                    ids.push({ id: record._id, rev: record._rev });
                }
                return { returnValue: true, results: ids };
            });
        },

        del: function (ids) {
            return asyncFuture(function () {
                var removed = 0;
                ids.forEach(function (id) {
                    if (rows[id]) {
                        delete rows[id];
                        removed++;
                    }
                });
                return { returnValue: true, count: removed };
            });
        },

        merge: function (queryOrObjects, props) {
            return asyncFuture(function () {
                if (Object.prototype.toString.call(queryOrObjects) === "[object Array]") {
                    // merge by object still needs an existing row to target
                    var merged = 0;
                    queryOrObjects.forEach(function (obj) {
                        if (obj._id && rows[obj._id]) {
                            for (var k in obj) {
                                if (obj.hasOwnProperty(k) && k !== "_id") {
                                    rows[obj._id][k] = obj[k];
                                }
                            }
                            rows[obj._id]._rev = nextRev++;
                            merged++;
                        }
                    });
                    return { returnValue: true, count: merged };
                }

                var from = queryOrObjects.from;
                var count = 0;
                for (var id in rows) {
                    if (rows.hasOwnProperty(id) && rows[id]._kind === from) {
                        for (var key in props) {
                            if (props.hasOwnProperty(key)) {
                                rows[id][key] = props[key];
                            }
                        }
                        rows[id]._rev = nextRev++;
                        count++;
                    }
                }
                return { returnValue: true, count: count };
            });
        }
    };
}

/* --------------------------------------------------------- fake Luna bus */

function makePalmCall(services, log, throwsFor, hangsFor, privateCategories) {
    return {
        call: function (url, method, args) {
            var serviceId = url.replace("palm://", "").replace(/\/$/, "");

            // Models PalmCall rejecting a malformed URI: it validates before
            // building anything, so the caller gets a throw where it expected a
            // future.
            if (throwsFor && serviceId === throwsFor) {
                throw new Error("_UriParse: Not a valid path in uri " + url + "/" + method);
            }

            // Models a service that accepts the call and never answers. This is
            // not hypothetical: it is what parked a backup at "Preparing" with
            // no error and no completion.
            if (hangsFor && serviceId === hangsFor) {
                return new Future();
            }

            // Models a private-only *category* on an otherwise reachable
            // service — com.palm.db answers on the public bus but exposes
            // internal/preBackup only on the private one.
            if (privateCategories && privateCategories[serviceId] &&
                    method.indexOf(privateCategories[serviceId]) === 0) {
                return asyncFuture(function () {
                    return { __exception: new Error('Unknown method "' +
                        method.split("/").pop() + '" for category "/' +
                        privateCategories[serviceId] + '"') };
                });
            }
            var handler = services[serviceId] && services[serviceId][method];

            log.push({ service: serviceId, method: method, args: args });

            if (!handler) {
                return asyncFuture(function () {
                    var err = new Error("Unknown method " + serviceId + "/" + method);
                    err.serviceId = serviceId;
                    return { __exception: err };
                });
            }

            var inner = new Future();
            setTimeout(function () {
                var result;
                try {
                    result = handler(args);
                } catch (err) {
                    err.serviceId = serviceId;
                    inner.exception = err;
                    return;
                }
                if (result instanceof Future) {
                    inner.nest(result);
                } else {
                    inner.result = result;
                }
            }, 0);
            return inner;
        },
        cancel: function () {}
    };
}

/* ------------------------------------------------------------- the load */

/**
 * Evaluates the service sources in sources.json order inside one shared
 * context, the way the framework does on device.
 */
function loadService(options) {
    options = options || {};

    var sources = JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, "sources.json"), "utf8"));
    var busLog = [];
    var db = makeDB();
    var palmCall = makePalmCall(options.services || {}, busLog,
        options.palmCallThrowsFor, options.palmCallHangsFor,
        options.privateCategories);

    // Only host-realm objects that a vm context does not provide for itself.
    // Passing in String/Object/Array/etc. would be actively wrong: common.js
    // installs String.prototype.shellQuote, and if `String` here were the host
    // constructor the patch would land on the host prototype while string
    // literals created inside the context kept the context's own — so
    // shellQuote would be missing exactly where it is used.
    var sandbox = {
        console: options.quiet ? { log: function () {} } : console,
        require: require,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Buffer: Buffer,
        process: process,

        IMPORTS: {
            foundations: {
                Data:    { DB: db },
                Control: { Future: Future },
                Comms:   { PalmCall: palmCall }
            },
            "foundations.io": {},
            "foundations.json": {},
            require: require
        }
    };
    sandbox.global = sandbox;

    var context = vm.createContext(sandbox);

    sources.forEach(function (entry) {
        if (!entry.source) {
            return;     // library declaration
        }
        var file = path.join(SERVICE_DIR, entry.source);
        var code = fs.readFileSync(file, "utf8");
        try {
            vm.runInContext(code, context, { filename: entry.source });
        } catch (err) {
            throw new Error("Failed loading " + entry.source + ": " + err.message);
        }
    });

    // Repoint every filesystem root at the sandbox directory. These are plain
    // globals in common.js precisely so this is possible.
    if (options.root) {
        var root = options.root.replace(/\\/g, "/");
        if (root.charAt(root.length - 1) !== "/") {
            root += "/";
        }
        vm.runInContext(
            'WORK_ROOT = "' + root + 'work/";' +
            'MANIFEST_ROOT = "' + root + 'work/manifests/";' +
            'JOB_ROOT = "' + root + 'work/jobs/";' +
            'STAGE_ROOT = "' + root + 'work/stage/";' +
            'LOCAL_TARGET_ROOT = "' + root + 'backups/";' +
            'STATIC_SERVICES_ROOT = "' + root + 'etc/";' +
            'backup.WORKING_COMPRESSED_FILENAME = "' + root + 'work/working.gz";',
            context);
    }

    context.__busLog = busLog;
    context.__db = db;
    return context;
}

/**
 * Invokes a command assistant the way the framework does, returning a Future.
 */
function runAssistant(context, assistantName, args, subscriptionSink) {
    var future = new Future();

    var subscription = subscriptionSink ? {
        get: function () {
            var f = new Future();
            f.then(f, function (sf) {
                subscriptionSink.push(sf._result);
            });
            return f;
        }
    } : undefined;

    vm.runInContext("__assistant = new " + assistantName + "();", context);
    var assistant = context.__assistant;

    assistant.controller = {
        args: args || {},
        message: {
            senderServiceName: function () { return "com.palm.backup.test"; },
            applicationID: function () { return "com.palm.backup.test"; }
        }
    };

    try {
        assistant.run(future, subscription);
    } catch (err) {
        future.exception = err;
    }
    return future;
}

module.exports = {
    Future: Future,
    loadService: loadService,
    runAssistant: runAssistant,
    SERVICE_DIR: SERVICE_DIR
};
