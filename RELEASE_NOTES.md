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
