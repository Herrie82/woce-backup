#!/bin/bash
#
# Builds com.woce.backup_<version>_all.ipk from the three package directories.
#
# palm-package only writes a control.tar.gz containing ./control, so the
# maintainer scripts are injected afterwards by tools/repack_ipk.py.
#
set -e

cd "$(dirname "$0")"

APP="com.woce.backup"
SERVICE="com.woce.backup.service"
PACKAGE="com.woce.backup.package"
OUT="build"

# The SDK is at a different path on each host, and on Windows it is a .bat.
find_palm_package() {
    if command -v palm-package >/dev/null 2>&1; then
        command -v palm-package
        return
    fi
    for candidate in \
        "/c/Program Files/PalmSDK/Current/bin/palm-package" \
        "/c/Program Files (x86)/HP webOS/SDK/bin/palm-package.bat" \
        "/opt/PalmSDK/Current/bin/palm-package"
    do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    return 1
}

PALM_PACKAGE="$(find_palm_package)" || {
    echo "error: palm-package not found. Install the Palm/HP webOS SDK." >&2
    exit 1
}

PYTHON="$(command -v python3 || command -v python)" || {
    echo "error: python3 not found; it is needed to inject postinst/prerm." >&2
    exit 1
}

VERSION="$("$PYTHON" -c "import json;print(json.load(open('$APP/appinfo.json'))['version'])")"

echo "woce-backup $VERSION"
echo

# Enyo evaluates a kind's components array at definition time, so a label or
# kind named there must already be loaded. node --check cannot see that, and on
# device it surfaces only as "Failed to find a constructor for kind [X]".
echo "Checking app load order..."
node tools/lint-enyo.js

# Stamp the build id into the service. Reinstalling does not restart a running
# node service, so without this there is no way to tell from the log whether the
# code being exercised is the code that was just built.
BUILD_ID="$VERSION+$(date +%Y%m%d-%H%M%S)"
echo "Stamping build $BUILD_ID..."
"$PYTHON" - "$BUILD_ID" <<'STAMP'
import re, sys
path = "com.woce.backup.service/assistants/service-assistant.js"
src = open(path, encoding="utf-8").read()
src = re.sub(r'var SERVICE_BUILD = "[^"]*";',
             'var SERVICE_BUILD = "%s";' % sys.argv[1], src)
open(path, "w", encoding="utf-8").write(src)

# The root helper carries the same id, for the same reason.
path = "device/woce-backupd.js"
src = open(path, encoding="utf-8").read()
src = re.sub(r'var VERSION = "[^"]*";',
             'var VERSION = "%s";' % sys.argv[1], src)
open(path, "w", encoding="utf-8").write(src)
STAMP

# Staged after stamping, so the bundled daemon carries the build id — it is
# the copy postinst installs, and a stale one there is how a daemon ends up
# serving code older than the package it came in.
# The postinst copies the helper out of the installed app bundle, so it has to
# ship inside it. Kept as a build step rather than a second copy in the tree, so
# device/ stays the single source of truth.
echo "Staging device components into the app bundle..."
rm -rf "$APP/device"
mkdir -p "$APP/device"
cp device/woce-backupd.js device/woce-backupd.conf "$APP/device/"

echo "Packaging..."
rm -rf "$OUT"
mkdir -p "$OUT"
"$PALM_PACKAGE" "$PACKAGE" "$APP" "$SERVICE" -o "$OUT"

IPK="$(ls -t "$OUT"/*.ipk 2>/dev/null | head -1)"
if [ -z "$IPK" ]; then
    echo "error: palm-package produced no .ipk" >&2
    exit 1
fi
echo "  $IPK"

echo "Injecting postinst/prerm..."
"$PYTHON" tools/repack_ipk.py "$IPK" device/postinst device/prerm

echo
echo "Built: $IPK"
echo
echo "Install with Preware or WebOS Quick Install so the postinst runs as root."
echo "palm-install also works, but skips the privileged helper and the app"
echo "will report limited mode."
