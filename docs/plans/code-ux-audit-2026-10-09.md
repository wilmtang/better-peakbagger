# Code and UX audit — 2026-10-09

Status: remediation authorized and in progress. No P0 or P1 finding was
established by the audit. This is a source-grounded review with targeted reproductions, not a
claim that every runtime path or live integration is proven correct.

## Baseline and scope

- Audited commit: `c22c96a1b4323748f908fb817adc2a11b277072b`, version 3.9.2.
  The working tree was clean; local `main` was three commits ahead of its tracked
  remote. Those existing commits were preserved.
- Reviewed manifest/build boundaries, capture and draft privacy contracts,
  settings and theme ownership, GitHub backup acknowledgements, Photo Library
  transactions and keyboard behavior, photo annotation interaction, report
  editing, popup layout, test coverage, and dependency policy.
- Read the [active CI/UX audit](ci-ux-maintainability-audit-2026-10-03.md) and
  [recent UI-state closure ledger](../archive/ui-state-audit-2026-10-06.md).
  Their completed fixes are not repeated as new findings. Existing dependency
  and release-recovery follow-ups keep their original owners and disposition.
- Runtime files were not changed. The audit adds this plan and its index entry.

P2 means a reproducible correctness or usability defect worth fixing in a
normal focused change. O1 is a P3 design opportunity requiring product judgment.

## Findings

| ID | Priority | User-visible consequence | Evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | P2 | Backup success can describe local content that was never committed | Bundled UI probes and worker/queue contract | Changed; final visual check pending |
| F2 | P2 | Open Favorites, Drafts, and Photos keep the old theme | Real unpacked Chrome extension and bundled UI probe | Open |
| F3 | P2 | A delayed startup read paints obsolete Settings choices | Deferred-read bundled UI probe | Open |
| F4 | P2 | Removing a photo drops keyboard focus to the document body | Bundled photo UI and IndexedDB fixture | Open |
| F5 | P2 | A failed photo removal produces no visible explanation | Injected IndexedDB quota failure | Open |
| F6 | P2 | Typing a label in a narrow window hides the photo being annotated | Real Chrome typing, geometry, and screenshot | Open |

### F1 — Backup success lacks the identity of the committed snapshot

**Evidence.** `options/favorites-backup.js` (lines 203–215) records the *current*
repository and favorites signature after the asynchronous request completes.
The worker builds the favorites snapshot before the network write in
`src/background/github-routes.js` (lines 1265–1281), but returns neither that
signature nor its repository identity to this UI. The reply therefore cannot
justify attaching success to whatever favorites happen to exist at completion.

A bundled-options probe held the backup response after taking a one-entry
snapshot, added a second local favorite, then released success for the old
snapshot. The UI displayed `Favorites backed up ✓ View commit` with two local
entries although the acknowledged snapshot contained one.

There is a second acknowledgement error in both backup panels.
`src/github/github-write-queue.js` (lines 92–99) explicitly returns
`superseded: true` when a later write replaced this caller's content before
commit. Favorites ignores that field; `options/settings-backup.js` (lines
274–294) also ignores it, despite correctly capturing its requested signature
before the request. A probe returning this legitimate reply shape made both
panels display their ordinary backed-up success state.

**Impact.** Users can trust a backup indicator that does not describe the data
they are looking at. Changing the connected repository during a Favorites
request can also misattribute the completion, based on the same source-level
identity error; that repository-switch case was not separately reproduced.
These checks establish incorrect acknowledgement, not remote data corruption.

**Smallest safe direction.** Have the worker return the actual snapshot and
connection identity associated with the write. Show current-content success
only when that identity matches the current UI state and the request was not
superseded. Otherwise explain that newer changes still need backup. Preserve
local edits, automatic backup, connection scoping, and queue coalescing.

**Acceptance.** Add focused cases for an edit during backup, repository change,
and a superseded write for both panels. Assert the rendered status and commit
link against the committed snapshot, including a subsequent successful backup.
Do not infer completion from queue admission or an unrelated batch commit.
One independent commit should cover the acknowledgement contract and its UI.

### F2 — Shared panel theme startup never subscribes to later changes

**Evidence.** `src/theme/panel-theme.js` (lines 19–28) applies the synchronous
mirror and performs one asynchronous read. It owns no subscription to settings
changes or system-theme changes. Settings has its own live controller, while
the standalone panels do not consistently apply theme on later settings events.

