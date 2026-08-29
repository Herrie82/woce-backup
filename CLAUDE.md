# woce-backup — webOS Project

This is a **Palm/HP webOS** application (original 2009–2012 platform, not LG webOS).

## Session Setup

At the start of every session, load the full webOS platform context:

```
webos://knowledge/all
```

This gives you knowledge of the Mojo/Enyo frameworks, Luna service bus, SDK tools
(including novacom), app structure conventions, and common gotchas — so we don't
have to re-establish basics each time.

---

## Project Details

**App ID:** `com.palm.app.backup` — deliberately the *stock* app's id, so this
installs as a replacement for the built-in Backup app rather than alongside it.
**Service ID:** `com.palm.app.backup.service`
**Package ID:** `com.palm.app.backup`
**Framework:** Enyo 0.10 (TouchPad)
**Target devices:** TouchPad (topaz); Pre 3 / Veer should work
**webOS version(s):** 3.0.5

## What this is

A working replacement for the stock Backup app, which cannot function because
Palm's cloud storage and metadata servers went dark in 2013. woce-backup reuses
the platform's still-intact registration protocol and writes to local storage
instead. See `README.md` for the full picture — it is the source of truth and
worth reading before making changes.

## App Structure

```
com.palm.app.backup/            Enyo 0.10 app; close port of the stock
                                com.palm.app.backup, plus the restore flow
                                ported from First Use
com.palm.app.backup.service/    Node service; port of com.palm.service.backup
                                with the cloud swapped for a pluggable target
com.palm.app.backup.package/    packageinfo.json
device/                         root helper daemon, upstart job, postinst/prerm
tools/                          build (repack_ipk.py) and off-device harness
```

Directory names are the ids, and the ids are constrained: **`palm-package`
requires both the app id and every service id to be a subdomain of the package
id** (`application id "X" must be subdomain of package id "Y"`, and the same
message for services). That is why the service is `com.palm.app.backup.service`
and not the stock `com.palm.service.backup` — the two stock ids share only
`com.palm`, and claiming that as the package id would name the ipk after the
entire Palm namespace. It is also why they all sit under one base name.

Reference sources live in the 3.0.5 Doctor extract at
`../touchpad/305doctor/resources/webOS/nova-cust-image-topaz.rootfs/`:
- `usr/palm/applications/com.palm.app.backup/`
- `usr/palm/services/com.palm.service.backup/`
- `usr/palm/applications/com.palm.app.firstuse/source/restore/`
- `etc/palm/backup/` — the registration files the whole thing hinges on

## Things that will bite you

Enyo/UI-layer gotchas now live in [`com.palm.app.backup/CLAUDE.md`](com.palm.app.backup/CLAUDE.md),
which loads automatically when working in that directory.

- **No LS2 role file is needed, and one would be ignored.**
  `/usr/share/ls2/roles/prv/com.palm.nodejs.json` already claims
  `/usr/palm/nodejs/node` as `privileged` with `allowedNames: ["*"]`, and
  `/usr/share` beats `/var/palm` on precedence. Every Node service inherits it.
- **The service is jailed** (`/etc/jail_triton.conf`): `/etc/palm` ro,
  `/media/internal` + `/var/file-cache` rw, but **not** `/var/preferences`,
  `/var/palm/data`, `/media/cryptofs`. That is the entire reason `device/`
  exists.
- **A reinstall does NOT restart a running node service.** It keeps serving the
  old code, and nothing in the log says so. `build.sh` stamps a build id that
  the service logs at startup — check it before trusting any other symptom:
  `grep "service starting, build" /var/log/messages | tail -1`.
- **Private-bus outbound IS name-dependent — measured on device.** LunaSysMgr
  generates a role for each third-party JS service from
  `/usr/palm/ls2/templates/Triton.prv`, which hardcodes `"outbound": []`. But
  `com.palm.service.payment` — third-party, in `/media/cryptofs/apps`, shipping
  no role of its own — has `outbound: ["*"]` on the private bus, while
  `com.achunt.jukie.service`, `ca.canucksoftware.filemgr` and ours all had
  `[]`. The `com.palm.` prefix is the only differentiator — which the rename to
  `com.palm.app.backup.service` puts us on the right side of, *if* the rule
  really is a prefix test and not a fixed list. That has not been re-measured
  since the rename; the `woce-lunacall` fallback below is what makes it safe
  either way.
