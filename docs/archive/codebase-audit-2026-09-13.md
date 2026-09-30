# Codebase audit — 2026-09-13

Status: **remediation completed and archived on 2026-09-14.** All six findings
and both investigation tasks have a recorded disposition below. The closure
ledger separates verified fixes from deliberately unchanged work and remaining
browser-proof gaps.

Audited baseline: `fff816f2880d6791c5eaf20a5b0bad3f0de22218` (3.7.2), with a
clean working tree. Line references below describe that revision.

## Findings first

Six issues were reproduced locally. The highest priority is recovery of report
text: disabling the Markdown editor can create a draft whose visible text and
Markdown source disagree, and Restore chooses the stale source. The other
findings concern shared resource ownership, keyboard scope, input validation,
and the test gate. Two additional investigation tasks are explicitly unproven
performance/maintenance opportunities, not asserted user-facing regressions.

| ID | Priority | Area | Finding | Evidence |
| --- | --- | --- | --- | --- |
| F1 | P1 | Report recovery | Live disable preserves stale Markdown ownership; restoring can replace newer native edits | Built-bundle draft/restore probe |
| F2 | P2 | Performance/storage | Independent terrain-cache owners exceed the shared budget and overwrite each other's index | Two-owner cache probe |
| F3 | P2 | UX/correctness | Library keyboard input can delete annotations in the hidden photo editor | Built photo-page probe |
| F4 | P2 | Storage lifecycle | A rejected blocked database open can later succeed and leak its connection | IndexedDB upgrade probe |
| F5 | P2 | GPX correctness | Impossible calendar dates normalize into apparently valid track timestamps | Parser probe |
| F6 | P2 | Engineering/test gate | The existing Imgur plan names a future directory in a form the documentation checker requires to exist | Baseline test failure |
| I1 | P3 | Performance investigation | Rich editing repeatedly walks/serializes the whole report; large-report interaction latency is unmeasured here | Source inspection only |
| I2 | P3 | Engineering debt | Synchronous and cooperative encounter/ambiguity policies have duplicated implementations | Source inspection; existing equivalence tests pass |

P1 denotes a credible loss or replacement of user-authored content. P2 denotes
a reproducible correctness, resource, interaction, or development-gate defect.
P3 work must establish value before changing implementation. No P0 issue was
established; this is a targeted repository audit, not proof that no other bugs
exist.

## Scope and verification

Inspected report editing/conversion/drafts/local photos, photo UI and storage,
upload transaction recovery, GPX parsing and capture detection, terrain cache
and prefetch ownership, settings storage/bridge/file transfer, and relevant
tests and prior audit records. GitHub and capture orchestration were sampled,
not exhaustively reviewed. Recent caption changes received additional scrutiny.

Checks run on macOS with Node 26.8.2:

| Check | Result | Limit of evidence |
| --- | --- | --- |
| `npm test` | **1,868 passed, 1 failed**, 1,869 total | Builds shipped bundles; the failure is F6 and existed before this audit document |
| `npm run lint` | Passed, with eight acknowledged owned web-ext warnings | Static and package lint, not runtime proof |
| `npm run test:scale` | **14/14 passed** | Fixture/Node/jsdom coverage; not real-browser responsiveness measurements |
| Documentation checker after adding this plan | Two tests passed; the same F6 test failed with only the pre-existing missing target | No additional broken targets reported |
| `git diff --check` | Passed | Whitespace validation only |
| F1 and F3 probes | Reproduced against built editor/photo bundles using existing jsdom harnesses | State and event behavior, not visual layout or native focus |
| F2, F4, F5 probes | Reproduced against current source using an in-memory CacheStorage adapter, fake-indexeddb, and jsdom's XML parser respectively | Deterministic counterexamples; cross-context browser verification remains necessary |