In hidden Chrome with the real unpacked extension, Favorites, Drafts, and Photos
were opened in light mode. Updating the stored preference to dark changed
Settings to dark while all three remained light. A bundled Drafts probe produced
the same result. The optional dark-Favorites screenshot branch of
`scripts/verify-extension.mjs` timed out at its actual theme postcondition
(line 1524); the normal verifier subsequently passed without that optional
branch. The failure is retained as product evidence, not dismissed as a flake.

**Impact.** Open management surfaces disagree with the user's explicit theme
choice. The missing system listener also leaves the shared owner unable to
follow an OS change by itself; that OS interaction was not reproduced.

**Smallest safe direction.** Give the shared panel theme owner a live settings
subscription and a system-theme listener used only for the system preference.
Guard the initial read against newer events and preserve the last known
preference on storage failure. Keep synchronous first-paint behavior and the
existing stylesheet ordering; avoid separate theme rules in each panel.

**Acceptance.** Verify already-open panels in light/dark and system modes,
including delayed startup reads and storage failure. Exercise the shipped
manifest in Chrome and Firefox because this is a load-time dependency. Inspect
the rendered colors and readability, not just the stored value.
Commit independently from the Settings control race in F3.

### F3 — A late Settings startup read overwrites a newer rendered snapshot

**Evidence.** `options/options.js` subscribes at line 273, but unconditionally
calls `S.get().then(populate)` at line 298. `populate` (lines 113–149) repaints
every control and replaces `confirmedSettings`, the snapshot used by save-error
recovery. There is no revision check tying the initial result to its read time.

A bundled-options probe delayed the controller's startup read with a snapshot
of light theme and retained waypoints enabled. A newer storage event correctly
painted dark theme and retained waypoints disabled. Releasing the old read
reverted the controls to light/enabled while storage remained dark/disabled.

**Impact.** Settings can misrepresent effective choices, including a capture
privacy control. A later save failure can also recover from the obsolete
confirmed snapshot. No actual waypoint disclosure was established by this
probe; the reproduced defect is false UI state.

**Smallest safe direction.** Track the revision of authoritative updates and
accept the startup result only if no newer update or local operation owns the
surface. Keep the confirmed snapshot coherent with the accepted settings.
The standalone Favorites entry already uses an initial-read revision pattern;
reuse that ownership principle without broad controller refactoring.

**Acceptance.** Defer startup reads across external updates and the first local
save. Verify both the rendered controls and save-failure recovery. Preserve
unrelated control focus and the existing shared schema validation.
Use one focused Settings-controller commit.

### F4 — Photo Library replacement destroys the user's keyboard position

**Evidence.** `photos/photos.js` (lines 3047–3080) redraws a library page using
`replaceChildren` at line 3072, without preserving the focused card/action.
Removal calls that redraw at line 2906. The photo editor's annotation list and
the recently fixed Favorites/Drafts lists have different focus handling; their
fixes do not cover this library grid.

With two saved photo cards, a bundled photo-page probe focused the first
`Remove…` action, confirmed removal, and waited for one remaining card.
`document.activeElement` became `BODY`, even though the Undo control existed.

**Impact.** Keyboard users lose their location after a routine reversible action.
Maintenance and other full-grid refreshes use the same replacement boundary,
but those triggers were not individually reproduced.

**Smallest safe direction.** Identify cards and actions by stable photo ID and
action. If focus belonged to the replaced grid, preserve the corresponding
action or move to the next/previous item or a stable empty-state target. Keep
Undo discoverable. Never move focus when the user has moved to search or another
surface while the asynchronous redraw was running.

**Acceptance.** Cover removal, restoration, Undo, maintenance, and pagination,
including the last item and focus moved outside the list before completion.
Check DOM keyboard focus in a real browser; native window focus and screen-reader
speech still require separate manual proof. Commit this independently from F5.

### F5 — Ordinary Photo Library storage errors escape the action boundary

**Evidence.** Removal in `photos/photos.js` (lines 2875–2882), Undo (lines
2890–2897), and restoration (lines 2912–2921) handle only
`PhotoStoreConflictError`; other errors are rethrown. Their card click handlers
(lines 3013–3029) discard the resulting promises without a rejection handler.

