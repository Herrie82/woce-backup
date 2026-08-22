# woce-backup

A working Backup and Restore app for Palm/HP webOS 3.0.5, rebuilt to store
backups **on the device** instead of on Palm's servers.

The stock `com.palm.app.backup` still ships on every webOS device and still
launches, but it cannot work: it was a thin UI over `com.palm.service.backup`,
which uploaded everything to Palm's cloud storage and metadata servers. Those
went dark in 2013, and the service fails before it touches a single file —
`doBackup()` calls `metadataServer.logBackupStarted()` as its first real step.

Nothing underneath is broken. Backup on webOS was never implemented by reading
files directly; each participating service drops a registration file into
`/etc/palm/backup/` naming its callbacks, and the backup service walks them:

```
preBackup(tempDir)  ->  a list of files    postBackup()
preRestore(version) ->  { proceed }        postRestore(files, tempDir)
                                           restoreFinished()
```

That protocol, `com.palm.db`'s `internal/preBackup` dump, and LunaSysMgr's
`com.palm.appDataBackup` (HTML5 app data) all still work perfectly. woce-backup
reuses them exactly as they are, and swaps out only the destination.

---

## What it backs up

Everything the stock backup did, because it asks the same services:

- Accounts, contacts and calendar
- System settings and preferences
- Browser data and stored credentials
- Application data (HTML5 databases and local storage, via `com.palm.appDataBackup`)
- Anything a third-party app registers for itself
- The applications themselves. Whatever `.ipk` is still sitting in Preware's
  or WOSQI's download cache gets archived and, on restore, reinstalled
  automatically via `ipkg` — no App Catalog round trip, no tapping through
  installers one at a time. For anything installed long enough ago that its
  original `.ipk` is gone from both caches — the common case — the fallback
  is the installed app's own directory under
  `/media/cryptofs/apps/usr/palm/applications/`, tarred up as-is and put back
  the same way on restore. LunaSysMgr picks it up the same way it picks up a
  fresh install: by scanning that directory at its own next boot, which
  restore already prompts for. The one thing that path doesn't reconstruct is
  ipkg's own record of the package, so Software Manager/Preware may not offer
  to manage or cleanly uninstall an app that came back this way even though it
  runs — a real, permanent trade-off of this fallback, not a bug. Only
  something to notice if both come up empty: not installed by ipkg at all
  (some app-catalog-installed apps use a different layout), or gone from disk
  entirely. `com.palm.*`-owned apps are left out of all of this: they come
  back through the OS/OTA process, not this app's restore. So is anything
  living in `/usr/palm/applications` — that is the system image, flashed rather
  than installed, and not the user's to back up. `ipkg` alone will not tell you
  which those are: its status file is the cryptofs one, but an image is free to
  seed a stanza there for an app it *baked* into the rootfs, which webOS CE 3.1
  does for Preware, Govnah and the Synergy runtime so Preware shows them as
  installed. Anything already
  present on the device you're restoring onto — never uninstalled, or put back
  manually before running restore — is skipped too, checked against that
  device at restore time, not against what was installed when the backup was
  made — and that check covers the system image too, which matters on the
  upgrade path this app exists to serve: an app that genuinely *was* a cryptofs
  install on webOS 3.0.5 can be baked into the rootfs on CE 3.1, and putting the
  backed-up copy back would not restore it, it would **shadow** the newer system
  copy with a 2013 one.

A backup checks that there is room before it starts, and refuses with a clear
message rather than failing somewhere in the middle. Plus, optionally, user
media from `/media/internal` — photos, videos, music,
documents, downloads, ringtones — as individually selectable categories. These
are **off by default**: a local backup is written to the same volume the media
lives on, so including them uses storage twice over. The "What to back up"
screen shows a live file count and size per category so the cost is visible
before you switch one on.

## Where backups go

```
/media/internal/webos-backups/
    manifests/000001-<nduId>      one JSON manifest per backup
    files/<md5>[.gz]              content-addressed file store
```

Content addressing is what makes backups incremental: a file whose contents have
not changed hashes to a name that is already present, so it is referenced by the
new manifest and never copied again.

`/media/internal` is the USB mass-storage area, so backups are plain files you
can copy off the device — or back onto it — with no tooling.

## Backups are not encrypted

This is a deliberate departure from stock, and the most important thing to know
about this app.