No real browser, live provider, live Peakbagger Save, GPU render, dependency
advisory query, or remote CI run was performed. No browser/profile cleanup was
needed. This audit makes no claims about spacing, clipping, screen-reader
speech, native focus, or window placement. Temporary probe/log files are not
required by the plan; reproduction inputs and observed outcomes are below.

The existing [caption plan](report-image-captions.md) recorded the then-open
real Peakbagger save/reopen compatibility gate. It was an independent release
requirement; local caption tests did not close that gate. The
[Imgur plan](../plans/imgur-media-hosting.md) remains proposed work.

## F1 — Hand off text ownership when disabling the report editor

**Evidence.** In `src/reports/report-editor.js` (lines 1632–1640), live disable
flushes and destroys the editors but leaves `state.mode`, `mdSource`, and the
save/pagehide listeners in place. `saveDraftNow()` still records Markdown mode
and reads the destroyed editor's retained value (lines 808–822). Restore trusts
the source field for a Markdown draft (lines 991–1002).

**Reproduction.** Open Markdown mode, type `**old markdown**`, and wait for the
draft. Disable `enableReportEditor` through the settings subscription. In the
revealed native textarea type `NEW NATIVE TEXT`, then dispatch pagehide. The
saved record contains:

```json
{
  "text": "NEW NATIVE TEXT",
  "mode": "markdown",
  "source": "**old markdown**"
}
```

Open another editor with that draft and choose Restore. The Markdown editor
shows `**old markdown**`, not the newer native text. Later synchronization can
persist the older content. The existing live-disable test checks only that the
native textarea becomes visible.

**Smallest safe fix.** Treat live disable as an explicit transition to native
text ownership. Clear stale Markdown/dirty state, settle pending timers, and
ensure subsequent draft and GitHub snapshot paths read the current textarea.
Preserve the established policy that ordinary Plain mode does not acquire
unsolicited autosaving. If retaining a recovery record during handoff, record
its actual mode and source. Do not remove native Save/backup integration merely
to silence the stale editor.

**Acceptance.** Add the complete disable → native edit → pagehide → restore
regression beside `test/reports/report-editor-drafts.test.mjs`. Also cover Save
snapshots after disable, a pending autosave, both rich/Markdown entry modes, and
pending local photos. Native text must remain authoritative; any restored draft
or Markdown backup must represent it. Inspect the handoff in hidden Chrome and
Firefox, including the native textarea and local-photo failure feedback.

## F2 — Enforce the terrain cache budget across owners

**Evidence.** Each `TerrainCache.create()` has its own queues and cached state
in `src/terrain/terrain-cache.js` (lines 205–239, 296–343). Its index is a whole
object written to one shared key, and eviction counts only that owner's known
entries (lines 247–274). Each terrain frame creates an owner in
`src/terrain/terrain-frame-runtime.js` (line 1827); prefetch also creates one in
`src/background/terrain-prefetch.js` (lines 75–77). A per-instance promise queue
does not serialize multiple owners sharing the same storage partition.

**Reproduction.** Create two cache instances over the same initially empty
CacheStorage/storage adapter, each with `limitMb: 1`. Concurrently load distinct
valid-header WebP payloads of 716,800 bytes, then flush both owners. Observed
usage: **1,433,600 bytes, two entries**, despite the 1,048,576-byte budget. The
persisted index contains only **one** entry. No tile exceeds the individual
budget. Initialization can later rediscover the orphaned metadata, but active
owners do not reconcile each other's new writes before enforcing their limit.

**Impact.** Multiple maps can exceed the advertised disk budget, lose accurate
LRU metadata, and cause additional reconciliation/eviction work. This probe
does not measure a browser memory leak or establish a fixed multiplier for all
browser storage partitions.

**Smallest safe fix.** Coordinate cache mutation/index reconciliation/eviction
across owners that share storage. Select a cross-context coordination mechanism
supported by both packaged browsers, or a single cache owner with an explicit
transport contract. Merely moving the promise queue to module scope is
insufficient across frames. Preserve per-consumer cancellation, byte validation,
and best-effort rendering when storage fails. Review prefetch owner replacement
at the same boundary: it currently replaces the cache reference without closing
the old instance.

