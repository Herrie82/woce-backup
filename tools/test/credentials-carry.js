/* Saved passwords in backups made without the passphrase.
 *
 * Found on a VM: a full backup with the passphrase held the keystore export,
 * the three incremental runs after it had none ("skipped: no passphrase"), and
 * restoring the newest - the obvious choice - brought back 17 accounts and no
 * passwords, without a word. These tests cover both halves of the fix:
 *
 *   - a run without a passphrase carries the last export of this device's
 *     chain forward by reference, and says where it came from; it does not
 *     when the export's file is gone, when the chain is another device's, or
 *     when the run has a passphrase of its own;
 *   - listBackups and getRestoreDevices say which backups have passwords, and
 *     name the newest one that does, and the restore confirmation uses that.
 *
 * Called from run-tests.js after everything else: it rebuilds the sandbox.
 */

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

module.exports = async function (t) {
    var harness = t.harness;
    var check = t.check;
    var ROOT = t.ROOT;

    var SERVICE_ID = "com.palm.backup.credentials";
    var filesDir = path.join(ROOT, "backups", "files");
    var manifestsDir = path.join(ROOT, "backups", "manifests");

    var device = { nduId: "abc123" };
    var exports = [];
    var imports = [];
    var keystore = { version: 1, data: "ciphertext-one" };

    var buildServices = function () {
        var services = t.buildServices();
        services["com.palm.deviceprofile"] = {
            getDeviceProfile: function () {
                return { returnValue: true, deviceInfo: {
                    nduId: device.nduId, deviceId: "device-" + device.nduId,
                    softwareVersion: "3.0.5", hardwareType: "topaz", deviceModel: "TouchPad" } };
            }
        };
        services["com.palm.keymanager"] = {
            exportKeystore: function (args) {
                exports.push(args.passphrase);
                return { returnValue: true, count: 1, unreadable: [],
                         keystore: JSON.parse(JSON.stringify(keystore)) };
            },
            importKeystore: function (args) {
                imports.push({ passphrase: args.passphrase, keystore: args.keystore });
                return { returnValue: true, imported: 1, skipped: 0, failed: [] };
            }
        };
        return services;
    };

    t.buildSandbox();
    var ctx = harness.loadService({ root: ROOT, services: buildServices(),
                                    quiet: !process.env.VERBOSE });
    vm.runInContext("privileged.setAvailableForTesting(false);", ctx);
    vm.runInContext("prefs.set({ userEnabled: true, userData: { passwords: true } });", ctx);

    var settle = function (future) {
        return new Promise(function (resolve) {
            future.settle(function (err, result) { resolve({ error: err, result: result }); });
        });
    };
    var readManifest = function (name) {
        return JSON.parse(fs.readFileSync(path.join(manifestsDir, name), "utf8"));
    };
    var section = function (manifest) {
        return (manifest.services || []).filter(function (s) {
            return s.service === SERVICE_ID;
        })[0];
    };
    var storedName = function (file) {
        return (file.checksum || file.origChecksum) + (file.compressed ? ".gz" : "");
    };
    var newestManifest = function () {
        var names = fs.readdirSync(manifestsDir).filter(function (n) { return /^\d{6}-/.test(n); });
        names.sort();
        return names[names.length - 1];
    };
    var backupRun = async function (args) {
        var r = await t.run(ctx, "BackupAssistant", args, []);
        var name = newestManifest();
        return { error: r.error, result: r.result, name: name, manifest: readManifest(name) };
    };

    t.section("Saved passwords: carried forward when there is no passphrase");

    var a = await backupRun({ full: true, passphrase: "pw-one" });
    var aSection = section(a.manifest);
    check("a backup with the passphrase exports the keystore",
        !a.error && exports.length === 1 && aSection && aSection.files.length === 1 &&
            aSection.files[0].path === "keystore-export" && aSection.carriedFrom === undefined,
        JSON.stringify([a.error && a.error.message, exports.length, aSection]));
    var aStored = aSection ? storedName(aSection.files[0]) : "";
    // Back-date A, so "as of A" can never be mistaken for a later backup's
    // own date: runs here finish within the same second.
    a.manifest.finished = "Thu, 01 Jan 2026 00:00:00 GMT";
    fs.writeFileSync(path.join(manifestsDir, a.name), JSON.stringify(a.manifest));
    check("...and its export is in the file store", fs.existsSync(path.join(filesDir, aStored)), aStored);

    var filesBefore = fs.readdirSync(filesDir).length;
    var b = await backupRun({});
    var bSection = section(b.manifest);
    check("a run without a passphrase does not call keymanager", exports.length === 1,
        String(exports.length));
    check("...but references the earlier export instead of leaving the section empty",
        !b.error && bSection && bSection.files.length === 1 &&
            storedName(bSection.files[0]) === aStored && bSection.files[0]["new"] === false,
        JSON.stringify([b.error && b.error.message, bSection]));
    check("...and records which backup it came from and as of when",
        bSection && bSection.carriedFrom === a.name && bSection.carriedFromDate === a.manifest.finished &&
            /carried forward/.test(bSection.description),
        JSON.stringify(bSection));
    check("...counts its size like any reused file",
        bSection && bSection.size === aSection.files[0].finalSize, JSON.stringify(bSection));
    check("...copies nothing into the store", fs.readdirSync(filesDir).length === filesBefore,
        filesBefore + " -> " + fs.readdirSync(filesDir).length);
    check("...and says so in the backup result",
        b.result && b.result.credentialsCarriedFrom === a.name, JSON.stringify(b.result));

    var c = await backupRun({});
    var cSection = section(c.manifest);
    check("a second run without one still names where the export was captured",
        cSection && cSection.carriedFrom === a.name && cSection.carriedFromDate === a.manifest.finished,
        JSON.stringify(cSection));

    var d = await backupRun({ full: true });
    var dSection = section(d.manifest);
    check("a full run without a passphrase carries it too",
        d.manifest.type === "full" && dSection && dSection.carriedFrom === a.name &&
            storedName(dSection.files[0]) === aStored,
        JSON.stringify(dSection));

    // A passphrase was given but the export failed: that is reported, not
    // papered over with an older export.
    var x = await (async function () {
        var services = buildServices();
        services["com.palm.keymanager"].exportKeystore = function () {
            throw new Error("keymanager is unhappy");
        };
        var failCtx = harness.loadService({ root: ROOT, services: services,
                                            quiet: !process.env.VERBOSE });
        vm.runInContext("privileged.setAvailableForTesting(false);", failCtx);
        vm.runInContext("prefs.set({ userEnabled: true, userData: { passwords: true } });", failCtx);
        var r = await t.run(failCtx, "BackupAssistant", { passphrase: "pw-x" }, []);
        var name = newestManifest();
        return { error: r.error, result: r.result, name: name, manifest: readManifest(name) };
    }());
    var xSection = section(x.manifest);
    check("a run whose export fails with a passphrase carries nothing and reports it",
        !x.error && xSection && xSection.files.length === 0 && xSection.carriedFrom === undefined &&
            x.result && typeof x.result.credentialsError === "string",
        JSON.stringify([x.error && x.error.message, xSection, x.result && x.result.credentialsError]));

    keystore = { version: 1, data: "ciphertext-two" };
    var e = await backupRun({ passphrase: "pw-two" });
    var eSection = section(e.manifest);
    check("a run with a passphrase exports afresh and carries nothing",
        exports.length === 2 && exports[1] === "pw-two" && eSection && eSection.files.length === 1 &&
            eSection.carriedFrom === undefined && storedName(eSection.files[0]) !== aStored &&
            e.result.credentialsCarriedFrom === undefined,
        JSON.stringify([exports, eSection]));

    // The purge after each run must keep the export alive: the carried
    // reference is what protects it once the backup that made it is trimmed.
    var refCtx = await settle(vm.runInContext("backup.getReferencedFiles(false)", ctx));
    check("a carried export counts as referenced for the purge",
        refCtx.result && refCtx.result[aStored] === true, JSON.stringify(refCtx.result));

    t.section("Saved passwords: listBackups and getRestoreDevices");

    var list = await t.run(ctx, "ListBackupsAssistant", {});
    var byName = {};
    ((list.result && list.result.backups) || []).forEach(function (bk) { byName[bk.manifestName] = bk; });
    check("listBackups: a fresh export has hasCredentials, no carriedFrom, as of its own date",
        byName[a.name] && byName[a.name].hasCredentials === true &&
            byName[a.name].credentialsCarriedFrom === null &&
            byName[a.name].credentialsAsOf === a.manifest.finished &&
            byName[a.name].credentialsBackup === null,
        JSON.stringify(byName[a.name]));
    check("listBackups: a carried one reports where from and as of when",
        byName[c.name] && byName[c.name].hasCredentials === true &&
            byName[c.name].credentialsCarriedFrom === a.name &&
            byName[c.name].credentialsAsOf === a.manifest.finished,
        JSON.stringify(byName[c.name]));

    // The export E made disappears from the store (pruned by hand, or the
    // backup copied without its files). The next run must not reference it.
    var eFile = path.join(filesDir, storedName(eSection.files[0]));
    var eAside = path.join(ROOT, "e-export-aside");
    fs.renameSync(eFile, eAside);
    var f = await backupRun({});
    var fSection = section(f.manifest);
    check("no carry when the newest export's file is missing from the store",
        !f.error && fSection && fSection.files.length === 0 && fSection.carriedFrom === undefined &&
            /no passphrase/.test(fSection.description),
        JSON.stringify([f.error && f.error.message, fSection]));

    list = await t.run(ctx, "ListBackupsAssistant", {});
    byName = {};
    ((list.result && list.result.backups) || []).forEach(function (bk) { byName[bk.manifestName] = bk; });
    check("listBackups: a backup without passwords says so",
        byName[f.name] && byName[f.name].hasCredentials === false &&
            byName[f.name].credentialsSkipped === true,
        JSON.stringify(byName[f.name]));
    check("listBackups: an export whose file is gone does not count",
        byName[e.name] && byName[e.name].hasCredentials === false, JSON.stringify(byName[e.name]));
    check("listBackups: it names the newest backup that still has passwords",
        byName[f.name] && byName[f.name].credentialsBackup &&
            byName[f.name].credentialsBackup.manifestName === d.name &&
            byName[f.name].credentialsBackup.date === d.manifest.finished,
        JSON.stringify(byName[f.name] && byName[f.name].credentialsBackup));

    var devices = await t.run(ctx, "GetRestoreDevicesAssistant", {});
    var dev = devices.result && devices.result.devices.filter(function (x) { return x.nduId === "abc123"; })[0];
    var same = !!dev && dev.backups.every(function (bk) {
        var l = byName[bk.manifestName];
        return l && ["hasCredentials", "credentialsSkipped", "credentialsCarriedFrom",
                     "credentialsAsOf", "credentialsBackup"].every(function (k) {
            return JSON.stringify(bk[k]) === JSON.stringify(l[k]);
        });
    });
    check("getRestoreDevices reports the same saved-password fields as listBackups",
        same && dev.backups.length === 7, JSON.stringify(dev && dev.backups));

    t.section("Saved passwords: only this device's chain, only what this service wrote");

    device.nduId = "zzz999";
    var g = await backupRun({});
    var gSection = section(g.manifest);
    check("another device's export is never carried",
        /-zzz999$/.test(g.name) && gSection && gSection.files.length === 0 &&
            gSection.carriedFrom === undefined,
        JSON.stringify([g.name, gSection]));
    device.nduId = "abc123";

    // Straight at the engine, with crafted manifests in the chain. E's export
    // goes back first, so the newest export in the chain is usable again.
    fs.renameSync(eAside, eFile);
    var carry = function (name, nduId) {
        ctx.__name = name;
        ctx.__ndu = nduId;
        return settle(vm.runInContext(
            "(function () { var target; var fu = targets.getCurrent();" +
            " fu.then(function (tf) { target = tf.result; tf.nest(backup.syncManifests(target)); });" +
            " fu.then(function (tf) { var r = tf.result;" +
            "   tf.nest(backup.carryCredentials(target, __name, __ndu)); });" +
            " return fu; }())", ctx));
    };
    var good = await carry("000090-abc123", "abc123");
    check("control: with E's file back, the engine carries E's export",
        good.result && good.result.carriedFrom === e.name &&
            good.result.carriedFromDate === e.manifest.finished, JSON.stringify(good));
    var unknown = await carry("000090-Unknown", "Unknown");
    check("an unknown nduId carries nothing", unknown.result === null, JSON.stringify(unknown));

    var crafted = JSON.parse(JSON.stringify(d.manifest));
    section(crafted).files[0].path = "../../etc/evil";
    section(crafted).carriedFrom = undefined;
    fs.writeFileSync(path.join(manifestsDir, "000080-abc123"), JSON.stringify(crafted));
    var craftedRun = await carry("000090-abc123", "abc123");
    check("a section not shaped like ours (crafted path) is not carried",
        craftedRun.result === null, JSON.stringify(craftedRun));
    var foreign = JSON.parse(JSON.stringify(d.manifest));
    foreign.deviceInfo.nduId = "zzz999";
    fs.writeFileSync(path.join(manifestsDir, "000080-abc123"), JSON.stringify(foreign));
    var foreignRun = await carry("000090-abc123", "abc123");
    check("a manifest named for this device but recording another is skipped",
        foreignRun.result && foreignRun.result.carriedFrom === e.name &&
            readManifest("000080-abc123").deviceInfo.nduId === "zzz999",
        JSON.stringify(foreignRun));
    fs.unlinkSync(path.join(manifestsDir, "000080-abc123"));

    // A good section in another device's chain, with no nduId recorded
    // inside it to give it away: only the name says whose it is.
    var other = JSON.parse(JSON.stringify(d.manifest));
    delete other.deviceInfo;
    fs.writeFileSync(path.join(manifestsDir, "000085-zzz999"), JSON.stringify(other));
    var otherRun = await carry("000090-abc123", "abc123");
    check("a manifest named for another device is not in this chain",
        otherRun.result && otherRun.result.carriedFrom === e.name, JSON.stringify(otherRun));
    fs.unlinkSync(path.join(manifestsDir, "000085-zzz999"));

    // Every device that could not read its nduId is named "Unknown", so an
    // "Unknown" chain is not one device's and carries nothing, even when it
    // holds an export.
    var unknownManifest = JSON.parse(JSON.stringify(d.manifest));
    unknownManifest.deviceInfo.nduId = "Unknown";
    fs.writeFileSync(path.join(manifestsDir, "000086-Unknown"), JSON.stringify(unknownManifest));
    var unknownRun = await carry("000090-Unknown", "Unknown");
    check("an Unknown chain with an export in it still carries nothing",
        unknownRun.result === null, JSON.stringify(unknownRun));
    fs.unlinkSync(path.join(manifestsDir, "000086-Unknown"));
    await carry("000090-abc123", "abc123");   // drops them from the cache too

    t.section("Saved passwords: restoring a carried export");

    var restored = await t.run(ctx, "RestoreAssistant", { manifestName: c.name, passphrase: "pw-one" }, []);
    check("restoring a carried backup imports the original export",
        !restored.error && imports.length === 1 && imports[0].passphrase === "pw-one" &&
            imports[0].keystore && imports[0].keystore.data === "ciphertext-one",
        JSON.stringify([restored.error && restored.error.message, imports]));
    var receiptDir = path.join(ROOT, "backups", "receipts");
    var receiptName = (fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir) : []).filter(function (n) {
        return n.indexOf(c.name + "-restore-") === 0;
    })[0];
    var receipt = receiptName ? JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), "utf8")) : null;
    check("the restore receipt records where the passwords came from",
        receipt && receipt.credentials && receipt.credentials.hasCredentials === true &&
            receipt.credentials.credentialsCarriedFrom === a.name &&
            receipt.credentials.credentialsAsOf === a.manifest.finished,
        JSON.stringify(receipt && receipt.credentials));

    t.section("Saved passwords: the restore confirmation (app)");

    // No Enyo runtime on the host, but the note is plain functions: load
    // ChooseBackupPage.js with a stub enyo and $L and call them.
    var REPO = path.join(__dirname, "..", "..");
    var rd = function (rel) { return fs.readFileSync(path.join(REPO, rel), "utf8"); };
    var choose = rd("com.palm.app.backup/source/restore/ChooseBackupPage.js");
    var ui = vm.createContext({
        enyo: { kind: function () {}, VFlexBox: {},
                macroize: function (text, values) {
                    return text.replace(/\{\$([^{}]*)\}/g, function (m, k) { return values[k]; });
                } },
        $L: function (s) { return s; }
    });
    vm.runInContext(choose, ui);
    var note = function (bk) {
        ui.__bk = bk;
        return vm.runInContext("credentialsRestoreNote(__bk, function (d) { return 'DATE(' + d + ')'; })", ui);
    };
    var noteF = note(byName[f.name]);
    check("the note for a backup without passwords says so and names the newest that has them",
        /no saved passwords/.test(noteF) && noteF.indexOf("DATE(" + d.manifest.finished + ")") !== -1,
        noteF);
    var noteSkipped = note({ hasCredentials: false, credentialsSkipped: true, credentialsBackup: null });
    check("...and still says so when no backup has them",
        /no saved passwords/.test(noteSkipped), noteSkipped);
    var noteC = note(byName[c.name]);
    check("the note for a carried backup gives the date the passwords are from",
        noteC.indexOf("DATE(" + a.manifest.finished + ")") !== -1 && /passphrase/.test(noteC), noteC);
    check("a backup with its own fresh export gets no note", note(byName[a.name]) === "",
        note(byName[a.name]));
    check("backupHasCredentials takes the service's answer",
        vm.runInContext("backupHasCredentials({ hasCredentials: false, services: [{ service: '" +
            SERVICE_ID + "', files: [{}] }] }) === false && " +
            "backupHasCredentials({ hasCredentials: true, services: [] }) === true", ui));

    var list2 = rd("com.palm.app.backup/source/BackupListPage.js");
    check("both restore confirmations show the note",
        /name: "confirmMessage"[^\n]*\n\s*\{ name: "credentialsNote"/.test(choose) &&
            /this\.\$\.credentialsNote\.setContent\(row\.credentialsNote/.test(choose) &&
            /credentialsNote: credentialsRestoreNote\(backup,/.test(choose) &&
            /name: "restoreMessage"[^\n]*\n\s*\{ name: "credentialsNote"/.test(list2) &&
            /var note = credentialsRestoreNote\(backup,/.test(list2) &&
            /this\.\$\.credentialsNote\.setShowing\(!!note\)/.test(list2));
};