The original encrypted every file with a device key held by
`com.palm.keymanager`. That key does not survive a webOS Doctor, and does not
exist on a different device. Encrypting a *local* backup the same way would make
it unreadable in precisely the two situations you would reach for it — after a
wipe, or when moving to another device.

So woce-backup compresses but does not encrypt. A backup is restorable after a
Doctor, and onto different hardware. It also means **anyone with access to the
device's USB storage can read your accounts and settings**. If that matters for
your threat model, copy the backup somewhere safe and delete it from the device.

---

## It installs as the stock Backup app

The app id is `com.palm.app.backup` — the id the built-in Backup app uses. The
package installs to `/media/cryptofs/apps/usr/palm/applications/com.palm.app.backup`,
while the original stays where it is on the read-only system partition. Two
directories then claim the same id, which is the usual way an app is overridden
on this platform, and it is why the id was taken rather than a fresh one
invented.

The service could not take the stock service's id to match. `palm-package`
requires the app id *and* every service id to be a subdomain of the package id,
and `com.palm.app.backup` and `com.palm.service.backup` share only `com.palm` —
naming the package after the whole Palm namespace to satisfy that would be
worse than the alternative. So the service is `com.palm.app.backup.service`,
which is still `com.palm.`-prefixed, which is the part that matters for
private-bus access. The dead stock service keeps its own name and is simply
never called.

```
package   com.palm.app.backup
app       com.palm.app.backup           (same id as the stock app)
service   com.palm.app.backup.service
```

## Installing

```bash
./build.sh
```

Produces `build/com.palm.app.backup_1.1.0_all.ipk`. Needs the Palm/HP webOS SDK for
`palm-package`, and Python 3 to inject the maintainer scripts (`palm-package`
writes a `control.tar.gz` containing only `./control`).

**Install with Preware or WebOS Quick Install**, not `palm-install`. Only those
run the `postinst` as root, which is what installs the privileged helper —
nothing further to run by hand. **Reboot once after the very first install**
(not needed again on later upgrades) — see "Reboot once after the first
install" below for why.

`palm-install` works too, but skips the helper. The app then runs in **limited
mode** and says so on its main screen — see below.

## Packaging for a feed

`build.sh` also rewrites the control file from `packaging/preware.json`. That is
not cosmetic. `palm-package` emits `Section: misc`, `Maintainer: N/A
<nobody@example.com>` and `Description: This is a webOS application.` — and
Preware reads the Description as the package **title**, files `misc` under
*Unsorted*, and special-cases that email address to hide it. Left alone, the
package shows up in the feed untitled and uncategorised.

Everything else Preware displays comes from a single-line JSON blob in the
`Source:` field, the convention the WebOS Internals feed uses and which Preware
parses in `app/models/package.js`. `packaging/preware.json` is the editable
source for it and lists which keys Preware actually reads.

Two of them earn their place:

- `PostInstallFlags: ["RestartDevice"]` — Preware prompts for the restart the
  first install needs (below), instead of leaving it to a README nobody reads.
- `MinWebOSVersion: 3.0.0`, and deliberately **no** `MaxWebOSVersion` — Preware
  treats a package capped at 3.0.5 as incompatible with a webOS CE 3.1 device,
  so capping it would hide future updates from exactly the users this is meant
  to carry forward.

`Version` cannot be set there: it comes from
`com.palm.app.backup/appinfo.json` by way of `palm-package`, which stays the
single source of truth.

## Limited mode, and why the helper exists

The backup service runs as a jailed Node service. Per `/etc/jail_triton.conf`
that jail gets `/etc/palm` read-only, `/media/internal` and `/var/file-cache`
read-write — but **not** `/var/preferences`, `/var/palm/data` or
`/media/cryptofs`.

Most services hand over their data by writing it into a temp directory we
provide, which works fine from inside the jail. But some legitimately return
absolute paths into those unreachable trees — `com.palm.service.contacts`
returns contact photo paths directly, for instance. Without a helper outside the
jail, those files simply cannot be read.

`woce-backupd` is that helper: a small root process started by upstart, talking
to the service through job files in `/media/internal/.woce-backup/jobs`. One job
covers a whole service's file list, so polling never dominates a run.