**Acceptance.** Add two-owner tests for distinct and identical tiles, concurrent
hits and eviction, close/flush ordering, and cache-limit changes. At a settled
checkpoint, actual cached bytes must respect the chosen shared-budget contract
and the index must describe the retained entries. Repeat in isolated hidden
Chrome/Firefox with two same-partition terrain surfaces. For rendered checks,
use the hardware GPU and record renderer and viewport; retain all existing DEM
consumer cancellation tests.

## F3 — Scope photo shortcuts to the visible editor

**Evidence.** `setView()` only hides/shows the editor and library in
`photos/photos.js` (lines 370–377). The document-level keyboard handler checks
busy state and text-input targets, but never the active view (lines 2868–2917).
Delete, Backspace, undo/redo, arrows, and tool shortcuts can still operate on
the hidden project. Project mutations schedule persistence.

**Reproduction.** In the built photo-page harness, load a photo, add one bolt
with Add at center, switch to Library, then dispatch Delete from the Library
navigation button. Observed: editor hidden, annotation count **1 → 0**, event
prevented, no page error. Undo is possible, but the change occurred outside the
surface displaying the affected content.

**Smallest safe fix.** Guard editor shortcuts with the active view and an
appropriate focus scope. Do not consume arrows/deletion when the editor has no
relevant action. Preserve native editing undo for caption/title fields and
keyboard access through the annotation list. End any coalesced gesture when
leaving the editor.

**Acceptance.** Add event-driven regressions in
`test/photos/photo-editor.test.mjs`: Library navigation/card focus must not
change the hidden project, its history, selected tool, or persisted draft.
Verify intended shortcuts still work in the editor. Use a hidden browser to
check the rendered Library → Editor transition and keyboard behavior; separately
record any untested native focus behavior.

## F4 — Close late database opens after a blocked-upgrade rejection

**Evidence.** `src/photos/photo-store.js` rejects the open promise on `blocked`
but leaves the request alive. Its later `onsuccess` only calls `resolve`
(lines 48–88). Resolving an already rejected promise gives no caller ownership
of the new connection. Opened databases also have no `versionchange` handler
to retire connections for a subsequent upgrade.

**Reproduction.** Hold version 3 of a disposable database open and request the
current version through `Store.openDatabase()`. It rejects with “Photo library
upgrade is blocked by another tab.” Close the original version-3 connection.
The rejected request subsequently succeeds. Deleting the disposable database
then reports blocked until the probe explicitly closes that otherwise
unreturned connection. The probe closed both connections and deleted the DB.

**Smallest safe fix.** Track whether the opener has already failed/been
abandoned, and close any subsequent successful connection immediately. Give
live connections a version-change lifecycle that closes safely and surfaces a
reload requirement to owners instead of silently leaving them with an unusable
store. Preserve existing transactions and data; this needs no schema bump.

**Acceptance.** Extend `test/photos/photo-store.test.mjs` with the blocked →
reject → blocker closes → late success sequence and assert a following upgrade
or deletion is unblocked. Cover ordinary success/error and a live connection's
version change. Verify the multi-tab upgrade/reload path in dedicated browser
profiles with disposable libraries.

## F5 — Reject nonexistent GPX calendar dates

**Evidence.** `src/gpx/gpx-parse.js` validates the timestamp's shape and then
uses `Date.parse()` plus a finite-number check (lines 43–63). The comment
assumes this validates calendar semantics, but overflow days are normalized.

**Reproduction input.**

```xml
<gpx><trk><trkseg><trkpt lat="45" lon="-120">
  <time>2026-02-30T12:00:00Z</time>
</trkpt></trkseg></trk></gpx>
```

