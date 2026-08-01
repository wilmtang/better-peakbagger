# Codebase audit — 2026-07-26 (privacy, transactions, lifecycle, and recovery)

Status: **remediation implemented and archived with two explicit verification
gaps.** F1–F13 are fixed and verified. F14 has a time-bounded, machine-enforced
acceptance for one upstream development-only advisory path, and F15's Android
manifest correction has not been exercised on a physical Firefox Android
device. The [closure ledger](#closure-ledger) distinguishes those gaps from
closed product risk.

Baseline: clean `main` at `b9c7a4a` (`3.1.0`), 43 commits ahead of
`origin/main` before this documentation-only audit. The prior
[polish audit](../archive/polish-audit-2026-07-24.md) is complete and archived;
this pass does not reopen its 18 closed findings. It does call out two places
where the same invariant was fixed on one surface but remains broken on
another: condition-based map binding and bounded settings-write recovery.

## Scope and evidence

This was a broad pass over the current shipped-code owners rather than a search
for style nits:

- the background capture, GPX processing, draft-opening, settings, and GitHub
  routes;
- the MAIN-world analyzer and Full Screen Map coordinators, their isolated
  bridges, and the terrain lifecycle;
- Settings controllers for favorites, transfer, GitHub, and report drafts;
- the capture popup, ascent-form upload/draft/report surfaces, and profile
  backup;
- `manifest.json`, bundle ownership, lint output, dependency state, and the
  unit/browser verification harnesses;
- the files changed since the previous audit, plus large/high-trust modules
  even when they had not changed.

Evidence collected on the baseline:

- `npm run lint:js`: passed.
- Five focused suites covering settings, capture/drafts, the analyzer, BigMap,
  and the report editor: **107 passed, 0 failed**.
- The independent review let `npm test` finish naturally: **807 passed, 0
  failed, 0 cancelled**, exit 0 in 135 seconds on Node 26.5.0. The initial
  “808 discovered / 1 cancelled” reading was an interrupt-generated file-level
  pseudo-test, not a missing test. F13 remains a real timer/resource leak: the
  isolated assertion passes in about 136 ms but the process stays alive until
  the 125-second device code expires.
- `npm run lint`: 0 errors, 0 notices, 12 warnings. F15 separates the expected
  cross-browser warning from warnings that need ownership.
- `npm audit --json`: 8 high, 0 critical. The eight aggregate rows collapse to
  one `brace-expansion` advisory in the development toolchain, reached through
  both direct ESLint dependencies and `web-ext`; no runtime dependency is
  implicated. F14 records the bounded risk and remediation.
- `npm run verify:extension`: passed in hidden Chrome for Testing, new headless,
  with the real unpacked MV3 `dist/`. It covered worker boot, storage and bridge
  round trips, capture/draft identity, settings/favorites, analyzer, maps,
  filters, profile backup, upload, and report editor.
- `npm run terrain:verify`: passed in hidden Chrome at 798×448 and 448×448 on
  the hardware renderer `ANGLE Metal Renderer: Apple M3 Pro`; 12 canvas resizes
  produced 0 blank frames and the mocked DEM rendered a non-flat 0–1750 m
  mesh. Its disposable screenshots were removed after the check.
- No visible browser or live Peakbagger page was used. The hidden checks prove
  shipped manifest/load behavior and the named DOM/renderer postconditions;
  they do **not** prove native focus, window placement, browser chrome, touch
  behavior, or the visual polish of the UX findings below.

## Reassessment after the independent review

The appended review was committed unchanged before this assessment was edited.
Its source citations and reruns caused the following corrections:

- **Accepted:** F1 keeps strict reads in both the isolated upload controller and
  worker instead of passing one privileged snapshot; F2 names the automatic
  backup race and lands after the typed error boundary; F3 pins restoration of
  an overwritten current-tab draft; F4 includes the live hover-frame accessor
  and removes the real 5.2-second test sleep; F9 covers both buttons; and F15
  describes three source-line owners instead of ten independent cleanups.
- **Accepted:** F7 is not a currently reachable destructive-cancellation bug in
  Chrome or Firefox. It is retained at P2 because focus/keyboard ownership
  becomes unusable or leaves the dialog during a consequential write and its
  busy-state contract is implicit and fragile. Browser evidence, not jsdom
  focus behavior, must lead its proof.
- **Accepted:** F13 is P2 test hygiene and performance. The suite passes; leaked
  timers consume roughly 125 of its 135 seconds. `--test-force-exit` exists on
  the current Node runner, but enabling it by default would conceal future
  leaks, so it is only a possible diagnostic backstop.
- **Partially accepted:** F14 was misattributed to `web-ext` alone and is one
  advisory, not eight distinct vulnerabilities. However, a blanket
  `brace-expansion@^5.0.8` override is not pre-approved: the live tree also has
  `minimatch@3.1.5` requesting `brace-expansion@^1.1.7`, so that override
  crosses a dependency major. The plan requires a compatible, path-scoped
  resolution proven by the affected tools.

The reassessed findings and execution order below are authoritative. The
independent review remains appended verbatim as provenance for its evidence and
recommendations, including the one override recommendation not adopted here.

## Priority summary

| ID | Severity | Category | Finding | Outcome |
| --- | --- | --- | --- | --- |
| F1 | P0 | privacy/correctness | A transient settings read can re-enable capture fields the user disabled | Fixed |
| F2 | P0 | data integrity | Settings export and manual GitHub backup can serialize defaults as real settings | Fixed |
| F3 | P0 | transaction | Partial draft-tab creation leaves blank tabs and live orphan identities | Fixed |
| F4 | P1 | map lifecycle | The analyzer freezes the first map frame while the overlay and hover marker follow replacements | Fixed |
| F5 | P1 | map lifecycle | Full Screen Map gives up after 10 seconds and binds only the frame present at startup | Fixed |
| F6 | P1 | state recovery | Analyzer settings writes can remain optimistic forever when the bridge never replies | Fixed |
| F8 | P1 | error boundary | Browser/internal exception text still reaches product surfaces | Fixed |
| F14 | P1 | supply chain | One high-severity development-tool advisory expands to eight audit rows | Bounded upstream acceptance |
| F7 | P2 | state/UX robustness | Favorites replacement has no explicit busy/focus contract | Fixed |
| F9 | P2 | recovery UX | “Manage TR drafts” can do nothing with no feedback | Fixed |
| F10 | P2 | recovery UX | Profile-backup availability and challenge-tab failures can disappear silently | Fixed |
| F11 | P2 | accessibility | Coordinate copy is mouse-only and clipboard failure is console-only | Fixed |
| F12 | P2 | copy | A disabled peak-map toggle says “Available once the peak” | Fixed |
| F13 | P2 | test hygiene | One options test leaks timers and adds about 125 seconds to the suite | Fixed |
| F15 | P2 | release hygiene | Lint warnings are accepted as an unowned aggregate, including an Android floor mismatch | Implemented; Android device proof outstanding |

Severity is impact and urgency, not an effort estimate. P0 means the invariant
can violate user consent, destroy/replace data, or strand a transaction. P1 is
a material correctness, recovery, or release-confidence defect. P2 is a
bounded UX/accessibility/maintenance defect.

---

## F1 — Capture privacy choices fail open on a settings read error

**Evidence.** [`settings.js`](../../src/settings/settings.js) deliberately
keeps `get()` fail-soft: any `storage.sync.get` failure returns schema defaults.
That is appropriate for passive rendering, but the same API is used by
[`readCapturePreferences`](../../src/background/background.js), and the
defaults in
[`settings-schema.js`](../../src/settings/settings-schema.js) enable waypoint
retention, Trip Info, ascent details, wilderness nights, and external activity
links.

The toolbar path has one authoritative worker read before provider capture. The
local-file path repeats the issue in the isolated-world
[`ascent-upload.js`](../../src/ascent/ascent-upload.js): it parses and sends
waypoints and the track name using `Settings.get()`, then the worker re-reads
the same fail-soft fallback before filtering the content-script-to-worker
message. Therefore a user who explicitly disabled waypoints or
track-name-derived Trip Info can have those fields retained during a transient
sync-storage failure. The raw provider GPX still stays on its source page, but
that narrower guarantee does not make ignoring an explicit field-level opt-out
acceptable.

**Broken invariant.** A failure to read privacy preferences must stop the
privacy-sensitive action. Defaults may keep a page renderable; they may not
authorize data capture.

**Fix.**

1. Expose the store's existing strict `read()` behavior as a deliberately named
   API such as `requireCurrent()`. Keep `get()` fail-soft for passive display.
2. Use the strict API in the worker before provider injection/capture. For local
   upload, use it in the isolated-world controller before parsing and again in
   the worker before accepting/filtering the message. If either read fails,
   retain no new job payload and show plain recovery copy: “Capture settings
   could not be read. Reload and try again. Nothing was captured.”
3. Preserve the worker re-read as defense in depth. Do not add a settings
   snapshot to the content-script protocol or let a page-supplied value become
   authoritative.
4. Audit every remaining `Settings.get()` call and classify it explicitly as
   display fallback, safe-default feature gate, privacy gate, destructive gate,
   or preservation action. Only the first two may remain fail-soft.

**Regression proof.**

- Force `storage.sync.get` to reject in both toolbar and local-upload harnesses.
  Assert no provider capture call, no waypoint/track-name message, no stored
  GPX/job payload, and actionable copy.
- With settings readable and the two fields disabled, retain the existing
  parity assertions that no waypoint/name survives.
- Run `npm run verify:extension` because the fix changes a dependency used at
  content-script load and crosses the isolated/MAIN-world boundary.

## F2 — Preservation actions can export or overwrite a default settings object

**Evidence.** Local export in
[`options/settings-backup.js`](../../options/settings-backup.js) and
`buildSettingsBackup()` in
[`github-routes.js`](../../src/background/github-routes.js) both call the
fail-soft `Settings.get()`. If sync storage is temporarily unreadable, local
export downloads a valid-looking default payload. Worse, manual GitHub backup
writes that payload to the fixed settings-backup path and reports success,
replacing a possibly correct remote backup.

Automatic settings backup is also exposed to a narrower race: its `enabled()`
gate and `build()` step read separately. The first read can succeed and the
second fail-soft to defaults, allowing the scheduled write. The false default
only prevents the write when the gate read itself fails.

**Broken invariant.** A preservation operation must preserve an authoritative
snapshot or fail without producing/replacing an artifact.

**Fix.**

1. Land F8's typed public error boundary before changing this route, then reuse
   F1's strict settings read for local export and every manual/automatic
   settings-backup build.
2. Move the strict read inside the manual GitHub backup's typed error boundary.
   No `putFile` call may occur when the snapshot cannot be read.
3. Keep the last remote file untouched and retain the local UI's retry state.
   Say “Settings could not be read, so no backup was changed.”
4. Treat a failed local export as an inline error; do not create a `Blob`, object
   URL, or synthetic download.

**Regression proof.**

- Reject sync reads and assert zero `URL.createObjectURL`, link clicks, GitHub
  writes, and sync signatures.
- Seed a non-default remote backup and prove the failed operation leaves it
  byte-identical.
- Exercise the manual retry after storage recovers and assert the real settings,
  not defaults, are serialized.

## F3 — Draft opening is not a transaction

**Evidence.** `openNewDraftTabs()` in
[`background.js`](../../src/background/background.js) creates an `about:blank`
tab and persists its `bpbDraftTabs` record once per selected summit. Only after
all creates does it navigate them with `Promise.all(tabs.update(...))`. There is
no rollback around tab creation, draft-record writes, the pre-navigation
callback, or navigation.

If the second `tabs.create`, a draft-record write, or one `tabs.update` fails,
earlier blank tabs and fresh draft identities remain. On retry, `openDrafts()`
sees any matching record, assumes the tab is live, calls `tabs.update`, and
returns `reused: true`; it can focus a blank tab or fail again on a stale tab
whose `onRemoved` cleanup has not run. The local-upload path is worse: it may
register the current form as the primary draft and update the job to `opened`
before a sibling navigation fails. That registration directly assigns
`drafts[tabId] = currentDraft`, overwriting any pre-existing current-tab record
without retaining it for rollback.

**Broken invariant.** A user gets the complete selected draft set, or every
artifact created by that attempt is rolled back. A failed open must remain
retryable.

**Fix.**

1. Give draft opening an explicit transaction object that tracks newly created
   tab IDs, newly written draft IDs, the prior current-tab draft (if any), and
   the prior job phase.
2. Preserve the necessary “record before navigation” race protection, but wrap
   every later step in rollback. On failure, remove only tabs created by this
   attempt, delete only its draft records, and restore the current-tab/job
   records it replaced.
3. Before reuse, validate every recorded tab with `tabs.get` and its expected
   ascent-edit URL/identity. Prune stale records and create a fresh set rather
   than treating “record exists” as “draft is usable.”
4. Keep tab grouping cosmetic: a grouping failure still returns the existing
   boolean warning and must not roll back good tabs.
5. Log the internal cause, return bounded public copy, and leave the popup or
   upload card on a retryable selection.

**Regression proof.**

- Inject failure at each `tabs.create` index, the draft-record mutation, the
  pre-navigation callback, and each `tabs.update` index.
- After each failure assert: no new blank/ascent tabs, no new draft identities,
  the exact original current-tab draft/job restored after the explicit
  overwrite path, and the next attempt succeeds.
- Simulate a recorded tab closing immediately before reuse and assert stale
  records are pruned without a false “reused” result.
- Retain the registration-before-navigation assertion for successful drafts.

## F4 — The analyzer has two conflicting map-frame lifecycles

**Evidence.** The analyzer defines a replacement-aware `findMapIframe()`, then
immediately freezes `const mapIframe = findMapIframe()` and passes that element
to [`map-viewport.js`](../../src/gpx/map-viewport.js). The viewport, native
Leaflet lookup, 3D hide/restore, toggle/compass placement, terrain initialization,
and peak-marker client all close over the frozen element.

[`map-overlay.js`](../../src/gpx/map-overlay.js) and the chart-hover handler keep
calling the live accessor. The current late-frame regression test inserts the
frame after 5.2 seconds and correctly proves the route casing appears—but it
does not assert that the viewport, resize handle, 3D toggle, Leaflet
invalidation, or peak feed recovered. They do not. If the frame is absent
during analyzer startup, `MapViewport.create` returns an inert object and the
toggle is never appended. If Peakbagger replaces the frame later, the overlay
and hover marker follow the new frame while native Leaflet access, the peak
client, 3D hide/restore, and the viewport remain tied to the old one.

**Broken invariant.** Every analyzer map feature must observe one current frame
identity and rebind atomically when that identity changes.

**Fix.**

1. Introduce one small map-frame lifecycle owner. It observes insertion,
   replacement, and `load`, and publishes the current usable frame.
2. Make the viewport attach/rebind idempotently. A late frame is moved into the
   existing viewport; a replacement inherits the size and gets the resize
   affordance exactly once.
3. Make native map access, the chart-hover marker, 3D hide/restore,
   toggle/compass placement, Leaflet invalidation, and terrain init ask the
   lifecycle owner for the current frame.
4. Reset the peak client and hover marker whenever frame identity changes.
   Dispose listeners/observers from the previous frame.
5. Fold the overlay's private frame observer into this owner or subscribe it to
   the same lifecycle; do not leave two competing notions of “current.”

**Regression proof.**

- Replace the real 5.2-second sleep in the current test with a deterministic
  clock/condition driver. Insert the frame after the old boundary and assert
  viewport, resize handle, overlay, hover marker, terrain toggle, Leaflet
  invalidation, and peak client all use it.
- Replace a fully initialized frame and assert the old frame has no extension
  controls/listeners while every feature targets the new frame.
- Run analyzer unit tests, `npm run verify:extension`, and
  `npm run terrain:verify` hidden on the hardware renderer.

## F5 — Full Screen Map still gates on a fixed 10-second retry

**Evidence.** The end of
[`big-map.js`](../../src/maps/big-map.js) polls `bindMap()` 40 times at 250 ms,
then silently stops. It attaches a `load` listener only to the frame returned by
the first startup query. A frame inserted after startup never receives that
listener; a usable Leaflet map that arrives after ten seconds never binds; a
later frame replacement is likewise invisible.

This is the same failure mode the previous audit fixed in the analyzer overlay.
The current hidden verifier proves the normal fixture initializes quickly, not
that a late or replaced production frame recovers.

**Fix.**

- Reuse the frame-lifecycle idiom from F4: observe frame identity and load,
  bind when the condition is true, and clean up on page teardown.
- A diagnostic ceiling may stop the observer on a permanently invalid page, but
  it must warn and remain a backstop rather than define correctness.
- Reset frame-derived `activeMap`, `activeMapWin`, peak client, casings, and
  terrain state on identity change.

**Regression proof.** Add BigMap tests for insertion after ten seconds (use a
fake clock or condition driver, not an 11-second sleep), frame reload, and
replacement. Assert native styles and 3D route/peak data recover exactly once.

## F6 — Analyzer setting writes have no acknowledgement deadline

**Evidence.** The MAIN-world BPB client in
[`gpx-analyzer.js`](../../src/gpx/gpx-analyzer.js) adds each optimistic patch to
`pending` and deletes it only on a matching `setResult`. If the isolated bridge
unloads, the worker is asleep/unreachable, or the reply is lost, the patch
remains optimistic forever, no error is shown, and the `pending` map grows.
Future confirmed settings are recomputed underneath the stale patch, so the
control can continue to display a value storage never accepted.

The prior audit added visible rollback for explicit negative replies. It
recorded a missing-reply timeout as a residual gap; that gap remains.

**Fix.**

- Start a bounded timer per request ID. On expiry, delete only that patch,
  recompute from the latest confirmed settings plus newer pending patches, and
  use the existing write-failure status.
- Clear the timer on a valid reply. Ignore a late reply after expiry unless it
  carries a confirmed storage snapshot that can be processed as an ordinary
  external update.
- Preserve ordering: an older failed/timed-out patch must never revert a newer
  patch for the same key.

**Regression proof.** Cover no reply, delayed success after timeout, explicit
failure, overlapping writes to the same key, and overlapping writes to
different keys. Use deterministic fake timers.

## F7 — Favorites replacement has an implicit and fragile busy/focus contract

**Evidence.** In
[`options/favorites.js`](../../options/favorites.js), confirming Buddy mirroring
or GitHub restore disables the confirmation's only two focusable controls and
starts the async replacement. The Escape listener is dialog-scoped. In the
independent Chromium and Firefox probe, focus was reported on `body` or the
disabled confirm control, but keyboard Escape targeted `body`; it did not reach
the listener or dismiss the in-progress write. The original
destructive-cancellation claim is therefore not reproducible in either target
engine.

The remaining defect is smaller but real: a consequential operation silently
leaves focus in an unusable or out-of-dialog state, exposes no `aria-busy`
state, and depends on the current DOM having no other focusable descendant.
Adding a link or retry affordance could make the unguarded Escape path
reachable. The settings-import confirmation already has an explicit busy
contract.

**Fix.** Apply the same explicit busy contract to the shared favorites
confirmation: set `aria-busy`, deliberately manage focus while the buttons are
unavailable, and ignore Escape/cancel while busy. Keep the reviewed impact
visible, dismiss only on success, and on failure restore controls/focus while
retaining the same reviewed replacement for retry. Do not claim cancellation
unless the worker protocol can prevent commit.

**Regression proof.** Lead with a hidden real-browser test against the actual
options page, not jsdom's different disabled-focus behavior. Hold the worker
response and assert the dialog remains visible, exposes busy state, and keeps a
deliberate focus target in Chrome and Firefox. Then prove success dismisses
once and failure remains retryable without reloading the Buddy list/backup.

## F8 — The background's public error boundary forwards internal messages

**Evidence.** The background message listener returns
`error.message` verbatim for every uncaught route failure. Capture and local
GPX processing also persist/return raw exception messages in broad catches.
The popup renders those messages in “Draft opening stopped,” and ascent
surfaces interpolate them into banners. A browser exception such as a
`tabs.create`, scripting, storage, or runtime error can therefore leak API
names/internal detail into user copy.

The prior audit fixed this for tab grouping only: it now logs the cause and
returns a boolean. The general boundary still violates the same rule.

**Fix.**

1. Define typed product errors with stable codes and bounded public messages.
2. Known validation/network failures may carry their curated copy. Unexpected
   browser/storage exceptions are logged with route context and converted at
   the outer boundary to a generic, actionable recovery sentence.
3. Never interpolate arbitrary page-world exception text. Normalize provider
   failures to known codes before they leave MAIN world.
4. Keep detailed causes in extension logs only; do not store them in public job
   objects.

**Regression proof.** Throw representative `tabs.create`, `tabs.update`,
`scripting.executeScript`, sync/session storage, and page-world errors. Assert
the raw sentinel appears in captured logs but nowhere in messages, stored
public jobs, popup cards, or ascent banners.

## F9 — “Manage TR drafts” can silently do nothing

**Evidence.** The report editor's `openDraftsManager()` is wired to both the
footer action and the draft-recovery bar. It sends `OPEN_DRAFTS_MANAGER`,
discards the response, and swallows synchronous and Promise failures. The
worker can reject the sender or fail `tabs.create`, yet both discovery actions
give no busy or failure feedback.

**Fix.** Use the shared runtime-message helper, await `{ok: true}`, briefly mark
the button busy/disabled, and write failure copy into the editor's existing
polite status region. Keep editing fully available and the button retryable.
The worker route should return a typed public failure instead of relying on the
outer raw-error catch.

**Regression proof.** Drive both entry points through success, forbidden
response, null response, rejected message, and tab-creation failure. Assert one
tab on success and visible, non-sticky recovery copy on failure.

## F10 — Profile-backup recovery actions can disappear or fail silently

**Evidence.**

- `initialize()` in
  [`profile-backup.js`](../../src/profile/profile-backup.js) removes the panel
  for every falsy status. The shared runtime helper normalizes worker/transport
  failures to `null`, so “feature disabled” and “status temporarily unavailable”
  are indistinguishable. An already-connected owner's only full-profile backup
  surface can disappear until a reload.
- Both Cloudflare recovery renderers call `window.open(...)` without checking a
  thrown error or null return. “Open check” can do nothing while “Resume”
  remains impossible.

**Fix.**

- Add an opt-in discriminated runtime helper result so this surface can
  distinguish transport failure from a real disabled/disconnected status.
  Keep the panel absent when truly disabled; render a compact retry state when
  availability is unknown.
- Route “Open check” through a checked tab-opening helper or at minimum detect
  failure/null and keep the challenge URL plus actionable error visible.

**Regression proof.** Cover initial worker failure, recovery without page
reload, disabled status, blocked/thrown check opening, and a successful check
tab. Do not expose GitHub credentials or broaden sender permissions.

## F11 — Coordinate copy excludes keyboard/touch users and hides failure

**Evidence.** The analyzer tells users to “Double-click point to copy
coordinates” and listens only for `dblclick` on the Chart.js canvas. Clipboard
rejection is written only to `console.error`; the visible hint remains
unchanged. There is no keyboard selection/copy path, no touch affordance, and
no test for the behavior.

**Fix.** Make point selection an explicit chart interaction:

- click/tap selects the nearest valid point and announces its coordinates;
- when the canvas is focused, left/right moves the selected point;
- a small secondary “Copy coordinates” action copies the selected point;
- success and failure use the panel's live status/hint, with a select-and-copy
  fallback where clipboard access is unavailable.

Do not make double-click the only path; it may remain as a shortcut if it calls
the same command.

**Regression proof.** Cover pointer, touch-equivalent click, keyboard
navigation, clipboard success/rejection, no valid elevation point, and
light/dark focus states. Visually inspect the real analyzer at its default and
narrow supported widths.

## F12 — Disabled Full Screen peak-map copy is grammatically incomplete

**Evidence.** BigMap composes the no-subject tooltip as
`Available once the ${mapType === 'P' ? 'peak' : 'map has a GPS track'}`. For a
peak map this renders “Available once the peak,” while the aria-label renders
“3D terrain available once the peak.”

**Fix.** Use complete sentences owned by map type, for example “Available once
the peak location loads” and “Available once the map has a GPS track.” Avoid
nested fragments for user copy.

**Regression proof.** Assert exact title and accessible name for peak, ascent,
and group maps with and without a terrain subject.

## F13 — Leaked device-flow timers add about 125 seconds to the test suite

**Evidence.** The test “opening the GitHub device page uses tabs.create and
reports a failure” reaches all assertions, but never closes its jsdom window.
The rendered device flow owns a one-second countdown and two-second auth poll.
The isolated assertion passes in about 136 ms, then the process exits normally
after 125.9 seconds when the device code expires.

The full suite likewise passes **807/807** in about 135 seconds. Interrupting
the runner creates the apparent extra cancelled file-level test that the
initial audit misread as an unaccounted test. Nothing is masked and CI's
15-minute timeout is not currently threatened; this is a test resource leak
and roughly 10× performance penalty, not a release-trust failure or Node 26
product defect.

**Fix.**

1. Register every jsdom returned by the options harness with deterministic
   `afterEach` teardown; keep explicit closes only where a test needs to assert
   teardown behavior.
2. Keep teardown as the proof. `--test-force-exit` may be useful as a separate
   diagnostic backstop on supported Node versions, but do not enable it by
   default because it would hide the next leaked handle.
3. Run the suite on CI's Node 24 and the documented newest supported major.

**Regression proof.** The isolated reproduction must exit promptly after its
assertions, then `npm test` must pass all discovered tests without waiting for
the device-code expiry or retaining active options timers. Record exact Node
versions and wall times.

## F14 — One development-tool advisory expands to eight audit rows

**Evidence.** `npm audit --json` reports eight high-severity rows that collapse
to one `brace-expansion` advisory, GHSA-mh99-v99m-4gvg, through dependency
chains rooted in both the direct `eslint@10.7.0` and `web-ext@10.5.0`.
Vulnerable instances include `brace-expansion@5.0.7` under direct ESLint paths
and a hoisted `brace-expansion@1.1.16` requested by
`minimatch@3.1.5`. The extension ships bundled runtime assets, not these tools,
so this is not a store-package runtime vulnerability. It is still relevant to
CI and developer machines, especially where lint consumes
repository-controlled patterns.

`npm audit fix --force` proposes a major downgrade to `web-ext@2.7.0`; that is
not a safe remediation plan. At reassessment time, `eslint@10.8.0` and
`brace-expansion@5.0.8` are published while `web-ext@10.5.0` remains current.
The existing 5.x ranges can accept 5.0.8 through a lockfile refresh, but a
blanket `brace-expansion@^5.0.8` override would also replace a dependency
declared as `^1.1.7`; calling 5.0.8 a patch in that path would be incorrect.

**Fix.**

- Refresh the lockfile so consumers already declaring a compatible 5.x range
  resolve `brace-expansion@5.0.8`; confirm those audit paths disappear. Treat
  the available direct ESLint update as ordinary tool churn, not as the root
  fix, and test it separately if adopted.
- Check current `web-ext`, `addons-linter`, `minimatch`, and
  `brace-expansion` releases and their declared ranges. Prefer upstream
  compatible releases for the remaining 1.x path.
- If an override is still necessary, scope it to a proven parent/path and test
  that parent's behavior. Do not globally force `brace-expansion@5` into a
  consumer declaring `^1.1.7`, or force any other incompatible transitive
  major merely to make the audit count zero.
- If upstream remains blocked, record a time-bounded risk acceptance with the
  exact dev-only reachability and an owner/date to recheck. Do not report “0
  vulnerabilities” until the live audit says so.

**Regression proof.** Clean `npm ci`, `npm audit`, `npm run lint`,
`npm run package`, `npm run verify:packages`, and the full test suite. Inspect
the produced archives to prove no tooling package entered `dist/`.

## F15 — Lint warnings have no machine-owned baseline

**Evidence.** `web-ext lint` currently succeeds with 12 warnings:

- one expected `BACKGROUND_SERVICE_WORKER_IGNORED` warning; the shared manifest
  deliberately also supplies `background.scripts` for Firefox;
- one `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: the manifest allows
  Firefox 140 while `gecko.data_collection_permissions` was not supported by
  Firefox for Android until 142;
- ten `UNSAFE_VAR_ASSIGNMENT` warnings: three in vendored MapLibre, three owned
  compass insertions compiled from one
  [`terrain-compass.js`](../../src/terrain/terrain-compass.js) source line, and
  four in the ascent-editor bundle. The owned ascent-editor warnings come from
  two [`report-editor.js`](../../src/reports/report-editor.js) lines: static
  toolbar markup and sanitized report preview; the other two come from editor
  dependencies.

The command returns zero, so a thirteenth warning would be accepted without any
review. The aggregate “12 existing warnings” is not an ownership model.

**Fix.**

1. Decide and document Android support. If Android is supported, set the
   Android-specific minimum to the first version that understands the required
   disclosure and test the derived Firefox manifest. If Android is not a
   supported product, encode/document that truth instead of leaving a misleading
   floor.
2. Remove the two owned static `innerHTML` sources: construct the compass SVG
   with SVG DOM APIs and toolbar labels with DOM nodes. Keep the report preview
   behind one named sanitizer/render boundary with adversarial tests. Those two
   source edits should clear four compiled warnings; do not count bundle copies
   as independent owners.
3. Parse JSON lint output in a project check. Allowlist only exact
   code/file/ownership tuples with a reason; fail on any new tuple. Keep the
   expected Firefox service-worker warning documented rather than trying to
   remove Chrome's source-of-truth entry.
4. Do not edit vendored MapLibre to silence its three warnings; pin them to the
   package version and reassess on dependency updates.

**Regression proof.** `npm run lint` and the new warning-baseline test, plus
report-markup injection tests, hidden Chrome verification, and derived Firefox
manifest/package verification.

---

## Execution order and commit boundaries

Every problem landed as an independent focused commit:

| Finding | Commit |
| --- | --- |
| F13 | `720a38c` — close options pages after every test |
| F8 | `72f8f73` — bound public error messages |
| F1 | `6fa0eb0` — fail closed when capture settings are unreadable |
| F2 | `334a891` — preserve settings backups on read failure |
| F3 | `d690ede` — make draft opening transactional |
| F4 | `8c2efc0` — unify analyzer map-frame lifecycle |
| F5 | `d7faf6f` — rebind replaced full-screen maps |
| F6 | `0a0da84` — bound analyzer settings acknowledgements |
| F7 | `3657f2d` — keep favorites replacement retryable |
| F9 | `ea7fcfd` — surface report drafts manager failures |
| F10 | `4d9e33f` — keep profile backup recovery visible |
| F12 | `1e34994` — complete unavailable terrain copy |
| F11 | `99d2ba8` — make coordinate copy keyboard accessible |
| F14 | `9f78503` — own the remaining development advisory |
| F15 | `e66d0c0` — own extension lint compatibility |

The original execution sequence is retained below as the implementation record.

1. **Remove the options timer leak (F13).** Deterministic options/jsdom
   teardown and controller disposal. Prove the isolated test and full suite no
   longer wait for device-code expiry on Node 24 and the current supported
   major.
2. **Split passive and authoritative settings reads (F1 API).** Add the strict
   API and classification tests without changing consumers.
3. **Establish typed public errors (F8).** Land error types and the outer
   boundary before strict reads can throw from preservation/capture routes.
4. **Fail closed for capture (F1 consumers).** Keep authoritative worker
   re-reads, add the isolated-upload gate, run focused tests, then hidden
   real-extension verification.
5. **Make settings preservation authoritative (F2).** Local export, manual and
   automatic GitHub backup, typed failure/retry tests.
6. **Make draft opening transactional (F3).** Rollback and stale-reuse pruning;
   verify toolbar and local-upload parity.
7. **Create one analyzer frame lifecycle (F4).** Characterization tests first,
   replace the fixed sleep, then lifecycle owner, viewport/overlay/terrain
   subscribers, hidden extension and hardware-GPU terrain verification.
8. **Adopt condition-based binding in BigMap (F5).** Keep this separate from F4
   so Full Screen Map regressions bisect cleanly.
9. **Bound analyzer writes (F6).** Timer/order tests and bridge verification.
10. **Make favorites replacement explicitly busy (F7).** Real-browser
    busy/Escape/focus behavior on the actual options page, then a rendered
    Settings check in both themes.
11. **Repair recovery affordances (F9, then F10).** Separate commits because
    report-draft navigation and profile backup have different senders and trust
    boundaries.
12. **Finish small UX defects (F12, then F11).** The copy fix is independent.
    Coordinate-copy accessibility gets its own behavioral and visual evidence.
13. **Repair the development chain (F14).** Never mix dependency churn with
    product changes.
14. **Own linter warnings and Android compatibility (F15).** This may follow
    F14 because a tool update can change warning locations/codes.

After every unit: inspect `git diff`, run its focused tests and `npm run
lint:js`, commit using the repository's explanatory Conventional Commit style,
and inspect `git log -1 --format=raw`. Run the full suite at the end of every
P0/P1 unit; F13 makes that gate materially faster but does not change whether
the suite's result is trustworthy.

## Final verification evidence

- `npm ci` completed from the lockfile.
- `npm run audit:ci` passed the exact development-only exception. Raw
  `npm audit` still reports eight aggregate high rows from the single accepted
  `brace-expansion` 1.x path; the exception expires on 2026-08-09.
- `npm run lint:js` passed. `npm run lint` passed with six exact owned warnings
  and no errors or notices.
- `npm test` passed **864/864** on Node 26.5.0 and Node 24.18.0.
- `npm run test:scale` passed **4/4**, including the 1,500-entry favorites and
  20,000-point GPX cases.
- `npm run verify:browsers` passed in hidden Chrome for Testing new headless and
  Firefox 153.0 at 1000×760.
- `npm run terrain:verify` passed in hidden Chrome at 798×448 and 448×448 on
  `ANGLE Metal Renderer: Apple M3 Pro`; 12 resizes produced zero blank frames
  and the mocked DEM produced a non-flat 0–1750 m mesh.
- `npm run terrain:verify:firefox` passed in hidden Firefox 151.0 at 1000×760
  on the reported hardware renderer; route, basemap, peaks, terrain, input, and
  resize checks passed.
- The Chrome and derived Firefox archives were built, structurally verified,
  and executed through `npm run verify:packages` in both hidden browsers.
- F7's busy/focus state was rendered in hidden Chrome at 1000×760. F9 was
  inspected in light and dark at default and 440 px widths. F11 was inspected
  in light/dark at 1000×760 and 440 px. F15's rebuilt editor preview was
  inspected at 1000×760.
- No verifier-owned browser process or disposable profile remained. The
  terrain screenshots and temporary Node 24 runtimes were removed. The
  pre-existing Firefox DevTools MCP profile/process was not touched.

These checks were hidden and protocol-driven. They do not prove native browser
focus, window placement, permission-prompt presentation, toolbar popup chrome,
touch-device behavior, or Firefox Android compatibility.

## Stop conditions

- A strict-settings change must not make passive page rendering fail because
  sync storage is temporarily unavailable.
- A draft rollback must never close a pre-existing user tab or delete a draft
  record not created/replaced by that transaction.
- A map-lifecycle refactor must not mutate Peakbagger's native layers, duplicate
  extension overlays/controls, or move extension APIs into MAIN world.
- Typed error cleanup must not erase actionable known errors into one generic
  sentence.
- F14 must not accept a forced tool downgrade or incompatible transitive
  override merely to make the audit count zero.
- Any one of these conditions stops the unit; revert only that unit's owned
  changes and investigate before proceeding.

## Closure ledger

This ledger preserves the three categories required by `AGENTS.md`.

### Open

None. The implementation work is complete; the remaining external/upstream
evidence belongs under “changed but not fully proven.”

### Fixed and verified

- **F1, capture privacy:** authoritative reads now gate toolbar capture and
  local upload before parsing or retention; the worker keeps its independent
  re-read. Storage-failure regressions and hidden real-extension checks passed.
- **F2, preservation authority:** local export plus manual and automatic GitHub
  settings backups now fail without producing or replacing an artifact when
  settings are unreadable. Retry and no-write tests passed.
- **F3, draft transaction:** per-source opening is serialized and rolls back
  created tabs and exact prior draft state without closing user-navigated tabs.
  Partial-create, update, callback, stale-reuse, and parity tests passed.
- **F4–F5, map lifecycles:** the analyzer and Full Screen Map now rebind late,
  reloaded, replaced, and removed MasterMap frames by identity. Old overlays,
  handlers, terrain state, peak clients, and camera state are released.
  Condition-driven unit, hidden browser, and hardware-GPU terrain checks passed.
- **F6, settings recovery:** optimistic MAIN-world settings writes have a
  five-second acknowledgement deadline, ordered rollback, late-snapshot rules,
  and timer disposal. Deterministic ordering/timeout tests and the real bridge
  check passed.
- **F7, replacement UX:** Buddy mirror and GitHub restore remain visibly busy
  and focused during the write, block cancellation/source changes, dismiss
  only on success, and restore the reviewed payload for retry on failure.
  Held-response Chrome/Firefox checks passed.
- **F8, public errors:** only typed, curated messages cross the worker and
  content/page boundaries. Unexpected internal exceptions are logged with
  context and surfaces receive stable recovery copy.
- **F9–F10, recovery UX:** both report-draft manager entry points and the
  profile-backup availability/challenge flows now retain actionable,
  retryable states for transport, popup, and worker failures.
- **F11–F12, accessibility/copy:** chart coordinates support click/tap,
  keyboard selection, an explicit Copy action, live status, and a selected-text
  clipboard fallback. Disabled terrain labels are complete per map type.
- **F13, test lifecycle:** centralized options teardown closes every jsdom
  window; the former 125-second tail is gone on Node 24 and Node 26.

### Intentionally not changed

- **The shared Chrome/Firefox background entries remain.** The
  `BACKGROUND_SERVICE_WORKER_IGNORED` Firefox warning is expected because Chrome
  needs `service_worker` and Firefox has the paired `scripts` entry. The exact
  warning is owned by the lint baseline rather than removing a required
  manifest half.
- **Six dependency/manifest linter warnings remain by ownership.** Three are
  pinned MapLibre renderer locations, two are generated ProseMirror/TipTap
  locations, and one is the shared background entry above. A changed location,
  duplicate, new warning, error, or notice fails `npm run lint`.
- **No size-only refactor is proposed.** `terrain-frame.js`, `background.js`,
  `report-markup.js`, and the largest test files are large, but line count alone
  is not a defect. The implementation extracted only the lifecycle,
  settings-client, and public-error boundaries needed for correctness.

### Changed but not fully proven

- **F14, upstream development advisory:** every compatible
  `brace-expansion` 5.x installation is patched to 5.0.8. The remaining 1.x
  route is development-only under the current `web-ext` toolchain and is
  accepted only by an exact path/version/advisory gate through 2026-08-09.
  Raw `npm audit` is therefore not clean, and this cannot be called fully fixed
  until upstream removes the incompatible path or the accepted toolchain
  changes safely.
- **F15, Firefox Android:** `gecko_android.strict_min_version` now declares
  142.0 independently of desktop Firefox 140.0, extension-owned HTML parsing
  warnings were removed, and the remaining six warnings are machine-owned.
  Desktop Firefox, packages, and manifest tests passed, but no physical Android
  device or mobile browser chrome was exercised.

## Known blind spots

- No live Garmin, Strava, GitHub repository, or Peakbagger account was mutated.
  Provider DOM/export drift and real GitHub conflict/rate-limit behavior remain
  release-level manual checks.
- The hidden browser baseline exercised normal fixture timing. F4 and F5 are
  source/test-gap findings; their late/replacement cases were not injected into
  the real browser during this audit.
- No visible, touch-device, or Firefox Android review was performed. Hidden
  Chrome and Firefox exercised the actual options and content-script surfaces,
  but cannot prove native focus, browser chrome, touch ergonomics, or Android
  manifest/store behavior.
- Dependency advisories and available versions are time-sensitive. The F14
  CI acceptance deliberately expires on 2026-08-09 so this snapshot cannot
  silently become permanent.
- This plan does not claim that no other defect exists. It records every
  concrete bug, UX failure, and material improvement found in this pass, with a
  fix and proof plan for each.

---

The independent review below is preserved as submitted in commit `3190e48`.
The revised assessment above records which corrections were accepted and where
the remediation judgment differs.

# Review pass — 2026-07-26 (independent verification of this plan)

Reviewer: a second agent, reading only the shipped source and re-running the
checks. Same baseline: clean `main`, `dist/` rebuilt from source. Every claim
below was checked against code or a command, not inferred from this document.

**Verdict: the findings are real and the diagnoses are mostly precise.** Thirteen
of fifteen hold as written. Two do not, and one piece of the shared evidence
section is wrong in a way that changes the plan's priority order — fix those
three before starting remediation, because two of them currently point work at
the wrong thing.

## Per-finding verification

| ID | Verdict | Note |
| --- | --- | --- |
| F1 | confirmed | Fix step 3 needs rework — see R4. |
| F2 | confirmed | Ordering dependency on F8 — see R7. |
| F3 | confirmed | |
| F4 | confirmed | One more live-accessor caller than stated — see R5. |
| F5 | confirmed | |
| F6 | confirmed | |
| F7 | **not reproducible as described** — see R2. | Severity should drop to P2. |
| F8 | confirmed | |
| F9 | confirmed | Two buttons, not one — see R7. |
| F10 | confirmed | |
| F11 | confirmed | |
| F12 | confirmed | |
| F13 | symptom confirmed, **conclusion wrong** — see R1. | Severity should drop to P2. |
| F14 | reproduced, **root misattributed** — see R3. | Fix plan needs rewriting. |
| F15 | confirmed, including every code/file/count | Ownership is smaller than it reads — see R6. |

## Corrections required

### R1 — `npm test` passes; the suite does not hang

This is the correction that matters most, because the execution order makes it
unit 1 and calls it "restore a trustworthy baseline."

The leaked timers are real and F13's reproduction is exact — the isolated test
prints a pass in ~133 ms and the file then stalls. But it stalls; it does not
hang. Run to completion:

- isolated test: exits on its own after **125.9 s**, exit 0, 1 pass, 0 cancelled.
  125 s is the device code's own lifetime (`expiresIn: 125` in
  `options.test.mjs:2127` (since split into `test/options/`)), so the leaked
  poll dies when the code expires.
- `npm test`: **807 passed, 0 failed, 0 cancelled, exit 0, 135 s wall clock**
  (Node 26.5.0).

The "**807 passed of 808 discovered**, then did not terminate" reading is an
artifact of interrupting the runner. When `node --test` is interrupted it emits a
file-level pseudo-test: my own interrupted single-test run reported
`tests 2 / pass 1 / cancelled 1` for a file containing one test, with
`'Promise resolution is still pending but the event loop has already resolved'`.
There is no 808th test. The audit counted the interrupt artifact as a real one
and concluded the baseline was untrustworthy.

Consequences for the plan:

- Delete "This is not a passing full-suite result" from **Scope and evidence**
  and record 807/807 in 135 s instead.
- F13 is **P2 test hygiene**, not P1 release confidence. Nothing was masked and
  CI is green: `.github/workflows/test.yml` allows `timeout-minutes: 15`.
- Keep F13 as execution unit 1 anyway, but for the honest reason: ~125 s of the
  135 s wall clock is one leaked poll. Fixing it makes the suite ~10× faster.
  Drop the "restore a trustworthy baseline" framing and the "once F13 makes it
  trustworthy" clause at the end of **Execution order**.
- Fix step 2's unnamed "test-runner timeout/backstop" is `--test-force-exit`
  (Node 22+). Name it, and keep the audit's own judgment that it is not the fix.

### R2 — F7's Escape path cannot be reached in either target browser

The code smell is real: [`favorites.js:836`](../../options/favorites.js) has no
`aria-busy` guard where
[`settings-backup.js:117`](../../options/settings-backup.js) has one. But the
described consequence — "Pressing Escape during the storage transaction hides the
dialog and restores focus" — does not happen, for a reason the audit missed:

- the favorites listener is bound to `mirrorConfirmationEl`; the settings-import
  listener it is compared against is bound to `document`. Only the second one can
  see a keydown from outside the dialog, which is exactly why it needs the guard.
- the dialog subtree ([`options.html:402`](../../options/options.html)) holds two
  buttons and static text — no third focusable node. `showReplacementConfirmation`
  focuses **Cancel** (`favorites.js:218`), and the confirm handler disables
  **both** buttons (`favorites.js:805`).
- so the moment the write starts, the dialog owns no focusable element, focus
  falls to `<body>`, and an Escape keydown never enters the dialog's subtree.

Verified headless with the real engines, using the actual DOM shape and handler
order (Chromium 149.0.7827.55 and Firefox 151, Playwright, isolated profiles):
focus after confirm is `BODY`/`confirm`, the Escape keydown targets `BODY`, the
dialog-scoped handler never runs, and `dlg.hidden` stays `false` in both.

Also note the trap this sets for the proposed regression test: jsdom does not
blur a disabled active element, so "hold the worker response, click confirm,
press Escape" **will** appear to reproduce the defect in jsdom and will assert a
behavior no user can trigger. Do not let that test become the evidence.

Keep the fix — the two confirmations should share one busy contract, and the
guard stops the next person from adding a focusable element and reintroducing a
real bug — but re-file it as **P2 consistency/robustness**, drop the destructive-UX
framing, and lead its proof with a real-browser check rather than jsdom.

### R3 — F14 is rooted in `brace-expansion`, and partly outside `web-ext`

`npm audit` reproduces exactly: 8 high, 0 critical, `fixAvailable` a major
downgrade to `web-ext@2.7.0`. Three things in the finding are wrong:

1. **All eight collapse to one advisory**: `brace-expansion`
   (GHSA-mh99-v99m-4gvg, unbounded expansion → OOM, range `<=5.0.7`). The other
   seven rows are `via` chains onto it.
2. **Not all of it is under `web-ext`.** `npm audit --json` names the vulnerable
   instances, and two of them are reached through this repository's *own direct*
   `eslint@10.7.0`: `node_modules/eslint/node_modules/brace-expansion@5.0.7` and
   `node_modules/@eslint/config-array/node_modules/brace-expansion@5.0.7`, plus
   hoisted `node_modules/minimatch@3.1.5` and
   `node_modules/brace-expansion@1.1.16`. `web-ext` is what pins
   `fixAvailable` to a downgrade; it is not the sole path. A web-ext-only
   remediation can never reach zero. ("No runtime dependency is implicated"
   remains correct — nothing here ships in `dist/`.)
3. **The recommended remediation order is backwards.** `web-ext`'s registry
   `latest` is **10.5.0** — the installed version — so "prefer an upstream
   patched release" has nothing to move to today. Meanwhile
   `brace-expansion@5.0.8` **is** published and `eslint@10.8.0` is out, so the
   narrow fixes that actually exist are `eslint` update plus
   `overrides: { "brace-expansion": "^5.0.8" }`. The fix text warns against
   forcing "a semantically incompatible minimatch major" — wrong package;
   `minimatch` is only flagged *via* `brace-expansion`, and the override target
   is a patch release, not a major.

Rewrite F14 around the real root, drop the web-ext-upgrade-first ordering, and
re-check the registry at implementation time as the finding already says.

### R4 — F1's snapshot-passing step weakens an existing fail-closed check

Everything in F1's evidence checks out: the private strict `read()`
([`settings.js:43`](../../src/settings/settings.js)), the fail-soft `get()` at
`:49`, all five capture defaults `true`
([`settings-schema.js:34`](../../src/settings/settings-schema.js)),
`readCapturePreferences` on `get()`
([`background.js:43`](../../src/background/background.js)), the toolbar path
handing those preferences into MAIN-world capture (`background.js:320`), and the
upload path's second read
([`ascent-upload.js:417`](../../src/ascent/ascent-upload.js)).

But fix step 3 — "pass one confirmed snapshot through the transaction; avoid
independently re-reading on the page and worker" — argues against the design it
is describing. `startGpxProcess` already re-filters the waypoints and the track
name against the worker's own read (`background.js:729`–`733`); the two reads are
deliberate defense in depth, and step 3's own last sentence re-mandates the
worker read it just removed. Make **both** reads strict and delete the
snapshot-passing idea: it adds a protocol, and the invariant is satisfied without
it.

Two wording fixes in the same finding: `ascent-upload.js` is *isolated-world*
extension code, not page code, so "across the extension boundary" and "accepting
fields from page code" describe a content-script→worker hop rather than the
page→extension exfiltration they imply. And on the toolbar path there is only one
read (the worker's), not a page/worker pair — worth stating, since it changes
what each regression test can assert.

### R5 — F4 undercounts the competing frame lifecycles

"Only `map-overlay.js` continues to call the live accessor" is not quite right.
[`gpx-analyzer.js:802`](../../src/gpx/gpx-analyzer.js) also calls
`findMapIframe()`, inside the chart's hover handler. That makes the split worse
than described, not better: after a frame replacement the hover marker follows
the **new** frame while `nativeLeafletMap()` (`:466`), the peak client (`:621`),
and 3D hide/restore (`:544`, `:577`) stay bound to the **old** one. Name the
hover-marker path in fix step 3 and in the replacement assertion.

The rest of F4 is exact, including the inert-viewport chain: `element` stays
`null` without an iframe ([`map-viewport.js:31`, `:96`](../../src/gpx/map-viewport.js)),
so `mapViewport` is `null`, so the terrain toggle is never appended
(`gpx-analyzer.js:334`) and the terrain container never resolves (`:513`). And
the cited test really does assert only polylines and layer count
([`gpx-analyzer.test.mjs:808`](../../test/gpx/gpx-analyzer.test.mjs)).

While you are in that test: it reaches the late-frame case with a real
`setTimeout(resolve, 5200)` (`:771`), which is the fixed sleep `AGENTS.md`
forbids and 5.2 s of the suite's wall clock. F4 rewrites this area, so fold
replacing it into F4's unit instead of leaving it unowned.

### R6 — F15's warning inventory is right; its ownership is 3 source lines

Reproduced exactly: 12 warnings, 0 errors, 0 notices, exit 0, and the split is
1 `BACKGROUND_SERVICE_WORKER_IGNORED` + 1
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` + 10 `UNSAFE_VAR_ASSIGNMENT`
(`vendor/maplibre-gl-csp.js:5` ×3, `content/big-map.js:431`,
`content/peak-map.js:184`, `content/gpx-analyzer.js:942`,
`content/ascent-editor.js` ×4). The Android detail is confirmed from the linter
itself: `strict_min_version` 140 versus 142 for
`gecko.data_collection_permissions`, and the manifest has no `gecko_android`
key at all — so the Android-specific floor is the right remedy.

One refinement worth writing down, because the finding reads like ten separate
cleanups: the three "compass insertions" are **one** source line —
[`terrain-compass.js:36`](../../src/terrain/terrain-compass.js) — bundled into
three outputs. The owned ascent-editor pair is
[`report-editor.js:122`](../../src/reports/report-editor.js) (static toolbar
markup) and `:366` (sanitized preview). So two source edits clear 4 of the 10
warnings, and only the preview needs the named-sanitizer treatment.

### R7 — smaller precision notes

- **F2 depends on F8.** `buildSettingsBackup()` is called *outside*
  `backupSettings`'s `try` ([`github-routes.js:836`](../../src/background/github-routes.js)),
  so a strict read that throws lands in the raw-message boundary F8 exists to
  fix. As ordered (F2 = unit 4, F8 = unit 10) the F2 commit ships a browser
  exception string in user copy. Either land F8 first or give F2 its own typed
  failure.
- **F2's automatic-backup hedge has a narrower race worth naming.** `enabled()`
  and `build()` read separately (`github-routes.js:810`–`811`), so a read that
  succeeds for the gate and fails for the build still writes defaults. "Normally
  prevents the scheduled write" is true but understates it.
- **F9 is two buttons.** `openDraftsManager` is wired at
  `report-editor.js:330` (footer) and `:568` (draft-recovery bar). Both need the
  busy/failure treatment; "the editor's only discovery action" describes one.
- **F3, worth pinning as its own assertion.** `drafts[tabId] = currentDraft`
  (`background.js:825`) overwrites any existing current-tab record with no saved
  copy, which is what makes "restore the prior current-tab draft" necessary
  rather than defensive.
- **Priority summary ordering.** F13/F14 are P1 rows sitting below P2 rows. After
  R1 and R2, F7 and F13 both become P2 — re-sort then.

## Evidence this pass

All hidden/headless; no visible window, no live Peakbagger page, no network
mutation. Host Node 26.5.0 (the repo documents 22+, CI uses 24), macOS 24.6.0.

- `npm run lint:js`: exit 0.
- `npm test`: **807 passed, 0 failed, 135 s, exit 0.**
- isolated `--test-name-pattern` run of the F13 test: pass in 133 ms, process
  exits at **125.9 s**; interrupting it at 30 s reproduces the audit's
  `cancelled 1` artifact verbatim.
- `npm audit --json`: 8 high / 0 critical; `nodes` and `via` read per advisory;
  registry checked for `web-ext`, `eslint`, `brace-expansion`.
- `npm run lint` and `web-ext lint --output json`: 12 warnings, exit 0, full
  code/file inventory captured.
- F7 focus/Escape probe: Playwright Chromium 149.0.7827.55 and Firefox 151,
  headless, disposable profiles, on a reduced page reproducing the dialog's DOM
  and handler order. Disposable script and logs were kept outside the repo.

Not established here: nothing onscreen. Spacing, focus-ring appearance, touch
behavior, and the F7 dialog's real rendered behavior inside the options page
(the probe used a reduced page, not `options.html`) all remain for remediation,
as does `verify:extension` / `terrain:verify`, which this pass did not re-run.
F4's and F5's late/replacement cases were read in source only.
