/*
	On-device tests: the installed app in the real WAM on a LuneOS device,
	talking to the real backup service. Run through tools/test-device.sh,
	which deploys the checkout, restarts the service, launches the app and
	forwards WAM's DevTools port; or by hand:

		DEVICE_DEBUG=http://127.0.0.1:19998 DEVICE_NAME=titan node tools/test/web/device-tests.js

	Every device has its own screen and pixel ratio, so the run records the
	CSS viewport WAM really gives the app and checks the passphrase dialog
	at that size. Add it to SCREENS in e2e-tests.js when it is a new one.

	What the buttons do is not tested here. Under WAM, Enyo 0.10 turns a tap
	into a click by calling PalmSystem.simulateMouseClick from its mouseup
	handler, and a click sent over DevTools (Input.dispatchMouseEvent or
	dispatchTouchEvent) never gets through that: the button sees a DOM click
	and its handler is not called (measured on a TouchPad, 2026-11-13). A
	field still focuses that way, so typing is tested. The buttons are
	covered by e2e-tests.js and by a finger on the device.

	Nothing here starts a backup. The
	Saved passwords category must be on for the dialog to appear;
	test-device.sh switches it on for the run if needed and puts it back.

	Screenshots go to test-output/device/<name>/.
*/
var path = require("path");
var t = require("./lib/harness.js");
var device = require("./lib/device.js");
var checks = require("./passphrase-checks.js");
var assert = t.assert;

var base = process.env.DEVICE_DEBUG || "http://127.0.0.1:19998";
var name = process.env.DEVICE_NAME || "device";
var outDir = path.join(__dirname, "..", "..", "..", "test-output", "device", name);
var APP = /com\.palm\.app\.backup\/index\.html/;

var page;

function shot(inName) {
	return page.screenshot(path.join(outDir, inName + ".png"));
}

t.test("device and screen", async function() {
	var info = await page.eval("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:screen.width+'x'+screen.height," +
		"ua:navigator.userAgent.replace(/^.*?Chrome\\/([0-9.]+).*$/,'Chrome $1'),palm:!!window.PalmSystem})");
	console.log("     " + name + ": " + info.width + "x" + info.height + " CSS px, devicePixelRatio " + info.dpr +
		", screen " + info.screen + ", " + info.ua);
	assert.ok(info.palm, "not running under WAM (no PalmSystem)");
});

t.test("boots without errors, with Saved passwords on", async function() {
	await page.reload();
	await page.waitFor(checks.app("return !!(app && app.initialLoadComplete);"), 30000);
	assert.ok(await page.eval(checks.app("return app.credentialsEnabled === true;")),
		"Saved passwords is off on this device; test-device.sh should have switched it on");
	assert.deepStrictEqual(page.errors, []);
});

t.test("the passphrase dialog and its buttons fit on this screen", async function() {
	var how = await checks.openDialog(page);
	if (how !== "tap") {
		console.log("     opened with " + how);
	}
	var l = await checks.layout(page);
	await shot("dialog");
	console.log("     dialog " + (l.dialog.r - l.dialog.l) + "x" + (l.dialog.b - l.dialog.t) + " at " + l.dialog.l + "," + l.dialog.t +
		" in " + l.viewport.w + "x" + l.viewport.h + "; buttons " +
		l.buttons.map(function(b) { return b.caption + " " + (b.box.r - b.box.l) + "px"; }).join(", "));
	assert.deepStrictEqual(l.buttons.map(function(b) { return b.caption; }), ["Cancel", "Skip", "Back up"]);
	assert.deepStrictEqual(l.problems, []);
});

t.test("the passphrase field takes typing", async function() {
	await checks.typePassphrase(page, "typed on the device");
	// Leave the dialog as a user would find it.
	await page.eval(checks.app("app.passphraseCancel(); return true;"));
});

(async function() {
	page = await device.attach(base, APP, 30000);
	await t.run({
		onFailure: async function(inTest) {
			try {
				await shot("FAIL-" + inTest.name.replace(/[^\w.-]+/g, "_"));
			} catch (e) {}
		},
		after: async function() {
			page.close();
		}
	});
})();