With `includeQuality: true`, the parser returns `timeState: "valid"`,
`invalidTime: false`, and a timestamp for **2026-03-02T12:00:00.000Z**.
Downstream capture sanitization therefore does not take its invalid-time path
in `src/capture/capture-core.js` (lines 107–111). This is acceptance of malformed
input, not evidence that normal Garmin/Strava exports emit such dates.

**Smallest safe fix.** Validate calendar components before accepting the parsed
instant, including leap-year day counts and the supported timezone/time forms.
Keep the validation in the shared parser. Preserve intentionally supported
valid forms, fractional seconds, offsets, and the missing-versus-invalid
distinction; do not inadvertently reject valid end-of-day forms when tightening
the parser.

**Acceptance.** Extend `test/gpx/gpx-parse.test.mjs` with February 30,
non-leap-year February 29, April 31, valid leap days, and offset timestamps.
Assert malformed dates yield missing usable time plus the invalid flag, and
that capture/analyzer consumers do not turn them into confident dates or
durations. Run provider and upload parser regressions as well.

## F6 — Restore the documentation test gate without creating dummy code

**Evidence.** The full baseline suite fails
`every relative link resolves, in maintained and archived documents alike`.
The sole missing target is reported as:

```text
docs/plans/imgur-media-hosting.md: src/media
```

`docs/plans/imgur-media-hosting.md` (line 276) describes adding a future provider
registry directory. `test/project/documentation.test.mjs` (lines 189–203) treats
backticked repository paths in active plans as references to existing files.
The proposed directory does not yet exist. This is a local test failure, not a
claim about the current status of remote CI.

**Smallest safe fix.** Express the future directory as explicitly proposed
prose in that plan, consistent with the current checker, or introduce a narrow
documented convention for future paths. Do not create an empty runtime module
just to satisfy the checker, and do not exempt real links from validation.

**Acceptance.** Run `node --test test/project/documentation.test.mjs` and the
full suite. Preserve detection of genuinely broken paths and links. This is an
independent documentation correction and should be committed separately from
runtime remediation.

## Investigation tasks — establish value before refactoring

### I1 — Measure long-report editing and preview costs

`src/reports/report-rich-editor.js` walks the document after every document
change to repair figures (lines 575–600). The editor's debounced synchronization
also serializes the whole rich document through HTML and a DOM parse in
`src/reports/report-editor.js` (lines 648–651, 707–730); Markdown synchronization
rebuilds its preview. These operations are real, but no interaction-latency
regression was measured in this audit. The passing GPX/photo scale tests do not
establish a budget for this report-editing path.

Measure typing, caption edits, Save flush, and Markdown preview with increasing
report sizes and image counts in a hidden browser. Record longest main-thread
task and input-to-next-paint time, with source size and viewport. If excessive,
restrict figure repairs to changed ranges and avoid rebuilding an unchanged
preview. Preserve full synchronous serialization at submission and every
caption pair/undo invariant. Do not add a report truncation limit as a shortcut.

### I2 — Reduce duplicated detection policy only where it can drift

`src/capture/capture-core.js` maintains separate synchronous/cooperative
encounter implementations (lines 454–583) and ambiguity propagation/capping
(lines 671–732). These duplicate scoring-adjacent decisions, not just loop
syntax. The existing equivalence test at
`test/capture/capture-core.test.mjs` (lines 202–225) passed; no divergence was
found in this audit.

If changing these algorithms, first expand equivalence coverage to singleton
segments, missing/reversed times after sanitization, dateline/polar data, and
transitive ambiguity. Then consider sharing small candidate/capping operations
while keeping cooperative checkpoint ownership explicit. Avoid a generic
pipeline rewrite or per-point promise overhead. Retain the current implementation
if extraction makes cancellation or correctness harder to reason about.

## Execution order and completion contract

1. **F6 — restore the baseline gate.** One small documentation commit; rerun the
   documentation checker before runtime work.