A bundled photo-page probe injected `QuotaExceededError` into the removal
transaction. The promise rejected without visible toast or error state. The
card remained present, so this reproduction establishes silent failure, not
loss of the saved photo. The conflict-only handlers on Undo/restoration are
source-grounded extensions of the same issue, not separately reproduced cases.

**Impact.** Users cannot tell why an action did nothing or whether it is safe to
retry. The exception escapes to an unhandled rejection instead of a recoverable
user-facing outcome.

**Smallest safe direction.** Catch operational errors at the action boundary,
preserve the catalog on failure, restore usable controls/focus, and provide a
concise retryable explanation. Keep conflict messages specific. Review the
library insertion boundary too: report insertion can succeed before reference
bookkeeping fails, so feedback must preserve that actual external outcome.
Avoid claiming that a remote image was removed by a local library operation.

**Acceptance.** Inject quota, aborted-transaction, and read failures into
removal, restoration, Undo, and project download. Assert visible feedback,
unchanged durable state on failed writes, and no unhandled rejection. Test
successful report insertion followed by bookkeeping failure separately.
One focused action-error-handling commit can cover these related boundaries.

### F6 — Narrow label editing separates text input from the photo

**Evidence.** `photos/photos.css` (lines 920–954) stacks the inspector below the
canvas at widths below 900px. `photos/photos.js` (lines 1619–1627) correctly
focuses and selects the new label with `preventScroll: true`; simply adding that
option again will not address the layout.

In real hidden Chrome at 390 × 760, a synthetic 900 × 600 photo was opened,
Text was selected, a label was placed on the photo, and `North ridge` was typed.
Typing scrolled to the inspector at `scrollY = 1276`. The photo's bounds were
−116 to 92px vertically, behind the sticky header; the focused input started
at 735px and extended below the viewport. Screenshot inspection confirmed that
the photo was no longer visible while editing the label. A simple intersection
test misleadingly reported it visible because it ignored header occlusion.

**Impact.** In a narrow desktop window, users must alternate scrolling between
the text field and the composition they are editing. Focus and project state
were retained; the defect is the interaction layout, not lost label data.

**Smallest safe direction.** Keep a compact text control near the visible photo
while editing at narrow widths, for example a contextual or anchored inspector.
Choose the smallest layout that preserves a visible label region and input.
Preserve the recent typing-focus fix, automatic label width, Undo, autosave,
and full-resolution export; do not add another preference to solve this.

**Acceptance.** Inspect placement and typing at 390 × 760, 520 × 800, and
1000 × 760 in both themes. Cover multiline labels, automatic width, keyboard
placement, and typing without tool shortcuts stealing characters. Confirm that
the label region and input can be seen together. Touch behavior remains an
external check. Keep this as a separate UX commit.

### O1 — Optional: confidence copy crowds capture result names

At 390 × 650, the real rendered popup gave the confidence badge approximately
182px while the peak-name column had 114px. `Mount Rainier — Columbia Crest`
wrapped to two lines and its evidence to several more. There was no horizontal
overflow, and the selection and primary action remained usable.

`popup/popup.css` (lines 116–134) reserves an unwrapped third grid column;
`popup/popup.js` (lines 314–320) fills it with
`Strong match · 96% confidence`. Consider shorter visible copy or a badge below
the name while preserving the shared Strong/Probable semantics and complete
accessible meaning. This is an owner-choice refinement, not a confirmed
functional regression. Inspect the normal popup width before choosing a change.

## Verification and evidence

| Check actually run | Result and limits |
| --- | --- |
| `npm test` | Passed: 2,348 tests, zero failures/cancellations/skips; builds shipped bundles. Does not prove native UI or live providers. |
| `npm run lint` | Passed ESLint, build, and web-ext policy; six existing owned web-ext warnings remain. |
| Fresh `npm audit --json` | Exit 1: three high findings on the existing development-tool path; see disposition below. |
| Evaluation of that fresh JSON with the repository audit policy | Strict policy rejected; the explicit reviewed-advisory policy accepted the exact existing path/version/expiry. |
| Normal Chrome path in `scripts/verify-extension.mjs` | Passed with real unpacked `dist/`, masked HTTPS Peakbagger fixtures, Chrome for Testing 153.0.8010.12, hidden new headless mode. Base viewport 1000 × 760 plus verifier responsive cases. |
| Optional dark-Favorites screenshot branch | Failed its theme wait; retained as F2 evidence. Passing the normal branch does not close F2. |
| Targeted bundled UI/IndexedDB probes | Reproduced F1, F3, F4, F5, and the Drafts instance of F2. Deferred reads/replies and injected errors were fixture controls. |
| Targeted real-extension Chrome checks | Reproduced F2 across three panels and F6; inspected the optional O1 layout. |
| `node --test test/project/documentation.test.mjs` and `git diff --check` | Passed: all three documentation tests and no whitespace errors. |