- **`palm_bus_config.json` is ignored.** The payment service declares
  `privateBusAccess: false` and still got `outbound: ["*"]`; we declare `true`
  and got `[]`. Do not reason from that file.
- **The daemon no longer writes a prv role for our own service, and must not
  start again.** `ensurePrivateBusRole` used to write
  `/var/palm/ls2/roles/prv/<service>.json` granting ourselves `outbound: ["*"]`,
  because the generated third-party role hardcodes `[]`. Under the
  `com.palm.*` name that grant should now come for free — but the reason to
  delete it rather than leave it as harmless insurance is that it is *not*
  harmless: the hub already has a generated role claiming this name, and a
  second role file naming the same service in its `permissions` block throws
  `Attempting to add duplicate service name to permission map`, **which drops
  both grants**. The workaround would take out the thing it was working
  around. `prerm` no longer deletes that file either, since nothing creates it.
  The `woce-lunacall` role is a different file for a different name and is
  still written.
- **The service is on the PUBLIC bus.** `palm_bus_config.json` is not honoured
  for third-party services. A service is reachable there only if it has a file
  in `/usr/share/dbus-1/services` (36 of them) — *not*
  `/usr/share/dbus-1/system-services`, which is the private list (107). A pub
  *role* file is not enough; without a service file the hub cannot launch it and
  answers `Service does not exist`.
  - Reachable: `com.palm.db`, `systemservice`, `keymanager`, `browserServer`,
    `service.accounts`, `filecache`, `activitymanager`, `power`, `preferences`.
  - Not: `deviceprofile`, `service.contacts`, `eas`, `messaging.chatthreader`,
    `service.migration`. `system.palmcall` retries those through the root
    helper, which shells `luna-send` — **luna-send defaults to the private
    bus** (`-P` selects public).
- **nduId comes from `/dev/nduid`**, not `com.palm.deviceprofile`. The jail
  copies that node mode 444 (`do_nduid` is set for every device in
  `jail_device.conf`); deviceprofile is private-bus only.
- **`com/palm/db/internal/preBackup` needs db8's "admin" role, granted by
  caller NAME.** `/etc/palm/mojodb.conf` hardcodes five callers
  (`com.palm.configurator`, `com.palm.service.backup`, `com.palm.odd.service`,
  `com.palm.service.migrationscript`, `com.palm.spacecadet`); everyone else gets
  `db: access denied` (errorCode -3999). Reaching the private bus is necessary
  but not sufficient. The first attempt at claiming it was a
  `configuration/db/permissions` file (`{"type":"db.role","object":"admin",...}`)
  for `configurator` to push via `putPermissions` at install — the additive
  route, since nothing under `/etc` needs touching and uninstall takes the
  grant with it automatically. It doesn't work: cross-checked against all 59
  real files under `/etc/palm/db/permissions` on a stock device, every single
  one uses `"type":"db.kind"` with `"object"` naming a specific kind
  (`"com.palm.activity:1"` and the like) — `db.role`/`"admin"` appears in none
  of them, meaning `putPermissions` has no real path for granting the admin
  role at all, additive or otherwise. The file shipped anyway for a while,
  silently doing nothing, until this was checked directly against real system
  files rather than assumed from the shape looking plausible. Removed; see the
  entry below for the grant that actually works.
- **An `allowedNames` entry is a permanent, exclusive claim — not a grant two
  executables can share.** Once a role (`exeName: "js"`) lists
  `com.palm.app.backup.service` — and LunaSysMgr generates exactly such a role
  for every third-party JS service, so one always exists — no
  *other* executable can ever request that name — confirmed on-device with the
  app fully closed: every attempt still fails `Attempted to register for a
  service name that already exists`, so it is not a live-process race. A
  second role file naming the same service in its `permissions` block does
  throw its own error (`Attempting to add duplicate service name to permission
  map`, dropping both grants), but fixing that JSON was not enough — the name
  itself is unavailable to any second claimant regardless. `woce-lunacall`
  therefore runs as its own identity, `com.palm.backup.privileged`, which
  nothing else claims.
