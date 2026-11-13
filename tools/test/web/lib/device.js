/*
	Attaches to a page of a web app running in WAM on a LuneOS device (or
	the VM), through WAM's DevTools port. WAM is started with
	--remote-debugging-port=9998; forward it first:

		adb -s <serial> forward tcp:19998 tcp:9998

		var device = require("./lib/device.js");
		var page = await device.attach("http://127.0.0.1:19998", /org\.webosports\.app\.weather\/index\.html/);
		await page.reload();                        // start the app over, errors are recorded from here
		await page.waitFor("window.weatherApp && weatherApp.lastJson", 60000);
		await page.screenshot("test-output/device/x.png");
		var all = await device.targets("http://127.0.0.1:19998");   // e.g. to find a dashboard window

	The page object has the same helpers as lib/browser.js pages (eval,
	waitFor, reload, screenshot, errors); there is no mock on a device, the
	real services answer.
*/
var fs = require("fs");
var path = require("path");

function sleep(inMs) {
	return new Promise(function(r) { setTimeout(r, inMs); });
}

async function targets(inBase) {
	return (await fetch(inBase + "/json/list")).json();
}

//* Waits for a page whose URL matches inPattern, then connects to it.
async function attach(inBase, inPattern, inTimeout) {
	var until = Date.now() + (inTimeout || 30000), target = null;
	while (!target && Date.now() < until) {
		try {
			target = (await targets(inBase)).filter(function(t) {
				return t.type === "page" && inPattern.test(t.url);
			})[0];
		} catch (e) {}
		if (!target) {
			await sleep(500);
		}
	}
	if (!target) {
		throw new Error("No WAM page matching " + inPattern + " at " + inBase);
	}
	return connect(target);
}

async function connect(inTarget) {
	var ws = new WebSocket(inTarget.webSocketDebuggerUrl);
	await new Promise(function(r, j) { ws.onopen = r; ws.onerror = function() { j(new Error("cannot connect to " + inTarget.url)); }; });
	var id = 0, pending = {};
	var page = {errors: [], console: [], target: inTarget};
	ws.onmessage = function(m) {
		var msg = JSON.parse(m.data);
		if (msg.id && pending[msg.id]) {
			var p = pending[msg.id];
			delete pending[msg.id];
			if (msg.error) {
				p.reject(new Error(msg.error.message));
			} else {
				p.resolve(msg.result);
			}
		} else if (msg.method === "Runtime.exceptionThrown") {
			var d = msg.params.exceptionDetails;
			page.errors.push((d.exception && d.exception.description) || d.text);
		} else if (msg.method === "Runtime.consoleAPICalled") {
			var text = msg.params.args.map(function(a) { return a.value !== undefined ? a.value : a.description; }).join(" ");
			page.console.push(msg.params.type + ": " + text);
			if (msg.params.type === "error") {
				page.errors.push("console.error: " + text);
			}
		}
	};
	function send(inMethod, inParams) {
		return new Promise(function(resolve, reject) {
			pending[++id] = {resolve: resolve, reject: reject};
			ws.send(JSON.stringify({id: id, method: inMethod, params: inParams || {}}));
		});
	}
	page.send = send;
	await send("Runtime.enable");
	await send("Page.enable");

	page.eval = async function(inExpression) {
		var r = await send("Runtime.evaluate", {expression: inExpression, returnByValue: true, awaitPromise: true});
		if (r.exceptionDetails) {
			throw new Error("eval failed: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
				r.exceptionDetails.text) + "\n  in: " + inExpression);
		}
		return r.result.value;
	};

	page.waitFor = async function(inExpression, inTimeout) {
		var until = Date.now() + (inTimeout || 10000), last;
		while (Date.now() < until) {
			try {
				last = await page.eval(inExpression);
				if (last) {
					return last;
				}
			} catch (e) {
				last = e.message;
			}
			await sleep(250);
		}
		throw new Error("timed out waiting for: " + inExpression + " (last: " + JSON.stringify(last) + ")");
	};

	page.reload = async function() {
		page.errors.length = 0;
		page.console.length = 0;
		await send("Page.reload", {ignoreCache: true});
		await sleep(500);
		await page.waitFor("document.readyState === 'complete'", 30000);
	};

	page.screenshot = async function(inFile) {
		var shot = await send("Page.captureScreenshot", {format: "png"});
		fs.mkdirSync(path.dirname(inFile), {recursive: true});
		fs.writeFileSync(inFile, Buffer.from(shot.data, "base64"));
		return inFile;
	};

	page.close = function() {
		ws.close();
	};

	return page;
}

module.exports = {attach: attach, targets: targets, sleep: sleep};