2. **F1 — protect report recovery.** Focused editor-state fix and regression
   commit; include actual native-text ownership in backup verification.
3. **F3 — contain photo shortcuts.** Independent interaction fix and tests.
4. **F4 — repair database ownership.** Independent lifecycle fix and tests.
5. **F5 — validate dates.** Shared parser fix with capture/analyzer regressions.
6. **F2 — coordinate shared cache state.** Establish the cross-context design
   and failure semantics before implementation; keep its commit focused.
7. **I1/I2 — investigate selectively.** Record measurements or a justified
   decision to leave the code unchanged. They do not block the correctness fixes.

For each completed unit, run focused tests and relevant lint before committing.
Run `npm test` and `npm run test:scale` at integration. Changes to content-script
load dependencies or the worker also require the real-extension verifier;
exercise both browsers for the editor/storage/cache changes. UI remediation
requires rendered inspection at relevant sizes, including narrow/dark states.
Record hidden/visible mode, browser, viewport, and renderer where applicable.
Do not infer live provider or Peakbagger server compatibility from fixtures.

Preserve manual Peakbagger Save ownership, explicit upload consent, fail-closed
identity checks, MAIN/isolated-world boundaries, shared settings/math authority,
and recovery after ambiguous remote outcomes. Update maintained subsystem guides
only when implementation changes their contracts. Archive this audit only after
each finding has a disposition; retain the separate caption compatibility gate.

## Remediation record

The audit was remediated as seven focused implementation commits before this
archive update:

| Item | Commit | Result |
| --- | --- | --- |
| F6 | `39527c4` | Marked the future media directory as proposed instead of creating dummy runtime code. |
| F1 | `608794c` | Made live disable an explicit native-text handoff, including pending autosave, page-exit draft, GitHub snapshot, restore, and local-photo failure behavior. |
| F3 | `875e0b2` | Scoped keyboard ownership to the visible photo editor and stopped consuming unavailable actions. |
| F4 | `8380ea6` | Closed late successful opens after rejection and retired live connections/pages on `versionchange`. |
| F5 | `8d8a21d` | Added explicit GPX calendar, leap-day, end-of-day, and timezone-offset validation before platform parsing. |
| F2 | `b752590` | Serialized extension-origin cache mutation with Web Locks, reconciled actual shared state under the lock, failed to network-only when coordination is unavailable, and closed prefetch owners before replacement. |
| I2 | `bc092da` | Shared candidate, nearest-encounter, and ambiguity-cap policy while preserving separate synchronous/cooperative loop and checkpoint ownership. |

A post-archive verifier follow-up replaced Firefox's stale four-link count with
the exact current Peak-link contract: Windy, Copernicus, and AirNow, with NOAA
absent. The direct Firefox gate and the combined Chrome/Firefox gate then both
passed.

The I1 measurement used the real unpacked extension in hidden Chrome for
Testing 153.0.8010.12 at 1280×900. At 10 KB/5 images, 100 KB/25 images, and a
synthetic 500 KB/100 images, respectively:

- Rich open took 14.7/45.0/98.6 ms synchronously and 28.0/70.8/160.0 ms to the
  next paint.
- Rich typing took 18.8/15.9/14.5 ms to the next paint; caption editing took
  6.2/8.5/15.2 ms. None produced a long task.
- Save dispatch took 5.0/9.2/30.0 ms and 30.2/24.2/45.4 ms to the next paint.
- Markdown open took 17.8/40.4/150.2 ms synchronously and 31.5/47.8/164.5 ms
  to the next paint. Preview completed in 162.1/213.2/363.1 ms, including its
  intentional 150 ms debounce. Only the synthetic 500 KB case produced a long
  task, with a 164 ms maximum.

These measurements did not justify a normal-report refactor. The 500 KB result
is a monitoring boundary, not evidence that the existing 100 KB path violates
an interaction budget.

## Closure ledger

### Fixed and verified