- **db8's admin-role grant has no API — mojodb.conf is edited directly.**
  Unlike per-kind permissions (`putPermissions`, install-time), the admin-role
  caller list is a hardcoded array with no configurator equivalent. The daemon
  inserts `com.palm.backup.privileged` into it by anchored string replacement
  (the file is JSON5-ish: comments, a trailing comma, so it's edited as text,
  not parsed) and saves the pre-edit bytes to `mojodb.conf.woce-backup-orig`
  once, so `prerm` restores the original file exactly rather than trying to
  pattern-match its own insertion back out. Takes effect on reboot, same as
  the role files — `mojodb-luna` reads its config once at its own startup.
- **`installPackages` is the one daemon op that runs arbitrary code**, since
  `ipkg install` executes a package's postinst script as root — same as any
  sideloaded install. Bounded the only way that risk allows: every `.ipk` path
  must already be inside `WORK_ROOT`, so it can only be a file the daemon
  itself fetched from a backup target during a restore it is running, never an
  arbitrary job-supplied path. The actual trust boundary is the one every
  restore already depends on — the backup target's contents, already written
  straight back into db8 and preferences — extended to the `.ipk`s that were
  sitting in it, not a new boundary. Chosen deliberately over a safer
  archive-and-manual-tap-install alternative: this app replaces system
  software (`com.palm.app.backup`/`com.palm.service.backup`), not a sandboxed
  third-party app, and should behave like the system tool it replaces.
- **This platform reboots via upstart/SysV `reboot`, not systemd** — webOS
  3.0.5 predates systemd entirely. `ops.reboot` replies `{returnValue: true}`
  *before* it runs `reboot now`, on a two-second `setTimeout` — confirmed
  on-device that `reboot now` actually brings the system down, and if the
  daemon executed it first, the reply would very likely never make it back:
  the job-result file, the service's poll of it, and the Luna response built
  on that all have to happen before the system goes, not after.
- **`luna-send -m <name>` sets the caller's service name**, but its own role
  (`/usr/share/ls2/roles/prv/com.palm.lunasend.json`) pins `allowedNames` to
  `["", "com.palm.lunasend"]` — claiming anything else fails with
  `LUNASERVICE ERROR -1027: Invalid permissions`. Hence `/usr/bin/woce-lunacall`,
  a private copy with its own role naming only our service.
- **db8 kind ACLs support `"caller": "com.palm.*"` wildcards** — 20 of the 57
  files in `/etc/palm/db/permissions` use one. That is the real mechanism behind
  "com.palm.* apps get more access"; it governs per-kind reads, not the admin
  role.
- **A file stored outside `manifest.services[].files` gets deleted by the very
  backup that stored it.** `backup.getReferencedFiles()` — what `purge()` uses
  to decide what survives — only ever walked `manifest.services`. Adding
  `manifest.packages[].file` (archived `.ipk`s) without also adding it there
  didn't leave the new files merely unprotected: `purge()` runs immediately
  after `storeManifest()` in the same backup, so the file gets written and then
  deleted before that same run even finishes. Caught by a test that actually
  restores what it just backed up rather than only inspecting the manifest
  JSON — the manifest looked completely correct; only fetching the bytes back
  proved they were gone. Any future top-level manifest field that references a
  stored file needs a matching line in `getReferencedFiles()`.
- **"Has this backup been restored" lives on the manifest, not in this
  device's `com.palm.backup.prefs`.** The obvious first instinct is prefs,
  since that's where every other piece of local state already lives - but
  restored-ness is a property of *that backup*, and putting it in the
  manifest means it survives a delete-and-recreate of prefs, shows up from
  any device that reads the same target, and needs no separate pruning when
  the backup itself is deleted (prefs-based tracking would need its own
  cleanup wired into `deleteManifest`/`purge`, manifest-based needs none - it
  goes with the file). `storeManifest` (the temp-write-then-upload-then-cache
  dance) moved from `backup.js`'s own closure into `backup-service.js` as
  `that.storeManifest(target, manifest, name)` so `restore.js` could reuse it
  for exactly this - it now sets `manifest.restoredCount`/`lastRestored` and
  writes the manifest back after a successful restore, tolerated like the
  staging cleanup next to it: the restore already succeeded, so a failed
  write-back must not turn that into a reported failure.
- **Never `DB.put` an existing object** — mojodb rejects it with `_rev must be
  specified for existing objects`, and caching a `_rev` just goes stale. Use
  `DB.merge({from: KIND}, props)`, which is what the stock service did.
- **Filecache types come from `/etc/palm/filecache_types/`**, installed at build
  time. `DefineType` exists in the binary but is not callable from the public
  bus. Reuse the stock `backuptempdir` type — it ships in the base image.
