#!/bin/bash
# Puts this checkout on a LuneOS device over adb, launches the app and runs
# tools/test/web/device-tests.js against it in the real WAM.
#
#   tools/test-device.sh <adb-serial> [name]
#
# On LuneOS the app and its service are a system package (/usr/palm, from
# the image), so the checkout's app and service directories are pushed over
# it, not installed as an ipk: the webOS ipk would land a second copy under
# /media/cryptofs without the LS2 configuration the image gives the system
# one. Before the first push the device's own copy is saved to
# test-output/device/<name>/orig.tar.gz; put it back with
#   adb -s <serial> push ... or: tools/test-device.sh --restore <serial> [name]
#
# The service is restarted so the pushed code is what answers (a running node
# service keeps serving the old code), and the run checks the build id it
# logs. Saved passwords is switched on for the run if it is off, since the
# dialog under test only appears then, and put back afterwards.
#
# COMPOSITOR=1 also saves the whole screen (captureCompositorOutput). It is
# off by default: on Titan kernels before the Mali sync fix that call
# panicked the kernel.
set -e
cd "$(dirname "$0")/.."

RESTORE=
if [ "$1" = "--restore" ]; then
	RESTORE=1
	shift
fi
SERIAL="$1"
NAME="${2:-$SERIAL}"
[ -n "$SERIAL" ] || { echo "usage: $0 [--restore] <adb-serial> [name]" >&2; exit 2; }
ADB="adb -s $SERIAL"
APP=com.palm.app.backup
SERVICE=com.palm.app.backup.service
APP_DIR=/usr/palm/applications/$APP
SERVICE_DIR=/usr/palm/services/$SERVICE
OUT="test-output/device/$NAME"
PORT=$((19000 + RANDOM % 900))
mkdir -p "$OUT"

# luna-send through a device file: its output does not survive an adb pipe.
luna() {
	$ADB shell "luna-send -w ${3:-20000} -n 1 '$1' '$2' > /tmp/woce-t.out 2>&1; cat /tmp/woce-t.out; rm -f /tmp/woce-t.out" </dev/null
}

if ! $ADB shell "test -d $APP_DIR && test -d $SERVICE_DIR" </dev/null; then
	echo "$NAME: no system install of $APP on this device; nothing to push over" >&2
	exit 1
fi

if [ -n "$RESTORE" ]; then
	[ -f "$OUT/orig.tar.gz" ] || { echo "no saved copy at $OUT/orig.tar.gz" >&2; exit 1; }
	$ADB push "$OUT/orig.tar.gz" /tmp/woce-orig.tar.gz >/dev/null
	# Back to exactly the saved tree: files the pushes added go too.
	$ADB shell "rm -rf $APP_DIR $SERVICE_DIR && tar -xzf /tmp/woce-orig.tar.gz -C / && rm -f /tmp/woce-orig.tar.gz" </dev/null
	$ADB shell "pkill -f '^com\.palm\.app\.backup\.service'; true" </dev/null
	echo "$NAME: restored the device's own $APP from $OUT/orig.tar.gz; service stopped, it restarts on the next call"
	exit 0
fi

echo "== $NAME: $($ADB shell getprop ro.product.vendor.device </dev/null) / $($ADB shell uname -m </dev/null)"

if [ ! -f "$OUT/orig.tar.gz" ]; then
	$ADB shell "tar -czf /tmp/woce-orig.tar.gz $APP_DIR $SERVICE_DIR 2>/dev/null" </dev/null
	$ADB pull /tmp/woce-orig.tar.gz "$OUT/orig.tar.gz" >/dev/null
	$ADB shell rm -f /tmp/woce-orig.tar.gz </dev/null
	echo "device's own copy saved: $OUT/orig.tar.gz"
fi