- **F2 — shared terrain-cache budget:** focused two-owner tests cover distinct
  and identical tiles, concurrent hits and eviction, close/flush ordering, and
  lower/zero limit transitions. `terrain:verify:cache-owners` also passed in
  two same-partition frames in hidden Chrome for Testing 153.0.8010.12 and
  Firefox 155.0 at 1000×760: both distinct- and identical-tile scenarios
  settled at one 716,800-byte entry with an exact index. The existing terrain
  render suites passed on the Apple M3 Pro hardware renderer in both browsers.
- **F5 — GPX calendar validation:** parser, provider, upload, capture, and
  analyzer regressions now distinguish impossible dates from missing values
  while preserving leap days, supported offsets, fractional seconds, and
  valid `24:00` forms.
- **F6 — documentation gate:** the future directory is explicitly proposed;
  the maintained/archived path checker passes without weakening its broken-link
  checks.
- **I2 — shared encounter policy:** the extracted pure decisions pass expanded
  synchronous/cooperative equivalence cases for singleton segments,
  missing/reversed times, antimeridian/polar coordinates, and transitive
  ambiguity, plus the full-analysis scale cases and checkpoint assertions.
- **Firefox verifier drift:** the end-to-end assertion now checks the three
  current link identities instead of accepting any four links. The focused
  peak-link tests, scoped ESLint, direct Firefox verification, and combined
  browser verification all passed.

### Intentionally not changed

- **I1 — editor restructuring:** no Rich-editor changed-range repair or
  incremental Markdown preview architecture was introduced. The measured
  10–100 KB cases stayed responsive in the chosen hidden-browser probe; only
  the deliberately extreme 500 KB case crossed the long-task threshold.
  Submission remains synchronously serialized, and there is no report-size
  truncation.
- The existing report-image-caption live Peakbagger save/reopen gate remains in
  `docs/plans/report-image-captions.md`; this audit neither closes nor absorbs
  that independent release requirement.
- The NOAA snow-depth link remains intentionally removed as established by
  `13779dd`; the verifier now tests that product contract rather than restoring
  the removed link to satisfy a count.

### Changed but not fully proven

- **F1 — live report disable:** source and DOM tests cover Rich and Markdown
  handoff, native edits, a cancelled-but-fired autosave callback, Save snapshot,
  page exit, restore, and local-photo failure placement. The exact live-disable
  transition was not visually inspected in both packaged browsers, so native
  focus and rendered handoff remain unproven.
- **F3 — photo shortcuts:** DOM regressions prove Library navigation/card keys
  leave the hidden project, history, tool, and persistence unchanged, while
  intended editor shortcuts still work. The exact rendered Library → Editor
  keyboard transition and native focus were not inspected in both browsers.
- **F4 — database lifecycle:** fake-indexeddb regressions cover blocked → reject
  → late success → close, ordinary error, live `versionchange`, and the page's
  reload-required state. A real multi-tab browser upgrade with disposable
  libraries was not run.
- No live provider, live Peakbagger Save, screen-reader, physical-device, native
  window-placement, or remote-CI evidence was produced. Hidden checks do not
  establish those behaviors.

Final combined-tree checks before archival:

- `npm test`: **1,887 passed, 0 failed**, after rebuilding all 29 shipped
  bundles in `dist/`.
- `npm run test:scale`: **14 passed, 0 failed**, including the full 20,000-point
  analysis/provider paths and the expanded cooperative detection checks.
- `npm run lint`: passed with the eight existing owner-reviewed web-ext warnings
  (one manifest, five MapLibre, one ProseMirror, and one TipTap warning).
- `node --test test/project/documentation.test.mjs`: **3 passed, 0 failed**.
- `npm run verify:browsers`: passed with the real unpacked extension in hidden
  Chrome for Testing 153.0.8010.12 new-headless and hidden Firefox 155.0.1 at
  1000×760. The Firefox runner also passed directly before the combined run.
- `git diff --check`: passed.
