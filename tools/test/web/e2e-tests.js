/*
	End-to-end tests of the app (com.palm.app.backup/index.html, unchanged)
	in headless Chromium, with the webOS runtime and the backup service
	answered by mock/webos-mock.js from fixtures/. Offline and deterministic.

		node tools/test/web/e2e-tests.js [--screenshots]
		TEST_FILTER=480x800 node tools/test/web/e2e-tests.js

	The page loads Enyo from /usr/palm/frameworks/enyo/0.10, as on a
	device. Tests use the copy a device actually runs (the built one; the
	enyo-1.0-ports sources differ from it), cached in test-output/enyo-0.10.
	Fetch it once from any LuneOS device:

		adb -s <serial> pull /usr/palm/frameworks/enyo/0.10 test-output/enyo-0.10

	or point ENYO_0_10 at another copy of that directory.

	fixtures/*.json are the service's real answers, recorded on a TouchPad
	with luna-send; a test changes a copy when it needs another state.

	Every test also fails when the page throws or logs a console.error, or
	calls a luna method the scenario does not answer. Screenshots (with
	--screenshots, and always for a failing test) go to test-output/web/.
*/
var fs = require("fs");
var path = require("path");
var t = require("./lib/harness.js");
var serverLib = require("./lib/server.js");
var browserLib = require("./lib/browser.js");
var checks = require("./passphrase-checks.js");
var assert = t.assert;

var repo = path.join(__dirname, "..", "..", "..");
var out = path.join(repo, "test-output");
var shotsDir = path.join(out, "web");
var wantShots = process.argv.indexOf("--screenshots") >= 0;
var enyoDir = path.resolve(process.env.ENYO_0_10 || path.join(out, "enyo-0.10"));
var mockSource = fs.readFileSync(path.join(__dirname, "mock", "webos-mock.js"), "utf8");
var SERVICE = "luna://com.palm.app.backup.service/";

/*
	Two things WAM gives Enyo 0.10 that Enyo 2 apps, which the shared mock
	was written for, never use:
	- palmGetResource: a synchronous read of an app file.
	- PalmSystem.simulateMouseClick(x, y, down): a native click at a point,
	  which is how a tap focuses an input. Here: focus what is at that point
	  when the press is released.
*/
var enyo1Runtime = "window.palmGetResource = function(inPath) {" +
	"var x = new XMLHttpRequest(); x.open('GET', inPath, false); x.send();" +
	"if (x.status !== 200) { throw new Error('palmGetResource: ' + inPath + ' ' + x.status); }" +
	"return x.responseText; };" +
	"if (window.PalmSystem && !PalmSystem.simulateMouseClick) {" +
	"PalmSystem.simulateMouseClick = function(inX, inY, inDown) {" +
	"var e = document.elementFromPoint(inX, inY); if (!inDown && e && e.focus) { e.focus(); } }; }";

/*
	The screens the app has to fit. The phones' sizes are their CSS
	viewports as WAM gives them; device-tests.js records the real one.
*/
var SCREENS = [
	// Measured by device-tests.js, 2026-11-13:
	{name: "1024x698", width: 1024, height: 698},     // TouchPad (tenderloin), dpr 1
	{name: "450x869", width: 450, height: 869},       // Brax3, screen 720x1612, dpr 1
	{name: "450x380", width: 450, height: 380},       // Q25 720x720 (weather app's device run, 2026-10-14)
	{name: "450x800", width: 450, height: 800},       // Galaxy A3 2015 540x960 (same)
	// Not measured yet: run device-tests.js there and replace these.
	{name: "1440x1440", width: 1440, height: 1440},   // Titan, screen size, not its viewport
	{name: "720x720", width: 720, height: 720},       // Titan Pocket, screen size
	{name: "480x800", width: 480, height: 800},       // MindPhone, screen size
	{name: "320x480", width: 320, height: 480}        // Pre 3 class
];

function fixture(inName) {
	return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", inName + ".json"), "utf8"));
}