- **Activity `type.foreground` must be omitted, not `false`.** The Activity
  Manager rejects the whole spec with "If present, 'foreground' should be
  specified as 'true'".
- **Node on device is 0.2.x.** No `fs.existsSync` (use `path.exists`), no
  `fs.appendFileSync`, no `child_process.execSync` (arrived in 0.12 — every
  `exec()` on device must be the async, callback-taking one), ES5 only. The
  test harness shims the modern/legacy gap — write service code for the
  *device*, not for the harness.
- **Futures are a FIFO queue.** Appending `.then` handlers to a future you were
  handed runs the caller's later handlers *in the middle* of your chain. Build a
  separate chain and `nest` it — see `doBackup`/`doRestore`.
- **Stub helper calls asynchronously in tests.** A synchronous stub makes
  `Future.nest` take its "already complete" path, which hides every bug that
  only exists on the asynchronous one. Two separate regressions passed a green
  suite because of this.
- **Never assign `f.exception = undefined`.** Reading `f.exception` (even in
  `if (f.exception)`) calls a getter that marks it handled — that is Foundations'
  own mechanism. *Assigning* replaces `_result` with `{isset: true}`, so any
  callback still queued on that future fires immediately, including the one
  `nest()` installed for a caller. Observed effect: a backup whose required
  service failed reported success while `handleError` was still running, leaving
  the UI on "Backing up..." forever.
- **`var result = f.result;` is a rethrow, not a read.** It is the idiom for
  "propagate anything upstream sent me". Never put it after a block that
  swallowed an exception — it undoes the swallow.
- **To fail after cleanup, put the error on the cleanup future** (`cf.exception
  = err`), not on the outer one. `nest()` has already queued its callback behind
  yours and would overwrite the outer future with the cleanup's success.
- **Tolerating optional failures uses `tolerate()`** (in `common.js`), which
  absorbs the failure inside the optional call's own future — and times out
  after `TOLERATE_TIMEOUT`. The timeout is not optional: `startBackup` has a
  7200s command timeout, so a Luna call that is accepted and never answered
  parks the run for two hours with no error, no completion and no log. That is
  indistinguishable from a backup that quietly stopped.
- **`tolerate()`'s 20s `TOLERATE_TIMEOUT` is generic and silently overrides a
  callee's own longer budget.** `privileged.listInstalledApps()` gives the root
  helper's job-file round trip 60s (ipkg enumeration is genuinely slow on this
  hardware) — but wrapping the call in plain `tolerate()` capped it at 20s
  regardless, on every single run, since `tolerate()` is `withTimeout(future,
  TOLERATE_TIMEOUT, fallback)` with no way to pass a different timeout through.
  Call `withTimeout(future, timeout, fallback)` directly with the callee's own
  budget when one exists; save `tolerate()` for calls with no stated timeout of
  their own.
- **A file a helper-routed call wrote can be unreadable to the jail even by a
  relative name.** `resolveFiles()` in `handlers/backup.js` only staged files
  whose returned path was *absolute* and outside the jail; a relative name
  unreadable at its tempDir-joined path was assumed genuinely missing and threw.
  That was true when every preBackup ran from inside the jail, but
  `com.palm.db/internal/preBackup` now runs via the root helper — as root,
  outside the jail — and a file it writes into (even jail-visible) tempDir can
  come out with permissions the jailed process cannot open. A relative,
  unreadable filename now gets a staging attempt too when privileged, same as
  an absolute one; only the manifest naming differs (relative name kept, not
  the resolved absolute path). Unprivileged behavior is unchanged: still a hard
  failure, since there is no other way to reach the bytes.
