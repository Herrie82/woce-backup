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

**App ID:** `com.woce.backup`
**Service ID:** `com.woce.backup.service`
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
com.woce.backup/            Enyo 0.10 app; close port of com.palm.app.backup,
                            plus the restore flow ported from First Use
com.woce.backup.service/    Node service; port of com.palm.service.backup with
                            the cloud swapped for a pluggable target
com.woce.backup.package/    packageinfo.json
device/                     root helper daemon, upstart job, postinst/prerm
tools/                      build (repack_ipk.py) and off-device test harness
```

Reference sources live in the 3.0.5 Doctor extract at
`../touchpad/305doctor/resources/webOS/nova-cust-image-topaz.rootfs/`:
- `usr/palm/applications/com.palm.app.backup/`
- `usr/palm/services/com.palm.service.backup/`
- `usr/palm/applications/com.palm.app.firstuse/source/restore/`
- `etc/palm/backup/` — the registration files the whole thing hinges on

## Things that will bite you

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
  `com.achunt.jukie.service`, `ca.canucksoftware.filemgr` and ours all have
  `[]`. The `com.palm.` prefix is the only differentiator.
- **`palm_bus_config.json` is ignored.** The payment service declares
  `privateBusAccess: false` and still got `outbound: ["*"]`; we declare `true`
  and got `[]`. Do not reason from that file.
- **The daemon writes our own prv role** (`ensurePrivateBusRole`) rather than
  squatting `com.palm.*`. It must be the daemon, not `postinst`: LunaSysMgr
  rescans and regenerates role files *after* the maintainer scripts run. Roles
  are read by `ls-hubd` only at boot, so the grant lands on the next reboot;
  until then `lunacall` covers private-bus calls.
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
  executables can share.** Once `com.woce.backup.service.json` (the main
  service's own role, `exeName: "js"`) lists `com.woce.backup.service`, no
  *other* executable can ever request that name — confirmed on-device with the
  app fully closed: every attempt still fails `Attempted to register for a
  service name that already exists`, so it is not a live-process race. A
  second role file naming the same service in its `permissions` block does
  throw its own error (`Attempting to add duplicate service name to permission
  map`, dropping both grants), but fixing that JSON was not enough — the name
  itself is unavailable to any second claimant regardless. `woce-lunacall`
  therefore runs as its own identity, `com.woce.backup.privileged`, which
  nothing else claims.
- **db8's admin-role grant has no API — mojodb.conf is edited directly.**
  Unlike per-kind permissions (`putPermissions`, install-time), the admin-role
  caller list is a hardcoded array with no configurator equivalent. The daemon
  inserts `com.woce.backup.privileged` into it by anchored string replacement
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
  device's `com.woce.backup.prefs`.** The obvious first instinct is prefs,
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
- **`enyo.macroize` placeholders are `{$key}`, not `#{key}`.** Its pattern is
  `/{\$([^{}]*)}/g` (`enyo-build.js`); anything else silently fails to match and
  the raw template string is what renders. Every `enyo.macroize($L(...), {...})`
  call in this app originally used `#{key}` and rendered literally, e.g. "#{count}
  backups" on screen — no error, no warning, just wrong text everywhere a count
  or size was interpolated.
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
- **Enyo evaluates `components` arrays at definition time.** A label or kind
  named there must already be loaded, so `depends.js` order matters and a label
  must live in the file that uses it (or an earlier one). Failure on device is a
  bare `Failed to find a constructor for kind [X]`. `tools/lint-enyo.js` catches
  it; `build.sh` runs it.