/**
	A device that has backups switched on and the Saved passwords category
	on, which is the default. Tests override pieces of it.
*/
function scenario(inOverrides) {
	var o = inOverrides || {};
	var last = fixture("getLastBackupTime");
	last.optOut = false;
	last.lastbackupTime = 1763024173000;
	var categories = fixture("getUserDataCategories");
	if (o.passwords === false) {
		categories.categories.forEach(function(c) {
			if (c.id === "passwords") {
				c.enabled = false;
			}
		});
	}
	var luna = {
		"luna://com.palm.telluriumservice/subscribeToCommands": {never: true}
	};
	luna[SERVICE + "getBackupStatus"] = {json: fixture("getBackupStatus")};
	luna[SERVICE + "getLastBackupTime"] = {json: last};
	luna[SERVICE + "listTargets"] = {json: fixture("listTargets")};
	luna[SERVICE + "listBackups"] = {json: fixture("listBackups")};
	luna[SERVICE + "getUserDataCategories"] = {json: categories};
	luna[SERVICE + "getRestoreOptions"] = {json: fixture("getRestoreOptions")};
	// Held open, as a running backup's subscription is; the call itself is
	// what these tests look at.
	luna[SERVICE + "startBackup"] = {never: true};
	return {webos: true, luna: luna, storage: {clear: true, set: {}}};
}

var server, browser, page, root;

async function open(inScenario, inScreen) {
	if (page) {
		await page.close();
	}
	var s = inScreen || SCREENS[1];
	page = await browser.newPage({width: s.width, height: s.height,
		initScripts: ["window.__MOCK_CONFIG__ = " + JSON.stringify(inScenario) + ";", mockSource, enyo1Runtime]});
	await page.goto(server.url + "/app/index.html");
	await page.waitFor(checks.app("return !!(app && app.initialLoadComplete);"), 15000);
	return page;
}

function startBackupCalls() {
	return page.eval("__MOCK__.calls.filter(function(c){return c.url==='" + SERVICE + "startBackup';}).map(function(c){return c.params;})");
}

function shot(inName) {
	return page.screenshot(path.join(shotsDir, inName + ".png"));
}

SCREENS.forEach(function(s) {
	t.test(s.name + ": the passphrase dialog and its buttons fit on screen", async function() {
		await open(scenario(), s);
		await checks.openDialog(page);
		var l = await checks.layout(page);
		if (wantShots) {
			await shot("dialog-" + s.name);
		}
		console.log("     dialog " + (l.dialog.r - l.dialog.l) + "x" + (l.dialog.b - l.dialog.t) + " at " + l.dialog.l + "," + l.dialog.t +
			"; buttons " + l.buttons.map(function(b) { return b.caption + " " + (b.box.r - b.box.l) + "px"; }).join(", "));
		assert.deepStrictEqual(l.buttons.map(function(b) { return b.caption; }), ["Cancel", "Skip", "Back up"]);
		assert.deepStrictEqual(l.problems, []);
	});

	t.test(s.name + ": the empty-passphrase message fits too", async function() {
		await open(scenario(), s);
		await checks.openDialog(page);
		await checks.tapNode(page, checks.button("Back up"));
		assert.ok(await checks.errorShown(page), "no message for an empty passphrase");
		var l = await checks.layout(page);
		if (wantShots) {
			await shot("dialog-empty-" + s.name);
		}
		assert.deepStrictEqual(l.problems, []);
	});
});

t.test("Back up with an empty passphrase keeps the dialog open and starts nothing", async function() {
	await open(scenario());
	await checks.openDialog(page);
	await checks.tapNode(page, checks.button("Back up"));
	assert.ok(await checks.dialogOpen(page), "the dialog closed");
	assert.ok(await checks.errorShown(page), "no message saying a passphrase is needed");
	assert.deepStrictEqual(await startBackupCalls(), []);
});

t.test("a passphrase typed after the message starts the backup with it", async function() {
	await open(scenario());
	await checks.openDialog(page);
	await checks.tapNode(page, checks.button("Back up"));
	await checks.typePassphrase(page, "correct horse");
	await checks.tapNode(page, checks.button("Back up"));
	await page.waitFor("!(" + checks.app("return app.$.passphraseDialog.showing;") + ")", 5000);
	var calls = await startBackupCalls();
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].passphrase, "correct horse");
	assert.strictEqual(calls[0].full, false);
});