Screenshots were inspected for the desktop photo editor (1000 × 760), narrow
photo editor (520 × 800), narrow Favorites (480 × 760), dark report Markdown
editor (1280 × 800), label typing (390 × 760), and a synthetic ready capture
popup (390 × 650). The label reproduction was light, exposing F2 rather than
proving the corresponding dark layout. These were hidden static HTML/SVG/canvas
checks; no hardware WebGL renderer result is claimed.

Logs, probe scripts, structured results, and screenshots are retained in the
task's local audit evidence directory, linked in the audit handoff.
Of particular relevance are `bpb-audit-2026-10-09-options-probes.log`,
`bpb-audit-2026-10-09-superseded-probes.log`,
`bpb-audit-2026-10-09-photo-probes.log`,
`bpb-audit-2026-10-09-targeted-browser.json`, and `photo-label-390.png`.
The evidence is local and tied to the audited baseline; it is not checked-in
automated regression coverage. Test browsers and disposable profiles were
closed, and exact profile/process inspection found no surviving audit browser.
The user's existing browsers and tabs were not used or closed.

Firefox, scale tests, terrain GPU verification, remote CI, store packaging,
native focus/window placement, screen-reader speech, touch, OS termination,
and live Garmin/Strava/Peakbagger/ImgBB/GitHub behavior were not verified in this
audit. Live services were not exercised for these reproductions. The intended
hidden extension/fixture surface loaded successfully; future UI fixes still
require fresh visual inspection of their affected states before closure.

## Existing accepted risk and preserved boundaries

The fresh dependency audit still reports the existing high-severity
`web-ext` → `@devicefarmer/adbkit` → `node-forge` advisory path.
`scripts/check-npm-audit.mjs` accepts only the exact development-tool path and
versions through **2026-10-17 07:00 UTC** when the reviewed exception is explicitly
requested; default evaluation remains strict. The lock entries are development
dependencies and these three packages were absent from the shipped attribution
inventory. This does not make the full dependency graph clean, and a `dev` flag
alone does not prove that a library is absent from extension bundles.
Keep the existing active-audit dependency follow-up; do not create a second
exception or silently extend its deadline. Release-recovery remote proof from
that plan also remains open.

Preserve raw-provider-GPX containment, narrow settings bridge validation,
complete summit lookup, draft identity and exactly-once Preview gates, and the
user's exclusive ownership of final Peakbagger Save. This review found no reason
to weaken those documented boundaries. Passing local tests is not proof of
live ownership signals or authenticated provider behavior.

## Proposed execution order and closure ledger

The user authorized remediation after the audit. Independent commits:
F1 backup acknowledgement; F3 Settings revision ownership; F2 shared theme
lifecycle; F5 photo action errors; F4 library focus; F6 narrow label editing.
Run focused regression coverage before each commit and the real extension
verifier for load-time dependencies. Preserve unrelated working-tree changes.
O1 can be accepted or declined separately without blocking the six defects.

### Fixed and verified

None yet. Focused runtime changes are listed below until their remaining
acceptance checks run.

### Intentionally not changed

- Existing local commits and the documented privacy and final-Save boundaries
  remain preserved throughout remediation.
- The existing exact, expiring dependency exception remains owned by the prior
  active plan. This records current risk; it is not a fresh acceptance or closure.
- O1 is deferred for product judgment and is not counted as a fixed defect.

### Changed but not fully proven

- F1: the worker now returns the written snapshot signature and repository;
  both panels require that identity and reject superseded current-content
  success. Focused options/worker coverage passed 144/144; build, focused
  ESLint, and whitespace checks passed. Hidden Chrome 153 real-extension
  verification passed; final status-copy visual inspection remains pending.

Keep native/live/platform proof gaps explicit when moving locally verified
items to the first category. Preserve this ledger when the plan is archived.