- **LunaSysMgr discovers installed apps by scanning
  `INSTALLED_APPS_DIR` at its own boot, not by consulting ipkg's package
  database.** Confirmed from strings in `usr/bin/LunaSysMgr` itself (not
  guessed): the binary contains a full `ApplicationManager` class with
  `scan()`/`scanForApplications()`/`scanOneApplicationFolder()`, each parsing
  an app's own `appinfo.json`, plus Luna methods `rescan` and
  `forceSingleAppScan` for triggering the same scan without a reboot (found,
  not lab-verified — the reboot restore already prompts for is what this app
  actually relies on, so that gap was never worth closing). ipkg's own install
  path calls no such method — the "new app arrived" notification only fires
  when LunaSysMgr's *own* `ApplicationManager`/`ApplicationInstaller` spawns
  `ipkg` itself (`util_ipkgInstallDone` → `postInstallScan`); running `ipkg
  install` directly, the way `installPackages` does, notifies nobody. This is
  *why* a plain directory copy back into `INSTALLED_APPS_DIR/<id>` works at
  all as a restore fallback (see `archivePackages`/`restoreAppDirectories` in
  `device/woce-backupd.js`): discovery doesn't care how the files got there,
  only that a boot-time scan finds a valid `appinfo.json`. What it doesn't
  reconstruct is ipkg's own bookkeeping
  (`.control`/`.list`/`.md5sums` under `.../usr/lib/ipkg/info/`), confirmed
  absent from all but one of 189 real `.postinst` scripts in the Doctor
  extract — so an app restored this way runs but may not be recognized by
  Software Manager/Preware as a manageable package. Chosen as a deliberate,
  permanent fallback for the case an app's original `.ipk` is gone from both
  cache locations (the common case for anything installed a while ago) — the
  `.ipk`-and-`ipkg install` path above is used whenever it's available
  precisely because it doesn't have this gap.
- **`/tmp` is not jail-writable, `isWritableHere` wrongly said it was.**
  `com.palm.appDataBackup`'s restore wanted
  `/tmp/com.palm.luna-sysmgr.cookies-html5-backup.sql`, and the jailed
  process's own `gunzip` — a shell redirect into that path — failed with
  EACCES. `/tmp` *is* in the root helper's `ALLOWED_WRITE_ROOTS`, so routing
  it through `unstage` like any other outside-the-jail destination works;
  assuming the jail could reach it directly does not. Testing this on Windows
  needs a path that isn't `/tmp/...`: Node resolves a leading `/` against the
  current drive root there, so a short, plausible `/tmp` path can already
  exist on the test machine by coincidence and skip the staging branch
  entirely — happened once while writing the regression test for this.
- **The service creates its db8 kind lazily.** Watching
  `com.palm.backup.prefs:1` before any service call has touched prefs fails with
  `kind not registered`. Call something that reads prefs first.
- **A throw outside a future kills the service silently.** Foundations catches
  anything thrown inside a `.then` callback, but a throw from an `fs`,
  `setTimeout` or `child_process` callback is outside its reach: the process
  dies, the log just stops, and the next call says "com.palm.service.backup is
  not running". `prologue.js` installs an `uncaughtException` handler so it at
  least says FATAL first. Never call `.then(this, ...)` from inside a plain
  node callback — `this` is not your object there, and Foundations asserts its
  scope is an object.
- **`/dev/nduid` is a character device.** `fs.readFile` stats it, sees size 0,
  and returns an empty string having read nothing. Use
  `openSync`/`readSync`/`closeSync`.
- **A future-returning helper must never throw synchronously.** `PalmCall.call`
  validates the URI up front, so a malformed one throws where the caller expects
  a future — escaping `tolerate()` and stalling the chain at "Preparing" with no
  error and no completion. `system.js` wraps every call in `safeCall()`.
- **Method names carry their own category and take no leading slash.** The
  battery query is `com/palm/power/batteryStatusQuery`, not
  `/com/palm/power/...` — the latter builds `palm://com.palm.power//com/...`,
  which PalmCall rejects.
- **An `interval` activity schedule may not carry a `start`.** "Unless precise
  time is specified, time intervals may not specify a start or end time."
- **`Kind:1` is not readable by a third-party caller.** Do not check whether a
  kind exists before creating it; just call `putKind`, which is idempotent.
- **A registered service can accept a callback and never answer.**
  `com.palm.browserServer` does exactly that for `preBackup`. Every callback
  goes through `withDeadline(..., SERVICE_CALL_TIMEOUT)`; without it the run
  parks forever, since `startBackup` has a 7200s command timeout.
- **A private-only *category* reads as "Unknown method", not "does not exist".**
  `com.palm.db` answers on the public bus but exposes `internal/preBackup` —
  the call the whole backup depends on — only on the private one.
  `system.isUnreachable()` treats `Unknown method` as a reason to retry through
  the root helper, alongside the two "service missing" messages.
- **`getFinalPath` must honour `_source`.** A staged file lives in the staging
  dir, not at its manifest path; resolving from `path` sends the checksum and
  the store back to the original the jail could not read.