t.test("Skip starts the backup without a passphrase", async function() {
	await open(scenario());
	await checks.openDialog(page);
	await checks.typePassphrase(page, "not used");
	await checks.tapNode(page, checks.button("Skip"));
	await page.waitFor("!(" + checks.app("return app.$.passphraseDialog.showing;") + ")", 5000);
	var calls = await startBackupCalls();
	assert.strictEqual(calls.length, 1);
	assert.ok(!("passphrase" in calls[0]), "a passphrase was sent: " + JSON.stringify(calls[0]));
});

t.test("Cancel starts nothing", async function() {
	await open(scenario());
	await checks.openDialog(page);
	await checks.tapNode(page, checks.button("Cancel"));
	await page.waitFor("!(" + checks.app("return app.$.passphraseDialog.showing;") + ")", 5000);
	assert.deepStrictEqual(await startBackupCalls(), []);
});

t.test("the message is gone when the dialog opens again", async function() {
	await open(scenario());
	await checks.openDialog(page);
	await checks.tapNode(page, checks.button("Back up"));
	assert.ok(await checks.errorShown(page));
	await checks.tapNode(page, checks.button("Cancel"));
	await page.waitFor("!(" + checks.app("return app.$.passphraseDialog.showing;") + ")", 5000);
	await checks.openDialog(page);
	assert.ok(!(await checks.errorShown(page)), "the old message is still there");
});

t.test("with Saved passwords off, Back Up starts at once without asking", async function() {
	await open(scenario({passwords: false}));
	await page.waitFor(checks.app("return app.initialLoadComplete && !app.backupInProgress;"), 20000);
	await checks.tapNode(page, checks.app("return app.$.BackupProgressButton.hasNode();"));
	await page.waitFor("__MOCK__.calls.some(function(c){return c.url==='" + SERVICE + "startBackup';})", 5000);
	assert.ok(!(await checks.dialogOpen(page)), "asked for a passphrase anyway");
	var calls = await startBackupCalls();
	assert.ok(!("passphrase" in calls[0]));
});

(async function() {
	if (!fs.existsSync(path.join(enyoDir, "framework", "enyo.js"))) {
		console.error("Enyo 0.10 not found at " + enyoDir + "\nFetch it from a LuneOS device:\n" +
			"  adb -s <serial> pull /usr/palm/frameworks/enyo/0.10 test-output/enyo-0.10");
		process.exit(2);
	}
	// One served root: the app under /app, Enyo where index.html asks for it.
	root = path.join(out, "web-root");
	fs.rmSync(root, {recursive: true, force: true});
	fs.mkdirSync(path.join(root, "usr", "palm", "frameworks", "enyo"), {recursive: true});
	fs.symlinkSync(path.join(repo, "com.palm.app.backup"), path.join(root, "app"));
	fs.symlinkSync(enyoDir, path.join(root, "usr", "palm", "frameworks", "enyo", "0.10"));

	server = await serverLib.start(root);
	browser = await browserLib.launch({profileDir: path.join(out, "profile-" + process.pid)});
	await t.run({
		afterEach: async function() {
			if (!page) {
				return;
			}
			assert.deepStrictEqual(page.errors, [], "page errors");
			var unmocked = await page.eval("__MOCK__.calls.filter(function(c){return c.unmocked;}).map(function(c){return c.url;})");
			assert.deepStrictEqual(unmocked, [], "luna calls the scenario does not answer");
		},
		onFailure: async function(inTest) {
			if (page) {
				await page.screenshot(path.join(shotsDir, "FAIL-" + inTest.name.replace(/[^\w.-]+/g, "_") + ".png"));
			}
		},
		after: async function() {
			if (page) {
				await page.close();
			}
			await browser.close();
			await server.stop();
			fs.rmSync(path.join(out, "profile-" + process.pid), {recursive: true, force: true});
		}
	});
})();
