/* Load-order lint for the Enyo app.
 *
 * Enyo evaluates a kind's `components` array at definition time, so anything it
 * names — a label, another kind — must already exist when the file loads. Node
 * --check cannot see this, and the failure on device is a bare
 * "Failed to find a constructor for kind [X]" with no hint at the cause.
 *
 * Checks, in depends.js order:
 *   1. every `kind: "X"` reference resolves to a kind defined earlier (or is a
 *      framework kind)
 *   2. every label_* identifier used inside a components array is defined
 *      earlier, or in the same file above its use
 *
 * Run: node tools/lint-enyo.js
 */

var fs   = require('fs');
var path = require('path');

var APP_DIR = path.join(__dirname, "..", "com.woce.backup");

// Properties that start with "on" but hold a caption rather than a handler
// name, so a quoted value is data and not a method reference.
var NON_HANDLER_PROPS = {
    onLabel: true,
    onContent: true,
    onValue: true
};

// Components a base kind contributes to `this.$` of anything extending it.
// Only what this app actually reaches for; extend as needed.
var INHERITED_COMPONENTS = {
    "enyo.ProgressButton": ["animator", "bar", "client", "cancelButton"],
    "enyo.DialogPrompt":   ["acceptButton", "cancelButton"],
    "DialogPrompt":        ["acceptButton", "cancelButton"]
};

// Enyo 0.10 kinds the app builds on. Not exhaustive for the framework — just
// everything this app actually names.
var FRAMEWORK_KINDS = [
    "Control", "Button", "Image", "Item", "SwipeableItem", "RowGroup", "Scroller",
    "VirtualList", "List", "Pane", "Toolbar", "AppMenu", "Popup", "ModalDialog",
    "DialogPrompt", "enyo.DialogPrompt", "Scrim", "Spinner", "SpinnerLarge",
    "ToggleButton", "ProgressBar", "ProgressButton", "PalmService", "Header",
    "VFlexBox", "HFlexBox", "ApplicationEvents",
    "enyo.VFlexBox", "enyo.HFlexBox", "enyo.ProgressButton", "enyo.Control"
];

function loadOrder() {
    var depends = fs.readFileSync(path.join(APP_DIR, "depends.js"), "utf8");
    var files = [];
    var re = /"([^"]+\.js)"/g;
    var match;
    while ((match = re.exec(depends)) !== null) {
        files.push(match[1]);
    }
    return files;
}

/**
 * Spans of every `components:` array literal in the source, as [start, end].
 */