- **The App Catalog's real id is `com.palm.app.enyo-findapps`, not
  `com.palm.app.appcatalog`** — it isn't in the 305 Doctor extract at all
  (neither is any app with "catalog" in its name), because on a device that's
  taken the community OTA it's webOS Archive's restored build of the *same
  stock app*, pointed at `appcatalog.webosarchive.org` instead of Palm's dead
  servers. It lives at `/usr/palm/applications/`, not `/media/cryptofs/apps/…`
  — installed to the system partition, not sideloaded. Launch it like any
  other app, `palm://com.palm.applicationManager/open` with `{id:
  "com.palm.app.enyo-findapps", params: {...}}` (this app already has
  `ApplicationManagerService` wired up for `BackupApp`'s Help menu item — reuse
  it, don't redeclare the service). To jump straight to one app's page rather
  than the catalog's home screen, `params` is `{viewToLoad: "APPDETAILS", id:
  "", publicApplicationId: <packageId>}` — confirmed from the installed app's
  own `AppCatalogWindow.js` (`showView()` switches on `params.viewToLoad`; the
  exact shape, `id` included, is lifted from its own promo-code handler, a
  real working caller) rather than guessed from the `sceneType`/`common`
  wrapper shape used elsewhere in the platform for *universal search*
  specifically (documented in `appinfo.json`'s `universalSearch` block) — that
  wrapper is unwrapped by the search subsystem before the app ever sees it, so
  passing it directly to `applicationManager/open` would not do anything.
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
- **A `lazy: true` dialog's named children don't exist until it is opened —
  and `setContent` before that crashes, not warns.** `enyo.LazyControl` only
  creates them in `validateComponents()`, which `ModalDialog`/`BasicPopup`
  call from inside `prepareOpen()` — i.e. as a side effect of `openAtCenter()`
  itself. Calling `this.$.someChild.setContent(...)` *before* `openAtCenter()`
  hits `someChild` while it's still `undefined`: `Cannot call method
  'setContent' of undefined`. `enyo.DialogPrompt` sidesteps this by calling
  `validateComponents()` unconditionally from its own `create()`, which is why
  `BackupInfo`'s `optOutDialog` (a `DialogPrompt`) never hit it — but
  `ModalDialog` doesn't. Fix is `this.$.dialogName.validateComponents();`
  before touching any named child, matching the framework's own
  `showSpinner`/`pickFile` idiom. First surfaced on device only after backup
  succeeded and `rowClicked` opened the restore-confirm dialog for the first
  time — every earlier run had nothing to click.
- **A double-tap on a confirm button can fire its action twice, since
  `ModalDialog.close()` is animated, not instant.** `confirmRestore` closed
  `restoreDialog` and started the restore in the same synchronous call — the
  dialog stayed visible through its close transition, so a second tap in that
  window re-entered `startRestore()` before the first call's response had come
  back. The result was two independent `RestoringPage` runs, each with its own
  `com.palm.filecache` tempDir, racing to claim `com.woce.backup.privileged`
  on the private bus — the exact same "already exists" collision documented
  above, just for the restore identity instead of the backup one, and with no
  malformed role file this time to explain it. `RestoringPage.startRestore`
  now guards on `this.awaitingResponse`, set before `.call()` and cleared at
  the top of both `restoreSuccess` and `restoreFailure` — narrow enough that
  the dropped-connection retry, "Try Again", and reconnect-retry paths (which
  by construction only ever call `startRestore` again *after* a response has
  already landed) are never blocked by it.
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
- **`enyo.VirtualList` has no `setCount`.** It is buffer-driven: `onSetupRow`
  returns `false` past the end of the data to signal the count. Call `punt()`
  after the data changes (`refresh()` alone keeps stale rows).
- **`createComponent(cfg, {owner: this})` registers the name under the *owner*,
  not the container.** So `container.destroyComponents()` removes nothing and
  the next rebuild trips the unique-name-under-owner rule. Either declare rows
  statically (see `UserDataPage`) or track and `destroy()` them individually
  (see `BackupApp.listTargetsSuccess`).
- **`SwipeableItem`'s `onConfirm` passes the row index directly** as the second
  argument; `onclick` passes an event carrying `rowIndex`. They differ.
- **`SwipeableItem` already asks before deleting — the problem was ever finding
  the gesture, not safety.** `confirmRequired: true` is the framework default,
  so a swipe past `triggerRatio` (0.35) shows its own built-in
  `ScrimmedConfirmPrompt` (Delete/Cancel) before `onConfirm` ever fires;
  `BackupListPage`'s swipe-to-delete on the backup list was never a one-tap
  accident waiting to happen. What it lacked was any visible hint that swiping
  a row does anything at all. Rather than replace it, added a second, explicit
  path to the same `performDelete` — a "Delete This Backup" button in the
  existing restore-confirm dialog, opening its own `DialogPrompt`
  (`enyo-button-negative`, same as `BackupInfo`'s `optOutDialog`) — and kept
  the swipe gesture as a working shortcut for whoever finds it. Both paths
  resolve the target by `manifestName` at the moment they actually act, not by
  a row index captured earlier: the explicit path is a two-dialog trip, long
  enough for a scheduled backup to land and shift every index below it.
- **`lazy: true` components have no `this.$.x` until first opened.** A service
  response that arrives before then will hit `undefined`.
- **A non-`lazy` `Pane` child is created once and persists across every visit,
  state and all.** `restorePage` (`RestoreComponent`) is not `lazy`, so its
  `chooseBackupPage`/`restoringPage` are built at app launch and never
  recreated. `RestoringPage.awaitingResponse` — the guard added to stop a
  double-tap re-entering `startRestore` mid-call — carried over from an
  *abandoned* attempt (backing out before the Luna call answered) into the
  *next* one, silently no-opping it until the original call's late response
  finally arrived and cleared the flag. Read as "nothing happened," "I had to
  pick a backup twice," or a run of failures that stopped once you waited.
  Partly addressed by resetting the page's state (`RestoringPage.reset()`) at
  the top of every fresh entry — but see the next entry: `awaitingResponse`
  itself clears on the *first* progress tick, seconds into a still-running
  restore, so it was never the guard against a genuine second entry.
- **`awaitingResponse` guards one call, not the flow.** It clears the instant
  any response arrives — including the first `InProgress` percent update — so
  it only blocks a re-tap in the first fraction of a second, not for a
  restore's whole duration. Confirmed on-device: two `restore` Luna calls for
  the identical manifest, 7 seconds apart, both accepted and racing for the
  `com.woce.backup.privileged` bus identity — the exact "already exists"
  collision documented above, just between two of this app's own `lunacall`
  invocations instead of two different binaries, and this time a genuine
  runtime race (two live processes wanting the same connection name at once)
  rather than the permanent role-file claim that error usually means here.
  Fixed at the layer that actually owns "is a restore already happening":
  `RestoreComponent.active`, set the moment `start`/`startWithManifest`
  begins and cleared only on a genuine finish or cancel — not by any progress
  tick — so a redundant entry is ignored regardless of what UI path triggers
  it. Backed up server-side too: `handlers/restore.js` now rejects a second
  `restore` call outright while one is already running (module-level
  `restoreInProgress`, since a fresh `RestoreAssistant` is constructed per
  call and has nowhere else to remember that). The client-side fix is UX; the
  server-side one is the actual guarantee, since it catches the collision
  regardless of how a second call ever gets triggered.
- **The header back button is app-level, not flow-aware.** `BackupApp.goBack()`
  jumps straight to `mainPage` regardless of the current page's own back/cancel
  semantics. For the restore flow that meant a second, inconsistent way out
  that skipped `RestoreComponent.cancel()` entirely, giving `RestoringPage` no
  chance to clean up (see the entry above). Fixed by hiding the header back
  button while `restorePage` is showing, so the flow's own bottom-anchored
  controls (`ChooseBackupPage`'s Cancel, `RestoringPage`'s error-popup Cancel)
  are the only way out.
- **`enyo.Footer` does not exist in this Enyo 0.10 build** — checked by
  grepping the compiled framework and First Use's source, zero matches in
  either. The real system-app idiom for a page-level bottom bar is
  `{ kind: "Toolbar", className: "enyo-toolbar-light", components: [...] }`
  as the last item in a `VFlexBox` with no `flex` of its own, so it settles to
  its natural height at the bottom once the flexed content above it has taken
  the rest — see `com.palm.app.dateandtime/source/DateAndTimePrefTimezone.js`
  in the Doctor extract (`enyo-button-dark` on the button inside it), or
  `com.palm.app.vpn/source/main/AddProfile.js` for one mixing in an
  `enyo-button-affirmative` button alongside a plain one. `Toolbar` defaults to
  `pack: "center", align: "center"` on itself (it's an `HFlexBox`), so a
  single centered button needs nothing extra - just a fixed `width` on the
  button, matching both examples. First guessed this codebase's own
  `HFlexLayout`-row pattern (`ChooseBackupPage`'s old Cancel row,
  `RestoringPage`'s error popup) was the idiom because it was the only thing
  used here yet - wrong: it was never checked against other system apps, only
  reused from earlier in this same codebase. `ChooseBackupPage`'s Cancel and
  `RestoringPage`'s Done/Restart now use the real `Toolbar` pattern; the error
  popup's Try Again/Cancel stays an `HFlexLayout` row since it lives inside a
  `ModalDialog`, not at page level - `Toolbar` is chrome for a screen, not a
  dialog's own button row. A `Toolbar` sibling under a `VFlexBox` that sets
  `align: "center"` (not the default) still needs `style: "width: 100%;"`
  itself, same reason `manualInstallGroup` below needs it - `align: "center"`
  shrink-wraps an unstyled child instead of stretching it.
- **A `VFlexBox` child needs `flex` to claim any of the box's overflow, and
  overflow needs a `Scroller` to actually scroll rather than spill.**
  `RestoringPage`'s done screen grew a variable-length list (the manual-install
  rows) with neither: `donePanel` and its list container had no `flex`, and the
  list itself was a bare `Control`. A long enough list just overflowed past the
  Done button with everything overlapping, rather than scrolling. Fixed by
  giving `donePanel`/`manualInstallGroup` `flex: 1` and wrapping the row list
  in its own `Scroller`.
- **A `flex: 1` sibling that isn't currently `showing` claims none of the
  parent's flex space - so a bottom Toolbar only reads as "stuck to the
  bottom" if *something* flexed is always visible above it.** A `Pane`
  child gets `height: 100%` from the framework's own `.enyo-view` rule
  (`position: absolute; ... height: 100%`), which is real and does work - the
  bug was one level down. `ChooseBackupPage` toggles between a spinner, an
  empty label and the list (only the list had `flex: 1`, and it starts
  `showing: false`), so during loading or the empty state nothing flexed was
  visible and the new Toolbar settled wherever that state's content ended,
  not the screen's actual bottom edge. `RestoringPage` had a sharper version
  of the same thing: its progress display and `donePanel` are *both*
  `flex: 1`, and the progress display was never hidden once `donePanel`
  appeared, so the two split the height and `donePanel`'s own Toolbar landed
  at the bottom of its half, not the page's. Fixed two ways: `ChooseBackupPage`
  (and `BackupListPage`, pre-emptively, since its list has the same
  showing-false pattern) now wraps loading/empty/list in one always-visible
  `flex: 1` container that outlives the state changes underneath it;
  `RestoringPage.showDone` now hides `progressPanel` before showing
  `donePanel`, restored by `reset()`/`startRestore()` on the next attempt.
- **The launch scrim reuses `bprogress`, the same full-page `Scrim`
  opt-in/opt-out already show/hide** - not a second one. `BackupApp.create()`
  shows it immediately and fires the five `refreshAll()` calls;
  `initialLoadStepDone()` (called from all five success *and* failure
  handlers, plus `handleGenericFailure` for the three that have no handler of
  their own) counts them down and hides it once, guarded by
  `initialLoadComplete` so it never re-shows on a later `windowActivated`/
  `goBack` refresh - re-scrimming the whole app for a background refresh
  would be far more disruptive than the second or two of stale data it would
  be covering.
- **The service creates its db8 kind lazily.** Watching
  `com.woce.backup.prefs:1` before any service call has touched prefs fails with
  `kind not registered`. Call something that reads prefs first.
- **A throw outside a future kills the service silently.** Foundations catches
  anything thrown inside a `.then` callback, but a throw from an `fs`,
  `setTimeout` or `child_process` callback is outside its reach: the process
  dies, the log just stops, and the next call says "com.woce.backup.service is
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
- **Registration files need trimming before `JSON.parse`.** The stock
  `com.palm.keymanager` ends with `}` plus four spaces, which node 0.2 rejects.
- **Backups are deliberately unencrypted.** Do not "fix" this; see README.

## Services

Ships a Node service (`com.woce.backup.service`) plus an optional root helper
(`device/woce-backupd.js`) installed by `postinst`. Without the helper the app
runs in limited mode and says so.

## Useful Commands

```bash
# Build (produces build/com.woce.backup_1.0.0_all.ipk)
./build.sh

# Off-device engine tests; VERBOSE=1 for the service's own logging.
# Runs against the REAL Foundations Future loaded from the Doctor extract.
node tools/test/run-tests.js

# Enyo load-order check (build.sh runs this too)
node tools/lint-enyo.js

# Install — Preware or WebOS Quick Install, NOT palm-install (postinst needs root)
palm-install build/com.woce.backup_1.0.0_all.ipk   # limited mode only

# Reinstalling does NOT restart a running node service — it keeps serving the
# old code. Always kill it first, or you will debug the previous build.
novacom run file://bin/sh -c "pkill -f com.woce.backup.service"

# Launch and watch logs
palm-launch com.woce.backup && palm-log -f com.woce.backup

# Poke the service directly
luna-send -n 1 -f palm://com.woce.backup.service/getBackupStatus '{}'
luna-send -n 1 -f palm://com.woce.backup.service/startBackup '{"full":true}'

# Quick file push during active development
novacom put file:///media/cryptofs/apps/usr/palm/applications/com.woce.backup/source/BackupApp.js \
  < com.woce.backup/source/BackupApp.js
```
