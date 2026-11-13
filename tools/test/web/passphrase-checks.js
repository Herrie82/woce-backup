/*
	The backup passphrase dialog, checked the same way in headless Chromium
	(e2e-tests.js) and in the real WAM on a device (device-tests.js).

	Everything here goes through real input events (CDP Input.*) and reads
	what is on screen (bounding boxes, visibility), not the app's fields,
	so a check means what a user would see. The page object is either
	lib/browser.js's or lib/device.js's; both have eval, waitFor and send.
*/
var sleep = require("./lib/device.js").sleep;

//* The BackupApp instance; index.html renders it without a global name.
var APP = "(function(){for(var k in enyo.master.$){if(enyo.master.$[k].kindName==='BackupApp'){return enyo.master.$[k];}}})()";

function app(inExpr) {
	return "(function(app){" + inExpr + "})(" + APP + ")";
}

//* Center of a node an expression returns, or null while it is not laid out.
async function centerOf(inPage, inNodeExpr) {
	return inPage.waitFor("(function(n){if(!n)return null;var r=n.getBoundingClientRect();" +
		"if(!r.width||!r.height)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};})(" + inNodeExpr + ")", 10000);
}

async function tapAt(inPage, inPoint) {
	await inPage.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: inPoint.x, y: inPoint.y});
	await inPage.send("Input.dispatchMouseEvent", {type: "mousePressed", x: inPoint.x, y: inPoint.y, button: "left", clickCount: 1});
	await inPage.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: inPoint.x, y: inPoint.y, button: "left", clickCount: 1});
	await sleep(150);
}

async function dragUp(inPage, inBy) {
	var x = Math.round(await inPage.eval("innerWidth/2")), y0 = Math.round(await inPage.eval("innerHeight*0.75"));
	await inPage.send("Input.dispatchMouseEvent", {type: "mousePressed", x: x, y: y0, button: "left", clickCount: 1});
	for (var i = 1; i <= 10; i++) {
		await inPage.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: x, y: y0 - inBy * i / 10, button: "left", buttons: 1});
		await sleep(16);
	}
	await inPage.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: x, y: y0 - inBy, button: "left", clickCount: 1});
	await sleep(700);
}

/**
	Taps a node the way a person would: at human pace (Enyo 0.10 drops a tap
	that follows the previous one within its double-tap window, measured
	at ~250 ms here), and after dragging the page up when the node is below
	the fold. Enyo's Scroller moves on drags; scrollIntoView does nothing.
*/
async function tapNode(inPage, inNodeExpr) {
	await sleep(600);
	for (var i = 0; i < 6; i++) {
		var c = await centerOf(inPage, inNodeExpr);
		var h = await inPage.eval("innerHeight");
		if (c.y > 0 && c.y < h - 4) {
			break;
		}
		await dragUp(inPage, Math.round(h * 0.4));
	}
	var at = await centerOf(inPage, inNodeExpr);
	var hNow = await inPage.eval("innerHeight");
	if (!(at.y > 0 && at.y < hNow - 4)) {
		throw new Error("could not bring the node on screen to tap it (center y " + Math.round(at.y) + ", viewport " + hNow + ")");
	}
	await tapAt(inPage, at);
}

var DIALOG = app("return app.$.passphraseDialog.hasNode();");

//* A dialog button by its caption, so a test reads like the screen does.
function button(inCaption) {
	return "(function(d){if(!d)return null;var b=d.querySelectorAll('.enyo-button');" +
		"for(var i=0;i<b.length;i++){if(b[i].textContent.trim()===" + JSON.stringify(inCaption) + ")return b[i];}return null;})(" + DIALOG + ")";
}

function dialogOpen(inPage) {
	return inPage.eval(app("var n=app.$.passphraseDialog.hasNode();if(!n||!app.$.passphraseDialog.showing)return false;" +
		"var r=n.getBoundingClientRect();return r.width>0&&r.height>0;"));
}

function errorShown(inPage) {
	return inPage.eval(app("var e=app.$.passphraseError;var n=e.hasNode();return !!(e.showing&&n&&n.getBoundingClientRect().height>0);"));
}

