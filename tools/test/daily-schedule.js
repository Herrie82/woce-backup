/* The daily backup activity, on legacy webOS and on LuneOS.
 *
 * Legacy webOS gets the stock activity, whose battery requirement makes its
 * Activity Manager hold the run under 25%. LuneOS's Activity Manager refuses
 * that requirement, so there the service creates its own activity, with no
 * requirements, and the scheduled run checks the battery itself. These tests
 * check which activity each platform gets and when a scheduled run goes ahead.
 *
 * Called from run-tests.js, which owns the counters, the fakes and `state`.
 */

var vm = require('vm');

module.exports = async function (t) {
    var check = t.check;
    var run = t.run;
    var state = t.state;
    var newContext = t.newContext;
    var listFilesIn = t.listFilesIn;
    var manifestDir = t.manifestDir;

    t.section("Daily schedule");

    var creates = function (ctx) {
        return ctx.__busLog.filter(function (entry) {
            return entry.service === "com.palm.activitymanager" && entry.method === "create";
        }).map(function (entry) { return entry.args.activity; });
    };

    state.activityManager = "legacy";
    var legacyCtx = newContext();
    var legacyOptIn = await run(legacyCtx, "OptInAssistant", {});
    var legacyCreates = creates(legacyCtx);
    check("legacy: opt-in succeeds", !legacyOptIn.error && legacyOptIn.result.enabled === true,
        legacyOptIn.error && legacyOptIn.error.message);
    check("legacy: one activity, the stock spec with battery 25",
        legacyCreates.length === 1 && legacyCreates[0].requirements &&
        legacyCreates[0].requirements.battery === 25,
        JSON.stringify(legacyCreates));
    check("legacy: the callback does not check the battery itself",
        legacyCreates.length === 1 && legacyCreates[0].callback.params.checkBattery === undefined,
        JSON.stringify(legacyCreates[0] && legacyCreates[0].callback));

    // LuneOS: the OSE bus, with an Activity Manager that refuses the stock
    // battery requirement as the real one does.
    state.activityManager = "luneos";
    var luneCtx = newContext();
    vm.runInContext("platform.isModernBus = function () { return true; };", luneCtx);
    var luneOptIn = await run(luneCtx, "OptInAssistant", {});
    var luneCreates = creates(luneCtx);
    check("LuneOS: opt-in succeeds", !luneOptIn.error && luneOptIn.result.enabled === true,
        luneOptIn.error && luneOptIn.error.message);
    check("LuneOS: one activity, our own spec with no requirements",
        luneCreates.length === 1 && luneCreates[0].requirements === undefined,
        JSON.stringify(luneCreates));
    check("LuneOS: our own spec has the callback check the battery",
        luneCreates.length === 1 && luneCreates[0].callback.params.checkBattery === true &&
        luneCreates[0].callback.params.scheduled === true &&
        luneCreates[0].schedule.interval === "24h",
        JSON.stringify(luneCreates[0]));
    state.activityManager = "legacy";

    var scheduled = async function (battery, charger, args) {
        state.battery = battery;
        state.charger = charger;
        var before = listFilesIn(manifestDir()).length;
        var ctx = newContext();
        // newContext's own prefs.set is not waited on; a scheduled run that
        // reads the toggle first would skip as "turned off".
        await run(ctx, "OptInAssistant", {});
        var outcome = await run(ctx, "ScheduledBackupAssistant", args, []);
        var after = listFilesIn(manifestDir()).length;
        state.battery = 88;
        state.charger = false;
        return { outcome: outcome, added: after - before };
    };
    var describe = function (r) {
        return (r.outcome.error ? r.outcome.error.message : JSON.stringify(r.outcome.result)) +
            ", manifests added " + r.added;
    };
    var ranOk = function (r) {
        return !r.outcome.error && r.outcome.result.STATUS === "Complete" && r.added === 1;
    };
    var skipped = function (r) {
        return !r.outcome.error && r.outcome.result.STATUS === "Skipped" && r.added === 0;
    };

    var low = await scheduled(10, false, { scheduled: true, checkBattery: true });
    check("LuneOS: below 25% and not charging, the day is skipped", skipped(low), describe(low));
    var lowCharging = await scheduled(10, true, { scheduled: true, checkBattery: true });
    check("LuneOS: below 25% on the charger, the backup runs", ranOk(lowCharging), describe(lowCharging));
    var atFloor = await scheduled(25, false, { scheduled: true, checkBattery: true });
    check("LuneOS: at 25% the backup runs", ranOk(atFloor), describe(atFloor));
    var unknown = await scheduled(undefined, false, { scheduled: true, checkBattery: true });
    check("LuneOS: an unreadable battery does not hold the backup up", ranOk(unknown), describe(unknown));
    var noCharger = await scheduled(10, undefined, { scheduled: true, checkBattery: true });
    check("LuneOS: low battery and an unreadable charger skips the day", skipped(noCharger), describe(noCharger));
    var legacyLow = await scheduled(10, false, { scheduled: true });
    check("legacy: the run is not second-guessed, the Activity Manager gated it",
        ranOk(legacyLow), describe(legacyLow));
};