- **`statSync` is not a readability test.** `com.palm.appDataBackup` returns
  paths under `/var/luna/preferences` that stat cleanly and then fail the read
  with EACCES. `isReadable()` opens the file.
- **The upstart start event is `started LunaSysMgr`.** There is no `luna` job;
  `start on started luna` silently never fires, so the daemon stays down across
  every reboot and only runs because `postinst` starts it by hand. `status
  woce-backupd` reporting `(stop) waiting` after a boot is the tell.
- **`/etc/palm/backup/com.palm.keymanager` is mode 0640 root-only.** The jailed
  service cannot read it (EBADF/EACCES, not malformed JSON); it comes through
  the helper's `readRegistrations` op. Every other registration file is 0644.
- **`postinst` must `stop` before `start`.** `start` on a running upstart job is
  a no-op, so an upgrade leaves the *previous* `woce-backupd` serving the old
  code — which is how `Unknown op: lunacall` happened. `build.sh` stamps the
  build id into the daemon too, so `Root helper available, version X` says which
  daemon is live.
- **`postinst` never lands on the device.** It lives in `control.tar.gz` and is
  run by ipkg during install. The daemon it installs is at
  `/usr/bin/woce-backupd.js`; the bundle copy is under the app's `device/`.
- **`palm-package` copies a package directory wholesale.** It drops hidden
  files, VCS and Eclipse metadata and `.ipk`s, and nothing else — so
  `com.palm.app.backup/CLAUDE.md` shipped in 3.1.1 as
  `/usr/palm/applications/com.palm.app.backup/CLAUDE.md`. Patterns for
  everything that must not reach the device live in
  `packaging/package-exclude.txt`, and `tools/repack_ipk.py` strips them out of
  `data.tar.gz` and then re-reads the archive to prove they are gone. It is
  done there, not by passing `--exclude-from` to `palm-package`, because an SDK
  build that does not know the option aborts packaging outright and `build.sh`
  still looks for the old Windows SDK. Add a pattern there rather than deleting
  the file from the tree.
- **Registration files need trimming before `JSON.parse`.** The stock
  `com.palm.keymanager` ends with `}` plus four spaces, which node 0.2 rejects.
- **Backups are deliberately unencrypted.** Do not "fix" this; see README.
- **We install under the stock app's id, and the stock app is still there.**
  Ours lands in `/media/cryptofs/apps/usr/palm/applications/com.palm.app.backup`;
  the original is in `/usr/palm/applications/com.palm.app.backup`, on a
  read-only partition we cannot and do not touch. LunaSysMgr scans both at boot
  and parses each `appinfo.json` it finds, so two directories now claim the same
  id. That is the standard override trick on this platform and is why the id was
  taken, but it has **not been verified on device which one wins** — check that
  the launcher icon opens this app before concluding anything else is broken.
  The service ids do not collide (`com.palm.app.backup.service` vs the stock
  `com.palm.service.backup`), so the dead stock service is never in the way.
- **`new Future(err)` is a SUCCESSFUL future carrying an Error.** Foundations'
  constructor is `this._result = { result: result, exception: undefined, isset:
  arguments.length > 0 }` — no special case for `Error`. `LocalTarget.get` and
  `putFile` both did this on a rejected path and every caller sailed past its
  error check: `storeFile` recorded the file in `storedFileMap` and in the
  manifest as stored, when nothing had been written. Use `failedFuture(err)`
  from `common.js`.
- **Foundations' `then` DOES nest a value the callback returns.**
  `_maybeDispatch` ends with `if (v !== undefined) { if (v && typeof v.then ===
  "function") { this.nest(v); } else { this.setResult(v); } }`, and `now()` and
  `callback()` do the same. So `return someFuture;` from a `then` callback is
  equivalent to `f.nest(someFuture)` — `system.getDeviceStatus` relies on it.
  Read from the real `future.js`, not inferred. The codebase uses `f.nest()`
  everywhere else and should keep doing so, but a `return` is not a bug.
- **A fixed timeout wrapped around a helper op that loops over packages is a
  cap on how many packages get processed.** The helper handles them one at a
  time with a 60s command timeout *each*. Archiving was wrapped in a flat 60s
  and reinstalling in plain `tolerate()`'s generic 20s, so on any real device
  the wrapper always won: every app came back `archived: false`, and on restore
  every app was reported as needing a manual reinstall *while ipkg was still
  installing it* — and then the staging directory was deleted out from under
  the running installs. Use `packageOpBudget(count)` (`common.js`), and if a
  package op does time out, do **not** clean up the staging directory: see
  `packageOpTimedOut` in `handlers/restore.js`.
