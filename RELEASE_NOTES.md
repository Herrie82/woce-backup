# woce-backup 1.1.0

*2026-08-21*

Installs as a replacement for the built-in Backup app, and fixes a run of
defects found in a review of 1.0.0.

## It now takes over the stock app's id

```
package   com.palm.app.backup
app       com.palm.app.backup           (same id as the stock app)
service   com.palm.app.backup.service
```

The service could not also take `com.palm.service.backup`: `palm-package`
requires the app id and every service id to be a subdomain of the package id,
and the two stock ids share only `com.palm`. The service name is still
`com.palm.`-prefixed, which is the part that governs private-bus access.

Because the daemon no longer needs to force a private-bus role for our own
name — and writing one alongside the hub's generated role would throw
*"duplicate service name to permission map"* and drop **both** grants — that
step is gone. The `woce-lunacall` identity and the `mojodb.conf` admin grant
stay, as the fallback.

## Fixed

- **Automatic app reinstall almost never reported success.** Fetching and
  reinstalling archived `.ipk`s was wrapped in a generic 20s timeout, against a
  helper that budgets 60s *per package*; archiving had a flat 60s for the whole
  set. In practice every app came back listed as "could not be reinstalled
  automatically" while ipkg was still installing it — and the staging directory
  was then deleted out from under the running installs. Budgets now scale with
  the package count, and the staging cleanup is skipped if an operation is
  still running.
- **A rejected path was reported as a completed write.** `new Future(err)` is a
  *successful* future carrying an Error in Foundations, so a file that was
  never written was recorded in the manifest as stored — poisoning later
  incremental backups that deduped against it.
- **Backing up could delete another device's backups.** Trimming to
  `manifestsToKeep` counted every manifest in the target, not just this
  device's, so importing backups from another device and running one backup
  here deleted the imported ones.
- **Restoring no longer starts without asking.** With exactly one backup
  present, the picker was skipped and "Restore a backup..." overwrote the
  device outright; the picker itself never confirmed either.
- **A backup now checks free space first** and refuses with a clear message
  instead of failing partway through. `getSpace()` had been implemented on both
  targets since the beginning and was never called.
- **Failures say what happened.** Backup, delete and category-save failures
  showed nothing at all — no dialog, no text — and the service's `errorText`
  went only to the log.
- **Large files no longer risk exhausting memory.** The copy path for every
  stored and restored file ignored stream backpressure.
- **Scanning media no longer blocks the service.** The "what to back up"
  estimate ran a synchronous recursive walk on every app launch and every
  window activation, stalling everything else including a running backup.
- **The launch scrim can no longer hang the app** if a service call never
  answers.
- **Assorted leaks and stuck state**: status listeners accumulated on every
  re-subscribe (now released via `cancelSubscription`); a restore that never
  settled left every later restore rejected as "already in progress"; a
  category toggle that failed to save reverted to the value that failed; the
  root helper had no `uncaughtException` handler, so a throw in an async
  callback killed it silently and everything quietly degraded to limited mode.

## Testing

The off-device suite could not run at all without the webOS Doctor extract:
the fallback path in `tools/test/future.js` read the wrong field, so every
assertion saw `undefined`. Fixed, plus regression coverage for the free-space
refusal and the cross-device purge. 102 checks.

---

# woce-backup 1.0.0

*2026-08-20*

The stock Backup app still launches on every webOS TouchPad, and still can't
back up a single file — Palm's cloud storage and metadata servers went dark
in 2013, and `doBackup()` fails before it touches anything. Nothing about the
platform's own backup protocol is broken, though: every service still drops
a registration file, `com.palm.db` still answers, LunaSysMgr's app data
backup still works. woce-backup reuses that protocol exactly as it is and
writes to the device's own storage instead of Palm's dead servers.

This is the first release.

## What it backs up

- Accounts, contacts, calendar, system settings, browser data, and
  application data (HTML5 databases and local storage) — everything the
  stock app's protocol already covers.
- The applications themselves. When the original `.ipk` is still in Preware's
  or WOSQI's download cache, it's archived and reinstalled automatically on
  restore. When it isn't — the common case for anything installed a while
  back — the installed app's own directory is archived instead and put back
  in place directly; the app reappears the same way a fresh install would,
  after the reboot restore already prompts for. (System apps aren't included
  here — they come back through the OS's own update path, not this one.)
- User media — photos, videos, music, documents, downloads, ringtones — as
  individually selectable categories, off by default since a local backup
  shares the same storage the media already lives on. Each category shows a
  live file count and size before you turn it on.

Backups are incremental: unchanged files are referenced, not recopied, so a
second backup of the same device is fast and small.

## Managing backups

- A dedicated backup list, something the cloud-based original never needed —
  each entry shows its date, size, type, and whether anything had to be
  skipped.
- Delete a backup you no longer need — tap it for the option, or swipe. Only
  the files that backup alone referenced are reclaimed; anything shared with
  another backup stays.
- A restored backup is marked as such, with when it was last restored — that
  travels with the backup itself, so it shows up from any device reading the
  same storage, not only the one that ran the restore.

## Restoring

- Pick a backup and restore, no wipe required — restore used to live only in
  First Use, meaning a full device reset just to reach it.
- A completed restore's Done button becomes **Restart** and reboots the
  device directly, since some of what was just restored — including a couple
  of the permission grants this app itself relies on — only takes effect on
  the next boot. Anything the automatic app reinstall couldn't manage on its
  own is listed with a direct link into the App Catalog.

## Full functionality needs the privileged helper

Installing through **Preware or WebOS Quick Install** (not `palm-install`)
sets up a small root helper alongside the app — required because the backup
service itself runs jailed, and the jail can't see everywhere a real backup
needs to reach. Without it, the app still runs and still backs up the bulk of
your data, just with an amber notice and a manifest listing exactly what had
to be skipped.

**Reboot once after the very first install.** The helper writes its own
permission grants immediately, automatically — nothing to run by hand — but
a couple of them are only read by the rest of the system at its own boot.
Upgrades after that don't need another one.

## Known limitations

- **Backups are not encrypted**, deliberately. The original encrypted with a
  device key that doesn't survive a webOS Doctor and doesn't exist on other
  hardware — encrypting a *local* backup the same way would make it unreadable
  in the two situations you'd actually reach for it. If that matters for your
  threat model, treat `/media/internal/webos-backups` accordingly.
- An app restored via the installed-directory fallback (no cached `.ipk`)
  runs normally, but Software Manager/Preware may not recognize it as a
  package they can manage or cleanly uninstall — that path doesn't
  reconstruct ipkg's own bookkeeping for it, only the app itself.

## Coming later: online backup via Synergy

Everything above writes to `/media/internal` on the device itself. The
backup and restore engine was built against a small, deliberately narrow
target interface (`list`, `get`, `putFile`, `postFile`, `del`, `batchDel`) —
the same shape the stock service used against Palm's servers — so a cloud
destination is a matter of implementing that interface once, not changing
the engine. `com.palm.service.boxnet` is still present on stock 3.0.5 and is
the obvious first Synergy connector to target; it isn't wired up yet. Local
backup and restore don't depend on it and aren't blocked by it.

## Credit

The protocol, the manifest format, and most of the UI come from Palm's
`com.palm.app.backup` and `com.palm.service.backup`, read out of a webOS
3.0.5 Doctor image. The restore flow is a port of First Use's, brought
forward so restoring no longer requires wiping the device to reach it. This
is a restoration, not a reimplementation.