function componentSpans(src) {
    var spans = [];
    var re = /components\s*:\s*\[/g;
    var match;
    while ((match = re.exec(src)) !== null) {
        var depth = 0;
        var i = match.index + match[0].length - 1;
        for (; i < src.length; i++) {
            if (src[i] === "[") { depth++; }
            else if (src[i] === "]") {
                depth--;
                if (depth === 0) { break; }
            }
        }
        spans.push([match.index, i]);
    }
    return spans;
}

/**
 * Spans of each `enyo.kind({ ... })` call, so per-kind checks do not see
 * another kind's methods or component names.
 */
function kindBlocks(src) {
    var blocks = [];
    var re = /enyo\.kind\(\{/g;
    var match;
    while ((match = re.exec(src)) !== null) {
        var depth = 0;
        var i = match.index + match[0].length - 1;
        for (; i < src.length; i++) {
            if (src[i] === "{") { depth++; }
            else if (src[i] === "}") {
                depth--;
                if (depth === 0) { break; }
            }
        }
        blocks.push({ start: match.index, end: i });
    }
    return blocks;
}

function inSpans(spans, pos) {
    for (var i = 0; i < spans.length; i++) {
        if (pos >= spans[i][0] && pos <= spans[i][1]) {
            return true;
        }
    }
    return false;
}

function main() {
    var files = loadOrder();
    var definedKinds = {};      // name -> file index
    var definedLabels = {};     // name -> { file: index, pos: offset }
    var problems = [];

    FRAMEWORK_KINDS.forEach(function (name) {
        definedKinds[name] = -1;
    });

    var sources = {};

    // Pass 1 — collect every definition with its position, so a same-file
    // reference can be compared positionally rather than assumed missing.
    files.forEach(function (rel, index) {
        var full = path.join(APP_DIR, rel);
        if (!fs.existsSync(full) || !/\.js$/.test(rel)) {
            return;
        }
        var src = fs.readFileSync(full, "utf8");
        sources[rel] = { src: src, index: index, spans: componentSpans(src) };

        var match, re;

        re = /\bname\s*:\s*"([A-Za-z][\w.]*)"/g;
        while ((match = re.exec(src)) !== null) {
            // Top-level kind names only: those sitting right after an
            // enyo.kind({ opener rather than nested inside a components array.
            var before = src.lastIndexOf("enyo.kind(", match.index);
            var between = src.substring(before, match.index);
            if (before >= 0 && between.indexOf("components") === -1 && between.length < 40) {
                definedKinds[match[1]] = index;
            }
        }

        re = /^(?:var\s+)?(label_[A-Za-z0-9_$]*)\s*=/gm;
        while ((match = re.exec(src)) !== null) {
            if (!definedLabels[match[1]]) {
                definedLabels[match[1]] = { file: index, pos: match.index };
            }
        }
    });

    // Pass 2 — check references.
    files.forEach(function (rel) {
        var entry = sources[rel];
        if (!entry) {
            return;
        }
        var src = entry.src;
        var index = entry.index;
        var spans = entry.spans;
        var match, re;

        re = /\bkind\s*:\s*"([^"]+)"/g;
        while ((match = re.exec(src)) !== null) {
            var kindName = match[1];
            if (!definedKinds.hasOwnProperty(kindName)) {
                problems.push(rel + ":" + lineOf(src, match.index) +
                    "  kind \"" + kindName + "\" is never defined");
            } else if (definedKinds[kindName] > index) {
                problems.push(rel + ":" + lineOf(src, match.index) +
                    "  kind \"" + kindName + "\" is defined in a file that loads later");
            }
        }

        re = /\b(label_[A-Za-z0-9_$]*)\b/g;
        while ((match = re.exec(src)) !== null) {
            var label = match[1];
            if (!inSpans(spans, match.index)) {
                continue;   // inside a method: runs after every file has loaded
            }
            var def = definedLabels[label];
            if (!def) {
                problems.push(rel + ":" + lineOf(src, match.index) +
                    "  " + label + " is never defined");
            } else if (def.file > index || (def.file === index && def.pos > match.index)) {
                problems.push(rel + ":" + lineOf(src, match.index) +
                    "  " + label + " is used at kind-definition time but defined " +
                    (def.file === index ? "further down this file" : "in a later file"));
            }
        }

        // Per-kind checks: an event handler naming a method that does not exist,
        // and a this.$.x reference to a component that was never declared. Enyo
        // fails silently on both — the handler simply never fires, and the $
        // lookup yields undefined at the point of use.
        kindBlocks(src).forEach(function (block) {
            var body = src.substring(block.start, block.end);
            var methods = {};
            var names = {};
            var m, r;

            r = /^\s{4}([A-Za-z_$][\w$]*)\s*:\s*function/gm;
            while ((m = r.exec(body)) !== null) { methods[m[1]] = true; }

            // Enyo synthesises a doFoo() sender for every onFoo declared in the
            // events block, and those are legitimate handler targets.
            var eventsMatch = /events\s*:\s*\{([\s\S]*?)\}/.exec(body);
            if (eventsMatch) {
                r = /\bon([A-Z][\w$]*)\s*:/g;
                while ((m = r.exec(eventsMatch[1])) !== null) {
                    methods["do" + m[1]] = true;
                }
            }

            r = /\bname\s*:\s*"([A-Za-z_$][\w$]*)"/g;
            while ((m = r.exec(body)) !== null) { names[m[1]] = true; }

            // Whatever the base kind contributes to $ is legitimately available
            // without being redeclared here.
            var baseMatch = /^\s*kind\s*:\s*(?:"([^"]+)"|([\w.]+))\s*,/m.exec(body);
            var base = baseMatch ? (baseMatch[1] || baseMatch[2]) : null;
            if (base && INHERITED_COMPONENTS[base]) {
                INHERITED_COMPONENTS[base].forEach(function (n) { names[n] = true; });
            }

            // Enyo mixes camelCase custom events (onSetupRow) with lowercase DOM
            // events (onclick), so both spellings have to be matched.
            r = /\b(on[A-Za-z][\w$]*)\s*:\s*"([A-Za-z_$][\w$]*)"/g;
            while ((m = r.exec(body)) !== null) {
                if (NON_HANDLER_PROPS[m[1]]) {
                    continue;   // a caption, not a handler
                }
                if (!methods[m[2]]) {
                    problems.push(rel + ":" + lineOf(src, block.start + m.index) +
                        "  " + m[1] + ' names handler "' + m[2] + '", which this kind does not define');
                }
            }

            r = /this\.\$\.([A-Za-z_$][\w$]*)/g;
            while ((m = r.exec(body)) !== null) {
                if (!names[m[1]]) {
                    problems.push(rel + ":" + lineOf(src, block.start + m.index) +
                        "  this.$." + m[1] + " has no matching component name in this kind");
                }
            }
        });
    });

    if (problems.length === 0) {
        var appKinds = Object.keys(definedKinds).length - FRAMEWORK_KINDS.length;
        console.log("lint-enyo: OK — " + files.length + " files, " + appKinds + " app kinds");
        process.exit(0);
    }

    console.log("lint-enyo: " + problems.length + " problem(s)\n");
    problems.forEach(function (p) { console.log("  " + p); });
    process.exit(1);
}

function lineOf(src, pos) {
    return src.substring(0, pos).split("\n").length;
}

main();