/**
	Taps the main Back Up button and waits for the dialog to be on screen.
	A device with backups switched off has no such button, and switching
	backups on would schedule real daily runs on it; there the dialog is
	opened through startBackup(false), which is what the button calls.
	Returns how it was opened.
*/
async function openDialog(inPage) {
	await inPage.waitFor(app("return app.initialLoadComplete && !app.backupInProgress;"), 20000);
	var how = "tap";
	var hasButton = await inPage.eval(app("var n=app.$.BackupProgressButton.hasNode();" +
		"return !!(n&&app.$.BackupProgressButton.showing&&n.getBoundingClientRect().height>0);"));
	if (hasButton) {
		await tapNode(inPage, app("return app.$.BackupProgressButton.hasNode();"));
	} else {
		how = "startBackup(false): backups are switched off here, so there is no Back Up button";
		await inPage.eval(app("app.startBackup(false); return true;"));
	}
	await inPage.waitFor(app("var n=app.$.passphraseDialog.hasNode();return !!(n&&app.$.passphraseDialog.showing&&" +
		"n.getBoundingClientRect().height>0);"), 5000);
	// The open is animated; measure the settled box.
	await sleep(600);
	return how;
}

/**
	Where the dialog and everything in it sits, against the viewport. Text
	that wraps is fine; text or buttons cut off or past the edge are not.
*/
function layout(inPage) {
	return inPage.eval("(function(d){var W=innerWidth,H=innerHeight;" +
		"function box(n){var r=n.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom)};}" +
		"var out={viewport:{w:W,h:H},dialog:box(d),buttons:[],texts:[],problems:[]};" +
		"function inside(name,b,o){if(b.l<o.l-1||b.t<o.t-1||b.r>o.r+1||b.b>o.b+1)out.problems.push(name+' '+JSON.stringify(b)+' is outside '+JSON.stringify(o));}" +
		"var vp={l:0,t:0,r:W,b:H};inside('dialog',out.dialog,vp);" +
		"var bs=d.querySelectorAll('.enyo-button');for(var i=0;i<bs.length;i++){var n=bs[i],b=box(n),cap=n.textContent.trim();" +
		"out.buttons.push({caption:cap,box:b,clipped:n.scrollWidth>n.clientWidth+1});inside('button \"'+cap+'\"',b,out.dialog);inside('button \"'+cap+'\"',b,vp);" +
		"if(n.scrollWidth>n.clientWidth+1)out.problems.push('button \"'+cap+'\" text is cut off ('+n.scrollWidth+'>'+n.clientWidth+')');}" +
		"var ts=d.querySelectorAll('.backup-info-text');for(var j=0;j<ts.length;j++){var t=ts[j];if(!t.offsetHeight)continue;var tb=box(t);" +
		"out.texts.push({text:t.textContent.trim(),box:tb});inside('text \"'+t.textContent.trim().slice(0,30)+'\"',tb,out.dialog);inside('text',tb,vp);}" +
		"return out;})(" + DIALOG + ")");
}

//* Types into the passphrase field the way a user would: focus by tap, then text.
async function typePassphrase(inPage, inText) {
	var field = app("var n=app.$.passphraseInput.hasNode();return n&&(n.querySelector('input')||n);");
	await tapNode(inPage, field);
	try {
		await inPage.waitFor(field + "===document.activeElement", 3000);
	} catch (e) {
		throw new Error("tapping the passphrase field did not focus it; focus is on " +
			await inPage.eval("(function(a){return a?a.tagName+'#'+a.id+'.'+a.className:'nothing';})(document.activeElement)"));
	}
	await inPage.send("Input.insertText", {text: inText});
	await inPage.waitFor(field + ".value===" + JSON.stringify(inText), 3000);
}

module.exports = {
	APP: APP, app: app, tapNode: tapNode, button: button, dialogOpen: dialogOpen, errorShown: errorShown,
	openDialog: openDialog, layout: layout, typePassphrase: typePassphrase, sleep: sleep
};
