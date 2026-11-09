/* Opening the restore flow from a launch.
 *
 * LuneOS's first use hands "restore my data" to after setup: LunaAppManager
 * launches com.palm.app.backup with {"restore": true}. The app has to open
 * its restore flow for that, on a first launch and on a relaunch, and for
 * nothing else - only a JSON true counts, and a relaunch during a backup only
 * brings the card forward.
 *
 * No Enyo runtime on the host: LaunchParams.js is plain functions, and
 * BackupApp.js is loaded with a stub enyo.kind that keeps the kind's
 * definition, whose handlers are then called on a stand-in for the app.
 * Called from run-tests.js.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

module.exports = async function (t) {
    var check = t.check;
    var REPO = path.join(__dirname, "..", "..");
    var rd = function (rel) { return fs.readFileSync(path.join(REPO, rel), "utf8"); };

    t.section("Launch: {\"restore\": true} opens the restore flow (app)");

    var params = vm.createContext({});
    vm.runInContext(rd("com.palm.app.backup/source/LaunchParams.js"), params);
    var wants = function (p) {
        params.__p = p;
        return vm.runInContext("launchWantsRestore(__p)", params);
    };

    check("an object with restore true", wants({ restore: true }) === true);
    check("its JSON text", wants("{\"restore\":true}") === true);
    check("restore true next to other keys", wants({ restore: true, accounts: true }) === true);
    var notRestore = [undefined, null, {}, "", "not json", "true", 1, true,
                      { restore: false }, { restore: "true" }, { restore: 1 },
                      { restore: [true] }, { Restore: true }, "{\"restore\":\"true\"}",
                      "[true]", { displayAffinity: 0, instanceId: "x" }];
    notRestore.forEach(function (p) {
        check("not for " + JSON.stringify(p), wants(p) === false);
    });

    check("depends.js loads LaunchParams.js before BackupApp.js",
        /"source\/LaunchParams\.js",\s*"source\/BackupApp\.js"/.test(rd("com.palm.app.backup/depends.js")));

    // BackupApp's definition, through a stub enyo.
    var kinds = {};
    var Resources = function () {};
    Resources.prototype.$L = function (s) { return s; };
    var app = vm.createContext({
        window: { location: { href: "file:///usr/palm/applications/com.palm.app.backup/index.html" } },
        enyo: {
            kind: function (def) { kinds[def.name] = def; },
            g11n: { Resources: Resources, setLocale: function () {} },
            VFlexBox: {}
        },
        $L: function (s) { return s; }
    });
    vm.runInContext(rd("com.palm.app.backup/source/LaunchParams.js"), app);
    vm.runInContext(rd("com.palm.app.backup/source/BackupApp.js"), app);
    var def = kinds.BackupApp;
    check("BackupApp is defined", !!def);
    if (!def) {
        return;
    }

    var events = null;
    (function find(list) {
        (list || []).forEach(function (c) {
            if (c.kind === "ApplicationEvents") {
                events = c;
            }
            find(c.components);
        });
    }(def.components));
    check("a relaunch reaches the app", events && events.onApplicationRelaunch === "applicationRelaunched");

    var standIn = function () {
        var opened = 0;
        var self = {
            backupInProgress: false,
            inherited: function () {},
            showRestore: function () { opened++; },
            opened: function () { return opened; }
        };
        return self;
    };
    var launchWith = function (p) {
        app.enyo.windowParams = p;
    };

    var a = standIn();
    launchWith({ restore: true });
    def.rendered.call(a);
    check("a launch with restore true opens the restore flow", a.opened() === 1);
    def.rendered.call(a);
    check("...once, not on every render", a.opened() === 1);

    var b = standIn();
    launchWith({});
    def.rendered.call(b);
    check("a plain launch opens the main page", b.opened() === 0);
    launchWith({ restore: "true" });
    var c = standIn();
    def.rendered.call(c);
    check("a launch with restore \"true\" does not", c.opened() === 0);

    var d = standIn();
    launchWith({});
    def.rendered.call(d);
    launchWith({ restore: true });
    var handled = def.applicationRelaunched.call(d);
    check("a relaunch with restore true opens the restore flow", d.opened() === 1);
    check("...and still brings the card forward", handled === false);
    launchWith({});
    def.applicationRelaunched.call(d);
    check("a plain relaunch leaves the page as it is", d.opened() === 1);

    var e = standIn();
    e.backupInProgress = true;
    launchWith({ restore: true });
    def.applicationRelaunched.call(e);
    check("not in the middle of a backup", e.opened() === 0);
};