- **`purge` trims only THIS device's manifests; the orphan sweep still reads
  every manifest.** That asymmetry is deliberate and load-bearing. A target is
  shared ground — the README tells people to copy backups between devices — and
  an unscoped trim meant `manifestsToKeep` counted every manifest present and
  deleted the lexicographically lowest, so importing ten backups from an old
  phone and running one backup here deleted them. The sweep staying unscoped is
  what keeps another device's files referenced and alive.
- **A subscribing assistant can implement `cancelSubscription()`.** The service
  framework calls it: `controller_command.js` has `if
  (this.assistant.cancelSubscription) { this.assistant.cancelSubscription(); }`.
  Without it `getBackupStatus` only ever added status listeners — the app
  re-subscribes from `refreshAll` on every window activation and again from
  `startBackup`, and `clearStatusListeners()` only runs at Complete/Failed.
- **`fileUtil.cp` is the copy path for every stored and restored file, and
  must honour backpressure.** `reader.on("data", buf => writer.write(buf))`
  ignoring the return value queues everything the write side has not flushed.
  Fine for a db8 dump, fatal for the media categories. `pause()` on a `false`
  from `write()`, `resume()` on `drain`. The root helper's `copyFileSync`
  already read and wrote in bounded 64K chunks for this reason.
- **Walking `/media/internal` must yield the event loop.** `getEstimate` ran a
  synchronous recursive walk plus a `statSync` per file, and
  `getUserDataCategories` is called on app launch *and* every window
  activation. The service is single-threaded, so that stalled everything else
  including a running backup's progress. `walkAsync` in `util/user-data.js` is
  an explicit stack with a per-tick budget, and results are cached for
  `SCAN_TTL`. Do not "simplify" it back to recursion.
- **A backup checks free space before it starts** (`checkFreeSpace` in
  `handlers/backup.js`, failing with `type: "SPACE"` which `BackupApp` shows).
  Both targets had implemented `getSpace()` from the beginning and nothing ever
  called it. Only a *full* run is checked against the media estimate — an
  incremental one re-references what is already stored rather than copying it,
  so demanding room for the whole library again would refuse backups that would
  have completed fine. A target that reports `free: null` is allowed through.
- **There is no auto-restore shortcut any more, and adding one back would be a
  mistake.** First Use skipped the picker when the target held exactly one
  backup, which was right there — the device had just been wiped. Ported here
  it meant "Restore a backup..." from the app menu was two taps from
  overwriting a working device's accounts and settings, with no prompt
  anywhere. `ChooseBackupPage` now confirms the choice, the same way
  `BackupListPage` always has.

## Services

Ships a Node service (`com.palm.app.backup.service`) plus an optional root
helper (`device/woce-backupd.js`) installed by `postinst`. Without the helper
the app runs in limited mode and says so.

## Useful Commands

```bash
# Build (produces build/com.palm.app.backup_1.1.0_all.ipk)
./build.sh

# Off-device engine tests; VERBOSE=1 for the service's own logging.
# Runs against the REAL Foundations Future loaded from the Doctor extract.
node tools/test/run-tests.js

# Enyo load-order check (build.sh runs this too)
node tools/lint-enyo.js

# Install — Preware or WebOS Quick Install, NOT palm-install (postinst needs root)
palm-install build/com.palm.app.backup_1.1.0_all.ipk   # limited mode only

# Reinstalling does NOT restart a running node service — it keeps serving the
# old code. Always kill it first, or you will debug the previous build.
novacom run file://bin/sh -c "pkill -f com.palm.app.backup.service"

# Launch and watch logs
palm-launch com.palm.app.backup && palm-log -f com.palm.app.backup

# Poke the service directly
luna-send -n 1 -f palm://com.palm.app.backup.service/getBackupStatus '{}'
luna-send -n 1 -f palm://com.palm.app.backup.service/startBackup '{"full":true}'

# Quick file push during active development
novacom put file:///media/cryptofs/apps/usr/palm/applications/com.palm.app.backup/source/BackupApp.js \
  < com.palm.app.backup/source/BackupApp.js
```
