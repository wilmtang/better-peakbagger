# Codebase audit — 2026-09-13

Status: proposed remediation; audit only. No runtime changes were made.

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

The existing [caption plan](report-image-captions.md) already records the open
real Peakbagger save/reopen compatibility gate. Preserve it as an independent
release requirement; local caption tests do not close that gate. The
[Imgur plan](imgur-media-hosting.md) remains proposed work.

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

## Closure ledger — initial state

All F1–F6 remain **open**. I1/I2 are investigation tasks. Reproducing a defect is
not fixing it; filling this ledger is part of subsequent remediation.

### Fixed and verified

None. This change adds the audit and its index entry only.

### Intentionally not changed

Runtime code, tests, and existing plans remain unchanged during this audit.
This is the requested review scope, not a decision to accept F1–F6. No broad
module-size refactor is proposed, and existing sync/async or execution-world
boundaries are not presumed to be smells merely because they are separate.

### Changed but not fully proven

No runtime changes in this audit. During remediation, list any fixes that lack
required browser, lifecycle, visual, or live-server evidence here, with the exact
remaining check. The caption plan's pre-existing live-save gap stays in its own
ledger and must not disappear when this audit is archived.