Without it, backups still capture db8, application data and everything under
`/media/internal` — the bulk of what you care about. The app shows an amber
notice, and each manifest records exactly which paths were skipped. Archiving
and reinstalling applications is helper-only too — `ipkg` has to run as root —
so without it, installed apps are listed in the manifest for the record but
never archived or reinstalled.

### A note on the helper's security

The job directory is on user-writable storage that is also exposed over USB, so
anything that can write there can ask the daemon to act. That is bounded
deliberately: there is no general "run a command" operation, every operation
validates its own arguments, and `unstage` — the only file-writing one that
writes outside the working area — checks each destination against an allowlist
with `/var/palm/ls2/`, `/etc/` and `/usr/` explicitly carved out, resolving
symlinked parents first.

`installPackages` is the exception worth calling out on its own: it is the one
operation that runs arbitrary code, since `ipkg install` executes a package's
postinst script as root, the same as any sideloaded install on the device. It
only ever touches an `.ipk` already inside the daemon's own working area —
never an arbitrary job-supplied path — which means it can only install a file
this same daemon fetched from a backup target during a restore this same
daemon is running. The trust boundary it actually depends on is the one every
restore already depends on: the backup target's own contents, which restore is
already writing straight back into db8 and preferences. This extends that same
boundary to the `.ipk`s that were sitting in it, rather than opening a new one.

`restoreAppDirectories` is the fallback's counterpart: no postinst runs, so it
doesn't carry the same arbitrary-code risk, but it does `rm -rf` the
destination before un-tarring, and that destination is never job-supplied —
always `INSTALLED_APPS_DIR` plus the already-validated app id, so it can only
ever touch that one app's own directory.

Read the top of `device/woce-backupd.js` before changing any of this.

## Reboot once after the first install

A third-party Node service would normally need a role file in
`/var/palm/ls2/roles/prv/` just to *reach* the private bus at all — the
service does not, and shipping one for that purpose would be pointless:

- `/usr/share/ls2/roles/prv/com.palm.nodejs.json` already claims
  `/usr/palm/nodejs/node` with `type: "privileged"` and `allowedNames: ["*"]`.
- `ls-hubd` scans `/usr/share` **before** `/var/palm` and the first matching
  `exeName` wins, so a role file of ours naming the same binary would be
  silently ignored.
- Every Node service on the device — including the stock backup service —
  registers under that one wildcard role. We inherit exactly the reach the
  original had.

But *reaching* the private bus and being allowed to *call out* on it turn out
to be different questions. LunaSysMgr auto-generates a role for every
third-party JS service with `"outbound": []` hardcoded — measured on device,
`com.palm.*`-named services get a permissive role instead, regardless of
where they're installed from or what they declare. Without matching that, the
one call the entire backup depends on, `com.palm.db/internal/preBackup`,
comes back as an unknown method.

Naming the service `com.palm.app.backup.service` should put it on the
permissive side of that rule by itself. The daemon used to write a role of our
own to force it, and deliberately no longer does: the hub already has a
generated role claiming this name, and a second role file naming the same
service in its `permissions` block throws *"Attempting to add duplicate service
name to permission map"* — which drops **both** grants. The workaround would
take out the thing it was working around.

What the daemon still writes at every startup is the role for its private
`luna-send` copy (`woce-lunacall`, running as `com.palm.backup.privileged`) and
a direct edit to `/etc/palm/mojodb.conf` granting that name db8's admin role —
see the top of `device/woce-backupd.js` for why each is needed and why neither
has a real API to request through instead. That pair is also the fallback if
the prefix rule turns out not to work the way it was measured: whenever a
direct private-bus call comes back "unknown method", the call is retried
through the helper.

Both are written to disk immediately, during `postinst`'s own first start of
the daemon — nothing to run by hand. But `ls-hubd` and `mojodb-luna` each read
their configuration once, at their own startup, not on every change to the
file — so **the very first install needs one reboot** afterward before the
grants actually take effect. It is not independently confirmed here how much
works in the narrow window before that first reboot, so treat the reboot as the
actual last install step rather than an optional cleanup. An upgrade over an
existing install doesn't need another reboot — the grants from the first
install are already in place.

---

## Layout

```
com.palm.app.backup/            Enyo 0.10 app (the UI)
com.palm.app.backup.service/    Node service (the engine)
com.palm.app.backup.package/    packageinfo.json tying them together
device/                     root helper, upstart job, postinst/prerm
packaging/                  feed metadata for the control file
tools/                      build and test tooling
```