# The checkout as it would ship: the packaging exclude list applies here too.
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
EXCLUDES=$(grep -vE '^\s*(#|$)' packaging/package-exclude.txt | sed 's/^/--exclude=/')
# shellcheck disable=SC2086
tar -cf - $EXCLUDES -C . "$APP" "$SERVICE" | tar -xf - -C "$STAGE"
# Stamp a build id, as build.sh does, so the log says which code answers.
BUILD_ID="test-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- "$APP" "$SERVICE" || echo "+dirty")-$(date +%Y%m%d-%H%M%S)"
sed -i "s/^var SERVICE_BUILD = \".*\";/var SERVICE_BUILD = \"$BUILD_ID\";/" "$STAGE/$SERVICE/assistants/service-assistant.js"
grep -q "\"$BUILD_ID\"" "$STAGE/$SERVICE/assistants/service-assistant.js" || { echo "could not stamp the build id" >&2; exit 1; }
tar -czf "$OUT/push.tar.gz" -C "$STAGE" "$APP" "$SERVICE"
$ADB push "$OUT/push.tar.gz" /tmp/woce-push.tar.gz >/dev/null
$ADB shell "mkdir -p /tmp/woce-push && tar -xzf /tmp/woce-push.tar.gz -C /tmp/woce-push && \
	cp -a /tmp/woce-push/$APP/. $APP_DIR/ && cp -a /tmp/woce-push/$SERVICE/. $SERVICE_DIR/ && \
	rm -rf /tmp/woce-push /tmp/woce-push.tar.gz && sync" </dev/null
echo "pushed $BUILD_ID"

# A reinstall does not restart a running node service. The patterns are
# The service's process title is its name (padded with spaces); anchored at
# the start, the pattern
# cannot match the shell running pkill.
# A plain TERM has been seen not to take on the TouchPad, so wait for the
# process to go and escalate if it does not.
$ADB shell "luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{\"id\":\"$APP\"}' >/dev/null 2>&1; \
	pkill -f '^com\.palm\.app\.backup\.service'; \
	for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f '^com\.palm\.app\.backup\.service' >/dev/null || break; sleep 0.5; done; \
	pkill -9 -f '^com\.palm\.app\.backup\.service'; true" </dev/null
STATE=$(luna "luna://$SERVICE/getUserDataCategories" '{}' 60000)
RUNNING=$($ADB shell "journalctl -b --no-pager | grep 'service starting, build' | tail -n 1" </dev/null)
case "$RUNNING" in
	*"$BUILD_ID"*) echo "service running $BUILD_ID" ;;
	*) echo "the service is not running the pushed code: $RUNNING" >&2; exit 1 ;;
esac

PASSWORDS_WERE=$(echo "$STATE" | node -e 'var s="";process.stdin.on("data",function(d){s+=d;}).on("end",function(){
	try { var c=JSON.parse(s).categories.filter(function(x){return x.id==="passwords";})[0]; console.log(c ? String(c.enabled===true) : ""); }
	catch (e) { console.log(""); } });')
echo "Saved passwords on this device: ${PASSWORDS_WERE:-unknown}"

cleanup() {
	$ADB forward --remove tcp:$PORT >/dev/null 2>&1 || true
	if [ "$PASSWORDS_WERE" = "false" ]; then
		luna "luna://$SERVICE/setUserDataCategories" '{"categories":{"passwords":false}}' >/dev/null
		echo "Saved passwords switched back off"
	fi
}
trap cleanup EXIT

if [ "$PASSWORDS_WERE" = "false" ]; then
	luna "luna://$SERVICE/setUserDataCategories" '{"categories":{"passwords":true}}' >/dev/null
	echo "Saved passwords switched on for the run"
fi

$ADB shell "luna-send -n 1 luna://com.palm.display/control/setState '{\"state\":\"on\"}' >/dev/null 2>&1; \
	luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"$APP\"}' >/dev/null 2>&1" </dev/null
$ADB forward tcp:$PORT tcp:9998 >/dev/null

RC=0
DEVICE_SERIAL="$SERIAL" DEVICE_DEBUG=http://127.0.0.1:$PORT DEVICE_NAME="$NAME" node tools/test/web/device-tests.js || RC=$?

if [ -n "$COMPOSITOR" ]; then
	luna luna://com.webos.surfacemanager/captureCompositorOutput '{"output":"/tmp/woce-shot.png","format":"PNG"}' >/dev/null
	$ADB pull /tmp/woce-shot.png "$OUT/compositor.png" >/dev/null 2>&1 && echo "screen: $OUT/compositor.png"
	$ADB shell rm -f /tmp/woce-shot.png </dev/null
fi
echo "screenshots: $OUT/"
exit $RC
