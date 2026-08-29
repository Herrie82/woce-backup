# com.palm.app.backup — Enyo 0.10 UI gotchas

Hard-won UI-layer findings for the Enyo app, split out of the repo-root
`CLAUDE.md` so they load only when working in this directory. The root file
keeps everything about the service, db8, the Luna bus, the jail, Foundations
futures, and packaging — read it too.

## Things that will bite you (UI layer)

- **`enyo.macroize` placeholders are `{$key}`, not `#{key}`.** Its pattern is
  `/{\$([^{}]*)}/g` (`enyo-build.js`); anything else silently fails to match and
  the raw template string is what renders. Every `enyo.macroize($L(...), {...})`
  call in this app originally used `#{key}` and rendered literally, e.g. "#{count}
  backups" on screen — no error, no warning, just wrong text everywhere a count
  or size was interpolated.
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
  `com.palm.filecache` tempDir, racing to claim `com.palm.backup.privileged`
  on the private bus — the exact same "already exists" collision documented
  above, just for the restore identity instead of the backup one, and with no
  malformed role file this time to explain it. `RestoringPage.startRestore`
  now guards on `this.awaitingResponse`, set before `.call()` and cleared at
  the top of both `restoreSuccess` and `restoreFailure` — narrow enough that
  the dropped-connection retry, "Try Again", and reconnect-retry paths (which
  by construction only ever call `startRestore` again *after* a response has
  already landed) are never blocked by it.
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
  `com.palm.backup.privileged` bus identity — the exact "already exists"
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