The app is a close port of the stock `com.palm.app.backup`, with the restore
flow brought over from First Use — where restore lived on stock webOS, meaning
you had to wipe the device to reach it. Screens the original did not have
(backup list, destination picker, category selection) sit below the original
layout rather than rearranging it. From that list, a backup can be deleted as
well as restored — tap a backup for the option, or swipe it. Restoring always
asks first, whichever way you reach it: the picker confirms the backup you
tapped before anything is overwritten. A restored
backup is marked as such, with when it was last restored — recorded on the
manifest itself, so it shows up from any device reading the same target, not
just the one that ran the restore.

Some restored state — role file grants among it — only takes effect on the
next boot, so a finished restore's Done button becomes **Restart** and reboots
the device directly through the privileged helper. Limited mode has no helper
to do that with, so it falls back to the plain Done button and asks you to
restart yourself, same as before this existed.

Every screen but the main one exits through its own bottom Toolbar (Cancel,
Done, or Restart) rather than the header's back arrow, matching how other
system apps anchor their own primary action — the header arrow is hidden
everywhere but the main screen accordingly. On launch, a full-page scrim
covers the main screen until every piece of its state has loaded, so nothing
is visible mid-populate.

### The target abstraction

`com.palm.app.backup.service/targets/` is the seam for cloud support. `TargetBase`
declares the same method set the stock service's `Storage` class used against
Palm's servers:

```
list  get  putFile  postFile  del  batchDel
```

The backup and restore engines call nothing else, so adding a Synergy connector
means implementing that interface and adding one line to `targets.js` — no
engine change. `com.palm.service.boxnet` is still present on 3.0.5 and is the
obvious first candidate.

## Testing

```bash
node tools/test/run-tests.js      # VERBOSE=1 for the service's own logging
node tools/lint-enyo.js           # app load-order check; also runs in build.sh
```

`lint-enyo.js` exists because Enyo evaluates a kind's `components` array at
definition time, so any label or kind it names must already be loaded. Nothing
else catches that: `node --check` sees valid syntax, and on device it surfaces
only as `Failed to find a constructor for kind [X]` with no hint at the cause.
It checks both directions — kinds referenced before their defining file loads,
and `label_*` identifiers used at definition time before assignment.

Runs the real handlers off-device against a temp filesystem, with fake
registered services standing in for `com.palm.db` and friends. Covers the
protocol sequencing, content addressing, incremental dedup, restore (including
restoring an older backup and checking the content that comes back), the
`restoreFinished` fan-out, delete-and-purge reference counting, opt-out erase,
dynamic registration, and both failure paths.

The tests run against the **real** Palm Foundations `Future`, loaded straight
out of the Doctor extract by `tools/test/future.js` (four small globals stubbed:
`Assert`, `Queue`, `console`, `exports`). That was not the first approach and
the change mattered: a hand-written stand-in agreed with Foundations closely
enough to pass everything while the device failed, because the divergence lived
in exactly the corner the bug did — `nest()` on a not-yet-complete future.
Testing a model of the framework only proves things about the model.

For the same reason the fake db8 and Luna bus resolve on a later tick rather
than immediately. Synchronous fakes make `nest()` always take its "already
complete" path, so the asynchronous path — the one every real call takes — never
runs.

A simplified fallback (`future-fallback.js`) is used when the Doctor extract is
absent, with a warning, so the suite still runs; a green result under it means
less.

What this cannot cover is the Luna bus and the jail. Those need a device.

### On-device checks

```bash
luna-send -n 1 -f palm://com.palm.app.backup.service/getBackupStatus '{}'
luna-send -n 1 -f palm://com.palm.app.backup.service/startBackup '{"full":true}'
tail -f /var/log/messages | grep woce
cat /var/log/woce-backupd.log
```

Then confirm `/media/internal/webos-backups/manifests/000001-<nduId>` exists and
parses, that a second backup dedups instead of re-storing, and that
`getBackupStatus` reports `privileged: true`.

## Credit

The protocol, the manifest format, the status model and most of the UI come from
Palm's `com.palm.app.backup` and `com.palm.service.backup`, read out of a webOS
3.0.5 Doctor. UI assets are the originals. This is a restoration, not a
reimplementation.
